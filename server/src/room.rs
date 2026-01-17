use crate::messaging::{broadcast_room_list, broadcast_to_room, send_to_client};
use crate::types::{Client, Clients, Room, Rooms, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;

pub async fn handle_disconnect(client_id: &str, clients: &Clients, rooms: &Rooms) {
    info!("Disconnecting client {}", client_id);
    {
        let mut locked_clients = clients.write().await;
        let mut locked_rooms = rooms.write().await;
        handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
        locked_clients.remove(client_id);
    }
    broadcast_room_list(clients, rooms).await;
}

pub fn handle_leave(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) {
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
                        payload: Some(
                            serde_json::json!({ "participant_count": room.clients.len() }),
                        ),
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    };
                    broadcast_to_room(room, clients, &msg, None);
                }
            }
        }
    }

    if let Some(room_id) = room_to_remove {
        info!("Closing room {}", room_id);
        rooms.remove(&room_id);
        // Use WsMessage struct for consistent message format (fixes B03)
        let msg = WsMessage {
            msg_type: "room_closed".to_string(),
            room: Some(room_id),
            client: None,
            payload: Some(serde_json::json!({ "reason": "Host left the room" })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        };
        if let Ok(msg_json) = serde_json::to_string(&msg) {
            for cid in clients_to_notify {
                if let Some(c) = clients.get(&cid) {
                    // Use try_send for bounded channel (non-blocking)
                    let _ = c
                        .sender
                        .try_send(Ok(warp::ws::Message::text(msg_json.clone())));
                }
            }
        }
    }
}

/// Close a room by ID, notifying all participants.
/// Used when a host creates a new room while one already exists.
pub async fn close_room(room_id: &str, clients: &Clients, rooms: &Rooms) {
    let clients_to_notify: Vec<String>;

    {
        let mut locked_rooms = rooms.write().await;
        let locked_clients = clients.read().await;

        if let Some(room) = locked_rooms.remove(room_id) {
            info!("Closing room {} (host creating new room)", room_id);
            clients_to_notify = room.clients.clone();

            // Notify all participants that the room is closed
            let msg = WsMessage {
                msg_type: "room_closed".to_string(),
                room: Some(room_id.to_string()),
                client: None,
                payload: Some(serde_json::json!({ "reason": "Host started a new room" })),
                ts: now_ms(),
                server_ts: Some(now_ms()),
            };

            for cid in &clients_to_notify {
                send_to_client(cid, &locked_clients, &msg);
            }

            // Clear room_id from all clients that were in this room
            drop(locked_clients);
            let mut locked_clients = clients.write().await;
            for cid in &clients_to_notify {
                if let Some(client) = locked_clients.get_mut(cid) {
                    if client.room_id.as_deref() == Some(room_id) {
                        client.room_id = None;
                    }
                }
            }
        } else {
            return;
        }
    }

    broadcast_room_list(clients, rooms).await;
}
