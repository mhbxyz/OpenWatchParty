pub mod app;
pub mod cli;
pub mod compose;
pub mod config;
pub mod diagnostics;
pub mod installer;
pub mod jellyfin;
pub mod output;
pub mod paths;
pub mod secrets;
pub mod state;
pub mod storage;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const STATE_SCHEMA_VERSION: u32 = 1;
