use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::Instant;

pub type SharedState = Arc<RwLock<ServerState>>;

#[derive(Debug, Default)]
pub struct ServerState {
    pub clients: HashMap<String, Client>,
    pub rooms: HashMap<String, Room>,
}

#[derive(Debug, Clone)]
pub struct Client {
    // Bounded sender to prevent OOM from slow/malicious clients (P-RS03 fix)
    pub sender: crate::messaging::ClientSender,
    pub room_id: Option<String>,
    pub user_id: String,
    pub user_name: String,
    pub authenticated: bool, // Whether client has authenticated via auth message
    /// JWT `exp` as Unix seconds. `None` is reserved for insecure no-auth sessions.
    pub session_expires_at: Option<u64>,
    pub authentication_version: u64,
    pub supports_host_transfer: bool,
    pub message_count: u32,
    pub last_reset: Instant,
    pub last_seen: Instant, // For zombie connection detection
}

#[derive(Debug, Clone, Serialize)]
pub struct Room {
    pub room_id: String,
    pub name: String,
    pub host_id: String,
    pub media_id: Option<String>,
    pub clients: Vec<String>,
    pub ready_clients: HashSet<String>,
    pub pending_play: Option<PendingPlay>,
    pub state: PlaybackState,
    #[serde(skip)]
    pub state_server_ts: u64,
    #[serde(skip)]
    pub target_server_ts: Option<u64>,
    #[serde(skip)]
    pub target_at: Option<Instant>,
    #[serde(skip)]
    pub last_state_at: Option<Instant>,
    #[serde(skip)]
    pub command_cooldown_until: Option<Instant>,
    /// Each member's last reported status (`participant_status`), by client id.
    #[serde(skip)]
    pub statuses: HashMap<String, &'static str>,
    #[serde(skip)]
    pub status_broadcast: StatusBroadcast,
}

/// When the room last got `participant_statuses` for a status change, and the
/// ticket of the one scheduled after it, if any (see `ws::handlers::status`).
#[derive(Debug, Clone, Default)]
pub struct StatusBroadcast {
    pub last_sent_at: Option<Instant>,
    pub scheduled_flush: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub position: f64,
    pub play_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPlay {
    pub position: f64,
    #[serde(skip)]
    pub generation: u64,
    pub position_ts: u64,
}

pub(crate) fn next_pending_play_generation() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
    NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
}

/// Incoming message types from clients (type-safe enum for dispatch)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClientMessageType {
    Auth,
    ListRooms,
    CreateRoom,
    JoinRoom,
    Ready,
    LeaveRoom,
    CloseRoom,
    PlayerEvent,
    StateUpdate,
    Ping,
    ClientLog,
    ChatMessage,
    ParticipantStatus,
    #[serde(other)]
    Unknown,
}

impl ClientMessageType {
    /// The wire name, as serialized.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::ListRooms => "list_rooms",
            Self::CreateRoom => "create_room",
            Self::JoinRoom => "join_room",
            Self::Ready => "ready",
            Self::LeaveRoom => "leave_room",
            Self::CloseRoom => "close_room",
            Self::PlayerEvent => "player_event",
            Self::StateUpdate => "state_update",
            Self::Ping => "ping",
            Self::ClientLog => "client_log",
            Self::ChatMessage => "chat_message",
            Self::ParticipantStatus => "participant_status",
            Self::Unknown => "unknown",
        }
    }
}

/// Outgoing message types from server (reserved for future use)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerMessageType {
    ClientHello,
    AuthSuccess,
    Error,
    RoomList,
    RoomState,
    ParticipantsUpdate,
    PlayerEvent,
    StateUpdate,
    Pong,
    ClientLeft,
    HostChanged,
    RoomClosed,
    ChatMessage,
}

/// Incoming WebSocket message from client
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct IncomingMessage {
    #[serde(rename = "type")]
    pub msg_type: ClientMessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ts: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WsMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ts: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_message_type_deserialize() {
        // Known types should deserialize correctly
        let json = r#""auth""#;
        let msg_type: ClientMessageType = serde_json::from_str(json).unwrap();
        assert_eq!(msg_type, ClientMessageType::Auth);

        let json = r#""player_event""#;
        let msg_type: ClientMessageType = serde_json::from_str(json).unwrap();
        assert_eq!(msg_type, ClientMessageType::PlayerEvent);

        let json = r#""state_update""#;
        let msg_type: ClientMessageType = serde_json::from_str(json).unwrap();
        assert_eq!(msg_type, ClientMessageType::StateUpdate);
    }

    #[test]
    fn test_client_message_type_unknown() {
        // Unknown types should deserialize to Unknown variant (not error)
        let json = r#""unknown_type""#;
        let msg_type: ClientMessageType = serde_json::from_str(json).unwrap();
        assert_eq!(msg_type, ClientMessageType::Unknown);

        let json = r#""typo_in_type""#;
        let msg_type: ClientMessageType = serde_json::from_str(json).unwrap();
        assert_eq!(msg_type, ClientMessageType::Unknown);
    }

    #[test]
    fn test_client_message_type_serialize() {
        // Serialization should produce snake_case
        let json = serde_json::to_string(&ClientMessageType::PlayerEvent).unwrap();
        assert_eq!(json, r#""player_event""#);

        let json = serde_json::to_string(&ClientMessageType::StateUpdate).unwrap();
        assert_eq!(json, r#""state_update""#);

        let json = serde_json::to_string(&ClientMessageType::CreateRoom).unwrap();
        assert_eq!(json, r#""create_room""#);

        let json = serde_json::to_string(&ClientMessageType::CloseRoom).unwrap();
        assert_eq!(json, r#""close_room""#);
    }

    #[test]
    fn client_message_type_names_match_the_wire_and_the_metric_labels() {
        for name in crate::metrics::CLIENT_MESSAGE_TYPES {
            let parsed: ClientMessageType =
                serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed.as_str(), name);
            if parsed != ClientMessageType::Unknown {
                assert_eq!(serde_json::to_value(&parsed).unwrap(), name);
            }
        }
    }

    #[test]
    fn test_incoming_message_deserialize() {
        let json = r#"{"type": "ping", "ts": 12345}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.msg_type, ClientMessageType::Ping);
        assert_eq!(msg.ts, 12345);
    }

    #[test]
    fn test_incoming_message_with_payload() {
        let json = r#"{"type": "player_event", "room": "room-123", "payload": {"action": "play"}, "ts": 12345}"#;
        let msg: IncomingMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.msg_type, ClientMessageType::PlayerEvent);
        assert_eq!(msg.room, Some("room-123".to_string()));
        assert!(msg.payload.is_some());
    }

    #[test]
    fn test_incoming_message_rejects_unknown_envelope_fields() {
        let json = r#"{"type":"player_event","room":"room-123","payload":{"action":"play"},"ts":12345,"extra":true}"#;
        assert!(serde_json::from_str::<IncomingMessage>(json).is_err());
    }

    #[test]
    fn test_playback_state() {
        let state = PlaybackState {
            position: 123.45,
            play_state: "playing".to_string(),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("123.45"));
        assert!(json.contains("playing"));
    }

    #[test]
    fn room_serialization_skips_internal_timing_and_pending_identity() {
        let mut room = crate::test_helpers::create_room("r1", "host");
        room.pending_play = Some(PendingPlay {
            position: 12.0,
            generation: next_pending_play_generation(),
            position_ts: 1_700_000_000_000,
        });

        let json = serde_json::to_value(room).unwrap();

        assert!(json.get("state_server_ts").is_none());
        assert!(json.get("target_server_ts").is_none());
        assert!(json.get("target_at").is_none());
        assert!(json.get("last_state_at").is_none());
        assert!(json.get("command_cooldown_until").is_none());
        assert!(json["pending_play"].get("generation").is_none());
        assert_eq!(json["pending_play"]["position_ts"], 1_700_000_000_000_u64);
    }

    #[test]
    fn client_message_type_names_match_the_wire_format() {
        use ClientMessageType::*;
        for message_type in [
            Auth,
            ListRooms,
            CreateRoom,
            JoinRoom,
            Ready,
            LeaveRoom,
            CloseRoom,
            PlayerEvent,
            StateUpdate,
            Ping,
            ClientLog,
            ChatMessage,
            ParticipantStatus,
        ] {
            let wire = serde_json::to_string(&message_type).unwrap();
            assert_eq!(wire, format!("\"{}\"", message_type.as_str()));
            // The metrics count every client message type under its own label.
            assert!(
                crate::metrics::CLIENT_MESSAGE_TYPES.contains(&message_type.as_str()),
                "{} has no metrics label",
                message_type.as_str()
            );
        }
        assert_eq!(Unknown.as_str(), "unknown");
    }
}
