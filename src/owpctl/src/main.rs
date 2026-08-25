use clap::Parser;
use owpctl::cli::Cli;

fn main() {
    if let Err(error) = owpctl::app::run(Cli::parse()) {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}
