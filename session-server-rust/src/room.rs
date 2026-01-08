use crate::messaging::{broadcast_room_list, broadcast_to_room};
use crate::types::{Client, Clients, Room, Rooms, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;

pub async fn handle_disconnect(client_id: &str, clients: &Clients, rooms: &Rooms) {
    println!("[server] Disconnecting client {}", client_id);
    {
        let mut locked_clients = clients.write().await;
        let mut locked_rooms = rooms.write().await;
        handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
        locked_clients.remove(client_id);
    }
    broadcast_room_list(clients, rooms).await;
}

pub fn handle_leave(client_id: &str, clients: &mut HashMap<String, Client>, rooms: &mut HashMap<String, Room>) {
    let mut room_to_remove = None;
    let mut clients_to_notify = Vec::new();

    if let Some(client) = clients.get_mut(client_id) {
        if let Some(room_id) = client.room_id.take() {
            if let Some(room) = rooms.get_mut(&room_id) {
                room.clients.retain(|id| id != client_id);
                room.ready_clients.remove(client_id);
                if room.host_id == client_id {
                    room.pending_play = None;
                }
                if room.clients.is_empty() || room.host_id == client_id {
                    clients_to_notify = room.clients.clone();
                    room_to_remove = Some(room_id.clone());
                } else {
                    let msg = WsMessage {
                        msg_type: "client_left".to_string(),
                        room: Some(room_id),
                        client: Some(client_id.to_string()),
                        payload: None,
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    };
                    broadcast_to_room(room, clients, &msg, None);
                }
            }
        }
    }

    if let Some(room_id) = room_to_remove {
        println!("[server] Closing room {}", room_id);
        rooms.remove(&room_id);
        let msg_json = serde_json::json!({"type": "room_closed"}).to_string();
        for cid in clients_to_notify {
            if let Some(c) = clients.get(&cid) {
                let _ = c.sender.send(Ok(warp::ws::Message::text(msg_json.clone())));
            }
        }
    }
}
