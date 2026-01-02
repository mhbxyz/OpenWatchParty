use crate::messaging::{broadcast_room_list, broadcast_to_room, send_room_list, send_to_client};
use crate::room::handle_leave;
use crate::types::{Clients, PendingPlay, PlaybackState, Room, WsMessage};
use crate::utils::now_ms;
use futures::StreamExt;
use std::collections::HashSet;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

const PLAY_SCHEDULE_MS: u64 = 1500;
const CONTROL_SCHEDULE_MS: u64 = 300;
const MAX_READY_WAIT_MS: u64 = 2000;

pub async fn client_connection(ws: warp::ws::WebSocket, clients: Clients, rooms: crate::types::Rooms) {
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();
    let client_rcv = UnboundedReceiverStream::new(client_rcv);

    tokio::task::spawn(async move {
        let _ = client_rcv.forward(client_ws_sender).await;
    });

    let temp_id = uuid::Uuid::new_v4().to_string();
    println!("[server] Client connected: {}", temp_id);
    clients.lock().unwrap().insert(temp_id.clone(), crate::types::Client { sender: client_sender, room_id: None });

    send_to_client(&temp_id, &clients.lock().unwrap(), &WsMessage {
        msg_type: "client_hello".to_string(),
        room: None,
        client: Some(temp_id.clone()),
        payload: Some(serde_json::json!({ "client_id": temp_id.clone() })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    });

    send_room_list(&temp_id, &clients, &rooms);

    while let Some(result) = client_ws_rcv.next().await {
        if let Ok(msg) = result {
            client_msg(&temp_id, msg, &clients, &rooms).await;
        }
    }

    crate::room::handle_disconnect(&temp_id, &clients, &rooms);
}

fn all_ready(room: &Room) -> bool {
    room.ready_clients.len() >= room.clients.len()
}

fn broadcast_scheduled_play(room: &mut Room, clients: &Clients, position: f64, target_server_ts: u64) {
    room.state.position = position;
    room.state.play_state = "playing".to_string();
    let msg = WsMessage {
        msg_type: "player_event".to_string(),
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(serde_json::json!({
            "action": "play",
            "position": position,
            "target_server_ts": target_server_ts
        })),
        ts: now_ms(),
        server_ts: Some(target_server_ts),
    };
    let locked_clients = clients.lock().unwrap();
    broadcast_to_room(room, &locked_clients, &msg, None);
}

fn schedule_pending_play(room_id: String, created_at: u64, rooms: crate::types::Rooms, clients: Clients) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(MAX_READY_WAIT_MS)).await;
        let mut locked_rooms = rooms.lock().unwrap();
        if let Some(room) = locked_rooms.get_mut(&room_id) {
            if let Some(pending) = &room.pending_play {
                if pending.created_at != created_at {
                    return;
                }
                let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                let position = pending.position;
                room.pending_play = None;
                broadcast_scheduled_play(room, &clients, position, target_server_ts);
            }
        }
    });
}

async fn client_msg(client_id: &str, msg: warp::ws::Message, clients: &Clients, rooms: &crate::types::Rooms) {
    let msg_str = if let Ok(s) = msg.to_str() { s } else { return };
    println!("[server] Received from {}: {}", client_id, msg_str);

    let mut parsed: WsMessage = match serde_json::from_str(msg_str) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[server] JSON error: {}", e);
            return;
        }
    };

    let mut locked_rooms = rooms.lock().unwrap();
    let mut locked_clients = clients.lock().unwrap();

    match parsed.msg_type.as_str() {
        "list_rooms" => {
            drop(locked_rooms);
            drop(locked_clients);
            send_room_list(client_id, clients, rooms);
        },
        "create_room" => {
            if let Some(payload) = &parsed.payload {
                let room_name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("New Room").to_string();
                let room_id = uuid::Uuid::new_v4().to_string();
                let start_pos = payload.get("start_pos").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let media_id = payload.get("media_id").and_then(|v| v.as_str()).map(|v| v.to_string());

                println!("[server] Creating room '{}' ({}) for {}", room_name, room_id, client_id);

                let room = Room {
                    room_id: room_id.clone(),
                    name: room_name,
                    host_id: client_id.to_string(),
                    media_id,
                    clients: vec![client_id.to_string()],
                    ready_clients: HashSet::from([client_id.to_string()]),
                    pending_play: None,
                    state: PlaybackState { position: start_pos, play_state: "paused".to_string() },
                };

                locked_rooms.insert(room_id.clone(), room.clone());
                if let Some(client) = locked_clients.get_mut(client_id) {
                    client.room_id = Some(room_id.clone());
                }

                send_to_client(client_id, &locked_clients, &WsMessage {
                    msg_type: "room_state".to_string(),
                    room: Some(room_id.clone()),
                    client: Some(client_id.to_string()),
                    payload: Some(serde_json::json!({ "name": room.name, "host_id": room.host_id, "state": room.state, "participant_count": 1, "media_id": room.media_id })),
                    ts: now_ms(),
                    server_ts: Some(now_ms()),
                });

                drop(locked_rooms);
                drop(locked_clients);
                broadcast_room_list(clients, rooms);
            }
        },
        "join_room" => {
            if let Some(ref room_id) = parsed.room {
                if let Some(room) = locked_rooms.get_mut(room_id) {
                    println!("[server] Client {} joining room {}", client_id, room_id);
                    if !room.clients.contains(&client_id.to_string()) {
                        room.clients.push(client_id.to_string());
                    }
                    room.ready_clients.remove(client_id);
                    if let Some(client) = locked_clients.get_mut(client_id) {
                        client.room_id = Some(room_id.clone());
                    }

                    send_to_client(client_id, &locked_clients, &WsMessage {
                        msg_type: "room_state".to_string(),
                        room: Some(room_id.clone()),
                        client: Some(client_id.to_string()),
                        payload: Some(serde_json::json!({ "name": room.name, "host_id": room.host_id, "state": room.state, "participant_count": room.clients.len(), "media_id": room.media_id })),
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    });

                    broadcast_to_room(room, &locked_clients, &WsMessage {
                        msg_type: "participants_update".to_string(),
                        room: Some(room_id.clone()),
                        client: None,
                        payload: Some(serde_json::json!({ "participant_count": room.clients.len() })),
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    }, Some(client_id));
                }
            }
        },
        "ready" => {
            if let Some(ref room_id) = parsed.room {
                if let Some(room) = locked_rooms.get_mut(room_id) {
                    room.ready_clients.insert(client_id.to_string());
                    if room.pending_play.is_some() && all_ready(room) {
                        let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                        let position = room.pending_play.as_ref().map(|p| p.position).unwrap_or(room.state.position);
                        room.pending_play = None;
                        broadcast_scheduled_play(room, clients, position, target_server_ts);
                    }
                }
            }
        },
        "leave_room" => {
            println!("[server] Client {} requested leave", client_id);
            handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
            drop(locked_rooms);
            drop(locked_clients);
            broadcast_room_list(clients, rooms);
        },
        "player_event" | "state_update" => {
            if let Some(ref room_id) = parsed.room {
                if let Some(room) = locked_rooms.get_mut(room_id) {
                    if room.host_id != client_id {
                        return;
                    }
                    if let Some(payload) = &parsed.payload {
                        if let Some(pos) = payload.get("position").and_then(|v| v.as_f64()) { room.state.position = pos; }
                        if let Some(st) = payload.get("play_state").and_then(|v| v.as_str()) { room.state.play_state = st.to_string(); }
                        if parsed.msg_type == "player_event" {
                             if let Some(action) = payload.get("action").and_then(|v| v.as_str()) {
                                 if action == "play" { room.state.play_state = "playing".to_string(); }
                                 if action == "pause" { room.state.play_state = "paused".to_string(); }
                             }
                        }
                    }
                    if parsed.msg_type == "player_event" {
                        let action = parsed.payload.as_ref().and_then(|p| p.get("action")).and_then(|v| v.as_str()).unwrap_or("");
                        if action == "play" {
                            let position = parsed.payload.as_ref().and_then(|p| p.get("position")).and_then(|v| v.as_f64()).unwrap_or(room.state.position);
                            if all_ready(room) {
                                let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                                broadcast_scheduled_play(room, clients, position, target_server_ts);
                            } else {
                                let created_at = now_ms();
                                room.pending_play = Some(PendingPlay { position, created_at });
                                schedule_pending_play(room_id.clone(), created_at, rooms.clone(), clients.clone());
                            }
                        } else {
                            let target_server_ts = now_ms() + CONTROL_SCHEDULE_MS;
                            if let Some(payload) = parsed.payload.as_mut() {
                                payload["target_server_ts"] = serde_json::json!(target_server_ts);
                            }
                            parsed.server_ts = Some(target_server_ts);
                            for dest_id in &room.clients {
                                if dest_id != client_id { send_to_client(dest_id, &locked_clients, &parsed); }
                            }
                        }
                    } else {
                        parsed.server_ts = Some(now_ms());
                        for dest_id in &room.clients {
                            if dest_id != client_id { send_to_client(dest_id, &locked_clients, &parsed); }
                        }
                    }
                }
            }
        },
        "ping" => {
            send_to_client(client_id, &locked_clients, &WsMessage {
                msg_type: "pong".to_string(),
                room: parsed.room,
                client: parsed.client,
                payload: parsed.payload,
                ts: now_ms(),
                server_ts: Some(now_ms()),
            });
        },
        _ => {}
    }
}
