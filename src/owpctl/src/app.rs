use anyhow::bail;

use crate::{
    cli::{Cli, Command},
    paths::Paths,
};

pub fn run(cli: Cli) -> anyhow::Result<()> {
    let paths = Paths::resolve(cli.scope, cli.root.as_deref())?;
    match cli.command {
        Command::Status(_) => crate::output::print(
            &serde_json::json!({
                "overall": "not_installed",
                "state_file": paths.state_file,
                "version": crate::VERSION,
            }),
            cli.json,
        ),
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
