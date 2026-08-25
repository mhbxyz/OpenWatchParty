use owpctl::{cli::ScopeArg, config::DesiredConfig, paths::Paths, state::InstallationState};
use tempfile::tempdir;
use url::Url;

#[test]
fn local_config_derives_websocket_and_safe_defaults() {
    let config =
        DesiredConfig::local(Url::parse("https://media.example/jellyfin").unwrap()).unwrap();
    assert_eq!(
        config.session_server.public_websocket_url.as_str(),
        "wss://media.example:3000/ws"
    );
    assert_eq!(config.session_server.bind_address.to_string(), "127.0.0.1");
    assert_eq!(config.plugin.jwt_audience, "OpenWatchParty");
}

#[test]
fn root_override_keeps_tests_out_of_system_paths() {
    let root = tempdir().unwrap();
    let paths = Paths::resolve(ScopeArg::System, Some(root.path())).unwrap();
    assert_eq!(paths.config_file, root.path().join("etc/owpctl.toml"));
    assert_eq!(paths.state_file, root.path().join("var/state.json"));
}

#[test]
fn state_never_contains_the_secret_itself() {
    let state = InstallationState::new("0.3.2");
    let json = serde_json::to_string(&state).unwrap();
    assert!(!json.contains("jwt_secret"));
}
