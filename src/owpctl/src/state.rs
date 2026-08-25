use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::STATE_SCHEMA_VERSION;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallationState {
    pub schema_version: u32,
    pub installation_id: Uuid,
    pub installed_version: String,
    pub image_reference: String,
    pub image_digest: Option<String>,
    pub plugin_version: String,
    pub jellyfin_server_id: Option<String>,
    pub ownership: Ownership,
    pub secret_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Ownership {
    pub session_server: bool,
    pub plugin: bool,
    pub configuration: bool,
}

impl InstallationState {
    pub fn new(version: impl Into<String>) -> Self {
        let version = version.into();
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            installation_id: Uuid::new_v4(),
            installed_version: version.clone(),
            image_reference: String::new(),
            image_digest: None,
            plugin_version: version,
            jellyfin_server_id: None,
            ownership: Ownership::default(),
            secret_fingerprint: String::new(),
        }
    }
}
