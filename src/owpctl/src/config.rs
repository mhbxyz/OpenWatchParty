use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::CONFIG_SCHEMA_VERSION;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DesiredConfig {
    pub schema_version: u32,
    pub channel: ReleaseChannel,
    pub jellyfin: JellyfinConfig,
    pub session_server: SessionServerConfig,
    pub plugin: PluginConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseChannel {
    Stable,
    Beta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JellyfinConfig {
    pub base_url: Url,
    pub public_origin: Url,
    pub runtime: JellyfinRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JellyfinRuntime {
    Docker {
        container: String,
    },
    Systemd {
        unit: String,
        plugin_directory: String,
    },
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionServerConfig {
    pub bind_address: IpAddr,
    pub published_port: u16,
    pub public_websocket_url: Url,
    pub allowed_origins: Vec<String>,
    pub log_level: String,
    pub max_connections: u32,
    pub max_connections_per_ip: u32,
    pub auth_timeout_seconds: u32,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginConfig {
    pub token_ttl_seconds: u32,
    pub invite_ttl_seconds: u32,
    pub jwt_audience: String,
    pub jwt_issuer: String,
}

impl DesiredConfig {
    pub fn local(jellyfin_url: Url) -> anyhow::Result<Self> {
        let host = jellyfin_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Jellyfin URL has no host"))?;
        let websocket = Url::parse(&format!(
            "{}://{host}:3000/ws",
            if jellyfin_url.scheme() == "https" {
                "wss"
            } else {
                "ws"
            }
        ))?;
        Ok(Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            channel: ReleaseChannel::Stable,
            jellyfin: JellyfinConfig {
                public_origin: jellyfin_url.clone(),
                base_url: jellyfin_url,
                runtime: JellyfinRuntime::External,
            },
            session_server: SessionServerConfig {
                bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
                published_port: 3000,
                public_websocket_url: websocket,
                allowed_origins: vec![],
                log_level: "info".to_string(),
                max_connections: 256,
                max_connections_per_ip: 32,
                auth_timeout_seconds: 10,
                auth_mode: "hybrid".to_string(),
            },
            plugin: PluginConfig {
                token_ttl_seconds: 3600,
                invite_ttl_seconds: 3600,
                jwt_audience: "OpenWatchParty".to_string(),
                jwt_issuer: "Jellyfin".to_string(),
            },
        })
    }
}
