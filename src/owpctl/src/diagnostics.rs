use std::{
    path::Path,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tungstenite::{client::IntoClientRequest, Message};

use crate::{
    config::DesiredConfig,
    jellyfin::{JellyfinClient, OpenWatchPartyToken, PluginInfo, PublicSystemInfo},
    paths::Paths,
    state::InstallationState,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Warning,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCheck {
    pub id: &'static str,
    pub status: CheckStatus,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticReport {
    pub overall: CheckStatus,
    pub installed_version: Option<String>,
    pub checks: Vec<DiagnosticCheck>,
}

impl DiagnosticReport {
    pub fn add_warning(&mut self, id: &'static str, summary: impl Into<String>) {
        self.checks.push(warning(id, summary));
        self.overall = overall_status(&self.checks);
    }
}

pub fn load(paths: &Paths) -> anyhow::Result<(Option<DesiredConfig>, Option<InstallationState>)> {
    let config = paths
        .config_file
        .exists()
        .then(|| crate::storage::read_toml(&paths.config_file))
        .transpose()?;
    let state = paths
        .state_file
        .exists()
        .then(|| crate::storage::read_json(&paths.state_file))
        .transpose()?;
    Ok((config, state))
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct SessionHealth {
    status: String,
    auth_enabled: bool,
    version: String,
    protocol_version: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WebSocketMeasurement {
    rtt_ms: u64,
    offset_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WebSocketFailure {
    Http(u16),
    ServerError { code: String, message: String },
    Timeout,
    Connection(String),
    Exchange(String),
}

pub fn run(
    config: Option<&DesiredConfig>,
    state: Option<&InstallationState>,
    api_token_file: Option<&Path>,
) -> DiagnosticReport {
    let mut checks = vec![
        command_check("docker", &["version", "--format", "{{.Server.Version}}"]),
        command_check("compose", &["compose", "version"]),
    ];
    if let Some(config) = config {
        let public_info = match JellyfinClient::new(config.jellyfin.base_url.clone())
            .and_then(|client| client.public_info())
        {
            Ok(info) => {
                checks.push(pass(
                    "jellyfin",
                    format!("Jellyfin {} ({})", info.version, info.server_name),
                ));
                Some(info)
            }
            Err(error) => {
                checks.push(fail("jellyfin", error.to_string()));
                None
            }
        };
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build();
        let health = match &client {
            Ok(client) => match fetch_text(
                client,
                endpoint_url(&config.session_server.public_websocket_url, "health"),
            ) {
                Ok((status, body)) => {
                    let (check, health) = health_check(status, &body);
                    checks.push(check);
                    health
                }
                Err(error) => {
                    checks.push(fail("session_server", error.to_string()));
                    None
                }
            },
            Err(error) => {
                checks.push(fail("session_server", error.to_string()));
                None
            }
        };
        match &client {
            Ok(client) => match fetch_text(
                client,
                endpoint_url(&config.session_server.public_websocket_url, "ready"),
            ) {
                Ok((status, body)) => checks.push(ready_check(status, &body)),
                Err(error) => checks.push(fail("session_ready", error.to_string())),
            },
            Err(error) => checks.push(fail("session_ready", error.to_string())),
        }

        let deep = api_token_file.map(|path| {
            JellyfinClient::token_from_file(path)
                .and_then(|token| {
                    JellyfinClient::new(config.jellyfin.base_url.clone())
                        .map(|client| client.with_token(token))
                })
                .and_then(|client| Ok((client.plugin_info()?, client.openwatchparty_token()?)))
        });
        match deep {
            Some(Ok((plugin_info, token))) => {
                checks.push(pass(
                    "plugin",
                    format!("OpenWatchParty {}", plugin_info.version),
                ));
                if let (Some(jellyfin), Some(health)) = (&public_info, &health) {
                    checks.push(versions_check(jellyfin, &plugin_info, health));
                }
                if let Some(health) = &health {
                    checks.push(authentication_check(
                        health.auth_enabled,
                        token.auth_enabled,
                    ));
                }
                checks.push(mixed_content_check(
                    &config.jellyfin.public_origin,
                    &config.session_server.public_websocket_url,
                ));
                checks.extend(websocket_checks(
                    &config.jellyfin.public_origin,
                    &config.session_server.public_websocket_url,
                    &token,
                    health.is_some(),
                ));
            }
            Some(Err(error)) => {
                checks.push(fail("plugin", error.to_string()));
                checks.push(mixed_content_check(
                    &config.jellyfin.public_origin,
                    &config.session_server.public_websocket_url,
                ));
            }
            None => {
                checks.push(warning(
                    "plugin",
                    "Admin token not supplied; deep plugin checks skipped",
                ));
                checks.push(mixed_content_check(
                    &config.jellyfin.public_origin,
                    &config.session_server.public_websocket_url,
                ));
            }
        }
    } else {
        checks.push(fail("configuration", "owpctl.toml is missing"));
    }
    if let Some(check) = state.and_then(phase_check) {
        checks.push(check);
    }
    DiagnosticReport {
        overall: overall_status(&checks),
        installed_version: state.map(|state| state.installed_version.clone()),
        checks,
    }
}

fn fetch_text(client: &reqwest::blocking::Client, url: url::Url) -> anyhow::Result<(u16, String)> {
    let response = client.get(url).send()?;
    let status = response.status().as_u16();
    Ok((status, response.text()?))
}

fn health_check(status: u16, body: &str) -> (DiagnosticCheck, Option<SessionHealth>) {
    if !(200..300).contains(&status) {
        return (fail("session_server", format!("HTTP {status}")), None);
    }
    match serde_json::from_str::<SessionHealth>(body) {
        Ok(health) if health.status == "ok" => (
            pass(
                "session_server",
                format!(
                    "Session server {}, protocol {}, authentication {}",
                    health.version,
                    health.protocol_version,
                    if health.auth_enabled { "on" } else { "off" }
                ),
            ),
            Some(health),
        ),
        _ => (fail("session_server", "unexpected /health response"), None),
    }
}

fn ready_check(status: u16, body: &str) -> DiagnosticCheck {
    let reported = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value["status"].as_str().map(str::to_owned));
    match (status, reported.as_deref()) {
        (200, Some("ready")) => pass("session_ready", "Session server is ready"),
        (503, Some("shutting_down")) => {
            fail("session_ready", "the session server is shutting down")
        }
        (200, _) => fail("session_ready", "HTTP 200"),
        _ => fail("session_ready", format!("HTTP {status}")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Version(u64, u64, u64);

fn parse_version(value: &str) -> Option<Version> {
    let mut parts = value.split(['-', '+']).next()?.split('.');
    Some(Version(
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn versions_check(
    jellyfin: &PublicSystemInfo,
    plugin: &PluginInfo,
    server: &SessionHealth,
) -> DiagnosticCheck {
    if server.protocol_version != 1 {
        return fail(
            "versions",
            format!(
                "session server protocol {} is incompatible; owpctl requires protocol 1",
                server.protocol_version
            ),
        );
    }
    let Some(server_version) = parse_version(&server.version) else {
        return warning(
            "versions",
            format!(
                "could not parse one or more versions: Jellyfin {}, plugin {}, session server {}",
                jellyfin.version, plugin.version, server.version
            ),
        );
    };
    if server_version < Version(0, 7, 0) {
        return fail(
            "versions",
            "session server is affected by advisory GHSA-fjpr-3g28-27r9; upgrade the session server to 0.7.0 or newer",
        );
    }
    let Some(plugin_version) = parse_version(&plugin.version) else {
        return warning(
            "versions",
            format!(
                "could not parse one or more versions: Jellyfin {}, plugin {}, session server {}",
                jellyfin.version, plugin.version, server.version
            ),
        );
    };
    if plugin_version <= Version(0, 3, 3) {
        let required = if parse_version(&jellyfin.version).is_some_and(|version| version.0 == 12) {
            "0.4.0 or newer"
        } else if parse_version(&jellyfin.version)
            .is_some_and(|version| version.0 == 10 && version.1 == 11)
        {
            "0.3.4"
        } else {
            "plugin 0.4.0 or newer for Jellyfin 12, or plugin 0.3.4 for Jellyfin 10.11"
        };
        return fail(
            "versions",
            format!(
                "plugin {} is unsupported; install {required}",
                plugin.version
            ),
        );
    }
    let Some(jellyfin_version) = parse_version(&jellyfin.version) else {
        return warning(
            "versions",
            format!(
                "could not parse one or more versions: Jellyfin {}, plugin {}, session server {}",
                jellyfin.version, plugin.version, server.version
            ),
        );
    };
    if jellyfin_version.0 == 12 {
        if plugin_version < Version(0, 4, 0) {
            return fail(
                "versions",
                format!(
                    "Jellyfin {} requires plugin 0.4.0 or newer; install a compatible plugin",
                    jellyfin.version
                ),
            );
        }
    } else if jellyfin_version.0 == 10 && jellyfin_version.1 == 11 {
        if plugin_version != Version(0, 3, 4) {
            return fail(
                "versions",
                format!(
                    "Jellyfin {} requires plugin 0.3.4; install plugin 0.3.4",
                    jellyfin.version
                ),
            );
        }
    } else {
        return warning(
            "versions",
            format!(
                "Jellyfin {} is not in the compatibility matrix",
                jellyfin.version
            ),
        );
    }
    pass(
        "versions",
        format!(
            "Jellyfin {}, plugin {}, session server {}: compatible",
            jellyfin.version, plugin.version, server.version
        ),
    )
}

fn authentication_check(server_enabled: bool, plugin_enabled: bool) -> DiagnosticCheck {
    match (server_enabled, plugin_enabled) {
        (true, false) => fail(
            "authentication",
            "the server requires authentication but the plugin issues no token; configure the plugin's JWT secret/mode to match the server",
        ),
        (false, true) => warning(
            "authentication",
            "the server accepts unauthenticated connections (ALLOW_INSECURE_NO_AUTH); tokens are ignored",
        ),
        (true, true) => pass(
            "authentication",
            "Plugin and session server authentication are enabled",
        ),
        (false, false) => pass(
            "authentication",
            "Plugin and session server authentication are disabled",
        ),
    }
}

fn mixed_content_check(origin: &url::Url, websocket: &url::Url) -> DiagnosticCheck {
    if origin.scheme() == "https" && websocket.scheme() == "ws" {
        fail(
            "mixed_content",
            "browsers block ws:// from an https page: use wss://",
        )
    } else {
        pass(
            "mixed_content",
            "Jellyfin and WebSocket URL schemes are browser-compatible",
        )
    }
}

fn websocket_checks(
    origin: &url::Url,
    url: &url::Url,
    token: &OpenWatchPartyToken,
    reached_session_server: bool,
) -> Vec<DiagnosticCheck> {
    match websocket_measurement(origin, url, token.token.as_deref(), token.auth_enabled) {
        Ok(measurement) => vec![
            websocket_success_check(measurement.rtt_ms),
            clock_check(measurement.rtt_ms, measurement.offset_ms),
        ],
        Err(error) => vec![websocket_failure_check(
            error,
            origin,
            url,
            reached_session_server,
        )],
    }
}

fn websocket_success_check(rtt_ms: u64) -> DiagnosticCheck {
    pass(
        "websocket",
        format!("Authenticated WebSocket ping/pong succeeded (RTT {rtt_ms} ms)"),
    )
}

fn websocket_measurement(
    origin: &url::Url,
    url: &url::Url,
    token: Option<&str>,
    auth_enabled: bool,
) -> Result<WebSocketMeasurement, WebSocketFailure> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| WebSocketFailure::Connection(error.to_string()))?;
    let origin_header = origin.origin().ascii_serialization().parse().map_err(
        |error: tungstenite::http::header::InvalidHeaderValue| {
            WebSocketFailure::Connection(error.to_string())
        },
    )?;
    request.headers_mut().insert("Origin", origin_header);
    let (mut socket, _) = tungstenite::connect(request).map_err(|error| match error {
        tungstenite::Error::Http(response) => WebSocketFailure::Http(response.status().as_u16()),
        other => WebSocketFailure::Connection(other.to_string()),
    })?;
    set_socket_timeout(socket.get_mut(), Duration::from_secs(5))
        .map_err(|error| WebSocketFailure::Connection(error.to_string()))?;
    let sent_ms = unix_time_ms().map_err(WebSocketFailure::Exchange)?;
    if auth_enabled {
        let token = token
            .ok_or_else(|| WebSocketFailure::Exchange("plugin returned no JWT".to_string()))?;
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "auth",
                    "payload": { "token": token, "protocol_version": 1 },
                    "ts": sent_ms
                })
                .to_string()
                .into(),
            ))
            .map_err(exchange_error)?;
    }
    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "ping", "payload": { "client_ts": sent_ms }, "ts": sent_ms
            })
            .to_string()
            .into(),
        ))
        .map_err(exchange_error)?;
    let mut authenticated = !auth_enabled;
    for _ in 0..8 {
        let message = socket.read().map_err(exchange_error)?;
        if !message.is_text() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(
            message
                .to_text()
                .map_err(|error| WebSocketFailure::Exchange(error.to_string()))?,
        )
        .map_err(|error| WebSocketFailure::Exchange(error.to_string()))?;
        if value["type"] == "error" {
            return Err(WebSocketFailure::ServerError {
                code: value["payload"]["code"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                message: value["payload"]["message"]
                    .as_str()
                    .unwrap_or("authentication failed")
                    .to_string(),
            });
        }
        authenticated |= value["type"] == "auth_success";
        if authenticated
            && value["type"] == "pong"
            && value["payload"]["client_ts"].as_u64() == Some(sent_ms)
        {
            let received_ms = unix_time_ms().map_err(WebSocketFailure::Exchange)?;
            let server_ms = value["server_ts"].as_u64().ok_or_else(|| {
                WebSocketFailure::Exchange("pong did not include server_ts".to_string())
            })?;
            let rtt_ms = received_ms.saturating_sub(sent_ms);
            let midpoint = i128::from(sent_ms) + i128::from(rtt_ms / 2);
            let offset = i128::from(server_ms) - midpoint;
            let offset_ms = offset.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64;
            let _ = socket.close(None);
            return Ok(WebSocketMeasurement { rtt_ms, offset_ms });
        }
    }
    Err(WebSocketFailure::Timeout)
}

fn unix_time_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| error.to_string())
}

fn exchange_error(error: tungstenite::Error) -> WebSocketFailure {
    match &error {
        tungstenite::Error::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            WebSocketFailure::Timeout
        }
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            WebSocketFailure::Timeout
        }
        _ => WebSocketFailure::Exchange(error.to_string()),
    }
}

/// `reached_session_server`: whether `/health` next to the WebSocket URL answered
/// as the session server. When it did not, an HTTP answer to the upgrade comes
/// from something else at that URL.
fn websocket_failure_check(
    error: WebSocketFailure,
    origin: &url::Url,
    url: &url::Url,
    reached_session_server: bool,
) -> DiagnosticCheck {
    match error {
        WebSocketFailure::Http(status) if !reached_session_server => fail(
            "websocket",
            format!(
                "{url} answered the WebSocket upgrade with HTTP {status}, and its /health is not the session server's: check that this URL leads to the session server"
            ),
        ),
        WebSocketFailure::Http(403) => fail(
            "websocket",
            format!(
                "the session server rejected the origin {}: add it to ALLOWED_ORIGINS",
                origin.origin().ascii_serialization()
            ),
        ),
        WebSocketFailure::Http(401) => fail(
            "websocket",
            "authentication was rejected during the WebSocket upgrade",
        ),
        WebSocketFailure::Http(status) => fail(
            "websocket",
            format!(
                "the WebSocket upgrade got HTTP {status}: check that the reverse proxy forwards WebSocket upgrades (Upgrade/Connection headers) to the session server"
            ),
        ),
        WebSocketFailure::ServerError { code, message } => match code.as_str() {
            "AUTHENTICATION_FAILED" => fail(
                "websocket",
                format!(
                    "the session server rejected the plugin's token: the plugin's JWT secret or key does not match the server's ({code}: {message})"
                ),
            ),
            "AUTHENTICATION_EXPIRED" => fail(
                "websocket",
                format!(
                    "the session server found the plugin's token expired: check that the Jellyfin and session-server clocks agree ({code}: {message})"
                ),
            ),
            _ => fail(
                "websocket",
                format!("the session server answered with an error ({code}: {message})"),
            ),
        },
        WebSocketFailure::Timeout => fail(
            "websocket",
            "no reply from the session server within 5 s",
        ),
        WebSocketFailure::Connection(message) => {
            fail("websocket", format!("could not reach {url}: {message}"))
        }
        WebSocketFailure::Exchange(message) => fail(
            "websocket",
            format!("WebSocket exchange with {url} failed: {message}"),
        ),
    }
}

fn clock_check(rtt_ms: u64, offset_ms: i64) -> DiagnosticCheck {
    let summary = format!("RTT {rtt_ms} ms, clock offset {offset_ms:+} ms");
    match (rtt_ms > 1_000, offset_ms.unsigned_abs() > 2_000) {
        (false, false) => pass("clock", summary),
        (true, false) => warning("clock", format!("{summary}; high latency")),
        (false, true) => warning(
            "clock",
            format!(
                "{summary}; this machine's clock differs from the server's; clients correct for it, but check NTP"
            ),
        ),
        (true, true) => warning(
            "clock",
            format!(
                "{summary}; high latency; this machine's clock differs from the server's; clients correct for it, but check NTP"
            ),
        ),
    }
}

fn set_socket_timeout(
    stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
    timeout: Duration,
) -> std::io::Result<()> {
    match stream {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(Some(timeout))
        }
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => {
            stream.get_mut().set_read_timeout(Some(timeout))
        }
        _ => Ok(()),
    }
}

fn command_check(id: &'static str, arguments: &[&str]) -> DiagnosticCheck {
    let result = if id == "compose" {
        Command::new("docker").args(arguments).output()
    } else {
        Command::new(id).args(arguments).output()
    };
    match result {
        Ok(output) if output.status.success() => {
            pass(id, String::from_utf8_lossy(&output.stdout).trim())
        }
        Ok(output) => fail(id, String::from_utf8_lossy(&output.stderr).trim()),
        Err(error) => fail(id, error.to_string()),
    }
}

fn endpoint_url(websocket: &url::Url, endpoint: &str) -> url::Url {
    let mut url = websocket.clone();
    let _ = url.set_scheme(if websocket.scheme() == "wss" {
        "https"
    } else {
        "http"
    });
    let path = url.path().strip_suffix("/ws").unwrap_or(url.path());
    url.set_path(&format!("{path}/{endpoint}"));
    url.set_query(None);
    url.set_fragment(None);
    url
}

fn pass(id: &'static str, summary: impl Into<String>) -> DiagnosticCheck {
    DiagnosticCheck {
        id,
        status: CheckStatus::Pass,
        summary: summary.into(),
    }
}
fn warning(id: &'static str, summary: impl Into<String>) -> DiagnosticCheck {
    DiagnosticCheck {
        id,
        status: CheckStatus::Warning,
        summary: summary.into(),
    }
}
fn fail(id: &'static str, summary: impl Into<String>) -> DiagnosticCheck {
    DiagnosticCheck {
        id,
        status: CheckStatus::Fail,
        summary: summary.into(),
    }
}

fn overall_status(checks: &[DiagnosticCheck]) -> CheckStatus {
    if checks.iter().any(|check| check.status == CheckStatus::Fail) {
        CheckStatus::Fail
    } else if checks
        .iter()
        .any(|check| check.status == CheckStatus::Warning)
    {
        CheckStatus::Warning
    } else {
        CheckStatus::Pass
    }
}

fn phase_check(state: &InstallationState) -> Option<DiagnosticCheck> {
    if state.phase == "ready" {
        return None;
    }
    Some(warning(
        "installation_phase",
        format!(
            "installation state reports phase \"{}\"; the previous install did not finish, re-run `owpctl install --yes --api-token-file <file>` to resume",
            state.phase
        ),
    ))
}

pub fn fetch_plugin_report(
    config: &DesiredConfig,
    api_token_file: &Path,
) -> anyhow::Result<serde_json::Value> {
    let token = JellyfinClient::token_from_file(api_token_file)?;
    JellyfinClient::new(config.jellyfin.base_url.clone())?
        .with_token(token)
        .diagnostics_report()
}

pub fn collect_plugin_report(
    report: &mut DiagnosticReport,
    config: Option<&DesiredConfig>,
    api_token_file: Option<&Path>,
) -> Option<serde_json::Value> {
    let (Some(config), Some(api_token_file)) = (config, api_token_file) else {
        return None;
    };
    match fetch_plugin_report(config, api_token_file) {
        Ok(value) => Some(value),
        Err(error) => {
            report.add_warning(
                "plugin_report",
                format!("could not collect the plugin diagnostics report: {error}"),
            );
            None
        }
    }
}

pub fn bundle(
    report: &DiagnosticReport,
    config: Option<&DesiredConfig>,
    state: Option<&InstallationState>,
    plugin_report: Option<&serde_json::Value>,
) -> serde_json::Value {
    let redacted_state = state.map(|state| {
        let mut redacted = state.clone();
        redacted.secret_fingerprint = "<redacted>".to_string();
        redacted
    });
    serde_json::json!({
        "tool": "owpctl",
        "version": crate::VERSION,
        "report": report,
        "config": config,
        "state": redacted_state,
        "plugin_report": plugin_report,
    })
}

#[cfg(test)]
mod tests;
