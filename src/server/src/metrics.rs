//! Prometheus metrics, served as text by `GET /metrics`.
//!
//! Counters are process-wide atomics; gauges are read from the shared state
//! when the endpoint is scraped. Every label value comes from a fixed list, so
//! a client cannot create new series, and no metric carries a user name, a
//! room name, a token or an id.

use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::ServerState;

/// Message types a client can send, as named on the wire.
pub const CLIENT_MESSAGE_TYPES: [&str; 14] = [
    "auth",
    "list_rooms",
    "create_room",
    "join_room",
    "ready",
    "leave_room",
    "close_room",
    "player_event",
    "state_update",
    "ping",
    "client_log",
    "chat_message",
    "participant_status",
    "unknown",
];

/// Message types the server sends, plus `other` for anything not listed.
pub const SERVER_MESSAGE_TYPES: [&str; 16] = [
    "client_hello",
    "auth_success",
    "error",
    "room_list",
    "room_state",
    "participants_update",
    "participant_list",
    "participant_statuses",
    "host_changed",
    "player_event",
    "state_update",
    "pong",
    "client_left",
    "room_closed",
    "chat_message",
    "other",
];

/// Error codes the server sends, plus `other` for anything not listed.
pub const ERROR_CODES: [&str; 22] = [
    "AUTHENTICATION_REQUIRED",
    "AUTHENTICATION_FAILED",
    "AUTHENTICATION_EXPIRED",
    "AUTHENTICATION_TIMEOUT",
    "PROTOCOL_VERSION_UNSUPPORTED",
    "RATE_LIMITED",
    "MESSAGE_TOO_LARGE",
    "UNSUPPORTED_MESSAGE_FORMAT",
    "INVALID_JSON",
    "UNKNOWN_MESSAGE_TYPE",
    "ROOM_ID_REQUIRED",
    "ROOM_NOT_FOUND",
    "ROOM_FULL",
    "NOT_ROOM_MEMBER",
    "HOST_PERMISSION_REQUIRED",
    "INVALID_PLAYBACK_PAYLOAD",
    "NOT_IN_ROOM",
    "INVALID_READY",
    "INVALID_CHAT_PAYLOAD",
    "CHAT_MESSAGE_EMPTY",
    "CHAT_MESSAGE_TOO_LONG",
    "other",
];

/// Why a WebSocket session ended. Each session is counted once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The client sent a close frame.
    ClientClosed,
    /// The connection ended without a close frame.
    ClientDisconnected,
    /// Reading from the socket failed.
    ReceiveError,
    /// The client exceeded the message rate limit.
    RateLimited,
    /// The client did not authenticate in time.
    AuthenticationTimeout,
    /// The client's session token expired.
    AuthenticationExpired,
    /// The client stopped reading and its outbound queue filled up or closed.
    OutboundQueueFailed,
    /// The server is shutting down.
    ServerShutdown,
    /// The client sent a message over the size limit, which the WebSocket
    /// layer refuses before the server sees it.
    MessageTooLarge,
    /// The session missed the heartbeat and was removed.
    HeartbeatTimeout,
}

const CLOSE_REASONS: [&str; 10] = [
    "client_closed",
    "client_disconnected",
    "receive_error",
    "rate_limited",
    "authentication_timeout",
    "authentication_expired",
    "outbound_queue_failed",
    "server_shutdown",
    "message_too_large",
    "heartbeat_timeout",
];

impl CloseReason {
    fn as_str(self) -> &'static str {
        CLOSE_REASONS[self as usize]
    }
}

/// Why a WebSocket upgrade was refused before a session started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionReason {
    /// The `Origin` header is not allowed.
    Origin,
    /// The global or per-IP connection limit is reached.
    ConnectionLimit,
}

const REJECTION_REASONS: [&str; 2] = ["origin", "connection_limit"];

/// A message the server dropped before dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidMessage {
    InvalidJson,
    TooLarge,
    UnsupportedFormat,
}

const INVALID_MESSAGES: [&str; 3] = ["invalid_json", "too_large", "unsupported_format"];

/// What a rate limit rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitScope {
    /// WebSocket messages from one client.
    Messages,
    /// Invite link requests from one user.
    Invites,
}

const RATE_LIMIT_SCOPES: [&str; 2] = ["messages", "invites"];

/// A counter with one series per value of a fixed label list.
pub struct LabeledCounter<const N: usize> {
    values: &'static [&'static str; N],
    counts: [AtomicU64; N],
}

impl<const N: usize> LabeledCounter<N> {
    const fn new(values: &'static [&'static str; N]) -> Self {
        Self {
            values,
            counts: [const { AtomicU64::new(0) }; N],
        }
    }

    /// Counts `value`, or `other` when the list has no such value.
    fn inc(&self, value: &str) {
        let index = self
            .values
            .iter()
            .position(|known| *known == value)
            .or_else(|| self.values.iter().position(|known| *known == "other"));
        debug_assert!(index.is_some(), "unknown metric label value {value}");
        if let Some(index) = index {
            self.counts[index].fetch_add(1, Ordering::Relaxed);
        }
    }

    #[cfg(test)]
    pub fn get(&self, value: &str) -> u64 {
        self.values
            .iter()
            .position(|known| *known == value)
            .map_or(0, |index| self.counts[index].load(Ordering::Relaxed))
    }

    fn render(&self, out: &mut String, name: &str, label: &str, help: &str) {
        let _ = writeln!(out, "# HELP {name} {help}");
        let _ = writeln!(out, "# TYPE {name} counter");
        for (value, count) in self.values.iter().zip(&self.counts) {
            let _ = writeln!(
                out,
                "{name}{{{label}=\"{value}\"}} {}",
                count.load(Ordering::Relaxed)
            );
        }
    }
}

pub struct Metrics {
    start_time_seconds: AtomicU64,
    connections: AtomicU64,
    connections_rejected: LabeledCounter<2>,
    rooms: AtomicU64,
    messages_received: LabeledCounter<{ CLIENT_MESSAGE_TYPES.len() }>,
    messages_sent: LabeledCounter<{ SERVER_MESSAGE_TYPES.len() }>,
    send_failures: AtomicU64,
    invalid_messages: LabeledCounter<3>,
    errors_sent: LabeledCounter<22>,
    rate_limited: LabeledCounter<2>,
    closes: LabeledCounter<10>,
    zombies_removed: AtomicU64,
}

impl Metrics {
    const fn new() -> Self {
        Self {
            start_time_seconds: AtomicU64::new(0),
            connections: AtomicU64::new(0),
            connections_rejected: LabeledCounter::new(&REJECTION_REASONS),
            rooms: AtomicU64::new(0),
            messages_received: LabeledCounter::new(&CLIENT_MESSAGE_TYPES),
            messages_sent: LabeledCounter::new(&SERVER_MESSAGE_TYPES),
            send_failures: AtomicU64::new(0),
            invalid_messages: LabeledCounter::new(&INVALID_MESSAGES),
            errors_sent: LabeledCounter::new(&ERROR_CODES),
            rate_limited: LabeledCounter::new(&RATE_LIMIT_SCOPES),
            closes: LabeledCounter::new(&CLOSE_REASONS),
            zombies_removed: AtomicU64::new(0),
        }
    }

    pub fn record_start(&self, unix_seconds: u64) {
        self.start_time_seconds
            .store(unix_seconds, Ordering::Relaxed);
    }

    pub fn connection_opened(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn connection_rejected(&self, reason: RejectionReason) {
        self.connections_rejected
            .inc(REJECTION_REASONS[reason as usize]);
    }

    pub fn connection_closed(&self, reason: CloseReason) {
        self.closes.inc(reason.as_str());
    }

    pub fn room_created(&self) {
        self.rooms.fetch_add(1, Ordering::Relaxed);
    }

    pub fn message_received(&self, message_type: &str) {
        self.messages_received.inc(message_type);
    }

    pub fn send_failed(&self) {
        self.send_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn invalid_message(&self, kind: InvalidMessage) {
        self.invalid_messages.inc(INVALID_MESSAGES[kind as usize]);
    }

    /// Counts a message once it is queued to a client: by type, and by code
    /// for an `error` message.
    pub fn message_delivered(&self, msg: &crate::types::WsMessage) {
        self.messages_sent.inc(&msg.msg_type);
        if msg.msg_type == "error" {
            if let Some(code) = msg
                .payload
                .as_ref()
                .and_then(|payload| payload.get("code"))
                .and_then(serde_json::Value::as_str)
            {
                self.errors_sent.inc(code);
            }
        }
    }

    pub fn rate_limited(&self, scope: RateLimitScope) {
        self.rate_limited.inc(RATE_LIMIT_SCOPES[scope as usize]);
    }

    pub fn zombie_removed(&self) {
        self.zombies_removed.fetch_add(1, Ordering::Relaxed);
    }

    /// The exposition text, with the gauges read from `state`.
    pub fn render(&self, state: &ServerState) -> String {
        let mut out = String::with_capacity(8 * 1024);
        let _ = writeln!(
            out,
            "# HELP owp_build_info Session server version and protocol version."
        );
        let _ = writeln!(out, "# TYPE owp_build_info gauge");
        let _ = writeln!(
            out,
            "owp_build_info{{version=\"{}\",protocol_version=\"{}\"}} 1",
            env!("CARGO_PKG_VERSION"),
            crate::ws::constants::PROTOCOL_VERSION
        );
        gauge(
            &mut out,
            "owp_start_time_seconds",
            "Unix time the session server started.",
            self.start_time_seconds.load(Ordering::Relaxed),
        );
        gauge(
            &mut out,
            "owp_connections_active",
            "WebSocket sessions currently open.",
            state.clients.len() as u64,
        );
        gauge(
            &mut out,
            "owp_clients_authenticated",
            "Open WebSocket sessions that have authenticated.",
            state.clients.values().filter(|c| c.authenticated).count() as u64,
        );
        gauge(
            &mut out,
            "owp_rooms_active",
            "Rooms currently open.",
            state.rooms.len() as u64,
        );
        gauge(
            &mut out,
            "owp_room_participants",
            "Participants across all open rooms.",
            state.rooms.values().map(|r| r.clients.len() as u64).sum(),
        );
        counter(
            &mut out,
            "owp_connections_total",
            "WebSocket sessions opened.",
            &self.connections,
        );
        self.connections_rejected.render(
            &mut out,
            "owp_connections_rejected_total",
            "reason",
            "WebSocket upgrades refused before a session started.",
        );
        counter(&mut out, "owp_rooms_total", "Rooms created.", &self.rooms);
        self.messages_received.render(
            &mut out,
            "owp_messages_received_total",
            "type",
            "Client messages parsed, by type.",
        );
        self.messages_sent.render(
            &mut out,
            "owp_messages_sent_total",
            "type",
            "Messages queued to clients, by type.",
        );
        counter(
            &mut out,
            "owp_send_failures_total",
            "Messages dropped because a client's outbound queue was full or closed.",
            &self.send_failures,
        );
        self.invalid_messages.render(
            &mut out,
            "owp_invalid_messages_total",
            "reason",
            "Client messages dropped before dispatch.",
        );
        self.errors_sent.render(
            &mut out,
            "owp_errors_sent_total",
            "code",
            "Error messages queued to clients, by error code.",
        );
        self.rate_limited.render(
            &mut out,
            "owp_rate_limited_total",
            "scope",
            "Requests rejected by a rate limit.",
        );
        self.closes.render(
            &mut out,
            "owp_websocket_closes_total",
            "reason",
            "WebSocket sessions ended, by reason.",
        );
        counter(
            &mut out,
            "owp_zombie_connections_removed_total",
            "Sessions removed after missing the heartbeat.",
            &self.zombies_removed,
        );
        out
    }
}

fn gauge(out: &mut String, name: &str, help: &str, value: u64) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} gauge");
    let _ = writeln!(out, "{name} {value}");
}

fn counter(out: &mut String, name: &str, help: &str, value: &AtomicU64) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} counter");
    let _ = writeln!(out, "{name} {}", value.load(Ordering::Relaxed));
}

/// The server's metrics.
#[cfg(not(test))]
pub fn metrics() -> &'static Metrics {
    static METRICS: Metrics = Metrics::new();
    &METRICS
}

/// Tests run in parallel, so each test thread counts on its own and a test
/// can assert exact values. `#[tokio::test]` runs its tasks on that thread.
#[cfg(test)]
pub fn metrics() -> &'static Metrics {
    thread_local! {
        static METRICS: &'static Metrics = Box::leak(Box::new(Metrics::new()));
    }
    METRICS.with(|metrics| *metrics)
}

#[cfg(test)]
impl Metrics {
    pub fn sent(&self, message_type: &str) -> u64 {
        self.messages_sent.get(message_type)
    }

    pub fn received(&self, message_type: &str) -> u64 {
        self.messages_received.get(message_type)
    }

    pub fn closed(&self, reason: CloseReason) -> u64 {
        self.closes.get(reason.as_str())
    }

    pub fn invalid(&self, kind: InvalidMessage) -> u64 {
        self.invalid_messages.get(INVALID_MESSAGES[kind as usize])
    }

    pub fn errors(&self, code: &str) -> u64 {
        self.errors_sent.get(code)
    }

    pub fn limited(&self, scope: RateLimitScope) -> u64 {
        self.rate_limited.get(RATE_LIMIT_SCOPES[scope as usize])
    }

    pub fn rejected(&self, reason: RejectionReason) -> u64 {
        self.connections_rejected
            .get(REJECTION_REASONS[reason as usize])
    }

    pub fn connections(&self) -> u64 {
        self.connections.load(Ordering::Relaxed)
    }

    pub fn rooms(&self) -> u64 {
        self.rooms.load(Ordering::Relaxed)
    }

    pub fn failures(&self) -> u64 {
        self.send_failures.load(Ordering::Relaxed)
    }

    pub fn zombies(&self) -> u64 {
        self.zombies_removed.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn unknown_label_values_fall_into_other() {
        let metrics = Metrics::new();
        let message = |msg_type: &str, payload| crate::types::WsMessage {
            msg_type: msg_type.to_string(),
            room: None,
            client: None,
            payload,
            ts: 0,
            server_ts: None,
        };
        metrics.message_delivered(&message("future_message", None));
        metrics.message_delivered(&message("pong", None));
        metrics.message_delivered(&message(
            "error",
            Some(serde_json::json!({ "code": "ROOM_FULL", "message": "Room is full" })),
        ));
        metrics.message_delivered(&message(
            "error",
            Some(serde_json::json!({ "code": "FUTURE_CODE", "message": "Later" })),
        ));
        assert_eq!(metrics.messages_sent.get("other"), 1);
        assert_eq!(metrics.messages_sent.get("pong"), 1);
        assert_eq!(metrics.messages_sent.get("error"), 2);
        assert_eq!(metrics.errors_sent.get("ROOM_FULL"), 1);
        assert_eq!(metrics.errors_sent.get("other"), 1);
    }

    #[test]
    fn enum_labels_match_their_lists() {
        assert_eq!(CloseReason::ClientClosed.as_str(), "client_closed");
        assert_eq!(CloseReason::ServerShutdown.as_str(), "server_shutdown");
        assert_eq!(CloseReason::HeartbeatTimeout.as_str(), "heartbeat_timeout");
        assert_eq!(
            REJECTION_REASONS[RejectionReason::ConnectionLimit as usize],
            "connection_limit"
        );
        assert_eq!(
            INVALID_MESSAGES[InvalidMessage::UnsupportedFormat as usize],
            "unsupported_format"
        );
        assert_eq!(
            RATE_LIMIT_SCOPES[RateLimitScope::Invites as usize],
            "invites"
        );
    }

    #[test]
    fn exposition_has_every_series_and_reads_gauges_from_the_state() {
        let mut state = ServerState::default();
        let (host, _host_rx) = test_helpers::create_client_with_rx("u1", "Host", true);
        let (guest, _guest_rx) = test_helpers::create_client_with_rx("u2", "Guest", false);
        state.clients.insert("host".to_string(), host);
        state.clients.insert("guest".to_string(), guest);
        let mut room = test_helpers::create_room("room-1", "host");
        room.clients.push("guest".to_string());
        state.rooms.insert("room-1".to_string(), room);

        let metrics = Metrics::new();
        metrics.record_start(1_700_000_000);
        metrics.connection_opened();
        metrics.message_received("ping");
        metrics.connection_closed(CloseReason::RateLimited);
        let text = metrics.render(&state);

        for line in [
            "owp_start_time_seconds 1700000000",
            "owp_connections_active 2",
            "owp_clients_authenticated 1",
            "owp_rooms_active 1",
            "owp_room_participants 2",
            "owp_connections_total 1",
            "owp_messages_received_total{type=\"ping\"} 1",
            "owp_messages_received_total{type=\"auth\"} 0",
            "owp_websocket_closes_total{reason=\"rate_limited\"} 1",
            "owp_errors_sent_total{code=\"ROOM_FULL\"} 0",
            "# TYPE owp_messages_sent_total counter",
            "# TYPE owp_connections_active gauge",
        ] {
            assert!(text.lines().any(|l| l == line), "missing: {line}");
        }
        assert!(text.contains(&format!(
            "owp_build_info{{version=\"{}\",protocol_version=\"{}\"}} 1",
            env!("CARGO_PKG_VERSION"),
            crate::ws::constants::PROTOCOL_VERSION
        )));
        // Every sample line belongs to a metric declared just before it, and
        // nothing from the state (names, ids) leaks into the text.
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            let name = line.split(['{', ' ']).next().unwrap();
            assert!(
                text.contains(&format!("# TYPE {name} ")),
                "undeclared: {line}"
            );
        }
        for private in ["Host", "Guest", "u1", "u2", "room-1", "host's room"] {
            assert!(!text.contains(private), "leaked {private}");
        }
    }
}
