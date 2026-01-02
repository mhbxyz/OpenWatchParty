use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub type Clients = Arc<Mutex<HashMap<String, Client>>>;
pub type Rooms = Arc<Mutex<HashMap<String, Room>>>;

#[derive(Debug, Clone)]
pub struct Client {
    pub sender: mpsc::UnboundedSender<std::result::Result<warp::ws::Message, warp::Error>>,
    pub room_id: Option<String>,
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
