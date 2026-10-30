use super::*;

fn public(version: &str) -> PublicSystemInfo {
    PublicSystemInfo {
        version: version.into(),
        id: "id".into(),
        server_name: "Jellyfin".into(),
        startup_wizard_completed: true,
    }
}

fn plugin(version: &str) -> PluginInfo {
    PluginInfo {
        id: "id".into(),
        name: "OpenWatchParty".into(),
        version: version.into(),
    }
}

fn health(version: &str, protocol_version: u64) -> SessionHealth {
    SessionHealth {
        status: "ok".into(),
        auth_enabled: true,
        version: version.into(),
        protocol_version,
    }
}

#[test]
fn endpoint_urls_keep_base_path() {
    let input = url::Url::parse("wss://media.example/jellyfin/owp/ws").unwrap();
    assert_eq!(
        endpoint_url(&input, "health").as_str(),
        "https://media.example/jellyfin/owp/health"
    );
    assert_eq!(
        endpoint_url(&input, "ready").as_str(),
        "https://media.example/jellyfin/owp/ready"
    );
}

#[test]
fn health_body_parsing_covers_good_missing_wrong_and_http() {
    let (check, parsed) = health_check(
        200,
        r#"{"status":"ok","auth_enabled":true,"version":"0.8.0","protocol_version":1}"#,
    );
    assert_eq!(check.status, CheckStatus::Pass);
    assert!(check.summary.contains("authentication on"));
    assert_eq!(parsed.unwrap(), health("0.8.0", 1));
    for body in [
        r#"{"status":"starting","auth_enabled":true,"version":"0.8.0","protocol_version":1}"#,
        r#"{"status":"ok","auth_enabled":true,"version":"0.8.0"}"#,
        r#"{"status":"ok","auth_enabled":"yes","version":"0.8.0","protocol_version":1}"#,
    ] {
        let (check, parsed) = health_check(200, body);
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.summary.contains("unexpected /health response"));
        assert!(parsed.is_none());
    }
    let (check, parsed) = health_check(503, "not json");
    assert_eq!(check.summary, "HTTP 503");
    assert!(parsed.is_none());
}

#[test]
fn readiness_mapping_covers_all_responses() {
    assert_eq!(
        ready_check(200, r#"{"status":"ready"}"#).status,
        CheckStatus::Pass
    );
    assert!(ready_check(503, r#"{"status":"shutting_down"}"#)
        .summary
        .contains("shutting down"));
    assert_eq!(ready_check(502, "").summary, "HTTP 502");
    assert_eq!(
        ready_check(200, r#"{"status":"other"}"#).summary,
        "HTTP 200"
    );
}

#[test]
fn versions_accept_supported_lines_and_lenient_syntax() {
    let check = versions_check(
        &public("12.1.0.7"),
        &plugin("0.8.0-beta.1"),
        &health("0.8.0-pre", 1),
    );
    assert_eq!(check.status, CheckStatus::Pass);
    assert!(check.summary.ends_with(": compatible"));
    assert_eq!(
        versions_check(&public("10.11.2"), &plugin("0.3.4"), &health("0.7.1", 1)).status,
        CheckStatus::Pass
    );
}

#[test]
fn versions_reject_protocol_vulnerable_server_and_old_plugin() {
    let protocol = versions_check(&public("12.0.0"), &plugin("0.8.0"), &health("0.8.0", 2));
    assert!(protocol.summary.contains("protocol 2"));
    let older_protocol = versions_check(&public("12.0.0"), &plugin("0.8.0"), &health("0.8.0", 0));
    assert!(older_protocol.summary.contains("protocol 0"));
    let vulnerable = versions_check(&public("12.0.0"), &plugin("0.8.0"), &health("0.6.9", 1));
    assert!(vulnerable.summary.contains("GHSA-fjpr-3g28-27r9"));
    assert!(vulnerable.summary.contains("0.7.0 or newer"));
    let old = versions_check(&public("12.0.0"), &plugin("0.3.3"), &health("0.8.0", 1));
    assert!(old.summary.contains("plugin 0.3.3 is unsupported"));
    assert!(old.summary.contains("0.4.0 or newer"));
    let old_on_10_11 = versions_check(&public("10.11.3"), &plugin("0.3.3"), &health("0.8.0", 1));
    assert!(old_on_10_11
        .summary
        .contains("plugin 0.3.3 is unsupported; install 0.3.4"));
    for check in [protocol, older_protocol, vulnerable, old, old_on_10_11] {
        assert_eq!(check.status, CheckStatus::Fail);
    }
}

#[test]
fn versions_enforce_each_plugin_line() {
    let twelve = versions_check(&public("12.0.0"), &plugin("0.3.4"), &health("0.8.0", 1));
    assert_eq!(twelve.status, CheckStatus::Fail);
    assert!(twelve.summary.contains("0.4.0 or newer"));
    let ten = versions_check(&public("10.11.0"), &plugin("0.4.0"), &health("0.8.0", 1));
    assert_eq!(ten.status, CheckStatus::Fail);
    assert!(ten.summary.contains("plugin 0.3.4"));
}

#[test]
fn versions_warn_for_unknown_line_and_unparsable_input() {
    assert_eq!(
        versions_check(&public("11.0.0"), &plugin("0.8.0"), &health("0.8.0", 1)).status,
        CheckStatus::Warning
    );
    let unparsable = versions_check(&public("twelve"), &plugin("0.8.0"), &health("0.8.0", 1));
    assert_eq!(unparsable.status, CheckStatus::Warning);
    assert!(unparsable.summary.contains("could not parse"));
}

#[test]
fn authentication_matrix_is_judged() {
    assert_eq!(authentication_check(true, true).status, CheckStatus::Pass);
    assert_eq!(authentication_check(false, false).status, CheckStatus::Pass);
    assert_eq!(authentication_check(true, false).status, CheckStatus::Fail);
    let ignored = authentication_check(false, true);
    assert_eq!(ignored.status, CheckStatus::Warning);
    assert!(ignored.summary.contains("ALLOW_INSECURE_NO_AUTH"));
}

#[test]
fn mixed_content_matrix_is_judged() {
    for (origin, websocket, expected) in [
        (
            "https://media.example",
            "ws://media.example/ws",
            CheckStatus::Fail,
        ),
        (
            "https://media.example",
            "wss://media.example/ws",
            CheckStatus::Pass,
        ),
        (
            "http://media.example",
            "ws://media.example/ws",
            CheckStatus::Pass,
        ),
        (
            "http://media.example",
            "wss://media.example/ws",
            CheckStatus::Pass,
        ),
    ] {
        assert_eq!(
            mixed_content_check(
                &url::Url::parse(origin).unwrap(),
                &url::Url::parse(websocket).unwrap(),
            )
            .status,
            expected
        );
    }
}

#[test]
fn websocket_http_error_mapping_is_actionable() {
    let origin = url::Url::parse("https://media.example").unwrap();
    let websocket = url::Url::parse("wss://sessions.example/ws").unwrap();
    assert!(
        websocket_failure_check(WebSocketFailure::Http(403), &origin, &websocket, true)
            .summary
            .contains("ALLOWED_ORIGINS")
    );
    assert!(
        websocket_failure_check(WebSocketFailure::Http(401), &origin, &websocket, true)
            .summary
            .contains("during the WebSocket upgrade")
    );
    for status in [400, 404, 426, 502] {
        let check =
            websocket_failure_check(WebSocketFailure::Http(status), &origin, &websocket, true);
        assert!(check.summary.contains(&format!("HTTP {status}")));
        assert!(check.summary.contains("Upgrade/Connection"));
    }
    for status in [403, 404] {
        let check =
            websocket_failure_check(WebSocketFailure::Http(status), &origin, &websocket, false);
        assert!(check.summary.contains(&format!("HTTP {status}")));
        assert!(check.summary.contains("not the session server's"));
        assert!(!check.summary.contains("ALLOWED_ORIGINS"));
    }
}

#[test]
fn websocket_success_includes_round_trip_time() {
    let check = websocket_success_check(12);
    assert_eq!(check.status, CheckStatus::Pass);
    assert!(check.summary.contains("RTT 12 ms"));
}

#[test]
fn websocket_auth_timeout_tls_and_refused_mapping_is_actionable() {
    let origin = url::Url::parse("https://media.example").unwrap();
    let websocket = url::Url::parse("wss://sessions.example/ws").unwrap();
    let server_error = |code: &str| {
        websocket_failure_check(
            WebSocketFailure::ServerError {
                code: code.into(),
                message: "Authentication failed".into(),
            },
            &origin,
            &websocket,
            true,
        )
    };
    let rejected = server_error("AUTHENTICATION_FAILED");
    assert!(rejected.summary.contains("does not match"));
    assert!(rejected
        .summary
        .contains("AUTHENTICATION_FAILED: Authentication failed"));
    assert!(server_error("AUTHENTICATION_EXPIRED")
        .summary
        .contains("clocks agree"));
    let other = server_error("RATE_LIMITED");
    assert!(other
        .summary
        .contains("answered with an error (RATE_LIMITED"));
    assert!(!other.summary.contains("does not match"));
    assert_eq!(
        websocket_failure_check(WebSocketFailure::Timeout, &origin, &websocket, true).summary,
        "no reply from the session server within 5 s"
    );
    for message in ["connection refused", "invalid peer certificate"] {
        let check = websocket_failure_check(
            WebSocketFailure::Connection(message.into()),
            &origin,
            &websocket,
            true,
        );
        assert!(check.summary.contains(websocket.as_str()));
        assert!(check.summary.contains(message));
    }
}

#[test]
fn clock_thresholds_are_judged() {
    assert_eq!(clock_check(1_000, 2_000).status, CheckStatus::Pass);
    let latency = clock_check(1_001, 0);
    assert_eq!(latency.status, CheckStatus::Warning);
    assert!(latency.summary.contains("high latency"));
    for offset in [2_001, -2_001] {
        let clock = clock_check(10, offset);
        assert_eq!(clock.status, CheckStatus::Warning);
        assert!(clock.summary.contains("check NTP"));
    }
    let both = clock_check(1_001, -2_001);
    assert!(both.summary.contains("high latency"));
    assert!(both.summary.contains("check NTP"));
}

#[test]
fn installation_phase_is_reported_only_when_interrupted() {
    let mut state = InstallationState::new("0.3.3");
    state.phase = "installing".into();
    let check = phase_check(&state).unwrap();
    assert_eq!(check.id, "installation_phase");
    assert_eq!(check.status, CheckStatus::Warning);
    state.phase = "ready".into();
    assert!(phase_check(&state).is_none());
}

#[test]
fn bundle_includes_plugin_report_and_redacts_fingerprint() {
    let report = DiagnosticReport {
        overall: CheckStatus::Pass,
        installed_version: Some("0.8.0".into()),
        checks: vec![],
    };
    let mut state = InstallationState::new("0.8.0");
    state.secret_fingerprint = "deadbeefcafe".into();
    let plugin_report = serde_json::json!({ "status": "ok" });
    let value = bundle(&report, None, Some(&state), Some(&plugin_report));
    assert_eq!(value["plugin_report"], plugin_report);
    assert_eq!(value["state"]["secret_fingerprint"], "<redacted>");
    assert!(!value.to_string().contains("deadbeefcafe"));
}

#[test]
fn plugin_report_failure_warning_updates_the_report() {
    let mut report = DiagnosticReport {
        overall: CheckStatus::Pass,
        installed_version: None,
        checks: vec![],
    };
    report.add_warning("plugin_report", "HTTP 503");
    assert_eq!(report.overall, CheckStatus::Warning);
    assert_eq!(report.checks[0].id, "plugin_report");
    assert!(report.checks[0].summary.contains("503"));
}
