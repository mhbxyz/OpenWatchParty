use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context};
use chrono::Utc;

use crate::{
    config::DesiredConfig, jellyfin::JellyfinClient, paths::Paths, secrets,
    state::InstallationState,
};

pub fn apply_values(config: &mut DesiredConfig, values: &[String]) -> anyhow::Result<()> {
    for value in values {
        let (key, value) = value
            .split_once('=')
            .with_context(|| format!("expected key=value, got {value}"))?;
        match key {
            "session.public-url" => {
                config.session_server.public_websocket_url = url::Url::parse(value)?
            }
            "session.log-level" => config.session_server.log_level = value.to_string(),
            "session.published-port" => {
                let previous = config.session_server.published_port;
                let next = value.parse()?;
                if config
                    .session_server
                    .public_websocket_url
                    .port_or_known_default()
                    == Some(previous)
                {
                    config
                        .session_server
                        .public_websocket_url
                        .set_port(Some(next))
                        .map_err(|_| anyhow::anyhow!("cannot update WebSocket port"))?;
                }
                config.session_server.published_port = next;
            }
            "session.max-connections" => config.session_server.max_connections = value.parse()?,
            "session.max-connections-per-ip" => {
                config.session_server.max_connections_per_ip = value.parse()?
            }
            "session.auth-mode" if matches!(value, "hs256" | "hybrid" | "asymmetric") => {
                config.session_server.auth_mode = value.to_string()
            }
            "jellyfin.base-url" => config.jellyfin.base_url = url::Url::parse(value)?,
            "jellyfin.public-origin" => config.jellyfin.public_origin = url::Url::parse(value)?,
            "plugin.token-ttl" => config.plugin.token_ttl_seconds = value.parse()?,
            "plugin.invite-ttl" => config.plugin.invite_ttl_seconds = value.parse()?,
            _ => bail!("unsupported configuration key: {key}"),
        }
    }
    Ok(())
}

pub fn configure(
    paths: &Paths,
    values: &[String],
    rotate_secret: bool,
    token_file: Option<&Path>,
    dry_run: bool,
) -> anyhow::Result<DesiredConfig> {
    let mut config: DesiredConfig = crate::storage::read_toml(&paths.config_file)?;
    apply_values(&mut config, values)?;
    if dry_run {
        return Ok(config);
    }
    crate::storage::write_toml(&paths.config_file, &config)?;

    let installed = paths.state_file.exists();
    if installed {
        let secret = if rotate_secret {
            let secret = secrets::generate_jwt_secret();
            crate::storage::atomic_write(
                &paths.secrets_file,
                secrets::env_file(&secret).as_bytes(),
                true,
            )?;
            secret
        } else {
            secrets::parse_env_secret(&fs::read_to_string(&paths.secrets_file)?)?
        };
        crate::storage::atomic_write(
            &paths.compose_file,
            crate::compose::render(
                &config,
                &crate::storage::read_json::<InstallationState>(&paths.state_file)?.image_reference,
                &paths.secrets_file,
                &paths.trust_store,
            )
            .as_bytes(),
            false,
        )?;
        if rotate_secret || !values.is_empty() {
            let token_file =
                token_file.context("--api-token-file is required to configure the plugin")?;
            let token = JellyfinClient::token_from_file(token_file)?;
            let client = JellyfinClient::new(config.jellyfin.base_url.clone())?.with_token(token);
            client.update_plugin_configuration(&crate::installer::plugin_configuration(
                &config, &secret,
            ))?;
        }
        crate::installer::compose(paths, &["up", "-d", "--remove-orphans"])?;
    }
    Ok(config)
}

pub fn backup(paths: &Paths, output: Option<&Path>) -> anyhow::Result<PathBuf> {
    let directory = output.map(Path::to_path_buf).unwrap_or_else(|| {
        paths
            .backup_dir
            .join(Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
    });
    fs::create_dir_all(&directory)?;
    for source in [
        &paths.config_file,
        &paths.secrets_file,
        &paths.state_file,
        &paths.compose_file,
        &paths.trust_store,
    ] {
        if source.exists() {
            fs::copy(source, directory.join(source.file_name().unwrap()))?;
        }
    }
    Ok(directory)
}

pub fn uninstall(
    paths: &Paths,
    config: &DesiredConfig,
    token_file: Option<&Path>,
    keep_config: bool,
) -> anyhow::Result<()> {
    let state: InstallationState = crate::storage::read_json(&paths.state_file)?;
    if state.ownership.session_server && paths.compose_file.exists() {
        crate::installer::compose(paths, &["down", "--remove-orphans"])?;
    }
    if state.ownership.plugin {
        let token_file = token_file.context("--api-token-file is required to remove the plugin")?;
        let token = JellyfinClient::token_from_file(token_file)?;
        JellyfinClient::new(config.jellyfin.base_url.clone())?
            .with_token(token)
            .uninstall_plugin()?;
    }
    for path in [&paths.state_file, &paths.compose_file] {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    if !keep_config {
        for path in [&paths.config_file, &paths.secrets_file] {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_keys_are_allowlisted() {
        let mut config =
            DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap()).unwrap();
        apply_values(
            &mut config,
            &[
                "session.max-connections=512".to_string(),
                "session.published-port=39010".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(config.session_server.max_connections, 512);
        assert_eq!(
            config.session_server.public_websocket_url.port(),
            Some(39010)
        );
        assert!(apply_values(&mut config, &["jwt.secret=leak".to_string()]).is_err());
    }
}
