use std::path::Path;

use anyhow::bail;

use crate::config::DesiredConfig;

/// Log levels the session server (env_logger) accepts; documented in
/// `docs/operations/configuration.md`.
pub const LOG_LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
const AUTH_MODES: [&str; 3] = ["hs256", "hybrid", "asymmetric"];
const MAX_IMAGE_LENGTH: usize = 512;

pub fn validate_log_level(log_level: &str) -> anyhow::Result<()> {
    if !LOG_LEVELS.contains(&log_level) {
        bail!(
            "session.log-level must be one of: {}",
            LOG_LEVELS.join(", ")
        );
    }
    Ok(())
}

fn validate_auth_mode(auth_mode: &str) -> anyhow::Result<()> {
    if !AUTH_MODES.contains(&auth_mode) {
        bail!(
            "session.auth-mode must be one of: {}",
            AUTH_MODES.join(", ")
        );
    }
    Ok(())
}

fn validate_image(image: &str) -> anyhow::Result<()> {
    if image.is_empty() || image.len() > MAX_IMAGE_LENGTH {
        bail!("image reference must be between 1 and {MAX_IMAGE_LENGTH} characters");
    }
    if !image.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/' | ':' | '@')
    }) {
        bail!("image reference contains characters that are not allowed in the Compose file");
    }
    Ok(())
}

/// Rejects values that could break out of the YAML scalar they are rendered into.
fn validate_yaml_value(option: &str, value: &str) -> anyhow::Result<()> {
    if value.contains('\n') || value.contains('\r') || value.contains('"') {
        bail!("{option} contains characters that are not allowed in the Compose file");
    }
    Ok(())
}

pub fn render(
    config: &DesiredConfig,
    image: &str,
    secrets_file: &Path,
    trust_store: &Path,
) -> anyhow::Result<String> {
    validate_image(image)?;
    validate_log_level(&config.session_server.log_level)?;
    validate_auth_mode(&config.session_server.auth_mode)?;

    let origins = config.session_server.allowed_origins.join(",");
    validate_yaml_value("session.allowed-origins", &origins)?;
    validate_yaml_value("plugin.jwt-audience", &config.plugin.jwt_audience)?;
    validate_yaml_value("plugin.jwt-issuer", &config.plugin.jwt_issuer)?;
    validate_yaml_value(
        "session.bind-address",
        &config.session_server.bind_address.to_string(),
    )?;

    let trust_directory = trust_store
        .parent()
        .unwrap_or(trust_store)
        .display()
        .to_string();
    validate_yaml_value("trust store directory", &trust_directory)?;

    let secret_environment = if config.session_server.auth_mode == "asymmetric" {
        String::new()
    } else {
        let secrets_path = secrets_file.display().to_string();
        validate_yaml_value("secrets file path", &secrets_path)?;
        format!("    env_file:\n      - {secrets_path}\n")
    };
    Ok(format!(
        r#"services:
  session-server:
    image: {image}
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - "{bind}:{published}:3000"
{secret_environment}    volumes:
      - {trust_directory}:/var/lib/openwatchparty:ro
    environment:
      HOST: 0.0.0.0
      PORT: 3000
      LOG_LEVEL: {log_level}
      ALLOWED_ORIGINS: "{origins}"
      ALLOW_INSECURE_NO_AUTH: "false"
      JWT_AUDIENCE: {audience}
      JWT_ISSUER: {issuer}
      JWT_AUTH_MODE: {auth_mode}
      JWT_TRUST_STORE_PATH: /var/lib/openwatchparty/trust-store.json
      MAX_CONNECTIONS: "{max_connections}"
      MAX_CONNECTIONS_PER_IP: "{max_connections_per_ip}"
      AUTH_TIMEOUT_SECONDS: "{auth_timeout}"
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
    labels:
      org.openwatchparty.managed-by: owpctl
"#,
        bind = config.session_server.bind_address,
        published = config.session_server.published_port,
        auth_mode = config.session_server.auth_mode,
        log_level = config.session_server.log_level,
        audience = config.plugin.jwt_audience,
        issuer = config.plugin.jwt_issuer,
        max_connections = config.session_server.max_connections,
        max_connections_per_ip = config.session_server.max_connections_per_ip,
        auth_timeout = config.session_server.auth_timeout_seconds,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> DesiredConfig {
        let mut config =
            crate::config::DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap())
                .unwrap();
        config.session_server.allowed_origins = vec!["http://localhost:8096".to_string()];
        config
    }

    fn render_with(config: &DesiredConfig, image: &str) -> anyhow::Result<String> {
        render(
            config,
            image,
            std::path::Path::new("/etc/openwatchparty/secrets.env"),
            std::path::Path::new("/var/lib/openwatchparty/trust-store.json"),
        )
    }

    #[test]
    fn compose_is_hardened_and_never_contains_secret() {
        let compose = render_with(&base_config(), "ghcr.io/example/image@sha256:abc").unwrap();
        assert!(compose.contains("read_only: true"));
        assert!(compose.contains("cap_drop:"));
        assert!(compose.contains("/var/lib/openwatchparty:ro"));
        assert!(!compose.contains("trust-store.json:/var/lib"));
        assert!(!compose.contains("JWT_SECRET="));
    }

    #[test]
    fn accepted_values_are_rendered() {
        let mut config = base_config();
        config.session_server.log_level = "debug".to_string();
        config.session_server.auth_mode = "asymmetric".to_string();
        let compose = render_with(&config, "ghcr.io/mhbxyz/owp-session-server:0.3.3").unwrap();
        assert!(compose.contains("LOG_LEVEL: debug"));
        assert!(compose.contains("JWT_AUTH_MODE: asymmetric"));
    }

    #[test]
    fn unsupported_log_level_is_rejected() {
        let mut config = base_config();
        config.session_server.log_level = "verbose".to_string();
        let error = render_with(&config, "ghcr.io/mhbxyz/owp-session-server:0.3.3").unwrap_err();
        assert!(error.to_string().contains("session.log-level"));
    }

    #[test]
    fn newline_injection_is_rejected() {
        let mut config = base_config();
        config.session_server.log_level = "info\n      PRIVILEGED: \"true\"".to_string();
        assert!(render_with(&config, "ghcr.io/mhbxyz/owp-session-server:0.3.3").is_err());

        let mut config = base_config();
        config.plugin.jwt_audience = "OpenWatchParty\"\n      EXTRA: x".to_string();
        let error = render_with(&config, "ghcr.io/mhbxyz/owp-session-server:0.3.3").unwrap_err();
        assert!(error.to_string().contains("plugin.jwt-audience"));
    }

    #[test]
    fn injected_image_reference_is_rejected() {
        let mut config = base_config();
        config.session_server.auth_mode = "asymmetric".to_string();
        let error = render_with(&config, "ghcr.io/x\n      privileged: true").unwrap_err();
        assert!(error.to_string().contains("image reference"));
    }
}
