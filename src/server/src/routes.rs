use crate::auth::JwtConfig;
use crate::types::SharedState;
use ipnet::IpNet;
use log::warn;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use warp::{Filter, Reply};

const DEFAULT_MAX_CONNECTIONS: usize = 256;
const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 32;
const DEFAULT_AUTH_TIMEOUT_SECONDS: u64 = 10;
const DEFAULT_INVITE_REQUESTS_PER_MINUTE: u32 = 10;
const INVITE_RATE_WINDOW: Duration = Duration::from_secs(60);
// Bounded bookkeeping: entries are pruned once this many inviters are tracked.
const MAX_TRACKED_INVITERS: usize = 1024;
const MAX_INVITE_REQUEST_BYTES: u64 = 1024;

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

#[derive(Clone, Copy)]
struct InviteWindow {
    started: Instant,
    count: u32,
}

/// Fixed-window per-client limiter for invite-ticket requests, following the
/// WebSocket message limiter: the window starts with the first accepted request
/// and resets after `window`.
#[derive(Clone)]
pub struct InviteRateLimiter {
    max_requests: u32,
    window: Duration,
    clients: Arc<Mutex<HashMap<String, InviteWindow>>>,
}

impl InviteRateLimiter {
    pub fn new(max_requests: u32, window: Duration) -> Self {
        Self {
            max_requests,
            window,
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if clients.len() >= MAX_TRACKED_INVITERS && !clients.contains_key(key) {
            let window = self.window;
            clients.retain(|_, entry| now.duration_since(entry.started) < window);
        }
        let entry = clients.entry(key.to_string()).or_insert(InviteWindow {
            started: now,
            count: 0,
        });
        if now.duration_since(entry.started) >= self.window {
            entry.started = now;
            entry.count = 0;
        }
        entry.count += 1;
        entry.count <= self.max_requests
    }
}

#[derive(Debug, Deserialize)]
struct InviteRequest {
    room_id: String,
    #[serde(default)]
    ttl_seconds: Option<u64>,
}

fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let value = authorization?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

fn error_reply(status: warp::http::StatusCode, message: &str) -> warp::reply::Response {
    warp::reply::with_status(
        warp::reply::json(&serde_json::json!({ "error": message })),
        status,
    )
    .into_response()
}

async fn handle_invite_request(
    authorization: Option<String>,
    request: InviteRequest,
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    limiter: InviteRateLimiter,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !jwt_config.enabled {
        return Ok(error_reply(
            warp::http::StatusCode::SERVICE_UNAVAILABLE,
            "Invite links require JWT authentication with a shared secret",
        ));
    }
    let Some(token) = bearer_token(authorization.as_deref()) else {
        return Ok(error_reply(
            warp::http::StatusCode::UNAUTHORIZED,
            "Authentication required",
        ));
    };
    let claims = match jwt_config.validate_token(token) {
        Ok(claims) => claims,
        Err(_) => {
            return Ok(error_reply(
                warp::http::StatusCode::UNAUTHORIZED,
                "Invalid session token",
            ))
        }
    };
    if !limiter.allow(&claims.sub) {
        crate::metrics::metrics().rate_limited(crate::metrics::RateLimitScope::Invites);
        return Ok(error_reply(
            warp::http::StatusCode::TOO_MANY_REQUESTS,
            "Rate limit exceeded",
        ));
    }

    let is_host = {
        let locked = state.read().await;
        match locked.rooms.get(&request.room_id) {
            None => {
                return Ok(error_reply(
                    warp::http::StatusCode::NOT_FOUND,
                    "Room not found",
                ))
            }
            Some(room) => locked
                .clients
                .get(&room.host_id)
                .is_some_and(|client| client.user_id == claims.sub),
        }
    };
    if !is_host {
        return Ok(error_reply(
            warp::http::StatusCode::FORBIDDEN,
            "Only the room host can create invite links",
        ));
    }

    match jwt_config.mint_invite_ticket(&request.room_id, request.ttl_seconds) {
        Ok((ticket, expires_at)) => Ok(warp::reply::json(&serde_json::json!({
            "ticket": ticket,
            "expires_at": expires_at
        }))
        .into_response()),
        Err(error) => Ok(error_reply(
            warp::http::StatusCode::SERVICE_UNAVAILABLE,
            &error,
        )),
    }
}

fn build_cors(
    allowed_origins: &[String],
    methods: Vec<&'static str>,
    headers: Vec<&'static str>,
) -> warp::cors::Builder {
    if allowed_origins.iter().any(|o| o == "*") {
        warp::cors()
            .allow_any_origin()
            .allow_methods(methods)
            .allow_headers(headers)
    } else {
        warp::cors()
            .allow_origins(
                allowed_origins
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .allow_methods(methods)
            .allow_headers(headers)
    }
}

pub fn build_invite_route(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    build_invite_route_with_limiter(
        state,
        jwt_config,
        allowed_origins,
        InviteRateLimiter::new(DEFAULT_INVITE_REQUESTS_PER_MINUTE, INVITE_RATE_WINDOW),
    )
}

pub fn build_invite_route_with_limiter(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
    limiter: InviteRateLimiter,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let state_filter = warp::any().map(move || state.clone());
    let jwt_filter = {
        let config = jwt_config;
        warp::any().map(move || config.clone())
    };
    let limiter_filter = warp::any().map(move || limiter.clone());
    let cors = build_cors(
        &allowed_origins,
        vec!["POST"],
        vec!["authorization", "content-type"],
    );

    warp::path("invite")
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::content_length_limit(MAX_INVITE_REQUEST_BYTES))
        .and(warp::body::json::<InviteRequest>())
        .and(state_filter)
        .and(jwt_filter)
        .and(limiter_filter)
        .and_then(handle_invite_request)
        .with(cors)
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
                limiter.try_acquire(ip).ok_or_else(|| {
                    crate::metrics::metrics()
                        .connection_rejected(crate::metrics::RejectionReason::ConnectionLimit);
                    warp::reject::custom(ConnectionLimitRejected)
                })
            }
        });

    let origin_check = warp::header::optional::<String>("origin")
        .and(allowed_origins_filter)
        .and_then(
            |origin: Option<String>, allowed: Arc<Vec<String>>| async move {
                match origin {
                    Some(ref o) if is_origin_allowed(o, &allowed) => Ok(()),
                    Some(o) => {
                        warn!("Rejected connection from origin: {o}");
                        crate::metrics::metrics()
                            .connection_rejected(crate::metrics::RejectionReason::Origin);
                        Err(warp::reject::custom(OriginRejected))
                    }
                    None => Ok(()),
                }
            },
        )
        .untuple_one();

    // The upgrade is checked first, so a plain HTTP request to /ws neither
    // takes a connection permit nor counts as a rejected connection.
    warp::path("ws")
        .and(warp::ws())
        .and(origin_check)
        .and(admission)
        .and(state_filter)
        .and(jwt_filter)
        .and(clock_filter)
        .and(tasks_filter)
        .map(
            move |ws: warp::ws::Ws,
                  permit,
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
                "auth_enabled": jwt_config.enabled,
                "version": env!("CARGO_PKG_VERSION"),
                "protocol_version": crate::ws::constants::PROTOCOL_VERSION
            }))
        })
        .with(cors)
}

/// Every route the server serves, as `main` runs them.
pub fn build_routes(
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    allowed_origins: Arc<Vec<String>>,
    ingress_config: IngressConfig,
    tasks: crate::tasks::AppTasks,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    build_ws_route_with_tasks(
        state.clone(),
        jwt_config.clone(),
        allowed_origins.clone(),
        ingress_config,
        tasks.clone(),
    )
    .or(build_invite_route(
        state.clone(),
        jwt_config.clone(),
        allowed_origins.clone(),
    ))
    .or(build_health_route(jwt_config, allowed_origins))
    .or(build_metrics_route(state))
    .or(build_ready_route(tasks))
    .recover(handle_rejection)
}

/// `GET /metrics`: Prometheus text exposition. It is meant for a scraper on the
/// internal network, so it has no CORS headers; keep it off the public proxy.
pub fn build_metrics_route(
    state: SharedState,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let state_filter = warp::any().map(move || state.clone());
    warp::path("metrics")
        .and(warp::path::end())
        .and(warp::get())
        .and(state_filter)
        .then(|state: SharedState| async move {
            let text = crate::metrics::metrics().render(&*state.read().await);
            warp::reply::with_header(
                text,
                "content-type",
                "text/plain; version=0.0.4; charset=utf-8",
            )
        })
}

/// `GET /ready`: 200 while the server accepts new sessions, 503 once it has
/// started shutting down. `/health` keeps answering until the process exits.
pub fn build_ready_route(
    tasks: crate::tasks::AppTasks,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    warp::path("ready")
        .and(warp::path::end())
        .and(warp::get())
        .map(move || {
            let (status, code) = if tasks.cancellation_token().is_cancelled() {
                ("shutting_down", warp::http::StatusCode::SERVICE_UNAVAILABLE)
            } else {
                ("ready", warp::http::StatusCode::OK)
            };
            warp::reply::with_status(
                warp::reply::json(&serde_json::json!({ "status": status })),
                code,
            )
        })
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

    #[tokio::test]
    async fn health_reports_version_protocol_and_authentication() {
        let route = build_health_route(
            test_jwt_config(true),
            Arc::new(vec!["http://localhost:8096".to_string()]),
        );
        let response = warp::test::request()
            .method("GET")
            .path("/health")
            .reply(&route)
            .await;
        assert_eq!(response.status(), 200);
        let body: serde_json::Value = serde_json::from_slice(response.body()).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["auth_enabled"], true);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["protocol_version"], 1);
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
        let error: serde_json::Value =
            serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();
        assert_eq!(error["payload"]["code"], "AUTHENTICATION_TIMEOUT");
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
        let error: serde_json::Value =
            serde_json::from_str(client.recv().await.unwrap().to_str().unwrap()).unwrap();
        assert_eq!(error["payload"]["code"], "AUTHENTICATION_EXPIRED");
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

    fn now_seconds() -> u64 {
        crate::utils::now_ms() / 1000
    }

    fn token_for_subject(config: &JwtConfig, subject: &str, expiration: u64) -> String {
        encode(
            &Header::default(),
            &Claims {
                sub: subject.to_string(),
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

    fn invite_route(
        state: SharedState,
        jwt_config: Arc<JwtConfig>,
        max_requests: u32,
    ) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
        build_invite_route_with_limiter(
            state,
            jwt_config,
            Arc::new(vec!["http://localhost:8096".to_string()]),
            InviteRateLimiter::new(max_requests, Duration::from_secs(60)),
        )
    }

    async fn state_with_hosts() -> SharedState {
        let state = crate::test_helpers::create_state();
        let mut locked = state.write().await;
        for (client_id, user_id, room_id) in [
            ("host-client", "user-host", "room-1"),
            ("host-two", "user-two", "room-2"),
        ] {
            let (mut client, _rx) =
                crate::test_helpers::create_client_with_rx(user_id, "Host", true);
            client.room_id = Some(room_id.to_string());
            locked.clients.insert(client_id.to_string(), client);
            locked.rooms.insert(
                room_id.to_string(),
                crate::test_helpers::create_room(room_id, client_id),
            );
        }
        drop(locked);
        state
    }

    fn invite_request(token: Option<&str>, body: serde_json::Value) -> warp::test::RequestBuilder {
        let request = warp::test::request()
            .method("POST")
            .path("/invite")
            .header("content-type", "application/json")
            .header("origin", "http://localhost:8096")
            .body(serde_json::to_string(&body).unwrap());
        match token {
            Some(token) => request.header("authorization", format!("Bearer {token}")),
            None => request,
        }
    }

    #[tokio::test]
    async fn invite_endpoint_mints_a_room_scoped_ticket_for_the_host() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config.clone(), 10);
        let token = token_for_subject(&jwt_config, "user-host", now_seconds() + 300);

        let response = invite_request(
            Some(&token),
            serde_json::json!({ "room_id": "room-1", "ttl_seconds": 300 }),
        )
        .reply(&route)
        .await;

        assert_eq!(response.status(), 200);
        let body: serde_json::Value = serde_json::from_slice(response.body()).unwrap();
        let ticket = body["ticket"].as_str().unwrap();
        let claims = jwt_config.validate_invite_ticket(ticket, "room-1").unwrap();
        assert_eq!(claims.room, "room-1");
        assert_eq!(body["expires_at"].as_u64().unwrap(), claims.exp as u64);
        assert!(claims.exp as u64 <= now_seconds() + 300);
    }

    #[tokio::test]
    async fn invite_endpoint_clamps_the_requested_ttl() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config.clone(), 10);
        let token = token_for_subject(&jwt_config, "user-host", now_seconds() + 300);

        let response = invite_request(
            Some(&token),
            serde_json::json!({ "room_id": "room-1", "ttl_seconds": 999_999 }),
        )
        .reply(&route)
        .await;

        assert_eq!(response.status(), 200);
        let body: serde_json::Value = serde_json::from_slice(response.body()).unwrap();
        let expires_at = body["expires_at"].as_u64().unwrap();
        assert!(expires_at <= now_seconds() + crate::auth::MAX_INVITE_TTL_SECONDS);
        assert!(expires_at >= now_seconds() + crate::auth::MIN_INVITE_TTL_SECONDS);
    }

    #[tokio::test]
    async fn invite_endpoint_rejects_non_hosts_and_unknown_rooms() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config.clone(), 10);
        let guest_token = token_for_subject(&jwt_config, "user-guest", now_seconds() + 300);

        let non_host = invite_request(
            Some(&guest_token),
            serde_json::json!({ "room_id": "room-1" }),
        )
        .reply(&route)
        .await;
        assert_eq!(non_host.status(), 403);

        let host_token = token_for_subject(&jwt_config, "user-host", now_seconds() + 300);
        let unknown = invite_request(
            Some(&host_token),
            serde_json::json!({ "room_id": "missing" }),
        )
        .reply(&route)
        .await;
        assert_eq!(unknown.status(), 404);
    }

    #[tokio::test]
    async fn invite_endpoint_requires_a_valid_session_token() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config.clone(), 10);

        let missing = invite_request(None, serde_json::json!({ "room_id": "room-1" }))
            .reply(&route)
            .await;
        assert_eq!(missing.status(), 401);

        let invalid = invite_request(
            Some("not-a-jwt"),
            serde_json::json!({ "room_id": "room-1" }),
        )
        .reply(&route)
        .await;
        assert_eq!(invalid.status(), 401);
    }

    #[tokio::test]
    async fn invite_endpoint_is_rate_limited_per_client() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config.clone(), 2);
        let host_one = token_for_subject(&jwt_config, "user-host", now_seconds() + 300);
        let host_two = token_for_subject(&jwt_config, "user-two", now_seconds() + 300);

        for _ in 0..2 {
            let response =
                invite_request(Some(&host_one), serde_json::json!({ "room_id": "room-1" }))
                    .reply(&route)
                    .await;
            assert_eq!(response.status(), 200);
        }
        let limited = invite_request(Some(&host_one), serde_json::json!({ "room_id": "room-1" }))
            .reply(&route)
            .await;
        assert_eq!(limited.status(), 429);

        let other_client =
            invite_request(Some(&host_two), serde_json::json!({ "room_id": "room-2" }))
                .reply(&route)
                .await;
        assert_eq!(other_client.status(), 200);
    }

    #[tokio::test]
    async fn invite_endpoint_is_unavailable_without_a_shared_secret() {
        let jwt_config = test_jwt_config(false);
        let route = invite_route(state_with_hosts().await, jwt_config, 10);

        let response = invite_request(
            Some("any-token"),
            serde_json::json!({ "room_id": "room-1" }),
        )
        .reply(&route)
        .await;

        assert_eq!(response.status(), 503);
    }

    #[tokio::test]
    async fn invite_endpoint_answers_cors_preflight() {
        let jwt_config = test_jwt_config(true);
        let route = invite_route(state_with_hosts().await, jwt_config, 10);

        let response = warp::test::request()
            .method("OPTIONS")
            .path("/invite")
            .header("origin", "http://localhost:8096")
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization, content-type",
            )
            .reply(&route)
            .await;

        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost:8096"
        );
        let allowed = response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(allowed.contains("authorization"));
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

    #[tokio::test]
    async fn metrics_count_a_session_and_are_served_as_prometheus_text() {
        use crate::metrics::{metrics, CloseReason, InvalidMessage, RejectionReason};
        let metrics = metrics();
        let before = (
            metrics.connections(),
            metrics.received("ping"),
            metrics.sent("pong"),
            metrics.sent("client_hello"),
            metrics.invalid(InvalidMessage::InvalidJson),
            metrics.errors("INVALID_JSON"),
            metrics.closed(CloseReason::ClientClosed),
            metrics.rejected(RejectionReason::Origin),
        );
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
            .handshake(route.clone())
            .await
            .unwrap();
        client.recv().await.unwrap(); // client_hello
        client.recv().await.unwrap(); // room_list, sent at once without authentication
        client.send_text(r#"{"type":"ping","ts":0}"#).await;
        client.recv().await.unwrap(); // pong
        client.send_text("not-json").await;
        client.recv().await.unwrap(); // error

        let response = warp::test::request()
            .path("/metrics")
            .reply(&build_metrics_route(state.clone()))
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "text/plain; version=0.0.4; charset=utf-8"
        );
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        for line in [
            "owp_connections_active 1".to_string(),
            format!("owp_connections_total {}", metrics.connections()),
            format!(
                "owp_messages_received_total{{type=\"ping\"}} {}",
                metrics.received("ping")
            ),
            format!(
                "owp_messages_sent_total{{type=\"pong\"}} {}",
                metrics.sent("pong")
            ),
        ] {
            assert!(body.lines().any(|l| l == line), "missing: {line}");
        }

        client.send(warp::ws::Message::close()).await;
        tokio::time::timeout(Duration::from_secs(1), client.recv_closed())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..10 {
            if state.read().await.clients.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let rejected = warp::test::ws()
            .path("/ws")
            .header("origin", "https://elsewhere.example")
            .handshake(route)
            .await;
        assert!(rejected.is_err());

        let after = (
            metrics.connections(),
            metrics.received("ping"),
            metrics.sent("pong"),
            metrics.sent("client_hello"),
            metrics.invalid(InvalidMessage::InvalidJson),
            metrics.errors("INVALID_JSON"),
            metrics.closed(CloseReason::ClientClosed),
            metrics.rejected(RejectionReason::Origin),
        );
        assert_eq!(
            after,
            (
                before.0 + 1,
                before.1 + 1,
                before.2 + 1,
                before.3 + 1,
                before.4 + 1,
                before.5 + 1,
                before.6 + 1,
                before.7 + 1,
            )
        );
    }

    #[tokio::test]
    async fn ready_reports_shutdown_while_health_stays_ok() {
        let tasks = crate::tasks::AppTasks::new();
        let route = build_routes(
            crate::test_helpers::create_state(),
            test_jwt_config(false),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
            tasks.clone(),
        );
        for path in ["/health", "/metrics", "/ready"] {
            let response = warp::test::request().path(path).reply(&route).await;
            assert_eq!(response.status(), 200, "{path}");
        }
        let response = warp::test::request().path("/ready").reply(&route).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(response.body()).unwrap()["status"],
            "ready"
        );

        tasks.cancel();
        let response = warp::test::request().path("/ready").reply(&route).await;
        assert_eq!(response.status(), 503);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(response.body()).unwrap()["status"],
            "shutting_down"
        );
        let response = warp::test::request().path("/health").reply(&route).await;
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn plain_http_requests_to_ws_are_not_counted_as_rejected_connections() {
        use crate::metrics::{metrics, RejectionReason};
        let before = (
            metrics().rejected(RejectionReason::Origin),
            metrics().rejected(RejectionReason::ConnectionLimit),
        );
        let route = build_ws_route(
            crate::test_helpers::create_state(),
            test_jwt_config(false),
            Arc::new(vec!["https://example.com".to_string()]),
            test_ingress_config(Duration::from_secs(5)),
        );
        let response = warp::test::request()
            .path("/ws")
            .header("origin", "https://elsewhere.example")
            .reply(&route)
            .await;
        assert_ne!(response.status(), 101);
        assert_eq!(
            (
                metrics().rejected(RejectionReason::Origin),
                metrics().rejected(RejectionReason::ConnectionLimit),
            ),
            before
        );
    }

    #[tokio::test]
    async fn a_message_over_the_size_limit_ends_the_session_with_its_own_reason() {
        use crate::metrics::{metrics, CloseReason, InvalidMessage};
        let before = (
            metrics().closed(CloseReason::MessageTooLarge),
            metrics().invalid(InvalidMessage::TooLarge),
            metrics().closed(CloseReason::ReceiveError),
        );
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
        client.recv().await.unwrap(); // client_hello
        client.recv().await.unwrap(); // room_list
        client
            .send_text("x".repeat(crate::ws::constants::MAX_MESSAGE_SIZE + 1))
            .await;
        let _ = tokio::time::timeout(Duration::from_secs(1), client.recv_closed()).await;
        for _ in 0..20 {
            if state.read().await.clients.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(state.read().await.clients.is_empty());
        assert_eq!(
            (
                metrics().closed(CloseReason::MessageTooLarge),
                metrics().invalid(InvalidMessage::TooLarge),
                metrics().closed(CloseReason::ReceiveError),
            ),
            (before.0 + 1, before.1 + 1, before.2)
        );
    }

    #[tokio::test]
    async fn a_zombie_session_is_counted_once_with_the_heartbeat_reason() {
        use crate::metrics::{metrics, CloseReason};
        let before = (
            metrics().closed(CloseReason::HeartbeatTimeout),
            metrics().closed(CloseReason::OutboundQueueFailed),
            metrics().zombies(),
        );
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
        client.recv().await.unwrap(); // client_hello
        let id = state.read().await.clients.keys().next().unwrap().clone();

        crate::tasks::remove_zombie(&id, &state).await;
        // A second sweep that finds it gone does not count it again.
        crate::tasks::remove_zombie(&id, &state).await;
        for _ in 0..20 {
            if metrics().closed(CloseReason::HeartbeatTimeout) > before.0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            (
                metrics().closed(CloseReason::HeartbeatTimeout),
                metrics().closed(CloseReason::OutboundQueueFailed),
                metrics().zombies(),
            ),
            (before.0 + 1, before.1, before.2 + 1)
        );
    }
}
