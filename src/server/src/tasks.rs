use crate::types::SharedState;
use crate::utils::now_ms;
use log::{info, warn};
use std::time::Duration;
use tokio::sync::oneshot;

const ZOMBIE_CHECK_INTERVAL_SECS: u64 = 30;
const ZOMBIE_TIMEOUT_MS: u64 = 60_000;

pub fn spawn_zombie_cleanup(state: SharedState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(ZOMBIE_CHECK_INTERVAL_SECS)).await;
            let now = now_ms();
            let zombies: Vec<String> = {
                let locked_state = state.read().await;
                locked_state
                    .clients
                    .iter()
                    .filter(|(_, c)| now - c.last_seen > ZOMBIE_TIMEOUT_MS)
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for id in zombies {
                warn!("Removing zombie connection: {}", id);
                crate::room::handle_disconnect(&id, &state).await;
            }
        }
    });
}

pub fn setup_shutdown_signal() -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm =
                signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
            let mut sigint =
                signal(SignalKind::interrupt()).expect("Failed to register SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => info!("Received SIGTERM, initiating graceful shutdown..."),
                _ = sigint.recv() => info!("Received SIGINT, initiating graceful shutdown..."),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c()
                .await
                .expect("Failed to listen for Ctrl+C");
            info!("Received Ctrl+C, initiating graceful shutdown...");
        }
        let _ = tx.send(());
    });
    rx
}
