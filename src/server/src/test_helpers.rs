use crate::types::{Client, PlaybackState, Room, ServerState, SharedState, WsMessage};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

pub fn create_state() -> SharedState {
    Arc::new(RwLock::new(ServerState::default()))
}

pub fn create_client_with_rx(
    user_id: &str,
    user_name: &str,
    authenticated: bool,
) -> (
    Client,
    mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
) {
    let (sender, rx, _disconnect) = crate::messaging::ClientSender::channel(100);
    let now = tokio::time::Instant::now();
    let client = Client {
        sender,
        room_id: None,
        user_id: user_id.to_string(),
        user_name: user_name.to_string(),
        authenticated,
        session_expires_at: None,
        authentication_version: 0,
        message_count: 0,
        last_reset: now,
        last_seen: now,
    };
    (client, rx)
}

pub fn create_room(room_id: &str, host_id: &str) -> Room {
    Room {
        room_id: room_id.to_string(),
        name: format!("Room de {}", host_id),
        host_id: host_id.to_string(),
        media_id: None,
        clients: vec![host_id.to_string()],
        ready_clients: HashSet::from([host_id.to_string()]),
        pending_play: None,
        state: PlaybackState {
            position: 0.0,
            play_state: "paused".to_string(),
        },
        state_server_ts: 0,
        target_server_ts: None,
        target_at: None,
        last_state_at: None,
        command_cooldown_until: None,
    }
}

pub fn recv_msg(
    rx: &mut mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
) -> Option<WsMessage> {
    match rx.try_recv() {
        Ok(Ok(msg)) => {
            let text = msg.to_str().ok()?;
            serde_json::from_str(text).ok()
        }
        _ => None,
    }
}

pub fn setup_room_with_host(
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
    host_id: &str,
) -> mpsc::Receiver<Result<warp::ws::Message, warp::Error>> {
    let (client, rx) = create_client_with_rx(host_id, "Host", true);
    let mut room = create_room("room-1", host_id);
    let mut client = client;
    client.room_id = Some("room-1".to_string());
    room.clients = vec![host_id.to_string()];
    clients.insert(host_id.to_string(), client);
    rooms.insert("room-1".to_string(), room);
    rx
}
