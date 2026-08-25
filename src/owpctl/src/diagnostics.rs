use std::{path::Path, process::Command, time::Duration};

use serde::Serialize;

use crate::{config::DesiredConfig, jellyfin::JellyfinClient, state::InstallationState};

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

pub fn run(
    config: Option<&DesiredConfig>,
    state: Option<&InstallationState>,
    api_token_file: Option<&Path>,
) -> DiagnosticReport {
    let mut checks = Vec::new();
    checks.push(command_check(
        "docker",
        &["version", "--format", "{{.Server.Version}}"],
    ));
    checks.push(command_check("compose", &["compose", "version"]));

    if let Some(config) = config {
        let jellyfin = JellyfinClient::new(config.jellyfin.base_url.clone());
        match jellyfin.and_then(|client| client.public_info()) {
            Ok(info) => checks.push(pass(
                "jellyfin",
                format!("Jellyfin {} ({})", info.version, info.server_name),
            )),
            Err(error) => checks.push(fail("jellyfin", error.to_string())),
        }

        match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .and_then(|client| {
                client
                    .get(health_url(&config.session_server.public_websocket_url))
                    .send()
            }) {
            Ok(response) if response.status().is_success() => {
                checks.push(pass("session_server", "Session server health is reachable"))
            }
            Ok(response) => checks.push(fail(
                "session_server",
                format!("HTTP {}", response.status()),
            )),
            Err(error) => checks.push(fail("session_server", error.to_string())),
        }

        if let Some(path) = api_token_file {
            let check = JellyfinClient::token_from_file(path)
                .and_then(|token| {
                    JellyfinClient::new(config.jellyfin.base_url.clone())
                        .map(|client| client.with_token(token))
                })
                .and_then(|client| client.plugin_info())
                .map(|info| pass("plugin", format!("OpenWatchParty {}", info.version)))
                .unwrap_or_else(|error| fail("plugin", error.to_string()));
            checks.push(check);
        } else {
            checks.push(warning(
                "plugin",
                "Admin token not supplied; deep plugin checks skipped",
            ));
        }
    } else {
        checks.push(fail("configuration", "owpctl.toml is missing"));
    }

    let overall = if checks.iter().any(|check| check.status == CheckStatus::Fail) {
        CheckStatus::Fail
    } else if checks
        .iter()
        .any(|check| check.status == CheckStatus::Warning)
    {
        CheckStatus::Warning
    } else {
        CheckStatus::Pass
    };
    DiagnosticReport {
        overall,
        installed_version: state.map(|state| state.installed_version.clone()),
        checks,
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

fn health_url(websocket: &url::Url) -> url::Url {
    let mut url = websocket.clone();
    let _ = url.set_scheme(if websocket.scheme() == "wss" {
        "https"
    } else {
        "http"
    });
    let path = url.path().strip_suffix("/ws").unwrap_or(url.path());
    url.set_path(&format!("{path}/health"));
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn websocket_health_url_keeps_base_path() {
        let input = url::Url::parse("wss://media.example/jellyfin/owp/ws").unwrap();
        assert_eq!(
            health_url(&input).as_str(),
            "https://media.example/jellyfin/owp/health"
        );
    }
}
