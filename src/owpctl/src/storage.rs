use std::{fs, io::Write, path::Path};

use anyhow::{bail, Context};
use serde::{de::DeserializeOwned, Serialize};

pub fn read_toml<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let contents =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    toml::from_str(&contents).with_context(|| format!("invalid TOML in {}", path.display()))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let contents = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_slice(&contents).with_context(|| format!("invalid JSON in {}", path.display()))
}

pub fn atomic_write(path: &Path, contents: &[u8], private: bool) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent", path.display()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
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
