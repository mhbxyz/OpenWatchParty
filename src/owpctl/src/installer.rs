use std::{fs, path::Path, process::Command, thread, time::Duration};

use anyhow::{bail, Context};
use serde::Serialize;

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

/// The plugin settings owpctl owns. Everything else in the plugin
/// configuration belongs to the administrator and is carried over.
#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct ManagedPluginSettings<'a> {
    jwt_secret: &'a str,
    allow_insecure_no_auth: bool,
    jwt_audience: &'a str,
    jwt_issuer: &'a str,
    token_ttl_seconds: u32,
    invite_ttl_seconds: u32,
    session_server_url: String,
    allow_auto_detected_session_server: bool,
}

/// The whole plugin configuration object owpctl writes.
#[derive(Clone, Serialize)]
#[serde(transparent)]
pub(crate) struct PluginConfiguration(serde_json::Map<String, serde_json::Value>);

impl std::fmt::Debug for PluginConfiguration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut map = formatter.debug_map();
        for (key, value) in &self.0 {
            if key == "JwtSecret" {
                map.entry(key, &"<redacted>");
            } else {
                map.entry(key, value);
            }
        }
        map.finish()
    }
}

pub fn validate_version(version: &str) -> anyhow::Result<()> {
    const MAX_LENGTH: usize = 64;
    if version.is_empty() || version.len() > MAX_LENGTH {
        bail!("--version must be between 1 and {MAX_LENGTH} characters");
    }
    if !version
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    {
        bail!("--version may only contain ASCII letters, digits, '.', '_' and '-'");
    }
    Ok(())
}

pub fn plan(version: &str) -> anyhow::Result<InstallationPlan> {
    validate_version(version)?;
    Ok(InstallationPlan {
        version: version.to_string(),
        image: format!("ghcr.io/mhbxyz/owp-session-server:{version}"),
        operations: vec![
            "validate Docker and Jellyfin",
            "install or update the Jellyfin plugin",
            "generate synchronized authentication configuration",
            "deploy the signed session server image",
            "verify plugin, token and session health",
        ],
    })
}

pub fn install(
    paths: &Paths,
    config: &DesiredConfig,
    version: &str,
    token: &str,
) -> anyhow::Result<InstallationState> {
    validate_version(version)?;
    require_command("docker", &["compose", "version"])?;
    let jellyfin = JellyfinClient::new(config.jellyfin.base_url.clone())?.with_token(token);
    let system = jellyfin.public_info()?;

    let previous_state: Option<InstallationState> = paths
        .state_file
        .exists()
        .then(|| crate::storage::read_json(&paths.state_file))
        .transpose()?;
    if let Some(phase) = interrupted_phase(previous_state.as_ref()) {
        eprintln!("resuming interrupted installation (previous phase: \"{phase}\")");
    }
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

    let result = (|| -> anyhow::Result<()> {
        // Jellyfin replaces the whole plugin configuration on update, so keep the
        // settings owpctl does not manage. Snapshot a detected plugin's
        // configuration before any upgrade can touch it.
        let previous_plugin_config: Option<serde_json::Value> = if plugin_was_absent {
            None
        } else {
            Some(jellyfin.plugin_configuration()?)
        };
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
            )?
            .as_bytes(),
            false,
        )?;
        compose(paths, &["up", "-d", "--remove-orphans"])?;
        state.ownership.session_server = true;
        state.image_reference = pinned_image.clone();
        state.image_digest = digest.clone();
        crate::storage::write_json(&paths.state_file, &state)?;

        write_installed_plugin_configuration(
            config,
            &secret,
            previous_plugin_config.as_ref(),
            || jellyfin.plugin_configuration(),
            |plugin_config| jellyfin.update_plugin_configuration(plugin_config),
        )?;
        wait_for_health(config)?;
        Ok(())
    })();

    if let Err(error) = result {
        state.phase = "failed".to_string();
        let _ = crate::storage::write_json(&paths.state_file, &state);
        return Err(error.context("installation did not complete"));
    }

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

/// Writes the plugin configuration once the plugin is installed. The installed
/// plugin's own configuration, read now rather than before the upgrade, says
/// which settings this version has and their types; a plugin that was not
/// detected before (including a failed detection) keeps these values.
fn write_installed_plugin_configuration(
    config: &DesiredConfig,
    secret: &str,
    previous: Option<&serde_json::Value>,
    read_installed: impl FnOnce() -> anyhow::Result<serde_json::Value>,
    write: impl FnOnce(&PluginConfiguration) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let installed = read_installed()?;
    write(&plugin_configuration(config, secret, previous, &installed)?)
}

/// Builds the plugin configuration owpctl writes. Jellyfin replaces the whole
/// configuration object on update, so the result starts from `installed`, the
/// configuration the installed plugin reports, takes every setting owpctl does
/// not manage from `previous` (read before an upgrade, when there was one),
/// and writes the managed settings over both.
///
/// A previous value is kept only when the installed plugin still has that
/// setting with the same JSON type: a setting a newer plugin removed, renamed
/// or retyped falls back to the installed plugin's value instead of making
/// Jellyfin reject the whole update.
pub(crate) fn plugin_configuration(
    config: &DesiredConfig,
    secret: &str,
    previous: Option<&serde_json::Value>,
    installed: &serde_json::Value,
) -> anyhow::Result<PluginConfiguration> {
    let mut merged = installed.as_object().cloned().unwrap_or_default();
    if let Some(previous) = previous.and_then(serde_json::Value::as_object) {
        for (key, value) in previous {
            if let Some(current) = merged.get_mut(key) {
                if same_json_type(current, value) {
                    *current = value.clone();
                }
            }
        }
    }
    let managed = ManagedPluginSettings {
        jwt_secret: secret,
        allow_insecure_no_auth: false,
        jwt_audience: &config.plugin.jwt_audience,
        jwt_issuer: &config.plugin.jwt_issuer,
        token_ttl_seconds: config.plugin.token_ttl_seconds,
        invite_ttl_seconds: config.plugin.invite_ttl_seconds,
        session_server_url: config.session_server.public_websocket_url.to_string(),
        allow_auto_detected_session_server: false,
    };
    let serde_json::Value::Object(managed) = serde_json::to_value(managed)? else {
        bail!("the managed plugin settings are not a JSON object");
    };
    merged.extend(managed);
    Ok(PluginConfiguration(merged))
}

/// Whether `value` can replace `current` without changing the setting's JSON
/// type. All numbers count as one type: Jellyfin writes a whole `double` such
/// as `1.0` as `1`.
fn same_json_type(current: &serde_json::Value, value: &serde_json::Value) -> bool {
    std::mem::discriminant(current) == std::mem::discriminant(value)
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

/// A persisted phase other than `ready` means the previous install did not finish.
fn interrupted_phase(previous: Option<&InstallationState>) -> Option<&str> {
    previous
        .filter(|state| state.phase != "ready")
        .map(|state| state.phase.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The configuration a freshly installed plugin reports: its defaults.
    fn installed_defaults() -> serde_json::Value {
        serde_json::json!({
            "JwtSecret": "",
            "AllowInsecureNoAuth": false,
            "JwtAudience": "OpenWatchParty",
            "JwtIssuer": "Jellyfin",
            "TokenTtlSeconds": 3600,
            "InviteTtlSeconds": 3600,
            "SessionServerUrl": "",
            "AllowAutoDetectedSessionServer": false,
            "HideNativeSyncPlayButton": false,
            "PanelOpacity": 0.55
        })
    }

    fn configuration(secret: &str) -> PluginConfiguration {
        written(secret, None, &installed_defaults())
    }

    fn written(
        secret: &str,
        previous: Option<&serde_json::Value>,
        installed: &serde_json::Value,
    ) -> PluginConfiguration {
        let config =
            DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap()).unwrap();
        plugin_configuration(&config, secret, previous, installed).unwrap()
    }

    fn written_json(
        previous: Option<&serde_json::Value>,
        installed: &serde_json::Value,
    ) -> serde_json::Value {
        serde_json::to_value(written("new-secret", previous, installed)).unwrap()
    }

    #[test]
    fn plugin_configuration_keeps_the_settings_owpctl_does_not_manage() {
        let previous = serde_json::json!({
            "JwtSecret": "old-secret",
            "HideNativeSyncPlayButton": true,
            "PanelOpacity": 1
        });
        let written = written_json(Some(&previous), &installed_defaults());
        assert_eq!(written["HideNativeSyncPlayButton"], serde_json::json!(true));
        assert_eq!(written["PanelOpacity"], serde_json::json!(1));

        // With no previous configuration, the installed plugin's values stay.
        let mut installed = installed_defaults();
        installed["HideNativeSyncPlayButton"] = serde_json::json!(true);
        let written = written_json(None, &installed);
        assert_eq!(written["HideNativeSyncPlayButton"], serde_json::json!(true));
        assert_eq!(written["PanelOpacity"], serde_json::json!(0.55));
    }

    #[test]
    fn plugin_configuration_overwrites_the_settings_owpctl_manages() {
        let previous = serde_json::json!({
            "JwtSecret": "old-secret",
            "AllowInsecureNoAuth": true,
            "JwtAudience": "someone-else",
            "JwtIssuer": "someone-else",
            "TokenTtlSeconds": 60,
            "InviteTtlSeconds": 60,
            "SessionServerUrl": "ws://old.example:3000/ws",
            "AllowAutoDetectedSessionServer": true
        });
        let written = written_json(Some(&previous), &previous);
        assert_eq!(written["JwtSecret"], serde_json::json!("new-secret"));
        assert_eq!(written["AllowInsecureNoAuth"], serde_json::json!(false));
        assert_eq!(written["JwtAudience"], serde_json::json!("OpenWatchParty"));
        assert_eq!(written["JwtIssuer"], serde_json::json!("Jellyfin"));
        assert_eq!(written["TokenTtlSeconds"], serde_json::json!(3600));
        assert_eq!(written["InviteTtlSeconds"], serde_json::json!(3600));
        assert_eq!(
            written["SessionServerUrl"],
            serde_json::json!("ws://localhost:3000/ws")
        );
        assert_eq!(
            written["AllowAutoDetectedSessionServer"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn plugin_configuration_falls_back_for_missing_or_wrongly_typed_settings() {
        let previous = serde_json::json!({
            "HideNativeSyncPlayButton": "true",
            "PanelOpacity": null,
            "RemovedSetting": true
        });
        let written = written_json(Some(&previous), &installed_defaults());
        assert_eq!(
            written["HideNativeSyncPlayButton"],
            serde_json::json!(false)
        );
        assert_eq!(written["PanelOpacity"], serde_json::json!(0.55));
        assert!(written.get("RemovedSetting").is_none());

        // A previous configuration that is not an object is ignored, and an
        // installed plugin that reports none leaves only the managed settings.
        let written = written_json(Some(&serde_json::json!("corrupt")), &installed_defaults());
        assert_eq!(
            written["HideNativeSyncPlayButton"],
            serde_json::json!(false)
        );
        let written = written_json(Some(&previous), &serde_json::Value::Null);
        assert_eq!(written["JwtSecret"], serde_json::json!("new-secret"));
        assert!(written.get("HideNativeSyncPlayButton").is_none());
    }

    #[test]
    fn an_upgrade_writes_the_new_plugin_settings_with_the_previous_values() {
        // Before the upgrade: an older plugin with a setting the new one dropped.
        let before = serde_json::json!({
            "JwtSecret": "old-secret",
            "HideNativeSyncPlayButton": true,
            "RemovedSetting": "kept by the old version"
        });
        // After the upgrade: the new plugin reports its own settings, including
        // one the older version did not have.
        let after = installed_defaults();
        let config =
            DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap()).unwrap();
        let mut posted = None;
        write_installed_plugin_configuration(
            &config,
            "new-secret",
            Some(&before),
            || Ok(after.clone()),
            |plugin_config| {
                posted = Some(serde_json::to_value(plugin_config)?);
                Ok(())
            },
        )
        .unwrap();

        let posted = posted.expect("the configuration is written");
        assert_eq!(posted["HideNativeSyncPlayButton"], serde_json::json!(true));
        assert_eq!(posted["PanelOpacity"], serde_json::json!(0.55));
        assert_eq!(posted["JwtSecret"], serde_json::json!("new-secret"));
        assert!(posted.get("RemovedSetting").is_none());
    }

    #[test]
    fn preexisting_plugin_is_not_claimed_during_upgrade() {
        assert!(!plugin_is_owned(false, None));
        assert!(plugin_is_owned(true, None));
        let mut state = InstallationState::new("0.3.2");
        state.ownership.plugin = true;
        assert!(plugin_is_owned(false, Some(&state)));
    }

    #[test]
    fn debug_output_redacts_the_jwt_secret() {
        let debug = format!("{:?}", configuration("super-secret-value"));
        assert!(!debug.contains("super-secret-value"));
        assert!(debug.contains("<redacted>"));
        assert!(debug.contains("OpenWatchParty"));
    }

    #[test]
    fn interrupted_phase_is_detected_for_resume() {
        assert_eq!(interrupted_phase(None), None);
        let mut state = InstallationState::new("0.3.3");
        state.phase = "installing".to_string();
        assert_eq!(interrupted_phase(Some(&state)), Some("installing"));
        state.phase = "failed".to_string();
        assert_eq!(interrupted_phase(Some(&state)), Some("failed"));
        state.phase = "ready".to_string();
        assert_eq!(interrupted_phase(Some(&state)), None);
    }

    #[test]
    fn version_is_limited_to_a_safe_character_set() {
        assert!(validate_version("0.3.3").is_ok());
        assert!(validate_version("0.3.3-rc.1_build2").is_ok());
        assert!(validate_version("").is_err());
        assert!(validate_version(&"9".repeat(65)).is_err());
        assert!(validate_version("0.3.3\n    privileged: true").is_err());
        assert!(validate_version("0.3.3\"").is_err());
        assert!(plan("0.3.3\n  privileged: true").is_err());
    }
}
