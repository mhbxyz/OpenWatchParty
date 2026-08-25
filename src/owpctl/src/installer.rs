use std::{fs, path::Path, process::Command, thread, time::Duration};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::{
    config::{DesiredConfig, JellyfinRuntime},
    jellyfin::JellyfinClient,
    paths::Paths,
    secrets,
    state::InstallationState,
};

#[derive(Debug, Clone, Serialize)]
pub struct InstallationPlan {
    pub version: String,
    pub image: String,
    pub operations: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct PluginConfiguration {
    jwt_secret: String,
    allow_insecure_no_auth: bool,
    jwt_audience: String,
    jwt_issuer: String,
    token_ttl_seconds: u32,
    invite_ttl_seconds: u32,
    session_server_url: String,
    allow_auto_detected_session_server: bool,
}

pub fn plan(version: &str) -> InstallationPlan {
    InstallationPlan {
        version: version.to_string(),
        image: format!("ghcr.io/mhbxyz/owp-session-server:{version}"),
        operations: vec![
            "validate Docker and Jellyfin",
            "install or update the Jellyfin plugin",
            "generate synchronized authentication configuration",
            "deploy the signed session server image",
            "verify plugin, token and session health",
        ],
    }
}

pub fn install(
    paths: &Paths,
    config: &DesiredConfig,
    version: &str,
    token: &str,
) -> anyhow::Result<InstallationState> {
    require_command("docker", &["compose", "version"])?;
    let jellyfin = JellyfinClient::new(config.jellyfin.base_url.clone())?.with_token(token);
    let system = jellyfin.public_info()?;

    let previous_state: Option<InstallationState> = paths
        .state_file
        .exists()
        .then(|| crate::storage::read_json(&paths.state_file))
        .transpose()?;
    let installed_plugin = jellyfin.plugin_info().ok();
    let plugin_was_absent = installed_plugin.is_none();
    let plugin_needs_install = installed_plugin
        .as_ref()
        .is_none_or(|plugin| plugin.version != version);
    let mut state = previous_state
        .clone()
        .unwrap_or_else(|| InstallationState::new(version));
    state.phase = "installing".to_string();
    state.installed_version = version.to_string();
    state.plugin_version = version.to_string();
    state.jellyfin_server_id = Some(system.id.clone());
    state.ownership.plugin = plugin_is_owned(plugin_was_absent, previous_state.as_ref());
    crate::storage::write_json(&paths.state_file, &state)?;

    let repository_changed = jellyfin.ensure_repository()?;
    if plugin_needs_install {
        jellyfin.install_plugin(version)?;
        restart_jellyfin(&config.jellyfin.runtime, &jellyfin)?;
        wait_for_jellyfin(&jellyfin)?;
    } else if repository_changed {
        // Repository was added for future upgrades; no restart is needed.
    }

    let secret = if paths.secrets_file.exists() {
        secrets::parse_env_secret(&fs::read_to_string(&paths.secrets_file)?)?
    } else {
        secrets::generate_jwt_secret()
    };
    crate::storage::atomic_write(
        &paths.secrets_file,
        secrets::env_file(&secret).as_bytes(),
        true,
    )?;
    state.ownership.configuration = true;
    state.secret_fingerprint = secrets::fingerprint(&secret);
    crate::storage::write_json(&paths.state_file, &state)?;
    if !paths.trust_store.exists() {
        crate::storage::write_json(&paths.trust_store, &crate::trust::TrustStore::empty())?;
    }

    let image = format!("ghcr.io/mhbxyz/owp-session-server:{version}");
    require_command("docker", &["pull", &image])?;
    let digest = image_digest(&image)?;
    let pinned_image = digest.clone().unwrap_or(image);
    crate::storage::atomic_write(
        &paths.compose_file,
        crate::compose::render(
            config,
            &pinned_image,
            &paths.secrets_file,
            &paths.trust_store,
        )
        .as_bytes(),
        false,
    )?;
    compose(paths, &["up", "-d", "--remove-orphans"])?;
    state.ownership.session_server = true;
    state.image_reference = pinned_image.clone();
    state.image_digest = digest.clone();
    crate::storage::write_json(&paths.state_file, &state)?;

    let plugin_config = plugin_configuration(config, &secret);
    jellyfin.update_plugin_configuration(&plugin_config)?;
    wait_for_health(config)?;

    state.phase = "ready".to_string();
    crate::storage::write_json(&paths.state_file, &state)?;
    Ok(state)
}

pub fn install_from_token_file(
    paths: &Paths,
    config: &DesiredConfig,
    version: &str,
    api_token_file: &Path,
) -> anyhow::Result<InstallationState> {
    let token = JellyfinClient::token_from_file(api_token_file)?;
    install(paths, config, version, &token)
}

pub(crate) fn plugin_configuration(config: &DesiredConfig, secret: &str) -> PluginConfiguration {
    PluginConfiguration {
        jwt_secret: secret.to_string(),
        allow_insecure_no_auth: false,
        jwt_audience: config.plugin.jwt_audience.clone(),
        jwt_issuer: config.plugin.jwt_issuer.clone(),
        token_ttl_seconds: config.plugin.token_ttl_seconds,
        invite_ttl_seconds: config.plugin.invite_ttl_seconds,
        session_server_url: config.session_server.public_websocket_url.to_string(),
        allow_auto_detected_session_server: false,
    }
}

pub fn compose(paths: &Paths, arguments: &[&str]) -> anyhow::Result<()> {
    let status = Command::new("docker")
        .args(["compose", "--project-name", "openwatchparty", "-f"])
        .arg(&paths.compose_file)
        .args(arguments)
        .status()?;
    if !status.success() {
        bail!("docker compose failed");
    }
    Ok(())
}

fn image_digest(image: &str) -> anyhow::Result<Option<String>> {
    let output = Command::new("docker")
        .args([
            "image",
            "inspect",
            "--format",
            "{{index .RepoDigests 0}}",
            image,
        ])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let digest = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!digest.is_empty() && digest != "<no value>").then_some(digest))
}

fn restart_jellyfin(runtime: &JellyfinRuntime, jellyfin: &JellyfinClient) -> anyhow::Result<()> {
    match runtime {
        JellyfinRuntime::Docker { container } => require_command("docker", &["restart", container]),
        JellyfinRuntime::Systemd { unit, .. } => require_command("systemctl", &["restart", unit]),
        JellyfinRuntime::External => jellyfin.restart(),
    }
}

fn wait_for_jellyfin(client: &JellyfinClient) -> anyhow::Result<()> {
    for _ in 0..60 {
        if client.public_info().is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(1));
    }
    bail!("Jellyfin did not restart within 60 seconds")
}

fn wait_for_health(config: &DesiredConfig) -> anyhow::Result<()> {
    let mut url = config.session_server.public_websocket_url.clone();
    let _ = url.set_scheme(if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    });
    url.set_path("/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    for _ in 0..30 {
        if client
            .get(url.clone())
            .send()
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(1));
    }
    bail!("session server did not become healthy")
}

fn require_command(command: &str, arguments: &[&str]) -> anyhow::Result<()> {
    let status = Command::new(command)
        .args(arguments)
        .status()
        .with_context(|| format!("cannot execute {command}"))?;
    if !status.success() {
        bail!("{command} {} failed", arguments.join(" "));
    }
    Ok(())
}

fn plugin_is_owned(plugin_was_absent: bool, previous: Option<&InstallationState>) -> bool {
    plugin_was_absent || previous.is_some_and(|state| state.ownership.plugin)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preexisting_plugin_is_not_claimed_during_upgrade() {
        assert!(!plugin_is_owned(false, None));
        assert!(plugin_is_owned(true, None));
        let mut state = InstallationState::new("0.3.2");
        state.ownership.plugin = true;
        assert!(plugin_is_owned(false, Some(&state)));
    }
}
