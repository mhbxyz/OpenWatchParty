use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub type Clients = Arc<RwLock<HashMap<String, Client>>>;
pub type Rooms = Arc<RwLock<HashMap<String, Room>>>;

#[derive(Debug, Clone)]
pub struct Client {
    // Bounded sender to prevent OOM from slow/malicious clients (P-RS03 fix)
    pub sender: mpsc::Sender<std::result::Result<warp::ws::Message, warp::Error>>,
    pub room_id: Option<String>,
    pub user_id: String,
    pub user_name: String,
    pub authenticated: bool, // Whether client has authenticated via auth message
    pub message_count: u32,
    pub last_reset: u64,
    pub last_seen: u64, // For zombie connection detection
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
    pub last_state_ts: u64,
    #[serde(skip)]
    pub last_command_ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub position: f64,
    pub play_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPlay {
    pub position: f64,
    pub created_at: u64,
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
    PlayerEvent,
    StateUpdate,
    Ping,
    ClientLog,
    QualityUpdate,
    ChatMessage,
    #[serde(other)]
    Unknown,
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
    RoomClosed,
    QualityUpdate,
    ChatMessage,
}

/// Incoming WebSocket message from client
#[derive(Serialize, Deserialize, Debug, Clone)]
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
    fn test_playback_state() {
        let state = PlaybackState {
            position: 123.45,
            play_state: "playing".to_string(),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("123.45"));
        assert!(json.contains("playing"));
    }
}
