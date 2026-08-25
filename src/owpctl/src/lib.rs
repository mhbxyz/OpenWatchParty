pub mod app;
pub mod cli;
pub mod config;
pub mod output;
pub mod paths;
pub mod state;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const STATE_SCHEMA_VERSION: u32 = 1;
