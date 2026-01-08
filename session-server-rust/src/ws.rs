use crate::auth::Claims;
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
const MIN_STATE_UPDATE_INTERVAL_MS: u64 = 500;
const POSITION_JITTER_THRESHOLD: f64 = 0.5;
const COMMAND_COOLDOWN_MS: u64 = 2000;

// Rate limiting constants
const RATE_LIMIT_MESSAGES: u32 = 30;  // Max messages per window
const RATE_LIMIT_WINDOW_MS: u64 = 1000;  // Window size in ms

// Resource limits
const MAX_ROOMS_PER_USER: usize = 3;  // Max rooms a user can host
const MAX_CLIENTS_PER_ROOM: usize = 20;  // Max clients in a room

pub async fn client_connection(ws: warp::ws::WebSocket, clients: Clients, rooms: crate::types::Rooms, claims: Claims) {
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();
    let client_rcv = UnboundedReceiverStream::new(client_rcv);

    tokio::task::spawn(async move {
        let _ = client_rcv.forward(client_ws_sender).await;
    });

    let temp_id = uuid::Uuid::new_v4().to_string();
    println!("[server] Client connected: {} (user: {}, name: {})", temp_id, claims.sub, claims.name);
    clients.write().await.insert(temp_id.clone(), crate::types::Client {
        sender: client_sender,
        room_id: None,
        user_id: claims.sub,
        user_name: claims.name,
        message_count: 0,
        last_reset: now_ms(),
    });

    {
        let locked_clients = clients.read().await;
        send_to_client(&temp_id, &locked_clients, &WsMessage {
            msg_type: "client_hello".to_string(),
            room: None,
            client: Some(temp_id.clone()),
            payload: Some(serde_json::json!({ "client_id": temp_id.clone() })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        });
    }

    send_room_list(&temp_id, &clients, &rooms).await;

    while let Some(result) = client_ws_rcv.next().await {
        if let Ok(msg) = result {
            client_msg(&temp_id, msg, &clients, &rooms).await;
        }
    }

    crate::room::handle_disconnect(&temp_id, &clients, &rooms).await;
}

fn all_ready(room: &Room) -> bool {
    room.ready_clients.len() >= room.clients.len()
}

async fn broadcast_scheduled_play(room: &mut Room, clients: &Clients, position: f64, target_server_ts: u64) {
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
    let locked_clients = clients.read().await;
    broadcast_to_room(room, &locked_clients, &msg, None);
}

fn schedule_pending_play(room_id: String, created_at: u64, rooms: crate::types::Rooms, clients: Clients) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(MAX_READY_WAIT_MS)).await;
        let mut locked_rooms = rooms.write().await;
        if let Some(room) = locked_rooms.get_mut(&room_id) {
            if let Some(pending) = &room.pending_play {
                if pending.created_at != created_at {
                    return;
                }
                let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                let position = pending.position;
                room.pending_play = None;

                // Update room state
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
                let locked_clients = clients.read().await;
                broadcast_to_room(room, &locked_clients, &msg, None);
            }
        }
    });
}

/// Returns true if the client is rate limited (should drop the message)
async fn check_rate_limit(client_id: &str, clients: &Clients) -> bool {
    let mut locked_clients = clients.write().await;
    if let Some(client) = locked_clients.get_mut(client_id) {
        let now = now_ms();
        // Reset counter if window has passed
        if now - client.last_reset > RATE_LIMIT_WINDOW_MS {
            client.message_count = 0;
            client.last_reset = now;
        }
        client.message_count += 1;
        if client.message_count > RATE_LIMIT_MESSAGES {
            return true; // Rate limited
        }
    }
    false
}

async fn client_msg(client_id: &str, msg: warp::ws::Message, clients: &Clients, rooms: &crate::types::Rooms) {
    // Rate limiting check
    if check_rate_limit(client_id, clients).await {
        eprintln!("[server] Rate limited client: {}", client_id);
        return;
    }

    let msg_str = if let Ok(s) = msg.to_str() { s } else { return };
    println!("[server] Received from {}: {}", client_id, msg_str);

    let mut parsed: WsMessage = match serde_json::from_str(msg_str) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[server] JSON error: {}", e);
            return;
        }
    };

    match parsed.msg_type.as_str() {
        "list_rooms" => {
            send_room_list(client_id, clients, rooms).await;
        },
        "create_room" => {
            if let Some(payload) = &parsed.payload {
                // Check if user already hosts too many rooms
                {
                    let locked_rooms = rooms.read().await;
                    let rooms_hosted = locked_rooms.values()
                        .filter(|r| r.host_id == client_id)
                        .count();
                    if rooms_hosted >= MAX_ROOMS_PER_USER {
                        let locked_clients = clients.read().await;
                        send_to_client(client_id, &locked_clients, &WsMessage {
                            msg_type: "error".to_string(),
                            room: None,
                            client: Some(client_id.to_string()),
                            payload: Some(serde_json::json!({ "message": "Maximum rooms limit reached" })),
                            ts: now_ms(),
                            server_ts: Some(now_ms()),
                        });
                        return;
                    }
                }

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
                    last_state_ts: now_ms(),
                    last_command_ts: 0,
                };

                {
                    let mut locked_rooms = rooms.write().await;
                    let mut locked_clients = clients.write().await;

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
                }

                broadcast_room_list(clients, rooms).await;
            }
        },
        "join_room" => {
            if let Some(ref room_id) = parsed.room {
                let mut locked_rooms = rooms.write().await;
                let mut locked_clients = clients.write().await;

                if let Some(room) = locked_rooms.get_mut(room_id) {
                    // Check room capacity before joining
                    if !room.clients.contains(&client_id.to_string()) && room.clients.len() >= MAX_CLIENTS_PER_ROOM {
                        send_to_client(client_id, &locked_clients, &WsMessage {
                            msg_type: "error".to_string(),
                            room: Some(room_id.clone()),
                            client: Some(client_id.to_string()),
                            payload: Some(serde_json::json!({ "message": "Room is full" })),
                            ts: now_ms(),
                            server_ts: Some(now_ms()),
                        });
                        return;
                    }

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
                let mut locked_rooms = rooms.write().await;
                if let Some(room) = locked_rooms.get_mut(room_id) {
                    room.ready_clients.insert(client_id.to_string());
                    if room.pending_play.is_some() && all_ready(room) {
                        let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                        let position = room.pending_play.as_ref().map(|p| p.position).unwrap_or(room.state.position);
                        room.pending_play = None;
                        broadcast_scheduled_play(room, clients, position, target_server_ts).await;
                    }
                }
            }
        },
        "leave_room" => {
            println!("[server] Client {} requested leave", client_id);
            {
                let mut locked_clients = clients.write().await;
                let mut locked_rooms = rooms.write().await;
                handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
            }
            broadcast_room_list(clients, rooms).await;
        },
        "player_event" | "state_update" => {
            if let Some(ref room_id) = parsed.room {
                let mut locked_rooms = rooms.write().await;
                let locked_clients = clients.read().await;

                if let Some(room) = locked_rooms.get_mut(room_id) {
                    if room.host_id != client_id {
                        return;
                    }

                    let current_ts = now_ms();

                    // For state_update: filter out updates that are too frequent or have insignificant changes
                    if parsed.msg_type == "state_update" {
                        // Ignore state_updates during command cooldown (HLS echo prevention)
                        if room.last_command_ts > 0 && current_ts - room.last_command_ts < COMMAND_COOLDOWN_MS {
                            return;
                        }

                        if let Some(payload) = &parsed.payload {
                            let new_pos = payload.get("position").and_then(|v| v.as_f64()).unwrap_or(room.state.position);
                            let new_play_state = payload.get("play_state").and_then(|v| v.as_str()).unwrap_or(&room.state.play_state);
                            let play_state_changed = new_play_state != room.state.play_state;
                            let pos_diff = new_pos - room.state.position;

                            if !play_state_changed {
                                if current_ts - room.last_state_ts < MIN_STATE_UPDATE_INTERVAL_MS {
                                    return;
                                }
                                if pos_diff < -POSITION_JITTER_THRESHOLD && pos_diff > -2.0 {
                                    return;
                                }
                                if pos_diff >= 0.0 && pos_diff < POSITION_JITTER_THRESHOLD {
                                    return;
                                }
                            }
                        }
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

                    room.last_state_ts = current_ts;

                    if parsed.msg_type == "player_event" {
                        let action = parsed.payload.as_ref().and_then(|p| p.get("action")).and_then(|v| v.as_str()).unwrap_or("");
                        room.last_command_ts = current_ts;

                        if action == "play" {
                            let position = parsed.payload.as_ref().and_then(|p| p.get("position")).and_then(|v| v.as_f64()).unwrap_or(room.state.position);
                            if all_ready(room) {
                                let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                                broadcast_scheduled_play(room, clients, position, target_server_ts).await;
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
            let locked_clients = clients.read().await;
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
