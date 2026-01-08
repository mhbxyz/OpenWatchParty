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

pub async fn broadcast_room_list(clients: &Clients, rooms: &Rooms) {
    let client_ids: Vec<String> = {
        let locked_clients = clients.read().await;
        locked_clients.keys().cloned().collect()
    };
    for id in client_ids {
        send_room_list(&id, clients, rooms).await;
    }
}

pub fn send_to_client(client_id: &str, clients: &HashMap<String, Client>, msg: &WsMessage) {
    if let Some(client) = clients.get(client_id) {
        match serde_json::to_string(msg) {
            Ok(json) => {
                let _ = client.sender.send(Ok(warp::ws::Message::text(json)));
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
            let _ = client.sender.send(Ok(warp_msg.clone()));
        }
    }
}
