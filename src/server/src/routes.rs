use crate::auth::JwtConfig;
use crate::types::SharedState;
use ipnet::IpNet;
use log::warn;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use warp::{Filter, Reply};

const DEFAULT_MAX_CONNECTIONS: usize = 256;
const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 32;
const DEFAULT_AUTH_TIMEOUT_SECONDS: u64 = 10;

#[derive(Debug)]
struct OriginRejected;
impl warp::reject::Reject for OriginRejected {}

#[derive(Debug)]
struct ConnectionLimitRejected;
impl warp::reject::Reject for ConnectionLimitRejected {}

#[derive(Clone, Debug)]
pub struct IngressConfig {
    max_connections: usize,
    max_connections_per_ip: usize,
    trusted_proxies: Vec<IpNet>,
    auth_timeout: Duration,
}

impl IngressConfig {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            max_connections: parse_positive_env("MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS)?,
            max_connections_per_ip: parse_positive_env(
                "MAX_CONNECTIONS_PER_IP",
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            trusted_proxies: parse_trusted_proxies(
                &std::env::var("TRUSTED_PROXIES").unwrap_or_default(),
            )?,
            auth_timeout: Duration::from_secs(parse_positive_env(
                "AUTH_TIMEOUT_SECONDS",
                DEFAULT_AUTH_TIMEOUT_SECONDS,
            )?),
        })
    }
}

fn parse_positive_env<T>(name: &str, default: T) -> Result<T, String>
where
    T: std::str::FromStr + PartialOrd + Default + Copy,
{
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<T>()
            .map_err(|_| format!("{name} must be a positive integer"))?,
        Err(_) => default,
    };
    if value <= T::default() {
        return Err(format!("{name} must be a positive integer"));
    }
    Ok(value)
}

fn parse_trusted_proxies(value: &str) -> Result<Vec<IpNet>, String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .parse::<IpNet>()
                .or_else(|_| entry.parse::<IpAddr>().map(IpNet::from))
                .map_err(|_| format!("TRUSTED_PROXIES contains an invalid IP or CIDR: {entry}"))
        })
        .collect()
}

#[derive(Clone)]
struct ConnectionLimiter {
    global: Arc<Semaphore>,
    per_ip_limit: usize,
    per_ip: Arc<Mutex<HashMap<IpAddr, Arc<Semaphore>>>>,
}

impl ConnectionLimiter {
    fn new(global_limit: usize, per_ip_limit: usize) -> Self {
        Self {
            global: Arc::new(Semaphore::new(global_limit)),
            per_ip_limit,
            per_ip: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn try_acquire(&self, ip: IpAddr) -> Option<ConnectionPermit> {
        let global_permit = self.global.clone().try_acquire_owned().ok()?;
        let ip_semaphore = self
            .per_ip
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(ip)
            .or_insert_with(|| Arc::new(Semaphore::new(self.per_ip_limit)))
            .clone();
        let ip_permit = ip_semaphore.clone().try_acquire_owned().ok()?;

        Some(ConnectionPermit {
            global_permit: Some(global_permit),
            ip_permit: Some(ip_permit),
            ip,
            ip_semaphore,
            limiter: self.clone(),
        })
    }
}

struct ConnectionPermit {
    global_permit: Option<OwnedSemaphorePermit>,
    ip_permit: Option<OwnedSemaphorePermit>,
    ip: IpAddr,
    ip_semaphore: Arc<Semaphore>,
    limiter: ConnectionLimiter,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.ip_permit.take();
        self.global_permit.take();
        let mut per_ip = self
            .limiter
            .per_ip
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.ip_semaphore.available_permits() == self.limiter.per_ip_limit
            && Arc::strong_count(&self.ip_semaphore) == 2
            && per_ip
                .get(&self.ip)
                .is_some_and(|current| Arc::ptr_eq(current, &self.ip_semaphore))
        {
            per_ip.remove(&self.ip);
        }
    }
}

fn client_ip(
    remote: Option<SocketAddr>,
    forwarded_for: Option<&str>,
    trusted_proxies: &[IpNet],
) -> IpAddr {
    let remote_ip = remote
        .map(|address| address.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    if trusted_proxies
        .iter()
        .any(|network| network.contains(&remote_ip))
    {
        if let Some(header) = forwarded_for {
            let forwarded: Vec<IpAddr> = header
                .split(',')
                .filter_map(|value| value.trim().parse::<IpAddr>().ok())
                .collect();
            if let Some(client) = forwarded
                .iter()
                .rev()
                .find(|ip| !trusted_proxies.iter().any(|network| network.contains(*ip)))
            {
                return *client;
            }
            if let Some(client) = forwarded.first() {
                return *client;
            }
        }
    }
    remote_ip
}

pub fn get_allowed_origins() -> Vec<String> {
    std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:8096,https://localhost:8096".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn is_origin_allowed(origin: &str, allowed: &Arc<Vec<String>>) -> bool {
    if allowed.iter().any(|o| o == "*") {
        warn!("SECURITY: Wildcard origin (*) configured - ALL origins allowed. This disables CORS protection!");
        return true;
    }
    allowed.iter().any(|o| o == origin)
}

#[cfg(test)]
pub fn build_ws_route(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
    ingress_config: IngressConfig,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    build_ws_route_with_tasks(
        state,
        jwt_config,
        allowed_origins,
        ingress_config,
        crate::tasks::AppTasks::new(),
    )
}

pub fn build_ws_route_with_tasks(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
    ingress_config: IngressConfig,
    tasks: crate::tasks::AppTasks,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    build_ws_route_with_clock(
        state,
        jwt_config,
        allowed_origins,
        ingress_config,
        Arc::new(crate::utils::now_ms),
        tasks,
    )
}

fn build_ws_route_with_clock(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
    ingress_config: IngressConfig,
    session_clock: crate::ws::SessionClock,
    tasks: crate::tasks::AppTasks,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let state_filter = warp::any().map(move || state.clone());
    let jwt_filter = {
        let config = jwt_config;
        warp::any().map(move || config.clone())
    };
    let allowed_origins_filter = {
        let origins = allowed_origins;
        warp::any().map(move || origins.clone())
    };
    let limiter = ConnectionLimiter::new(
        ingress_config.max_connections,
        ingress_config.max_connections_per_ip,
    );
    let trusted_proxies = Arc::new(ingress_config.trusted_proxies);
    let auth_timeout = ingress_config.auth_timeout;
    let clock_filter = warp::any().map(move || session_clock.clone());
    let tasks_filter = warp::any().map(move || tasks.clone());

    let admission = warp::addr::remote()
        .and(warp::header::optional::<String>("x-forwarded-for"))
        .and_then(move |remote, forwarded_for: Option<String>| {
            let limiter = limiter.clone();
            let trusted_proxies = trusted_proxies.clone();
            async move {
                let ip = client_ip(remote, forwarded_for.as_deref(), &trusted_proxies);
                limiter
                    .try_acquire(ip)
                    .ok_or_else(|| warp::reject::custom(ConnectionLimitRejected))
            }
        });

    let origin_check = warp::header::optional::<String>("origin")
        .and(allowed_origins_filter)
        .and_then(
            |origin: Option<String>, allowed: Arc<Vec<String>>| async move {
                match origin {
                    Some(ref o) if is_origin_allowed(o, &allowed) => Ok(()),
                    Some(o) => {
                        warn!("Rejected connection from origin: {}", o);
                        Err(warp::reject::custom(OriginRejected))
                    }
                    None => Ok(()),
                }
            },
        )
        .untuple_one();

    warp::path("ws")
        .and(origin_check)
        .and(admission)
        .and(warp::ws())
        .and(state_filter)
        .and(jwt_filter)
        .and(clock_filter)
        .and(tasks_filter)
        .map(
            move |permit,
                  ws: warp::ws::Ws,
                  state,
                  jwt_config: Arc<JwtConfig>,
                  session_clock,
                  tasks: crate::tasks::AppTasks| {
                ws.max_message_size(crate::ws::constants::MAX_MESSAGE_SIZE)
                    .max_frame_size(crate::ws::constants::MAX_FRAME_SIZE)
                    .on_upgrade(move |socket| async move {
                        let connection_tasks = tasks.clone();
                        let connection = tasks.spawn(async move {
                            let _permit = permit;
                            crate::ws::client_connection(
                                socket,
                                state,
                                jwt_config,
                                auth_timeout,
                                session_clock,
                                connection_tasks,
                            )
                            .await;
                        });
                        let _ = connection.await;
                    })
            },
        )
}

pub async fn handle_rejection(
    rejection: warp::Rejection,
) -> Result<warp::reply::Response, warp::Rejection> {
    let status = if rejection.find::<ConnectionLimitRejected>().is_some() {
        Some(warp::http::StatusCode::TOO_MANY_REQUESTS)
    } else if rejection.find::<OriginRejected>().is_some() {
        Some(warp::http::StatusCode::FORBIDDEN)
    } else {
        None
    };
    match status {
        Some(status) => Ok(warp::reply::with_status(
            status.canonical_reason().unwrap_or("Rejected"),
            status,
        )
        .into_response()),
        None => Err(rejection),
    }
}

pub fn build_health_route(
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let jwt_filter = warp::any().map(move || jwt_config.clone());

    let cors = if allowed_origins.iter().any(|o| o == "*") {
        warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET"])
            .allow_headers(vec!["content-type"])
    } else {
        warp::cors()
            .allow_origins(
                allowed_origins
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>(),
            )
            .allow_methods(vec!["GET"])
            .allow_headers(vec!["content-type"])
    };

    warp::path("health")
        .and(warp::get())
        .and(jwt_filter)
        .map(|jwt_config: Arc<JwtConfig>| {
            warp::reply::json(&serde_json::json!({
                "status": "ok",
                "auth_enabled": jwt_config.enabled
            }))
        })
        .with(cors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Claims;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn is_origin_allowed_exact_match() {
        let allowed = Arc::new(vec!["https://example.com".to_string()]);
        assert!(is_origin_allowed("https://example.com", &allowed));
    }

    #[test]
    fn is_origin_allowed_no_match() {
        let allowed = Arc::new(vec!["https://example.com".to_string()]);
        assert!(!is_origin_allowed("https://other.com", &allowed));
    }

    #[test]
    fn is_origin_allowed_wildcard() {
        let allowed = Arc::new(vec!["*".to_string()]);
        assert!(is_origin_allowed("https://anything.com", &allowed));
    }

    #[test]
    fn is_origin_allowed_empty_list() {
        let allowed = Arc::new(vec![]);
        assert!(!is_origin_allowed("https://example.com", &allowed));
    }

    #[test]
    fn is_origin_allowed_multiple_origins() {
        let allowed = Arc::new(vec![
            "https://a.com".to_string(),
            "https://b.com".to_string(),
        ]);
        assert!(is_origin_allowed("https://b.com", &allowed));
        assert!(!is_origin_allowed("https://c.com", &allowed));
    }

    #[test]
    fn get_allowed_origins_default() {
        // Without modifying env vars, just verify the parsing logic:
        // The function splits on comma, trims, and filters empty
        let result = get_allowed_origins();
        assert!(!result.is_empty());
        // Each entry should be trimmed (no leading/trailing whitespace)
        for origin in &result {
            assert_eq!(origin, origin.trim());
            assert!(!origin.is_empty());
        }
    }

    #[test]
    fn connection_limits_are_global_per_ip_and_released_on_drop() {
        let limiter = ConnectionLimiter::new(2, 1);
        let first_ip = IpAddr::from([192, 0, 2, 1]);
        let second_ip = IpAddr::from([192, 0, 2, 2]);
        let first = limiter.try_acquire(first_ip).unwrap();
        assert!(limiter.try_acquire(first_ip).is_none());
        let second = limiter.try_acquire(second_ip).unwrap();
        assert!(limiter.try_acquire(IpAddr::from([192, 0, 2, 3])).is_none());

        drop(first);
        assert!(limiter.try_acquire(first_ip).is_some());
        drop(second);
    }

    #[test]
    fn forwarded_for_requires_a_trusted_proxy() {
        let trusted = vec!["10.0.0.0/8".parse().unwrap()];
        let forwarded = Some("203.0.113.9, 10.0.0.2");

        assert_eq!(
            client_ip(Some("10.1.2.3:1234".parse().unwrap()), forwarded, &trusted),
            IpAddr::from([203, 0, 113, 9])
        );
        assert_eq!(
            client_ip(Some("192.0.2.4:1234".parse().unwrap()), forwarded, &trusted),
            IpAddr::from([192, 0, 2, 4])
        );
        assert_eq!(
            client_ip(
                Some("10.1.2.3:1234".parse().unwrap()),
                Some("198.51.100.66, 203.0.113.9, 10.0.0.2"),
                &trusted,
            ),
            IpAddr::from([203, 0, 113, 9])
        );
    }

    #[test]
    fn transport_limits_are_fixed_at_sixty_four_kibibytes() {
        assert_eq!(crate::ws::constants::MAX_MESSAGE_SIZE, 64 * 1024);
        assert_eq!(crate::ws::constants::MAX_FRAME_SIZE, 64 * 1024);
    }

    fn test_ingress_config(auth_timeout: Duration) -> IngressConfig {
        IngressConfig {
            max_connections: 8,
            max_connections_per_ip: 4,
            trusted_proxies: Vec::new(),
            auth_timeout,
        }
    }

    fn test_jwt_config(enabled: bool) -> Arc<JwtConfig> {
        Arc::new(JwtConfig {
            secret: if enabled {
                "not-used-by-this-test".to_string()
            } else {
                String::new()
            },
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled,
        })
    }

    fn token_with_expiration(config: &JwtConfig, expiration: u64) -> String {
        encode(
            &Header::default(),
            &Claims {
                sub: "user".to_string(),
                name: "Alice".to_string(),
                aud: config.audience.clone(),
                iss: config.issuer.clone(),
                exp: expiration as usize,
                iat: (crate::utils::now_ms() / 1000) as usize,
            },
            &EncodingKey::from_secret(config.secret.as_bytes()),
        )
        .unwrap()
    }

    async fn authenticate(client: &mut warp::test::WsClient, token: &str) {
        client
            .send_text(format!(
                r#"{{"type":"auth","payload":{{"token":"{token}"}},"ts":0}}"#
            ))
            .await;
        for expected in ["auth_success", "room_list"] {
            let response: serde_json::Value =
                serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();
            assert_eq!(response["type"], expected);
        }
    }

    #[tokio::test]
    async fn unauthenticated_jwt_connection_times_out_and_is_cleaned_up() {
        let state = crate::test_helpers::create_state();
        let route = build_ws_route(
            state.clone(),
            test_jwt_config(true),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_millis(20)),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                client.recv().await.unwrap().to_str().unwrap()
            )
            .unwrap()["type"],
            "client_hello"
        );
        tokio::time::timeout(Duration::from_secs(1), client.recv_closed())
            .await
            .unwrap()
            .unwrap();
        tokio::task::yield_now().await;
        assert!(state.read().await.clients.is_empty());
    }

    #[tokio::test]
    async fn outbound_failure_signal_closes_and_cleans_up_connection() {
        let state = crate::test_helpers::create_state();
        let route = build_ws_route(
            state.clone(),
            test_jwt_config(false),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();
        client.recv().await.unwrap();
        client.recv().await.unwrap();

        let sender = state
            .read()
            .await
            .clients
            .values()
            .next()
            .unwrap()
            .sender
            .clone();
        sender.request_disconnect();

        tokio::time::timeout(Duration::from_secs(1), client.recv_closed())
            .await
            .unwrap()
            .unwrap();
        tokio::task::yield_now().await;
        assert!(state.read().await.clients.is_empty());
    }

    #[tokio::test]
    async fn shutdown_closes_active_socket_and_reaps_connection_task() {
        let state = crate::test_helpers::create_state();
        let tasks = crate::tasks::AppTasks::new();
        let route = build_ws_route_with_tasks(
            state.clone(),
            test_jwt_config(false),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
            tasks.clone(),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();
        client.recv().await.unwrap();
        client.recv().await.unwrap();

        tasks.cancel();
        client.recv_closed().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), tasks.wait())
            .await
            .expect("connection task survived shutdown");

        assert!(state.read().await.clients.is_empty());
        assert_eq!(tasks.active_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn authenticated_session_is_valid_before_its_expiration() {
        let state = crate::test_helpers::create_state();
        let jwt_config = test_jwt_config(true);
        let route = build_ws_route(
            state.clone(),
            jwt_config.clone(),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();
        client.recv().await.unwrap();
        let expiration = crate::utils::now_ms() / 1000 + 60;

        authenticate(&mut client, &token_with_expiration(&jwt_config, expiration)).await;
        client.send_text(r#"{"type":"ping","ts":0}"#).await;
        let response: serde_json::Value =
            serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();

        assert_eq!(response["type"], "pong");
        let locked = state.read().await;
        let authenticated = locked.clients.values().next().unwrap();
        assert!(authenticated.authenticated);
        assert_eq!(authenticated.session_expires_at, Some(expiration));
    }

    #[tokio::test(start_paused = true)]
    async fn authenticated_session_expires_without_inbound_traffic_and_is_cleaned_up() {
        let state = crate::test_helpers::create_state();
        let jwt_config = test_jwt_config(true);
        let wall_clock = Arc::new(AtomicU64::new(crate::utils::now_ms()));
        let session_clock: crate::ws::SessionClock = {
            let wall_clock = wall_clock.clone();
            Arc::new(move || wall_clock.load(Ordering::SeqCst))
        };
        let route = build_ws_route_with_clock(
            state.clone(),
            jwt_config.clone(),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
            session_clock,
            crate::tasks::AppTasks::new(),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();
        client.recv().await.unwrap();
        let expiration = crate::utils::now_ms() / 1000 + 10;
        authenticate(&mut client, &token_with_expiration(&jwt_config, expiration)).await;

        wall_clock.store(expiration * 1000, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(1)).await;
        client.recv_closed().await.unwrap();
        tokio::task::yield_now().await;

        assert!(state.read().await.clients.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn valid_refresh_rearms_the_session_expiration() {
        let state = crate::test_helpers::create_state();
        let jwt_config = test_jwt_config(true);
        let route = build_ws_route(
            state.clone(),
            jwt_config.clone(),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();
        client.recv().await.unwrap();
        let now = crate::utils::now_ms() / 1000;
        authenticate(&mut client, &token_with_expiration(&jwt_config, now + 60)).await;

        tokio::time::advance(Duration::from_secs(30)).await;
        authenticate(&mut client, &token_with_expiration(&jwt_config, now + 120)).await;
        tokio::time::advance(Duration::from_secs(31)).await;
        client.send_text(r#"{"type":"ping","ts":0}"#).await;
        let response: serde_json::Value =
            serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();

        assert_eq!(response["type"], "pong");
        let locked = state.read().await;
        let authenticated = locked.clients.values().next().unwrap();
        assert_eq!(authenticated.session_expires_at, Some(now + 120));
        assert_eq!(authenticated.authentication_version, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn insecure_connection_has_no_authentication_timeout() {
        let state = crate::test_helpers::create_state();
        let route = build_ws_route(
            state.clone(),
            test_jwt_config(false),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_millis(10)),
        );
        let mut client = warp::test::ws()
            .path("/ws")
            .header("origin", "https://example.com")
            .handshake(route)
            .await
            .unwrap();

        client.recv().await.unwrap();
        client.recv().await.unwrap();
        tokio::time::advance(Duration::from_secs(3_600)).await;
        client.send_text(r#"{"type":"ping","ts":0}"#).await;
        let response: serde_json::Value =
            serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();
        assert_eq!(response["type"], "pong");
        assert_eq!(
            state
                .read()
                .await
                .clients
                .values()
                .next()
                .unwrap()
                .session_expires_at,
            None
        );
    }
}
