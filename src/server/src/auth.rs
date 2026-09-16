use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub name: String,
    pub aud: String,
    pub iss: String,
    pub exp: usize,
    pub iat: usize,
}

const MIN_ENTROPY_BITS: f64 = 80.0;
const MIN_SECRET_LENGTH: usize = 32;
/// JWT `exp` is enforced at the exact whole Unix second, without clock leeway.
pub const JWT_EXPIRATION_LEEWAY_SECONDS: u64 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthMode {
    Hs256,
    Hybrid,
    Asymmetric,
}

fn calculate_entropy(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut freq: HashMap<u8, usize> = HashMap::new();
    for byte in data {
        *freq.entry(*byte).or_insert(0) += 1;
    }
    let len = data.len() as f64;
    let entropy: f64 = freq
        .values()
        .map(|&count| {
            let p = count as f64 / len;
            -p * p.log2()
        })
        .sum();
    entropy * len
}

fn log_insecure_mode_warning() {
    log::warn!("=======================================================");
    log::warn!("SECURITY WARNING: INSECURE DEVELOPMENT MODE ENABLED!");
    log::warn!("Authentication is disabled and anyone can join rooms.");
    log::warn!("Unset ALLOW_INSECURE_NO_AUTH and configure JWT_SECRET for production.");
    log::warn!("=======================================================");
}

fn validate_secret_quality(secret: &str) -> Result<(), String> {
    if secret.chars().any(char::is_whitespace) {
        return Err("JWT_SECRET must not contain whitespace".to_string());
    }
    let character_count = secret.chars().count();
    if character_count < MIN_SECRET_LENGTH {
        return Err(format!(
            "JWT_SECRET must contain at least {MIN_SECRET_LENGTH} Unicode characters"
        ));
    }
    let decoded = STANDARD
        .decode(secret)
        .or_else(|_| URL_SAFE.decode(secret))
        .or_else(|_| URL_SAFE_NO_PAD.decode(secret))
        .map_err(|_| "JWT_SECRET must be Base64 or Base64URL encoded".to_string())?;
    if decoded.len() < 32 {
        return Err("JWT_SECRET must encode at least 32 random bytes".to_string());
    }
    let entropy = calculate_entropy(&decoded);
    if entropy < MIN_ENTROPY_BITS {
        return Err(format!(
            "JWT_SECRET has {entropy:.1} bits of estimated diversity; at least {MIN_ENTROPY_BITS:.0} bits are required"
        ));
    }
    if has_obvious_sequence(secret.as_bytes()) || has_obvious_sequence(&decoded) {
        return Err("JWT_SECRET contains an obvious sequential pattern".to_string());
    }
    Ok(())
}

fn has_obvious_sequence(decoded: &[u8]) -> bool {
    decoded.windows(4).any(|window| {
        window.windows(2).all(|pair| pair[1] == pair[0] + 1)
            || window.windows(2).all(|pair| pair[0] == pair[1] + 1)
    })
}

#[derive(Clone)]
pub struct JwtConfig {
    pub secret: String,
    pub audience: String,
    pub issuer: String,
    pub enabled: bool,
}

impl JwtConfig {
    pub fn from_env() -> Result<Self, String> {
        let secret = std::env::var("JWT_SECRET").unwrap_or_default();
        let allow_insecure = std::env::var("ALLOW_INSECURE_NO_AUTH")
            .map(|value| parse_insecure_flag(&value))
            .unwrap_or(false);
        let audience =
            std::env::var("JWT_AUDIENCE").unwrap_or_else(|_| "OpenWatchParty".to_string());
        let issuer = std::env::var("JWT_ISSUER").unwrap_or_else(|_| "Jellyfin".to_string());
        let mode = auth_mode()?;
        if mode == AuthMode::Asymmetric {
            let path = std::env::var("JWT_TRUST_STORE_PATH")
                .map_err(|_| "JWT_TRUST_STORE_PATH is required in asymmetric mode".to_string())?;
            crate::trust::TrustStore::load(std::path::Path::new(&path))?;
            return Ok(Self {
                secret: String::new(),
                audience,
                issuer,
                enabled: true,
            });
        }
        let config = Self::from_values(secret, allow_insecure, audience, issuer)?;
        if mode == AuthMode::Hybrid {
            let path = std::env::var("JWT_TRUST_STORE_PATH")
                .map_err(|_| "JWT_TRUST_STORE_PATH is required in hybrid mode".to_string())?;
            crate::trust::TrustStore::load(std::path::Path::new(&path))?;
        }
        Ok(config)
    }

    fn from_values(
        mut secret: String,
        allow_insecure: bool,
        audience: String,
        issuer: String,
    ) -> Result<Self, String> {
        if secret.trim().is_empty() {
            secret.clear();
        }
        let enabled = !secret.is_empty();

        if !enabled {
            if !allow_insecure {
                return Err(
                    "JWT_SECRET is required unless ALLOW_INSECURE_NO_AUTH=true is explicitly set"
                        .to_string(),
                );
            }
            log_insecure_mode_warning();
        } else {
            validate_secret_quality(&secret)?;
        }

        Ok(Self {
            secret,
            audience,
            issuer,
            enabled,
        })
    }

    pub fn validate_token(&self, token: &str) -> Result<Claims, String> {
        if !self.enabled {
            return Ok(Claims {
                sub: "anonymous".to_string(),
                name: "Anonymous".to_string(),
                aud: self.audience.clone(),
                iss: self.issuer.clone(),
                exp: 0,
                iat: 0,
            });
        }

        let header =
            decode_header(token).map_err(|error| format!("Invalid token header: {error}"))?;
        // The trust store is only consulted for RS256 tokens, so an HS256-only
        // deployment does not need JWT_TRUST_STORE_PATH to be set.
        let trust_store = if header.alg == Algorithm::RS256 {
            Some(std::path::PathBuf::from(trust_store_path()?))
        } else {
            None
        };
        self.validate_header(token, &header, auth_mode()?, trust_store.as_deref())
    }

    fn validate_header(
        &self,
        token: &str,
        header: &Header,
        mode: AuthMode,
        trust_store_path: Option<&Path>,
    ) -> Result<Claims, String> {
        if header.alg == Algorithm::RS256 {
            if mode == AuthMode::Hs256 {
                return Err("RS256 token rejected in hs256 mode".to_string());
            }
            let kid = header
                .kid
                .as_deref()
                .ok_or_else(|| "RS256 token has no kid".to_string())?;
            let path = trust_store_path
                .ok_or_else(|| "JWT_TRUST_STORE_PATH is not configured".to_string())?;
            return self.validate_rs256_with_path(token, kid, path);
        }
        if header.alg != Algorithm::HS256 {
            return Err("Unsupported JWT algorithm".to_string());
        }
        if mode == AuthMode::Asymmetric {
            return Err("HS256 token rejected in asymmetric mode".to_string());
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[&self.audience]);
        validation.set_issuer(&[&self.issuer]);
        validation.validate_exp = true;
        validation.leeway = JWT_EXPIRATION_LEEWAY_SECONDS;

        match decode::<Claims>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        ) {
            Ok(token_data) => {
                let now_seconds = (crate::utils::now_ms() / 1000) as usize;
                if token_data.claims.exp <= now_seconds {
                    Err("Invalid token: token has expired".to_string())
                } else {
                    Ok(token_data.claims)
                }
            }
            Err(e) => Err(format!("Invalid token: {e}")),
        }
    }

    fn validate_rs256_with_path(
        &self,
        token: &str,
        kid: &str,
        path: &std::path::Path,
    ) -> Result<Claims, String> {
        // Parsed once per store revision: rotation and revocation are picked up
        // without re-reading and re-parsing the file for every token.
        let store = crate::trust::TrustStore::load_cached(path)?;
        let key = store.active_key(kid)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&key.audience]);
        validation.set_issuer(&[&key.issuer]);
        validation.leeway = JWT_EXPIRATION_LEEWAY_SECONDS;
        let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|error| format!("invalid trusted RSA key: {error}"))?;
        let claims = decode::<Claims>(token, &decoding_key, &validation)
            .map_err(|error| format!("Invalid token: {error}"))?
            .claims;
        let now = (crate::utils::now_ms() / 1000) as usize;
        if claims.exp <= now
            || claims.iat > now.saturating_add(30)
            || claims.exp.saturating_sub(claims.iat) > 86_400
        {
            return Err("Invalid token lifetime".to_string());
        }
        Ok(claims)
    }
}

/// Reads `JWT_AUTH_MODE` once: the process environment cannot change while the
/// server runs, and this sits on the per-token validation path.
fn auth_mode() -> Result<AuthMode, String> {
    static MODE: OnceLock<Result<AuthMode, String>> = OnceLock::new();
    MODE.get_or_init(|| {
        parse_auth_mode(
            &std::env::var("JWT_AUTH_MODE")
                .unwrap_or_else(|_| "hs256".to_string())
                .to_ascii_lowercase(),
        )
    })
    .clone()
}

/// Reads `JWT_TRUST_STORE_PATH` once for the same reason.
fn trust_store_path() -> Result<String, String> {
    static PATH: OnceLock<Result<String, String>> = OnceLock::new();
    PATH.get_or_init(|| {
        std::env::var("JWT_TRUST_STORE_PATH")
            .map_err(|_| "JWT_TRUST_STORE_PATH is not configured".to_string())
    })
    .clone()
}

fn parse_auth_mode(value: &str) -> Result<AuthMode, String> {
    match value {
        "hs256" => Ok(AuthMode::Hs256),
        "hybrid" => Ok(AuthMode::Hybrid),
        "asymmetric" => Ok(AuthMode::Asymmetric),
        value => Err(format!("unsupported JWT_AUTH_MODE: {value}")),
    }
}

fn parse_insecure_flag(value: &str) -> bool {
    value.eq_ignore_ascii_case("true") || value == "1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entropy_empty_string() {
        assert_eq!(calculate_entropy(b""), 0.0);
    }

    #[test]
    fn test_entropy_single_char() {
        let entropy = calculate_entropy(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(
            entropy < 1.0,
            "Repeated single char should have near-zero entropy"
        );
    }

    #[test]
    fn test_entropy_two_chars() {
        let entropy = calculate_entropy(b"abababababababababababababababab");
        assert!(
            entropy > 10.0 && entropy < 40.0,
            "Two char alternating should have low entropy: {entropy}"
        );
    }

    #[test]
    fn test_entropy_random_looking() {
        let entropy = calculate_entropy(b"aB3$xY9!pQ2@wE5#rT8^uI1&oP4*");
        assert!(
            entropy > MIN_ENTROPY_BITS,
            "Random-looking string should have high entropy: {entropy}"
        );
    }

    #[test]
    fn test_entropy_uuid() {
        let entropy = calculate_entropy(b"550e8400e29b41d4a716446655440000");
        assert!(
            entropy > 60.0,
            "UUID should have reasonable entropy: {entropy}"
        );
    }

    #[test]
    fn test_entropy_weak_password() {
        let entropy = calculate_entropy(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb");
        assert!(
            entropy < MIN_ENTROPY_BITS,
            "Weak pattern should have low entropy: {entropy}"
        );
    }

    #[test]
    fn test_jwt_config_rejects_implicit_disabled_auth() {
        let result =
            JwtConfig::from_values(String::new(), false, "test".to_string(), "test".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_jwt_config_allows_explicit_insecure_mode() {
        let config =
            JwtConfig::from_values(String::new(), true, "test".to_string(), "test".to_string())
                .unwrap();
        assert!(!config.enabled);
    }

    #[test]
    fn test_jwt_config_enables_auth_when_secret_is_set() {
        let config = JwtConfig::from_values(
            "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=".to_string(),
            false,
            "audience".to_string(),
            "issuer".to_string(),
        )
        .unwrap();
        assert!(config.enabled);
        assert_eq!(config.audience, "audience");
        assert_eq!(config.issuer, "issuer");
    }

    #[test]
    fn test_jwt_config_rejects_short_secret() {
        let result = JwtConfig::from_values(
            "short-but-varied-123!".to_string(),
            false,
            "test".to_string(),
            "test".to_string(),
        );
        assert!(result.err().unwrap().contains("at least 32"));
    }

    #[test]
    fn test_jwt_config_rejects_low_entropy_secret() {
        let result = JwtConfig::from_values(
            "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=".to_string(),
            false,
            "test".to_string(),
            "test".to_string(),
        );
        assert!(result.err().unwrap().contains("diversity"));
    }

    #[test]
    fn test_jwt_config_accepts_strong_base64url_secret() {
        let secret = "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow";
        let config = JwtConfig::from_values(
            secret.to_string(),
            false,
            "test".to_string(),
            "test".to_string(),
        )
        .unwrap();
        assert_eq!(config.secret, secret);
    }

    #[test]
    fn test_jwt_config_rejects_predictable_high_diversity_secret() {
        for secret in [
            "abcdefghijklmnopqrstuvwxyzABCDEF",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr",
            "your-32-character-secret-key-here",
            "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
            "B0vL    hmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=",
        ] {
            let result = JwtConfig::from_values(
                secret.to_string(),
                false,
                "test".to_string(),
                "test".to_string(),
            );
            assert!(result.is_err(), "predictable secret was accepted: {secret}");
        }
    }

    #[test]
    fn test_jwt_config_rejects_surrounding_whitespace() {
        let result = JwtConfig::from_values(
            " B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=".to_string(),
            false,
            "test".to_string(),
            "test".to_string(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_jwt_config_accepts_standard_and_url_safe_alphabets() {
        for secret in [
            "98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ=",
            "98WPRKE6UmMf3yz96_mQPgkiEnDw4mIo1BPYNUA45rQ",
        ] {
            assert!(JwtConfig::from_values(
                secret.to_string(),
                false,
                "test".to_string(),
                "test".to_string(),
            )
            .is_ok());
        }
    }

    #[test]
    fn test_jwt_config_rejects_unpadded_standard_and_mixed_alphabets() {
        for secret in [
            "98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ",
            "d1wVY4zF4kyG84jG/NshZg0ypQTurZv-7+jzya6ZF70=",
        ] {
            assert!(JwtConfig::from_values(
                secret.to_string(),
                false,
                "test".to_string(),
                "test".to_string(),
            )
            .is_err());
        }
    }

    #[test]
    fn test_jwt_config_rejects_whitespace_only_secret() {
        let result = JwtConfig::from_values(
            "   \t".to_string(),
            false,
            "test".to_string(),
            "test".to_string(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_insecure_flag_requires_an_explicit_true_value() {
        assert!(parse_insecure_flag("true"));
        assert!(parse_insecure_flag("TRUE"));
        assert!(parse_insecure_flag("1"));
        assert!(!parse_insecure_flag("false"));
        assert!(!parse_insecure_flag("yes"));
        assert!(!parse_insecure_flag(" true "));
        assert!(!parse_insecure_flag(""));
    }

    #[test]
    fn unknown_auth_mode_is_rejected() {
        assert_eq!(parse_auth_mode("hybrid").unwrap(), AuthMode::Hybrid);
        assert!(parse_auth_mode("asymetric").is_err());
    }

    #[test]
    fn test_jwt_validate_when_disabled() {
        let config = JwtConfig {
            secret: String::new(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: false,
        };
        let result = config.validate_token("any-token");
        assert!(result.is_ok(), "Should succeed when auth disabled");
        let claims = result.unwrap();
        assert_eq!(claims.name, "Anonymous");
    }

    #[test]
    fn test_jwt_validate_invalid_token() {
        let config = JwtConfig {
            secret: "test-secret-with-at-least-32-characters-here".to_string(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: true,
        };
        let result = config.validate_token("invalid-token");
        assert!(result.is_err(), "Should fail for invalid token");
    }

    #[test]
    fn test_jwt_rejects_token_at_exact_expiration_second() {
        use jsonwebtoken::{encode, EncodingKey, Header};

        let config = JwtConfig {
            secret: "test-secret".to_string(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: true,
        };
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = encode(
            &Header::default(),
            &Claims {
                sub: "user".to_string(),
                name: "User".to_string(),
                aud: "test".to_string(),
                iss: "test".to_string(),
                exp: now,
                iat: now.saturating_sub(1),
            },
            &EncodingKey::from_secret(config.secret.as_bytes()),
        )
        .unwrap();

        assert!(config.validate_token(&token).is_err());
    }

    // --- RS256 / trust store ------------------------------------------------

    // RSA-3072 fixture generated for these tests only. It is never used by the
    // server; it keeps the asymmetric path covered without adding a key
    // generation dependency back to the build.
    const TEST_RSA_PEM: &str = "-----BEGIN PRIVATE KEY-----
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
ghwPqeM2CO//6dCav8vYSdem
-----END PRIVATE KEY-----";

    const TEST_RSA_MODULUS: &str = "rMkMIxVgwNFH1iP8czfyW0_n9YMI9P1q7A0oHD-NtU2lx8bK3VfQA_NWu9Cp9YwC0qOH9AHdKm7DzTWi9h80tYDdd-VUcdtfuV4qjR_ZSx7eX2WRSy-n8ySrMzktQjw2TIO3ZHKy1zK4P0cFc-1ttWSofQEJzptFYgLfbjHycjdErsC4jnPsjkwt7bjLDsms_VT0YLzwCAwXTNMOcU59PKVfWBDc6wqbFjE1iZsZ0uKowvcrGrLM2aiUyGy_isr33alCOwUtYEuApjJnLkg_Jpf2a5hqcDcFZ0CNUSRs9IhG1KGl381PBd4lT0ltxteYVQjXD8pqug2WeW0S31fhiPQV52oJe65--9bH8bGTyjuw5c8Yzx3lLfKzhv20r-jMsJwjEfv4lYHPXQyEbyZ_BxJpkfKUu3t33hShqlzFPKO_sj8i38UjfeG7MmyDNhH0y5aueFV2nYYGFzm2a7PCYg0gSLx4T-zNZi935r39w0IyWNhyaeqbZnS8O2AYPkhp";
    const TEST_KID: &str = "test-key-3072";
    const TEST_ISSUER: &str = "Jellyfin";
    const TEST_AUDIENCE: &str = "OpenWatchParty";

    fn unique_temp_dir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let counter = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "owp-auth-{}-{}-{counter}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_trust_store(
        dir: &Path,
        status: &str,
        issuer: &str,
        audience: &str,
        modulus: &str,
    ) -> std::path::PathBuf {
        let path = dir.join("trust.json");
        let contents = format!(
            r#"{{"version":1,"keys":[{{"kid":"{TEST_KID}","issuer":"{issuer}","audience":"{audience}","n":"{modulus}","e":"AQAB","status":"{status}"}}]}}"#
        );
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn rotate_trust_store(path: &Path, contents: &str) {
        let next = path.with_extension("next");
        std::fs::write(&next, contents).unwrap();
        std::fs::rename(&next, path).unwrap();
    }

    fn sign_rs256(kid: Option<&str>, exp: usize, iat: usize) -> String {
        use jsonwebtoken::{encode, EncodingKey};
        let mut header = Header::new(Algorithm::RS256);
        header.kid = kid.map(str::to_string);
        encode(
            &header,
            &Claims {
                sub: "user-1".to_string(),
                name: "Alice".to_string(),
                aud: TEST_AUDIENCE.to_string(),
                iss: TEST_ISSUER.to_string(),
                exp,
                iat,
            },
            &EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    /// Signs a token with explicit claims, for the audience/issuer cases.
    fn sign_rs256_claims(audience: &str, issuer: &str) -> String {
        use jsonwebtoken::{encode, EncodingKey};
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(TEST_KID.to_string());
        let now = (crate::utils::now_ms() / 1000) as usize;
        encode(
            &header,
            &Claims {
                sub: "user-1".to_string(),
                name: "Alice".to_string(),
                aud: audience.to_string(),
                iss: issuer.to_string(),
                exp: now + 600,
                iat: now,
            },
            &EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    fn validate_rs256_token(token: &str, path: &Path) -> Result<Claims, String> {
        let config = JwtConfig {
            secret: "unused-in-asymmetric-mode".to_string(),
            audience: TEST_AUDIENCE.to_string(),
            issuer: TEST_ISSUER.to_string(),
            enabled: true,
        };
        let header = decode_header(token).unwrap();
        config.validate_header(token, &header, AuthMode::Asymmetric, Some(path))
    }

    #[test]
    fn rs256_token_signed_by_a_trusted_key_is_accepted() {
        let dir = unique_temp_dir();
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, TEST_RSA_MODULUS);
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = sign_rs256(Some(TEST_KID), now + 600, now);

        let claims = validate_rs256_token(&token, &path).expect("trusted RS256 token must verify");
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.name, "Alice");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs256_rejects_revoked_unknown_and_unidentified_keys() {
        let dir = unique_temp_dir();
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = sign_rs256(Some(TEST_KID), now + 600, now);

        let revoked = write_trust_store(
            &dir,
            "revoked",
            TEST_ISSUER,
            TEST_AUDIENCE,
            TEST_RSA_MODULUS,
        );
        assert!(validate_rs256_token(&token, &revoked).is_err());

        let retiring = write_trust_store(
            &dir,
            "retiring",
            TEST_ISSUER,
            TEST_AUDIENCE,
            TEST_RSA_MODULUS,
        );
        assert!(
            validate_rs256_token(&token, &retiring).is_ok(),
            "retiring keys must keep verifying existing tokens"
        );

        let unknown = sign_rs256(Some("some-other-key"), now + 600, now);
        assert!(validate_rs256_token(&unknown, &retiring).is_err());

        let without_kid = sign_rs256(None, now + 600, now);
        let error = validate_rs256_token(&without_kid, &retiring).unwrap_err();
        assert!(error.contains("no kid"), "unexpected error: {error}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs256_enforces_the_key_audience_and_issuer() {
        let dir = unique_temp_dir();
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, TEST_RSA_MODULUS);

        assert!(
            validate_rs256_token(&sign_rs256_claims("OtherAudience", TEST_ISSUER), &path).is_err()
        );
        assert!(
            validate_rs256_token(&sign_rs256_claims(TEST_AUDIENCE, "OtherIssuer"), &path).is_err()
        );
        assert!(
            validate_rs256_token(&sign_rs256_claims(TEST_AUDIENCE, TEST_ISSUER), &path).is_ok()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs256_enforces_the_token_lifetime() {
        let dir = unique_temp_dir();
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, TEST_RSA_MODULUS);
        let now = (crate::utils::now_ms() / 1000) as usize;

        assert!(
            validate_rs256_token(
                &sign_rs256(
                    Some(TEST_KID),
                    now.saturating_sub(1),
                    now.saturating_sub(60)
                ),
                &path
            )
            .is_err(),
            "expired tokens must be rejected"
        );

        let future_iat =
            validate_rs256_token(&sign_rs256(Some(TEST_KID), now + 3600, now + 120), &path)
                .unwrap_err();
        assert!(
            future_iat.contains("lifetime"),
            "unexpected error: {future_iat}"
        );

        let too_long = validate_rs256_token(&sign_rs256(Some(TEST_KID), now + 90_000, now), &path)
            .unwrap_err();
        assert!(
            too_long.contains("lifetime"),
            "unexpected error: {too_long}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs256_rejects_a_modulus_below_3072_bits() {
        let dir = unique_temp_dir();
        let short_modulus = URL_SAFE_NO_PAD.encode([7u8; 64]);
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, &short_modulus);
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = sign_rs256(Some(TEST_KID), now + 600, now);

        let error = validate_rs256_token(&token, &path).unwrap_err();
        assert!(error.contains("3072"), "unexpected error: {error}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn algorithm_and_mode_mismatches_are_rejected() {
        let dir = unique_temp_dir();
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, TEST_RSA_MODULUS);
        let now = (crate::utils::now_ms() / 1000) as usize;
        let rs256 = sign_rs256(Some(TEST_KID), now + 600, now);
        let config = JwtConfig {
            secret: "unused".to_string(),
            audience: TEST_AUDIENCE.to_string(),
            issuer: TEST_ISSUER.to_string(),
            enabled: true,
        };

        let error = config
            .validate_header(
                &rs256,
                &decode_header(&rs256).unwrap(),
                AuthMode::Hs256,
                Some(&path),
            )
            .unwrap_err();
        assert!(error.contains("hs256 mode"), "unexpected error: {error}");

        use jsonwebtoken::{encode, EncodingKey};
        let hs256 = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                sub: "user-1".to_string(),
                name: "Alice".to_string(),
                aud: TEST_AUDIENCE.to_string(),
                iss: TEST_ISSUER.to_string(),
                exp: now + 600,
                iat: now,
            },
            &EncodingKey::from_secret(b"a-shared-secret-for-tests-only!!"),
        )
        .unwrap();
        let error = config
            .validate_header(
                &hs256,
                &decode_header(&hs256).unwrap(),
                AuthMode::Asymmetric,
                Some(&path),
            )
            .unwrap_err();
        assert!(
            error.contains("asymmetric mode"),
            "unexpected error: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rs256_revocation_is_visible_without_a_restart() {
        let dir = unique_temp_dir();
        let path = write_trust_store(&dir, "active", TEST_ISSUER, TEST_AUDIENCE, TEST_RSA_MODULUS);
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = sign_rs256(Some(TEST_KID), now + 600, now);

        assert!(validate_rs256_token(&token, &path).is_ok());

        rotate_trust_store(
            &path,
            &format!(
                r#"{{"version":1,"keys":[{{"kid":"{TEST_KID}","issuer":"{TEST_ISSUER}","audience":"{TEST_AUDIENCE}","n":"{TEST_RSA_MODULUS}","e":"AQAB","status":"revoked"}}]}}"#
            ),
        );

        let error = validate_rs256_token(&token, &path).unwrap_err();
        assert!(
            error.contains("revoked") || error.contains("unknown"),
            "revocation must be visible immediately, got: {error}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
