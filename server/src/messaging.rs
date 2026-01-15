use crate::types::{Client, Clients, Room, Rooms, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;

pub async fn send_room_list(client_id: &str, clients: &Clients, rooms: &Rooms) {
    let locked_rooms = rooms.read().await;
    let list: Vec<serde_json::Value> = locked_rooms.values().map(|r| {
        serde_json::json!({ "id": r.room_id, "name": r.name, "count": r.clients.len(), "media_id": r.media_id })
    }).collect();

    let msg = WsMessage {
        msg_type: "room_list".to_string(),
        room: None,
        client: None,
        payload: Some(serde_json::json!(list)),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };

    let locked_clients = clients.read().await;
    send_to_client(client_id, &locked_clients, &msg);
}

// P-RS08 fix: Serialize room list once and send to all clients (avoids N serializations)
pub async fn broadcast_room_list(clients: &Clients, rooms: &Rooms) {
    // Build and serialize message once
    let json = {
        let locked_rooms = rooms.read().await;
        let list: Vec<serde_json::Value> = locked_rooms.values().map(|r| {
            serde_json::json!({ "id": r.room_id, "name": r.name, "count": r.clients.len(), "media_id": r.media_id })
        }).collect();

        let msg = WsMessage {
            msg_type: "room_list".to_string(),
            room: None,
            client: None,
            payload: Some(serde_json::json!(list)),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        };

        match serde_json::to_string(&msg) {
            Ok(j) => j,
            Err(e) => {
                log::error!("Failed to serialize room list: {}", e);
                return;
            }
        }
    };

    // Send pre-serialized message to all clients
    let locked_clients = clients.read().await;
    let warp_msg = warp::ws::Message::text(json);
    for client in locked_clients.values() {
        if let Err(e) = client.sender.try_send(Ok(warp_msg.clone())) {
            log::warn!("Failed to send room list (buffer full or closed): {}", e);
        }
    }
}

pub fn send_to_client(client_id: &str, clients: &HashMap<String, Client>, msg: &WsMessage) {
    if let Some(client) = clients.get(client_id) {
        match serde_json::to_string(msg) {
            Ok(json) => {
                // Use try_send to avoid blocking on full buffer (bounded channel)
                if let Err(e) = client.sender.try_send(Ok(warp::ws::Message::text(json))) {
                    log::warn!("Failed to send to client {} (buffer full or closed): {}", client_id, e);
                }
            }
            Err(e) => {
                log::error!("Failed to serialize message for client {}: {}", client_id, e);
            }
        }
    }
}

pub fn broadcast_to_room(room: &Room, clients: &HashMap<String, Client>, msg: &WsMessage, exclude: Option<&str>) {
    let json = match serde_json::to_string(msg) {
        Ok(j) => j,
        Err(e) => {
            log::error!("Failed to serialize broadcast message for room {}: {}", room.room_id, e);
            return;
        }
    };
    let warp_msg = warp::ws::Message::text(json);
    for client_id in &room.clients {
        if Some(client_id.as_str()) == exclude { continue; }
        if let Some(client) = clients.get(client_id) {
            // Use try_send to avoid blocking on full buffer (bounded channel)
            if let Err(e) = client.sender.try_send(Ok(warp_msg.clone())) {
                log::warn!("Failed to broadcast to client {} (buffer full or closed): {}", client_id, e);
            }
        }
    }
}
