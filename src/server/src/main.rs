mod auth;
mod messaging;
mod room;
mod routes;
mod tasks;
mod types;
mod utils;
mod ws;

#[cfg(test)]
mod test_helpers;

use crate::auth::JwtConfig;
use crate::types::{ServerState, SharedState};
use log::{info, warn};
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use warp::Filter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let default_log_level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_log_level))
        .init();

    let jwt_config = Arc::new(
        JwtConfig::from_env()
            .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?,
    );
    let allowed_origins = Arc::new(routes::get_allowed_origins());
    let ingress_config = routes::IngressConfig::from_env()
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;

    info!("Allowed origins: {:?}", allowed_origins);
    info!(
        "JWT: {}",
        if jwt_config.enabled {
            "ENABLED"
        } else {
            "INSECURE DEVELOPMENT MODE"
        }
    );

    let state: SharedState = Arc::new(RwLock::new(ServerState::default()));
    let app_tasks = tasks::AppTasks::new();

    tasks::spawn_zombie_cleanup(state.clone(), &app_tasks);

    let routes = routes::build_ws_route_with_tasks(
        state,
        jwt_config.clone(),
        allowed_origins.clone(),
        ingress_config,
        app_tasks.clone(),
    )
    .or(routes::build_health_route(jwt_config, allowed_origins))
    .recover(routes::handle_rejection);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("Invalid HOST:PORT combination");
    let shutdown_signal = tasks::shutdown_signal();

    info!("OpenWatchParty server listening on {}", addr);
    let cancellation = app_tasks.cancellation_token();
    let server = warp::serve(routes)
        .bind(addr)
        .await
        .graceful(cancellation.cancelled_owned())
        .run();
    let mut server_task = tokio::spawn(server);

    tokio::select! {
        result = &mut server_task => {
            result?;
            app_tasks.cancel();
            app_tasks.wait().await;
        }
        _ = shutdown_signal => {
            app_tasks.cancel();
            let graceful = async {
                let result = (&mut server_task).await;
                app_tasks.wait().await;
                result
            };
            if tokio::time::timeout(tasks::SHUTDOWN_GRACE_PERIOD, graceful)
                .await
                .is_err()
            {
                let aborted = app_tasks.abort_remaining();
                warn!("Graceful shutdown deadline elapsed; aborting {aborted} application tasks");
                server_task.abort();
                let _ = server_task.await;
                app_tasks.wait().await;
            }
        }
    }
    info!("Server shutdown complete");
    Ok(())
}
