use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context};
use serde::{de::DeserializeOwned, Serialize};

/// Guards against two temporary names colliding within the same nanosecond.
static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn read_toml<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let contents =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    toml::from_str(&contents).with_context(|| format!("invalid TOML in {}", path.display()))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let contents = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_slice(&contents).with_context(|| format!("invalid JSON in {}", path.display()))
}

fn temporary_path(path: &Path) -> anyhow::Result<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("{} has no file name", path.display()))?
        .to_string_lossy();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(path.with_file_name(format!(
        ".{file_name}.{}.{nanos}.{counter}.tmp",
        std::process::id()
    )))
}

pub fn atomic_write(path: &Path, contents: &[u8], private: bool) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent", path.display()))?;
    fs::create_dir_all(parent)?;
    // A unique per-call name means a leftover temporary from a crashed run can never
    // block later writes to the same target.
    let temporary = temporary_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    let mut file = options
        .open(&temporary)
        .with_context(|| format!("cannot create {}", temporary.display()))?;
    if let Err(error) = (|| -> std::io::Result<()> {
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })() {
        let _ = fs::remove_file(&temporary);
        bail!(error);
    }
    Ok(())
}

pub fn write_toml<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    atomic_write(path, toml::to_string_pretty(value)?.as_bytes(), false)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value)?, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_files(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.') && name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn write_succeeds_when_a_stale_temporary_file_exists() {
        let root = tempfile::tempdir().unwrap();
        let stale = root.path().join(".owpctl.toml.tmp");
        fs::write(&stale, b"leftover from a crashed run").unwrap();
        let target = root.path().join("owpctl.toml");
        atomic_write(&target, b"fresh", false).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"fresh");
        // The stale file is not ours, so it is left untouched.
        assert!(stale.exists());
    }

    #[test]
    fn write_sets_contents_and_permissions() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("secrets.env");
        atomic_write(&private, b"secret", true).unwrap();
        assert_eq!(fs::read(&private).unwrap(), b"secret");
        let public = root.path().join("compose.yaml");
        atomic_write(&public, b"services: {}", false).unwrap();
        assert_eq!(fs::read(&public).unwrap(), b"services: {}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&private), 0o600);
            assert_eq!(mode(&public), 0o644);
        }
    }

    #[test]
    fn no_temporary_files_remain_after_success() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("owpctl.toml");
        atomic_write(&target, b"a = 1", false).unwrap();
        assert!(temporary_files(root.path()).is_empty());
    }

    #[test]
    fn sequential_writes_both_succeed() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("owpctl.toml");
        atomic_write(&target, b"first", false).unwrap();
        atomic_write(&target, b"second", false).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert!(temporary_files(root.path()).is_empty());
    }
}
