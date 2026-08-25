use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{config::DesiredConfig, paths::Paths};

#[derive(Clone)]
struct WebState {
    nonce: Arc<Mutex<Option<String>>>,
    session: String,
    origin: String,
    paths: Paths,
    dry_run: bool,
    shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct SetupRequest {
    jellyfin_url: String,
    admin_token: Option<String>,
    apply: bool,
}

#[derive(Serialize)]
struct SetupResponse {
    status: &'static str,
    config_file: String,
    plan: crate::installer::InstallationPlan,
}

pub fn run(paths: Paths, dry_run: bool) -> anyhow::Result<()> {
    tokio::runtime::Runtime::new()?.block_on(run_async(paths, dry_run))
}

async fn run_async(paths: Paths, dry_run: bool) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let token = random_token();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let origin = format!("http://{address}");
    let state = WebState {
        nonce: Arc::new(Mutex::new(Some(token.clone()))),
        session: random_token(),
        origin: origin.clone(),
        paths,
        dry_run,
        shutdown: Arc::new(Mutex::new(Some(shutdown_tx))),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/setup", post(setup))
        .with_state(state);
    let url = format!("{origin}/?token={token}");
    println!("Open this one-time setup URL:\n{url}");
    let _ = webbrowser::open(&url);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_rx => {},
                _ = tokio::time::sleep(Duration::from_secs(1800)) => {},
            }
        })
        .await?;
    Ok(())
}

async fn index(State(state): State<WebState>, Query(query): Query<TokenQuery>) -> Response {
    let valid = {
        let mut nonce = state.nonce.lock().unwrap();
        let valid = nonce
            .as_deref()
            .zip(query.token.as_deref())
            .is_some_and(|(expected, actual)| expected == actual);
        if valid {
            *nonce = None;
        }
        valid
    };
    if !valid {
        return (StatusCode::UNAUTHORIZED, "Invalid or consumed setup token").into_response();
    }
    let mut response = Html(INDEX_HTML).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "owp_setup={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800",
            state.session
        ))
        .unwrap(),
    );
    secure_headers(response.headers_mut());
    response
}

async fn setup(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(request): Json<SetupRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return (StatusCode::FORBIDDEN, "Invalid setup session").into_response();
    }
    let result = (|| -> anyhow::Result<SetupResponse> {
        let mut config = DesiredConfig::local(url::Url::parse(&request.jellyfin_url)?)?;
        config.session_server.allowed_origins =
            vec![config.jellyfin.public_origin.origin().ascii_serialization()];
        let plan = crate::installer::plan(crate::VERSION);
        if request.apply && !state.dry_run {
            let token = request
                .admin_token
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("admin token is required"))?;
            crate::storage::write_toml(&state.paths.config_file, &config)?;
            crate::installer::install(&state.paths, &config, crate::VERSION, token)?;
            if let Some(sender) = state.shutdown.lock().unwrap().take() {
                let _ = sender.send(());
            }
        }
        Ok(SetupResponse {
            status: if request.apply {
                "installed"
            } else {
                "planned"
            },
            config_file: state.paths.config_file.display().to_string(),
            plan,
        })
    })();
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    }
}

fn authorized(state: &WebState, headers: &HeaderMap) -> bool {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok());
    origin == Some(state.origin.as_str())
        && cookie.is_some_and(|value| {
            value
                .split(';')
                .any(|part| part.trim() == format!("owp_setup={}", state.session))
        })
        && headers
            .get("x-owp-csrf")
            .and_then(|value| value.to_str().ok())
            == Some("1")
}

fn secure_headers(headers: &mut HeaderMap) {
    headers.insert("content-security-policy", HeaderValue::from_static(
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

const INDEX_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenWatchParty Setup</title><style>body{font:16px system-ui;background:#111827;color:#f9fafb;max-width:760px;margin:3rem auto;padding:1rem}main{background:#1f2937;padding:2rem;border-radius:16px}label{display:block;margin:1rem 0}.hint{color:#9ca3af}input{width:100%;box-sizing:border-box;padding:.8rem;margin-top:.4rem}button{padding:.8rem 1.2rem;margin-right:.5rem}pre{white-space:pre-wrap}</style></head><body><main><h1>OpenWatchParty Setup</h1><p class="hint">Local one-time setup assistant.</p><label>Jellyfin URL<input id="url" value="http://localhost:8096"></label><label>Temporary Jellyfin admin API token<input id="token" type="password" autocomplete="off"></label><button id="plan">Preview plan</button><button id="install">Install</button><pre id="result"></pre></main><script>async function submit(apply){const response=await fetch('/api/setup',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-OWP-CSRF':'1'},body:JSON.stringify({jellyfin_url:document.querySelector('#url').value,admin_token:document.querySelector('#token').value,apply})});document.querySelector('#result').textContent=response.ok?JSON.stringify(await response.json(),null,2):await response.text();}document.querySelector('#plan').onclick=()=>submit(false);document.querySelector('#install').onclick=()=>submit(true);</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_require_origin_cookie_and_csrf() {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths::resolve(crate::cli::ScopeArg::User, Some(root.path())).unwrap();
        let (tx, _) = oneshot::channel();
        let state = WebState {
            nonce: Arc::new(Mutex::new(None)),
            session: "secret".into(),
            origin: "http://127.0.0.1:1234".into(),
            paths,
            dry_run: true,
            shutdown: Arc::new(Mutex::new(Some(tx))),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:1234"),
        );
        headers.insert(header::COOKIE, HeaderValue::from_static("owp_setup=secret"));
        headers.insert("x-owp-csrf", HeaderValue::from_static("1"));
        assert!(authorized(&state, &headers));
        headers.remove("x-owp-csrf");
        assert!(!authorized(&state, &headers));
    }
}
