use serde::Serialize;

use crate::{
    config::DesiredConfig,
    diagnostics::{CheckStatus, DiagnosticReport},
    installer::InstallationPlan,
    state::InstallationState,
    trust::TrustStore,
};

/// Human-readable rendering of a command result, used when `--json` is not requested.
pub trait Summary {
    fn summary(&self) -> String;
}

/// Prints `value` as JSON when `json` is set, and a human-readable summary otherwise.
pub fn print<T: Serialize + Summary>(value: &T, json: bool) -> anyhow::Result<()> {
    if json {
        print_json(value)
    } else {
        print!("{}", value.summary());
        Ok(())
    }
}

/// Prints the machine-readable representation consumed by scripts.
pub fn print_json<T: Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn print_diagnostics(report: &DiagnosticReport, json: bool) -> anyhow::Result<()> {
    if json {
        return print_json(report);
    }
    for check in &report.checks {
        let marker = match check.status {
            CheckStatus::Pass => "OK",
            CheckStatus::Warning => "WARN",
            CheckStatus::Fail => "FAIL",
        };
        println!("{marker:4} {:20} {}", check.id, check.summary);
    }
    println!("Overall: {:?}", report.overall);
    Ok(())
}

impl Summary for InstallationPlan {
    fn summary(&self) -> String {
        let mut summary = format!(
            "OpenWatchParty {} installation plan\n  image: {}\n  operations:\n",
            self.version, self.image
        );
        for operation in &self.operations {
            summary.push_str(&format!("    - {operation}\n"));
        }
        summary
    }
}

impl Summary for InstallationState {
    fn summary(&self) -> String {
        format!(
            "installation {}: OpenWatchParty {} [{}]\n  image: {}\n  plugin version: {}\n",
            self.installation_id,
            self.installed_version,
            self.phase,
            if self.image_reference.is_empty() {
                "-"
            } else {
                &self.image_reference
            },
            self.plugin_version,
        )
    }
}

impl Summary for DesiredConfig {
    fn summary(&self) -> String {
        let mut summary = String::new();
        summary.push_str(&format!("Jellyfin: {}\n", self.jellyfin.public_origin));
        summary.push_str(&format!(
            "Session server: {}:{} ({})\n",
            self.session_server.bind_address,
            self.session_server.published_port,
            self.session_server.public_websocket_url
        ));
        summary.push_str(&format!("Log level: {}\n", self.session_server.log_level));
        summary.push_str(&format!("Auth mode: {}\n", self.session_server.auth_mode));
        summary
    }
}

impl Summary for TrustStore {
    fn summary(&self) -> String {
        let mut summary = format!(
            "Trust store generation {}, {} key(s)\n",
            self.generation,
            self.keys.len()
        );
        for key in &self.keys {
            summary.push_str(&format!(
                "  {} [{:?}] issuer={} audience={}\n",
                key.kid, key.status, key.issuer, key.audience
            ));
        }
        summary
    }
}

impl Summary for serde_json::Value {
    fn summary(&self) -> String {
        match self {
            serde_json::Value::Object(fields) => {
                let mut summary = String::new();
                for (key, value) in fields {
                    summary.push_str(&format!("{key}: {}\n", scalar(value)));
                }
                summary
            }
            value => format!("{}\n", scalar(value)),
        }
    }
}

fn scalar(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        value => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_summary_is_human_readable() {
        let plan = InstallationPlan {
            version: "0.3.3".to_string(),
            image: "ghcr.io/mhbxyz/owp-session-server:0.3.3".to_string(),
            operations: vec!["validate Docker and Jellyfin"],
        };
        let summary = plan.summary();
        assert!(summary.contains("OpenWatchParty 0.3.3 installation plan"));
        assert!(summary.contains("- validate Docker and Jellyfin"));
    }

    #[test]
    fn object_values_render_without_quotes() {
        let value = serde_json::json!({ "backup": "/tmp/backup", "uninstalled": true });
        let summary = value.summary();
        assert!(summary.contains("backup: /tmp/backup"));
        assert!(summary.contains("uninstalled: true"));
    }
}
