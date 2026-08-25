use std::path::Path;

use crate::config::DesiredConfig;

pub fn render(config: &DesiredConfig, image: &str, secrets_file: &Path) -> String {
    let origins = config.session_server.allowed_origins.join(",");
    format!(
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
    env_file:
      - {secrets}
    environment:
      HOST: 0.0.0.0
      PORT: 3000
      LOG_LEVEL: {log_level}
      ALLOWED_ORIGINS: "{origins}"
      ALLOW_INSECURE_NO_AUTH: "false"
      JWT_AUDIENCE: {audience}
      JWT_ISSUER: {issuer}
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
        secrets = secrets_file.display(),
        log_level = config.session_server.log_level,
        audience = config.plugin.jwt_audience,
        issuer = config.plugin.jwt_issuer,
        max_connections = config.session_server.max_connections,
        max_connections_per_ip = config.session_server.max_connections_per_ip,
        auth_timeout = config.session_server.auth_timeout_seconds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compose_is_hardened_and_never_contains_secret() {
        let mut config =
            crate::config::DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap())
                .unwrap();
        config.session_server.allowed_origins = vec!["http://localhost:8096".to_string()];
        let compose = render(
            &config,
            "ghcr.io/example/image@sha256:abc",
            std::path::Path::new("/etc/openwatchparty/secrets.env"),
        );
        assert!(compose.contains("read_only: true"));
        assert!(compose.contains("cap_drop:"));
        assert!(!compose.contains("JWT_SECRET="));
    }
}
