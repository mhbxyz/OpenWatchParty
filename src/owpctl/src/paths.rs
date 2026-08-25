use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::cli::ScopeArg;

#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_file: PathBuf,
    pub secrets_file: PathBuf,
    pub state_file: PathBuf,
    pub compose_file: PathBuf,
    pub backup_dir: PathBuf,
}

impl Paths {
    pub fn resolve(scope: ScopeArg, root: Option<&Path>) -> anyhow::Result<Self> {
        let (config_dir, state_dir) = if let Some(root) = root {
            (root.join("etc"), root.join("var"))
        } else {
            match scope {
                ScopeArg::System => (
                    PathBuf::from("/etc/openwatchparty"),
                    PathBuf::from("/var/lib/openwatchparty"),
                ),
                ScopeArg::User => {
                    let config =
                        dirs::config_dir().context("cannot determine user config directory")?;
                    let state = dirs::state_dir()
                        .or_else(dirs::data_local_dir)
                        .context("cannot determine user state directory")?;
                    (config.join("openwatchparty"), state.join("openwatchparty"))
                }
            }
        };
        Ok(Self {
            config_file: config_dir.join("owpctl.toml"),
            secrets_file: config_dir.join("secrets.env"),
            state_file: state_dir.join("state.json"),
            compose_file: state_dir.join("compose.yaml"),
            backup_dir: state_dir.join("backups"),
            config_dir,
            state_dir,
        })
    }
}
