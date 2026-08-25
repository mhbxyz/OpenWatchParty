use std::{fs, path::Path};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustStore {
    pub version: u32,
    #[serde(default)]
    pub keys: Vec<TrustedKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedKey {
    pub kid: String,
    pub issuer: String,
    pub audience: String,
    pub n: String,
    pub e: String,
    pub status: KeyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyStatus {
    Active,
    Retiring,
    Revoked,
}

impl TrustStore {
    pub fn load(path: &Path) -> Result<Self, String> {
        let contents = fs::read(path)
            .map_err(|error| format!("cannot read trust store {}: {error}", path.display()))?;
        let store: Self = serde_json::from_slice(&contents)
            .map_err(|error| format!("invalid trust store {}: {error}", path.display()))?;
        if store.version != 1 {
            return Err(format!("unsupported trust store version {}", store.version));
        }
        Ok(store)
    }

    pub fn active_key(&self, kid: &str) -> Result<&TrustedKey, String> {
        if kid.len() > 128
            || !kid
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid RSA key id".to_string());
        }
        let key = self
            .keys
            .iter()
            .find(|key| {
                key.kid == kid && matches!(key.status, KeyStatus::Active | KeyStatus::Retiring)
            })
            .ok_or_else(|| "unknown or revoked RSA key".to_string())?;
        let modulus = URL_SAFE_NO_PAD
            .decode(&key.n)
            .map_err(|_| "invalid RSA modulus encoding".to_string())?;
        if modulus.len() < 384 {
            return Err("RSA modulus must contain at least 3072 bits".to_string());
        }
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revoked_and_invalid_key_ids_are_rejected() {
        let store = TrustStore {
            version: 1,
            keys: vec![TrustedKey {
                kid: "valid_key".into(),
                issuer: "issuer".into(),
                audience: "aud".into(),
                n: "n".into(),
                e: "AQAB".into(),
                status: KeyStatus::Revoked,
            }],
        };
        assert!(store.active_key("valid_key").is_err());
        assert!(store.active_key("../key").is_err());
    }
}
