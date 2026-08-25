use anyhow::bail;

use crate::{
    cli::{Cli, Command},
    config::DesiredConfig,
    paths::Paths,
    state::InstallationState,
};

pub fn run(cli: Cli) -> anyhow::Result<()> {
    let paths = Paths::resolve(cli.scope, cli.root.as_deref())?;
    match cli.command {
        Command::Status(arguments) | Command::Doctor(arguments) => {
            let config: Option<DesiredConfig> = paths
                .config_file
                .exists()
                .then(|| crate::storage::read_toml(&paths.config_file))
                .transpose()?;
            let state: Option<InstallationState> = paths
                .state_file
                .exists()
                .then(|| crate::storage::read_json(&paths.state_file))
                .transpose()?;
            let report = crate::diagnostics::run(
                config.as_ref(),
                state.as_ref(),
                arguments.api_token_file.as_deref(),
            );
            if !arguments.quiet {
                crate::output::print_diagnostics(&report, cli.json)?;
            }
            Ok(())
        }
        command => bail!("{} is not implemented yet", command_name(&command)),
    }
}

fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Setup(_) => "setup",
        Command::Install(_) => "install",
        Command::Configure(_) => "configure",
        Command::Doctor(_) => "doctor",
        Command::Status(_) => "status",
        Command::Upgrade(_) => "upgrade",
        Command::Backup(_) => "backup",
        Command::Uninstall(_) => "uninstall",
    }
}
