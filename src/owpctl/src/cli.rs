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
    Ui(UiArgs),
    Status(DiagnosticArgs),
    Logs(LogsArgs),
    Upgrade(ApplyArgs),
    Backup(BackupArgs),
    Uninstall(UninstallArgs),
    Trust(TrustArgs),
    Pair(PairArgs),
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
    #[arg(long)]
    pub jellyfin_url: Option<String>,
}

#[derive(Debug, Args)]
pub struct ApplyArgs {
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub yes: bool,
    #[arg(long)]
    pub version: Option<String>,
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ConfigureArgs {
    #[arg(long = "set")]
    pub values: Vec<String>,
    #[arg(long)]
    pub rotate_jwt_secret: bool,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct DiagnosticArgs {
    #[arg(long)]
    pub quiet: bool,
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
    /// Write a redacted support bundle (report, configuration and state) to this file.
    #[arg(long)]
    pub bundle: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct UiArgs {
    /// Read a Jellyfin administrator API token from this file for deep checks.
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
    /// Print the dashboard URL without opening a browser.
    #[arg(long)]
    pub no_open: bool,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    /// Number of recent log lines to show before following.
    #[arg(long, default_value_t = 100)]
    pub tail: u32,
    /// Print the recent lines and exit instead of following.
    #[arg(long)]
    pub no_follow: bool,
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
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct TrustArgs {
    #[arg(long)]
    pub store: PathBuf,
    #[command(subcommand)]
    pub command: TrustCommand,
}

#[derive(Debug, Subcommand)]
pub enum TrustCommand {
    Init,
    List,
    Add {
        #[arg(long)]
        jwk: PathBuf,
        #[arg(long)]
        issuer: String,
        #[arg(long, default_value = "OpenWatchParty")]
        audience: String,
    },
    Revoke {
        #[arg(long)]
        kid: String,
    },
}

#[derive(Debug, Args)]
pub struct PairArgs {
    #[arg(long)]
    pub jellyfin_url: String,
    #[arg(long)]
    pub api_token_file: PathBuf,
    #[arg(long)]
    pub trust_store: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_defaults_to_a_hundred_lines_and_follows() {
        let cli = Cli::try_parse_from(["owpctl", "logs"]).expect("logs parses");
        let Command::Logs(arguments) = cli.command else {
            panic!("expected the logs command");
        };
        assert_eq!(arguments.tail, 100);
        assert!(!arguments.no_follow);
    }

    #[test]
    fn logs_accepts_tail_and_no_follow() {
        let cli =
            Cli::try_parse_from(["owpctl", "logs", "--tail", "25", "--no-follow"]).expect("parses");
        let Command::Logs(arguments) = cli.command else {
            panic!("expected the logs command");
        };
        assert_eq!(arguments.tail, 25);
        assert!(arguments.no_follow);
    }

    #[test]
    fn doctor_accepts_a_bundle_path() {
        let cli = Cli::try_parse_from(["owpctl", "doctor", "--bundle", "/tmp/owp-bundle.json"])
            .expect("parses");
        let Command::Doctor(arguments) = cli.command else {
            panic!("expected the doctor command");
        };
        assert_eq!(
            arguments.bundle.as_deref(),
            Some(std::path::Path::new("/tmp/owp-bundle.json"))
        );
    }

    #[test]
    fn ui_accepts_a_token_file_and_no_open() {
        let cli = Cli::try_parse_from([
            "owpctl",
            "ui",
            "--api-token-file",
            "/tmp/jellyfin-token",
            "--no-open",
        ])
        .expect("parses");
        let Command::Ui(arguments) = cli.command else {
            panic!("expected the ui command");
        };
        assert_eq!(
            arguments.api_token_file.as_deref(),
            Some(std::path::Path::new("/tmp/jellyfin-token"))
        );
        assert!(arguments.no_open);
    }
}
