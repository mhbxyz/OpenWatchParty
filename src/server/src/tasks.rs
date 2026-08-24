use crate::types::SharedState;
use log::{info, warn};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

const ZOMBIE_CHECK_INTERVAL_SECS: u64 = 30;
const ZOMBIE_TIMEOUT: Duration = Duration::from_secs(60);
pub const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(5);

fn is_zombie(client: &crate::types::Client, now: Instant) -> bool {
    crate::utils::elapsed_saturating(now, client.last_seen) > ZOMBIE_TIMEOUT
}

#[derive(Clone)]
pub struct AppTasks {
    cancellation: CancellationToken,
    tracker: TaskTracker,
    abort_handles: Arc<Mutex<HashMap<u64, AbortHandle>>>,
    next_id: Arc<AtomicU64>,
}

struct TrackedTaskGuard {
    id: u64,
    abort_handles: Arc<Mutex<HashMap<u64, AbortHandle>>>,
}

impl Drop for TrackedTaskGuard {
    fn drop(&mut self) {
        self.abort_handles.lock().unwrap().remove(&self.id);
    }
}

impl AppTasks {
    pub fn new() -> Self {
        Self {
            cancellation: CancellationToken::new(),
            tracker: TaskTracker::new(),
            abort_handles: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn spawn<F>(&self, future: F) -> JoinHandle<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let abort_handles = self.abort_handles.clone();
        let (start_tx, start_rx) = tokio::sync::oneshot::channel();
        let guard = TrackedTaskGuard { id, abort_handles };
        let handle = self.tracker.spawn(async move {
            let _guard = guard;
            if start_rx.await.is_err() {
                return;
            }
            future.await;
        });
        self.abort_handles
            .lock()
            .unwrap()
            .insert(id, handle.abort_handle());
        let _ = start_tx.send(());
        handle
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
        self.tracker.close();
    }

    pub async fn wait(&self) {
        self.tracker.wait().await;
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.abort_handles.lock().unwrap().len()
    }

    pub fn abort_remaining(&self) -> usize {
        let handles: Vec<_> = self
            .abort_handles
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        let count = handles.len();
        for handle in handles {
            handle.abort();
        }
        count
    }
}

pub fn spawn_zombie_cleanup(state: SharedState, tasks: &AppTasks) -> JoinHandle<()> {
    let cancellation = tasks.cancellation_token();
    tasks.spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(ZOMBIE_CHECK_INTERVAL_SECS)) => {}
            }
            if cancellation.is_cancelled() {
                break;
            }
            let now = Instant::now();
            let zombies: Vec<String> = {
                let locked_state = state.read().await;
                if cancellation.is_cancelled() {
                    return;
                }
                locked_state
                    .clients
                    .iter()
                    .filter(|(_, client)| is_zombie(client, now))
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for id in zombies {
                if cancellation.is_cancelled() {
                    return;
                }
                warn!("Removing zombie connection: {}", id);
                crate::room::handle_disconnect(&id, &state).await;
            }
        }
    })
}

#[cfg(test)]
pub async fn shutdown_app_tasks(tasks: &AppTasks, grace_period: Duration) -> usize {
    tasks.cancel();
    if tokio::time::timeout(grace_period, tasks.wait())
        .await
        .is_ok()
    {
        return 0;
    }
    let aborted = tasks.abort_remaining();
    tasks.wait().await;
    aborted
}

pub fn shutdown_signal() -> Pin<Box<dyn Future<Output = ()> + Send>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm =
            signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
        let mut sigint =
            signal(SignalKind::interrupt()).expect("Failed to register SIGINT handler");
        Box::pin(async move {
            tokio::select! {
                _ = sigterm.recv() => info!("Received SIGTERM, initiating graceful shutdown..."),
                _ = sigint.recv() => info!("Received SIGINT, initiating graceful shutdown..."),
            }
        })
    }
    #[cfg(not(unix))]
    {
        Box::pin(async {
            tokio::signal::ctrl_c()
                .await
                .expect("Failed to listen for Ctrl+C");
            info!("Received Ctrl+C, initiating graceful shutdown...");
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn sleeping_cleanup_stops_on_cancellation() {
        let tasks = AppTasks::new();
        let cleanup = spawn_zombie_cleanup(crate::test_helpers::create_state(), &tasks);
        tokio::task::yield_now().await;

        assert_eq!(shutdown_app_tasks(&tasks, Duration::from_secs(1)).await, 0);
        cleanup.await.unwrap();
        assert_eq!(tasks.active_count(), 0);
    }

    #[test]
    fn zombie_detection_uses_saturating_monotonic_elapsed_time() {
        let (mut client, _rx) = crate::test_helpers::create_client_with_rx("u1", "User", true);
        let start = Instant::now();
        client.last_seen = start;
        let wall_before = 10_000_u64;
        let wall_after = 9_000_u64;

        assert!(wall_after < wall_before);
        assert!(!is_zombie(&client, start - Duration::from_secs(1)));
        assert!(is_zombie(
            &client,
            start + ZOMBIE_TIMEOUT + Duration::from_millis(1)
        ));
    }

    #[tokio::test]
    async fn tasks_past_deadline_are_aborted_and_fully_reaped() {
        let tasks = AppTasks::new();
        tasks.spawn(std::future::pending());
        tokio::task::yield_now().await;

        assert_eq!(
            shutdown_app_tasks(&tasks, Duration::from_millis(10)).await,
            1
        );
        assert_eq!(tasks.active_count(), 0);
    }
}
