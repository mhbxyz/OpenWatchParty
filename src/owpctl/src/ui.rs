use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    cli::UiArgs, config::DesiredConfig, diagnostics::DiagnosticReport, paths::Paths,
    state::InstallationState,
};

const INDEX_HTML: &str = include_str!("../assets/ui/index.html");

#[derive(Clone, Serialize)]
struct Instance {
    jellyfin: String,
    websocket: String,
}

#[derive(Clone, Serialize)]
struct Snapshot {
    owpctl_version: &'static str,
    instance: Option<Instance>,
    report: DiagnosticReport,
}

trait Checks: Send + Sync + 'static {
    fn snapshot(&self) -> anyhow::Result<Snapshot>;
    fn bundle(&self, report: &DiagnosticReport) -> anyhow::Result<serde_json::Value>;
}

struct LiveChecks {
    paths: Paths,
    api_token_file: Option<PathBuf>,
}

impl LiveChecks {
    fn load(&self) -> anyhow::Result<(Option<DesiredConfig>, Option<InstallationState>)> {
        crate::diagnostics::load(&self.paths)
    }
}

impl Checks for LiveChecks {
    fn snapshot(&self) -> anyhow::Result<Snapshot> {
        let (config, state) = self.load()?;
        let instance = config.as_ref().map(|config| Instance {
            jellyfin: config
                .jellyfin
                .public_origin
                .as_str()
                .trim_end_matches('/')
                .to_string(),
            websocket: config.session_server.public_websocket_url.to_string(),
        });
        let report = crate::diagnostics::run(
            config.as_ref(),
            state.as_ref(),
            self.api_token_file.as_deref(),
        );
        Ok(Snapshot {
            owpctl_version: crate::VERSION,
            instance,
            report,
        })
    }

    fn bundle(&self, report: &DiagnosticReport) -> anyhow::Result<serde_json::Value> {
        let (config, state) = self.load()?;
        let mut report = report.clone();
        let plugin_report = crate::diagnostics::collect_plugin_report(
            &mut report,
            config.as_ref(),
            self.api_token_file.as_deref(),
        );
        Ok(crate::diagnostics::bundle(
            &report,
            config.as_ref(),
            state.as_ref(),
            plugin_report.as_ref(),
        ))
    }
}

#[derive(Clone)]
struct UiState {
    launch_token: Arc<Mutex<Option<String>>>,
    session: String,
    allowed_hosts: [String; 2],
    checks: Arc<dyn Checks>,
    latest_report: Arc<AsyncMutex<Option<DiagnosticReport>>>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

pub fn run(paths: Paths, arguments: UiArgs) -> anyhow::Result<()> {
    tokio::runtime::Runtime::new()?.block_on(run_async(paths, arguments))
}

async fn run_async(paths: Paths, arguments: UiArgs) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let launch_token = crate::web::random_token();
    let session = crate::web::random_token();
    let checks = Arc::new(LiveChecks {
        paths,
        api_token_file: arguments.api_token_file,
    });
    let app = router(checks, launch_token.clone(), session, address.port());
    let url = format!("http://{address}/?token={launch_token}");
    println!("Open the OpenWatchParty dashboard:\n{url}\nPress Ctrl+C to stop.");
    if !arguments.no_open {
        let _ = webbrowser::open(&url);
    }
    axum::serve(listener, app).await?;
    Ok(())
}

fn router(checks: Arc<dyn Checks>, launch_token: String, session: String, port: u16) -> Router {
    let state = UiState {
        launch_token: Arc::new(Mutex::new(Some(launch_token))),
        session,
        allowed_hosts: [format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        checks,
        latest_report: Arc::new(AsyncMutex::new(None)),
    };
    Router::new()
        .route("/", get(index))
        .route("/api/report", get(report))
        .route("/api/bundle", get(bundle))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_loopback_host,
        ))
        .with_state(state)
}

async fn require_loopback_host(
    State(state): State<UiState>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = if host_allowed(&state, request.headers()) {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "Invalid Host header").into_response()
    };
    crate::web::secure_headers(response.headers_mut());
    response
}

fn host_allowed(state: &UiState, headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| state.allowed_hosts.iter().any(|allowed| allowed == host))
}

async fn index(
    State(state): State<UiState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    let valid_token = {
        let mut launch_token = state.launch_token.lock().unwrap();
        let valid = launch_token
            .as_deref()
            .zip(query.token.as_deref())
            .is_some_and(|(expected, actual)| expected == actual);
        if valid {
            *launch_token = None;
        }
        valid
    };
    if valid_token {
        let mut response = Html(INDEX_HTML).into_response();
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&format!(
                "owp_ui={}; HttpOnly; SameSite=Strict; Path=/",
                state.session
            ))
            .unwrap(),
        );
        return response;
    }
    if has_session_cookie(&state, &headers) {
        return Html(INDEX_HTML).into_response();
    }
    (
        StatusCode::UNAUTHORIZED,
        "Invalid or consumed dashboard token",
    )
        .into_response()
}

async fn report(State(state): State<UiState>, headers: HeaderMap) -> Response {
    if !api_authorized(&state, &headers) {
        return (StatusCode::FORBIDDEN, "Invalid dashboard session").into_response();
    }
    let mut latest_report = state.latest_report.lock().await;
    let checks = Arc::clone(&state.checks);
    match tokio::task::spawn_blocking(move || checks.snapshot()).await {
        Ok(Ok(snapshot)) => {
            *latest_report = Some(snapshot.report.clone());
            Json(snapshot).into_response()
        }
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

async fn bundle(State(state): State<UiState>, headers: HeaderMap) -> Response {
    if !api_authorized(&state, &headers) {
        return (StatusCode::FORBIDDEN, "Invalid dashboard session").into_response();
    }
    let mut latest_report = state.latest_report.lock().await;
    let report = if let Some(report) = latest_report.as_ref() {
        report.clone()
    } else {
        let checks = Arc::clone(&state.checks);
        match tokio::task::spawn_blocking(move || checks.snapshot()).await {
            Ok(Ok(snapshot)) => {
                *latest_report = Some(snapshot.report.clone());
                snapshot.report
            }
            Ok(Err(error)) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
            Err(error) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
            }
        }
    };
    let checks = Arc::clone(&state.checks);
    match tokio::task::spawn_blocking(move || checks.bundle(&report)).await {
        Ok(Ok(value)) => {
            let disposition = format!(
                "attachment; filename=\"owp-support-{}.json\"",
                Utc::now().format("%Y%m%d-%H%M%S")
            );
            (
                [
                    (
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    ),
                    (
                        header::CONTENT_DISPOSITION,
                        HeaderValue::from_str(&disposition).unwrap(),
                    ),
                ],
                serde_json::to_vec(&value).unwrap(),
            )
                .into_response()
        }
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

fn api_authorized(state: &UiState, headers: &HeaderMap) -> bool {
    has_session_cookie(state, headers)
        && headers
            .get("x-owp-csrf")
            .and_then(|value| value.to_str().ok())
            == Some("1")
}

fn has_session_cookie(state: &UiState, headers: &HeaderMap) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .any(|part| part.trim() == format!("owp_ui={}", state.session))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{CheckStatus, DiagnosticCheck};

    struct FakeChecks;

    impl Checks for FakeChecks {
        fn snapshot(&self) -> anyhow::Result<Snapshot> {
            Ok(Snapshot {
                owpctl_version: crate::VERSION,
                instance: Some(Instance {
                    jellyfin: "http://localhost:8096".to_string(),
                    websocket: "ws://localhost:3000/ws".to_string(),
                }),
                report: fake_report(),
            })
        }

        fn bundle(&self, report: &DiagnosticReport) -> anyhow::Result<serde_json::Value> {
            Ok(crate::diagnostics::bundle(report, None, None, None))
        }
    }

    fn fake_report() -> DiagnosticReport {
        DiagnosticReport {
            overall: CheckStatus::Pass,
            installed_version: Some("0.8.0".to_string()),
            checks: vec![DiagnosticCheck {
                id: "docker",
                status: CheckStatus::Pass,
                summary: "29.1.3".to_string(),
            }],
        }
    }

    fn serve() -> (String, u16) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(
            Arc::new(FakeChecks),
            "launch-secret".to_string(),
            "session-secret".to_string(),
            port,
        );
        let _server = std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    axum::serve(listener, app).await.unwrap();
                });
        });
        (format!("http://127.0.0.1:{port}"), port)
    }

    #[test]
    fn dashboard_access_report_and_bundle() {
        let (base, port) = serve();
        let client = reqwest::blocking::Client::new();

        assert_eq!(
            client.get(format!("{base}/")).send().unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/?token=wrong"))
                .send()
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let response = client
            .get(format!("{base}/?token=launch-secret"))
            .send()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("owp_ui=session-secret;"));
        assert!(response.headers().contains_key("content-security-policy"));

        assert_eq!(
            client
                .get(format!("{base}/?token=launch-secret"))
                .send()
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/"))
                .header(header::COOKIE, "owp_ui=session-secret")
                .send()
                .unwrap()
                .status(),
            StatusCode::OK
        );

        assert_eq!(
            client
                .get(format!("{base}/api/report"))
                .send()
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{base}/api/report"))
                .header(header::COOKIE, "owp_ui=session-secret")
                .send()
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{base}/api/report"))
                .header("x-owp-csrf", "1")
                .send()
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{base}/api/report"))
                .header(header::COOKIE, "owp_ui=wrong")
                .header("x-owp-csrf", "1")
                .send()
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{base}/"))
                .header(header::COOKIE, "owp_ui=wrong")
                .send()
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .get(format!("{base}/api/report"))
            .header(header::COOKIE, "owp_ui=session-secret")
            .header("x-owp-csrf", "1")
            .send()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().unwrap();
        assert_eq!(body["owpctl_version"], crate::VERSION);
        assert_eq!(body["instance"]["jellyfin"], "http://localhost:8096");
        assert_eq!(body["report"]["checks"][0]["id"], "docker");

        assert_eq!(
            client
                .get(format!("{base}/api/report"))
                .header(header::HOST, format!("evil.example:{port}"))
                .header(header::COOKIE, "owp_ui=session-secret")
                .header("x-owp-csrf", "1")
                .send()
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );

        let response = client
            .get(format!("{base}/api/bundle"))
            .header(header::COOKIE, "owp_ui=session-secret")
            .header("x-owp-csrf", "1")
            .send()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/json"
        );
        assert!(response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("attachment; filename=\"owp-support-"));
        let body: serde_json::Value = response.json().unwrap();
        assert_eq!(body["tool"], "owpctl");
        assert_eq!(body["report"]["checks"][0]["id"], "docker");
    }

    #[test]
    fn plugin_report_without_token_is_skipped_without_warning() {
        let mut report = fake_report();
        let check_count = report.checks.len();
        let config =
            DesiredConfig::local(url::Url::parse("http://localhost:8096").unwrap()).unwrap();
        let plugin_report =
            crate::diagnostics::collect_plugin_report(&mut report, Some(&config), None);
        assert!(plugin_report.is_none());
        assert_eq!(report.checks.len(), check_count);
    }
}
