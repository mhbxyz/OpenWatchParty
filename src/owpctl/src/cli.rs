use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "owpctl", version, about)]
pub struct Cli {
    #[arg(long, global = true, value_enum, default_value_t = ScopeArg::User)]
    pub scope: ScopeArg,
    #[arg(long, global = true)]
    pub root: Option<PathBuf>,
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ScopeArg {
    User,
    System,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Setup(SetupArgs),
    Install(ApplyArgs),
    Configure(ConfigureArgs),
    Doctor(DiagnosticArgs),
    Status(DiagnosticArgs),
    Upgrade(ApplyArgs),
    Backup(BackupArgs),
    Uninstall(UninstallArgs),
}

#[derive(Debug, Args)]
pub struct SetupArgs {
    #[arg(long)]
    pub web: bool,
    #[arg(long)]
    pub non_interactive: bool,
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct ApplyArgs {
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
    #[arg(long)]
    pub version: Option<String>,
}

#[derive(Debug, Args)]
pub struct ConfigureArgs {
    #[arg(long = "set")]
    pub values: Vec<String>,
    #[arg(long)]
    pub rotate_jwt_secret: bool,
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct DiagnosticArgs {
    #[arg(long)]
    pub quiet: bool,
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct BackupArgs {
    #[arg(long)]
    pub output: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct UninstallArgs {
    #[arg(long)]
    pub keep_config: bool,
    #[arg(long)]
    pub yes: bool,
}
