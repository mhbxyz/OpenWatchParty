use std::{
    fs,
    fs::OpenOptions,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustStore {
    pub version: u32,
    pub generation: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicJwk {
    pub kty: String,
    pub n: String,
    pub e: String,
    #[serde(default)]
    pub kid: Option<String>,
}

impl TrustStore {
    pub fn empty() -> Self {
        Self {
            version: 1,
            generation: 0,
            keys: vec![],
        }
    }
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            return Ok(Self::empty());
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }
    pub fn add(
        &mut self,
        jwk: PublicJwk,
        issuer: String,
        audience: String,
    ) -> anyhow::Result<String> {
        if jwk.kty != "RSA" || jwk.n.is_empty() || jwk.e != "AQAB" {
            anyhow::bail!("only RSA keys with exponent AQAB are accepted");
        }
        let kid = jwk_thumbprint(&jwk);
        if !self.keys.iter().any(|key| key.kid == kid) {
            self.keys.push(TrustedKey {
                kid: kid.clone(),
                issuer,
                audience,
                n: jwk.n,
                e: jwk.e,
                status: KeyStatus::Active,
            });
            self.generation += 1;
        }
        Ok(kid)
    }
    pub fn revoke(&mut self, kid: &str) -> anyhow::Result<()> {
        let key = self
            .keys
            .iter_mut()
            .find(|key| key.kid == kid)
            .ok_or_else(|| anyhow::anyhow!("unknown kid"))?;
        key.status = KeyStatus::Revoked;
        self.generation += 1;
        Ok(())
    }
}

pub fn mutate<T>(
    path: &Path,
    operation: impl FnOnce(&mut TrustStore) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    let mut store = TrustStore::load(path)?;
    let result = operation(&mut store)?;
    crate::storage::write_json(path, &store)?;
    FileExt::unlock(&lock)?;
    Ok(result)
}

pub fn jwk_thumbprint(jwk: &PublicJwk) -> String {
    let canonical = format!(r#"{{"e":"{}","kty":"RSA","n":"{}"}}"#, jwk.e, jwk.n);
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn add_is_idempotent_and_revoke_persists() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("trust.json");
        let jwk = PublicJwk {
            kty: "RSA".into(),
            n: "modulus".into(),
            e: "AQAB".into(),
            kid: None,
        };
        let kid = mutate(&path, |store| {
            store.add(jwk.clone(), "issuer".into(), "aud".into())
        })
        .unwrap();
        mutate(&path, |store| store.add(jwk, "issuer".into(), "aud".into())).unwrap();
        mutate(&path, |store| store.revoke(&kid)).unwrap();
        let store = TrustStore::load(&path).unwrap();
        assert_eq!(store.keys.len(), 1);
        assert_eq!(store.keys[0].status, KeyStatus::Revoked);
    }
}
