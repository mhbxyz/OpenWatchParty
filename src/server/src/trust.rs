use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};

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

    /// Loads the trust store, reusing the previous parse while the file is
    /// unchanged.
    ///
    /// Revocation and rotation stay immediately visible: the fingerprint covers
    /// the inode, size and modification time, so both an atomic rename (the
    /// documented way to rotate the directory-mounted store) and an in-place
    /// rewrite invalidate the cache without any polling.
    pub fn load_cached(path: &Path) -> Result<Arc<Self>, String> {
        let fingerprint = Fingerprint::of(path)?;
        if !fingerprint.is_conclusive() {
            // Without a usable timestamp or inode the store cannot be proven
            // unchanged, so it is parsed on every call.
            return Ok(Arc::new(Self::load(path)?));
        }

        let cache = TRUST_STORE_CACHE.get_or_init(|| Mutex::new(None));
        let mut cached = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = cached.as_ref() {
            if entry.path == path && entry.fingerprint == fingerprint {
                return Ok(Arc::clone(&entry.store));
            }
        }

        let store = Arc::new(Self::load(path)?);
        *cached = Some(CachedStore {
            path: path.to_path_buf(),
            fingerprint,
            store: Arc::clone(&store),
        });
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    modified: Option<SystemTime>,
    len: u64,
    inode: u64,
}

impl Fingerprint {
    fn of(path: &Path) -> Result<Self, String> {
        let metadata = fs::metadata(path)
            .map_err(|error| format!("cannot read trust store {}: {error}", path.display()))?;
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        };
        #[cfg(not(unix))]
        let inode = 0;

        Ok(Self {
            modified: metadata.modified().ok(),
            len: metadata.len(),
            inode,
        })
    }

    fn is_conclusive(self) -> bool {
        self.modified.is_some() || self.inode != 0
    }
}

struct CachedStore {
    path: PathBuf,
    fingerprint: Fingerprint,
    store: Arc<TrustStore>,
}

static TRUST_STORE_CACHE: OnceLock<Mutex<Option<CachedStore>>> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_status(status: &str) -> String {
        // 384 bytes is the smallest modulus the store accepts (3072 bits).
        let modulus = URL_SAFE_NO_PAD.encode([3u8; 384]);
        format!(
            r#"{{"version":1,"keys":[{{"kid":"key-1","issuer":"i","audience":"a","n":"{modulus}","e":"AQAB","status":"{status}"}}]}}"#
        )
    }

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

    #[test]
    fn cached_load_reuses_an_unchanged_store_and_sees_rotation() {
        let dir = std::env::temp_dir().join(format!("owp-trust-cache-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trust.json");

        fs::write(&path, store_with_status("active")).unwrap();
        let first = TrustStore::load_cached(&path).unwrap();
        let second = TrustStore::load_cached(&path).unwrap();
        assert!(
            Arc::ptr_eq(&first, &second),
            "an unchanged store must be reused instead of re-parsed"
        );
        assert!(first.active_key("key-1").is_ok());

        // Rotation is an atomic rename over the mounted directory, which
        // changes the inode even when the content length is identical.
        let rotated = dir.join("trust.json.next");
        fs::write(&rotated, store_with_status("revoked")).unwrap();
        fs::rename(&rotated, &path).unwrap();

        let after_rotation = TrustStore::load_cached(&path).unwrap();
        assert!(
            after_rotation.active_key("key-1").is_err(),
            "revoking a key must be visible without a restart"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
