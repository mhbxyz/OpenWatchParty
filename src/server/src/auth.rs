use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

fn calculate_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut freq: HashMap<char, usize> = HashMap::new();
    for c in s.chars() {
        *freq.entry(c).or_insert(0) += 1;
    }
    let len = s.len() as f64;
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

fn validate_secret_quality(secret: &str) {
    if secret.len() < 32 {
        log::warn!(
            "JWT_SECRET is too short. Use at least 32 characters for secure authentication."
        );
    }
    let entropy = calculate_entropy(secret);
    if entropy < MIN_ENTROPY_BITS {
        log::warn!(
            "JWT_SECRET has low entropy ({:.1} bits, minimum recommended: {:.0} bits). \
             Use a cryptographically random secret for secure authentication.",
            entropy,
            MIN_ENTROPY_BITS
        );
    }
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
        Self::from_values(
            secret,
            allow_insecure,
            std::env::var("JWT_AUDIENCE").unwrap_or_else(|_| "OpenWatchParty".to_string()),
            std::env::var("JWT_ISSUER").unwrap_or_else(|_| "Jellyfin".to_string()),
        )
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
            validate_secret_quality(&secret);
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

        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[&self.audience]);
        validation.set_issuer(&[&self.issuer]);
        validation.validate_exp = true;
        validation.leeway = 60;

        match decode::<Claims>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        ) {
            Ok(token_data) => Ok(token_data.claims),
            Err(e) => Err(format!("Invalid token: {}", e)),
        }
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
        assert_eq!(calculate_entropy(""), 0.0);
    }

    #[test]
    fn test_entropy_single_char() {
        let entropy = calculate_entropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(
            entropy < 1.0,
            "Repeated single char should have near-zero entropy"
        );
    }

    #[test]
    fn test_entropy_two_chars() {
        let entropy = calculate_entropy("abababababababababababababababab");
        assert!(
            entropy > 10.0 && entropy < 40.0,
            "Two char alternating should have low entropy: {}",
            entropy
        );
    }

    #[test]
    fn test_entropy_random_looking() {
        let entropy = calculate_entropy("aB3$xY9!pQ2@wE5#rT8^uI1&oP4*");
        assert!(
            entropy > MIN_ENTROPY_BITS,
            "Random-looking string should have high entropy: {}",
            entropy
        );
    }

    #[test]
    fn test_entropy_uuid() {
        let entropy = calculate_entropy("550e8400e29b41d4a716446655440000");
        assert!(
            entropy > 60.0,
            "UUID should have reasonable entropy: {}",
            entropy
        );
    }

    #[test]
    fn test_entropy_weak_password() {
        let entropy = calculate_entropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb");
        assert!(
            entropy < MIN_ENTROPY_BITS,
            "Weak pattern should have low entropy: {}",
            entropy
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
            "test-secret-with-at-least-32-characters".to_string(),
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
}
