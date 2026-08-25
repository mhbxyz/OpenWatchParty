use anyhow::{bail, Context};
use dialoguer::{Confirm, Input};

use crate::{
    cli::{Cli, Command},
    config::DesiredConfig,
    paths::Paths,
    state::InstallationState,
};

pub fn run(cli: Cli) -> anyhow::Result<()> {
    let paths = Paths::resolve(cli.scope, cli.root.as_deref())?;
    match cli.command {
        Command::Setup(arguments) => setup(&paths, arguments),
        Command::Install(arguments) => {
            let config: DesiredConfig = crate::storage::read_toml(&paths.config_file)
                .context("run `owpctl setup` first")?;
            let version = arguments.version.as_deref().unwrap_or(crate::VERSION);
            let plan = crate::installer::plan(version);
            crate::output::print(&plan, cli.json)?;
            if arguments.dry_run {
                return Ok(());
            }
            if !arguments.yes {
                bail!("installation requires --yes after reviewing the plan");
            }
            let token_file = arguments
                .api_token_file
                .as_deref()
                .context("--api-token-file is required")?;
            let state = crate::installer::install(&paths, &config, version, token_file)?;
            crate::output::print(&state, cli.json)
        }
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

fn setup(paths: &Paths, arguments: crate::cli::SetupArgs) -> anyhow::Result<()> {
    if arguments.web {
        bail!("web setup is introduced in the next installer layer");
    }
    let config = if let Some(path) = arguments.config {
        crate::storage::read_toml(&path)?
    } else {
        let url = if let Some(url) = arguments.jellyfin_url {
            url
        } else if arguments.non_interactive {
            bail!("--jellyfin-url or --config is required in non-interactive mode");
        } else {
            Input::<String>::new()
                .with_prompt("Jellyfin URL")
                .default("http://localhost:8096".to_string())
                .interact_text()?
        };
        let mut config = DesiredConfig::local(url::Url::parse(&url)?)?;
        config.session_server.allowed_origins =
            vec![config.jellyfin.public_origin.origin().ascii_serialization()];
        config
    };
    if arguments.dry_run {
        return crate::output::print(&config, false);
    }
    if !arguments.non_interactive
        && !Confirm::new()
            .with_prompt(format!(
                "Write configuration to {}?",
                paths.config_file.display()
            ))
            .default(true)
            .interact()?
    {
        bail!("setup cancelled");
    }
    crate::storage::write_toml(&paths.config_file, &config)?;
    println!("Configuration written to {}", paths.config_file.display());
    Ok(())
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
