mod auth;
mod messaging;
mod room;
mod types;
mod utils;
mod ws;

use std::sync::Arc;
use std::time::Duration;
use log::{info, warn};
use warp::Filter;
use crate::auth::JwtConfig;
use crate::types::{Clients, Rooms};
use crate::utils::now_ms;

// Zombie connection detection
const ZOMBIE_CHECK_INTERVAL_SECS: u64 = 30;
const ZOMBIE_TIMEOUT_MS: u64 = 60_000;  // 60 seconds without message = zombie

fn get_allowed_origins() -> Vec<String> {
    std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:8096,https://localhost:8096".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// P-RS10 fix: Accept Arc<Vec<String>> to avoid cloning on each request
fn is_origin_allowed(origin: &str, allowed: &Arc<Vec<String>>) -> bool {
    if allowed.iter().any(|o| o == "*") {
        // Security warning: wildcard allows all origins
        warn!("SECURITY: Wildcard origin (*) configured - ALL origins allowed. This disables CORS protection!");
        return true;
    }
    allowed.iter().any(|o| o == origin)
}

#[tokio::main]
async fn main() {
    // Initialize logger with default level INFO (can override with RUST_LOG env var)
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).init();

    let jwt_config = Arc::new(JwtConfig::from_env());
    // P-RS10 fix: Wrap in Arc to avoid cloning on each request
    let allowed_origins = Arc::new(get_allowed_origins());

    info!("Allowed origins: {:?}", allowed_origins);
    info!("JWT authentication: {}", if jwt_config.enabled { "ENABLED" } else { "DISABLED" });

    let clients: Clients = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let rooms: Rooms = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));

    // Spawn zombie connection cleanup task
    {
        let clients_clone = clients.clone();
        let rooms_clone = rooms.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(ZOMBIE_CHECK_INTERVAL_SECS)).await;
                let now = now_ms();
                let mut zombies = Vec::new();

                // Find zombie clients
                {
                    let locked_clients = clients_clone.read().await;
                    for (id, client) in locked_clients.iter() {
                        if now - client.last_seen > ZOMBIE_TIMEOUT_MS {
                            zombies.push(id.clone());
                        }
                    }
                }

                // Disconnect zombies
                for id in zombies {
                    warn!("Removing zombie connection: {}", id);
                    room::handle_disconnect(&id, &clients_clone, &rooms_clone).await;
                }
            }
        });
    }

    let clients_filter = warp::any().map(move || clients.clone());
    let rooms_filter = warp::any().map(move || rooms.clone());
    let jwt_filter = {
        let config = jwt_config.clone();
        warp::any().map(move || config.clone())
    };

    // P-RS10 fix: Clone Arc (cheap) instead of Vec (expensive) on each request
    let allowed_origins_filter = {
        let origins = allowed_origins.clone();
        warp::any().map(move || origins.clone())
    };

    // Origin validation filter
    let origin_check = warp::header::optional::<String>("origin")
        .and(allowed_origins_filter.clone())
        .and_then(|origin: Option<String>, allowed: Arc<Vec<String>>| async move {
            match origin {
                Some(ref o) if is_origin_allowed(o, &allowed) => Ok(()),
                Some(o) => {
                    warn!("Rejected connection from origin: {}", o);
                    Err(warp::reject::custom(OriginRejected))
                }
                None => Ok(()), // Allow connections without Origin header (non-browser clients)
            }
        })
        .untuple_one();

    // WebSocket route with Origin validation (auth via message after connection)
    let ws_route = warp::path("ws")
        .and(origin_check)
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .and(jwt_filter.clone())
        .map(|ws: warp::ws::Ws, clients, rooms, jwt_config: Arc<JwtConfig>| {
            ws.on_upgrade(move |socket| ws::client_connection(socket, clients, rooms, jwt_config))
        });

    // Health check endpoint with CORS
    let cors = warp::cors()
        .allow_origins(allowed_origins.iter().map(|s| s.as_str()).collect::<Vec<_>>())
        .allow_methods(vec!["GET"])
        .allow_headers(vec!["content-type"]);

    let health_route = warp::path("health")
        .and(warp::get())
        .and(jwt_filter.clone())
        .map(|jwt_config: Arc<JwtConfig>| {
            warp::reply::json(&serde_json::json!({
                "status": "ok",
                "auth_enabled": jwt_config.enabled
            }))
        })
        .with(cors);

    let routes = ws_route.or(health_route);

    // Graceful shutdown support (fixes M-Q18)
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();

    // Spawn a task to handle shutdown signals
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
            let mut sigint = signal(SignalKind::interrupt()).expect("Failed to register SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => info!("Received SIGTERM, initiating graceful shutdown..."),
                _ = sigint.recv() => info!("Received SIGINT, initiating graceful shutdown..."),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.expect("Failed to listen for Ctrl+C");
            info!("Received Ctrl+C, initiating graceful shutdown...");
        }
        let _ = tx.send(());
    });

    info!("OpenWatchParty server listening on 0.0.0.0:3000");
    let (_, server) = warp::serve(routes)
        .bind_with_graceful_shutdown(([0, 0, 0, 0], 3000), async {
            rx.await.ok();
        });

    server.await;
    info!("Server shutdown complete");
}

#[derive(Debug)]
struct OriginRejected;
impl warp::reject::Reject for OriginRejected {}
