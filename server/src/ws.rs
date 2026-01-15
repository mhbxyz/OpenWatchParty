use crate::auth::JwtConfig;
use crate::messaging::{broadcast_room_list, broadcast_to_room, send_room_list, send_to_client};
use crate::room::{handle_leave, close_room};
use crate::types::{Clients, PlaybackState, Room, WsMessage};
use crate::utils::now_ms;
use futures::StreamExt;
use log::{debug, info, warn};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

// Channel buffer size for client message queues (prevents OOM from slow clients)
const CLIENT_CHANNEL_BUFFER: usize = 100;

const PLAY_SCHEDULE_MS: u64 = 1000;  // Reduced from 1500ms for better UX (UX-P1)
const CONTROL_SCHEDULE_MS: u64 = 300;
const MIN_STATE_UPDATE_INTERVAL_MS: u64 = 500;
const POSITION_JITTER_THRESHOLD: f64 = 0.5;
const COMMAND_COOLDOWN_MS: u64 = 2000;

// Rate limiting constants
const RATE_LIMIT_MESSAGES: u32 = 30;  // Max messages per window
const RATE_LIMIT_WINDOW_MS: u64 = 1000;  // Window size in ms

// Resource limits
const MAX_CLIENTS_PER_ROOM: usize = 20;  // Max clients in a room

// Payload validation
const MAX_POSITION_SECONDS: f64 = 86400.0;  // 24 hours max
const MAX_MESSAGE_SIZE: usize = 64 * 1024;  // 64 KB max message size

/// Validates a playback position value.
/// Returns false for NaN, Infinity, negative values, or values exceeding 24 hours (fixes L12).
fn is_valid_position(pos: f64) -> bool {
    pos.is_finite() && (0.0..=MAX_POSITION_SECONDS).contains(&pos)
}

fn is_valid_play_state(state: &str) -> bool {
    state == "playing" || state == "paused"
}

fn is_valid_media_id(id: &str) -> bool {
    // Jellyfin item IDs are 32 hex characters
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn client_connection(ws: warp::ws::WebSocket, clients: Clients, rooms: crate::types::Rooms, jwt_config: Arc<JwtConfig>) {
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    // Use bounded channel to prevent OOM from slow/malicious clients (P-RS03 fix)
    let (client_sender, client_rcv) = mpsc::channel(CLIENT_CHANNEL_BUFFER);
    let client_rcv = ReceiverStream::new(client_rcv);

    tokio::task::spawn(async move {
        let _ = client_rcv.forward(client_ws_sender).await;
    });

    let temp_id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    // Start unauthenticated (or authenticated if auth is disabled)
    let authenticated = !jwt_config.enabled;
    let (user_id, user_name) = if authenticated {
        ("anonymous".to_string(), "Anonymous".to_string())
    } else {
        ("".to_string(), "".to_string())
    };

    info!("Client connected: {} (auth_required: {})", temp_id, jwt_config.enabled);
    clients.write().await.insert(temp_id.clone(), crate::types::Client {
        sender: client_sender,
        room_id: None,
        user_id,
        user_name,
        authenticated,
        message_count: 0,
        last_reset: now,
        last_seen: now,
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
            client_msg(&temp_id, msg, &clients, &rooms, &jwt_config).await;
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

/// Returns true if the client is rate limited (should drop the message)
async fn check_rate_limit(client_id: &str, clients: &Clients) -> bool {
    let mut locked_clients = clients.write().await;
    if let Some(client) = locked_clients.get_mut(client_id) {
        let now = now_ms();
        // Update last_seen for zombie detection
        client.last_seen = now;
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

async fn send_error(client_id: &str, clients: &Clients, message: &str) {
    let locked_clients = clients.read().await;
    send_to_client(client_id, &locked_clients, &WsMessage {
        msg_type: "error".to_string(),
        room: None,
        client: Some(client_id.to_string()),
        payload: Some(serde_json::json!({ "message": message })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    });
}

/// Check if client is authenticated
async fn is_authenticated(client_id: &str, clients: &Clients) -> bool {
    let locked = clients.read().await;
    locked.get(client_id).map(|c| c.authenticated).unwrap_or(false)
}

async fn client_msg(client_id: &str, msg: warp::ws::Message, clients: &Clients, rooms: &crate::types::Rooms, jwt_config: &Arc<JwtConfig>) {
    // Rate limiting check
    if check_rate_limit(client_id, clients).await {
        warn!("Rate limited client: {}", client_id);
        send_error(client_id, clients, "Rate limit exceeded").await;
        return;
    }

    // Message size limit check (prevent OOM attacks)
    if msg.as_bytes().len() > MAX_MESSAGE_SIZE {
        warn!("Message too large from client {}: {} bytes", client_id, msg.as_bytes().len());
        send_error(client_id, clients, "Message too large").await;
        return;
    }

    let msg_str = if let Ok(s) = msg.to_str() { s } else { return };

    let mut parsed: WsMessage = match serde_json::from_str(msg_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("JSON parse error from {}: {}", client_id, e);
            send_error(client_id, clients, "Invalid message format").await;
            return;
        }
    };

    // Log message type only (not full payload for privacy)
    debug!("Message from {}: {}", client_id, parsed.msg_type);

    match parsed.msg_type.as_str() {
        "auth" => {
            // Handle authentication via message (security: token not in URL)
            if let Some(payload) = &parsed.payload {
                // Try JWT token first
                if let Some(token) = payload.get("token").and_then(|v| v.as_str()) {
                    match jwt_config.validate_token(token) {
                        Ok(claims) => {
                            let mut locked = clients.write().await;
                            if let Some(client) = locked.get_mut(client_id) {
                                client.authenticated = true;
                                client.user_id = claims.sub;
                                client.user_name = claims.name.clone();
                                info!("Client {} authenticated as {}", client_id, claims.name);
                            }
                            drop(locked);
                            let locked_clients = clients.read().await;
                            send_to_client(client_id, &locked_clients, &WsMessage {
                                msg_type: "auth_success".to_string(),
                                room: None,
                                client: Some(client_id.to_string()),
                                payload: Some(serde_json::json!({ "user_name": claims.name })),
                                ts: now_ms(),
                                server_ts: Some(now_ms()),
                            });
                            return;
                        }
                        Err(e) => {
                            warn!("Auth failed for {}: {}", client_id, e);
                            send_error(client_id, clients, "Authentication failed").await;
                            return;
                        }
                    }
                }
                // If no token but user_name provided, accept identity (auth disabled mode)
                // This allows clients to identify themselves when JWT is not required
                if !jwt_config.enabled {
                    let user_name = payload.get("user_name").and_then(|v| v.as_str());
                    let user_id = payload.get("user_id").and_then(|v| v.as_str());
                    if let Some(name) = user_name {
                        let mut locked = clients.write().await;
                        if let Some(client) = locked.get_mut(client_id) {
                            client.user_name = name.to_string();
                            if let Some(uid) = user_id {
                                client.user_id = uid.to_string();
                            }
                            info!("Client {} identified as {}", client_id, name);
                        }
                    }
                }
            }
        },
        "list_rooms" => {
            send_room_list(client_id, clients, rooms).await;
        },
        "create_room" => {
            // Require authentication for room operations
            if !is_authenticated(client_id, clients).await {
                send_error(client_id, clients, "Authentication required").await;
                return;
            }

            // Close any existing room by this user (one room per user)
            let existing_room_id = {
                let locked_rooms = rooms.read().await;
                locked_rooms.values()
                    .find(|r| r.host_id == client_id)
                    .map(|r| r.room_id.clone())
            };
            if let Some(room_id) = existing_room_id {
                close_room(&room_id, clients, rooms).await;
            }

            // Debug: log the payload
            info!("create_room payload: {:?}", parsed.payload);

            // Get username from payload first, fall back to client state
            let host_name = match parsed.payload.as_ref()
                .and_then(|p| p.get("user_name"))
                .and_then(|v| v.as_str())
            {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => {
                    let locked_clients = clients.read().await;
                    locked_clients.get(client_id)
                        .map(|c| c.user_name.clone())
                        .unwrap_or_else(|| "Anonymous".to_string())
                }
            };
            let room_name = format!("Room de {}", host_name);

            let room_id = uuid::Uuid::new_v4().to_string();
            let raw_start_pos = parsed.payload.as_ref()
                .and_then(|p| p.get("start_pos"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let start_pos = if is_valid_position(raw_start_pos) { raw_start_pos } else { 0.0 };
            let media_id = parsed.payload.as_ref()
                .and_then(|p| p.get("media_id"))
                .and_then(|v| v.as_str())
                .filter(|id| is_valid_media_id(id))
                .map(|v| v.to_string());

            info!("Creating room '{}' ({}) for {}", room_name, room_id, client_id);

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
        },
        "join_room" => {
            // Require authentication for room operations
            if !is_authenticated(client_id, clients).await {
                send_error(client_id, clients, "Authentication required").await;
                return;
            }
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

                    info!("Client {} joining room {}", client_id, room_id);
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
            info!("Client {} leaving room", client_id);
            {
                let mut locked_clients = clients.write().await;
                let mut locked_rooms = rooms.write().await;
                handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
            }
            broadcast_room_list(clients, rooms).await;
        },
        "player_event" | "state_update" => {
            if let Some(ref room_id) = parsed.room {
                // P-RS01 fix: Collect senders while holding lock, then send after releasing
                // This reduces lock contention during broadcasts
                let broadcast_data: Option<(Vec<mpsc::Sender<_>>, String)> = {
                    let mut locked_rooms = rooms.write().await;
                    let locked_clients = clients.read().await;

                    if let Some(room) = locked_rooms.get_mut(room_id) {
                        if room.host_id != client_id {
                            None
                        } else {
                            let current_ts = now_ms();

                            // For state_update: filter out updates that are too frequent or have insignificant changes
                            let should_process = if parsed.msg_type == "state_update" {
                                if let Some(payload) = &parsed.payload {
                                    let new_pos = payload.get("position").and_then(|v| v.as_f64()).unwrap_or(room.state.position);
                                    let new_play_state = payload.get("play_state").and_then(|v| v.as_str()).unwrap_or(&room.state.play_state);
                                    let play_state_changed = new_play_state != room.state.play_state;
                                    let pos_diff = new_pos - room.state.position;

                                    // Always allow state_update if play_state changed (critical for sync)
                                    // Only apply cooldown/throttle for position-only updates
                                    if play_state_changed {
                                        true
                                    } else {
                                        // Check various throttle conditions
                                        let in_command_cooldown = room.last_command_ts > 0 && current_ts - room.last_command_ts < COMMAND_COOLDOWN_MS;
                                        let too_frequent = current_ts - room.last_state_ts < MIN_STATE_UPDATE_INTERVAL_MS;
                                        let small_backward_jitter = (-2.0..-POSITION_JITTER_THRESHOLD).contains(&pos_diff);
                                        let small_forward_jitter = (0.0..POSITION_JITTER_THRESHOLD).contains(&pos_diff);

                                        !(in_command_cooldown || too_frequent || small_backward_jitter || small_forward_jitter)
                                    }
                                } else {
                                    true
                                }
                            } else {
                                true
                            };

                            if !should_process {
                                None
                            } else {
                                if let Some(payload) = &parsed.payload {
                                    // Validate and update position
                                    if let Some(pos) = payload.get("position").and_then(|v| v.as_f64()) {
                                        if is_valid_position(pos) {
                                            room.state.position = pos;
                                        }
                                    }
                                    // Validate and update play_state
                                    if let Some(st) = payload.get("play_state").and_then(|v| v.as_str()) {
                                        if is_valid_play_state(st) {
                                            room.state.play_state = st.to_string();
                                        }
                                    }
                                    if parsed.msg_type == "player_event" {
                                        if let Some(action) = payload.get("action").and_then(|v| v.as_str()) {
                                            if action == "play" { room.state.play_state = "playing".to_string(); }
                                            if action == "pause" { room.state.play_state = "paused".to_string(); }
                                        }
                                    }
                                }

                                room.last_state_ts = current_ts;

                                if parsed.msg_type == "player_event" {
                                    room.last_command_ts = current_ts;
                                    let target_server_ts = now_ms() + CONTROL_SCHEDULE_MS;
                                    if let Some(payload) = parsed.payload.as_mut() {
                                        payload["target_server_ts"] = serde_json::json!(target_server_ts);
                                    }
                                    parsed.server_ts = Some(target_server_ts);
                                } else {
                                    parsed.server_ts = Some(now_ms());
                                }

                                // Collect senders for clients in the room (excluding sender)
                                let senders: Vec<_> = room.clients.iter()
                                    .filter(|id| *id != client_id)
                                    .filter_map(|id| locked_clients.get(id).map(|c| c.sender.clone()))
                                    .collect();

                                // Serialize message once
                                match serde_json::to_string(&parsed) {
                                    Ok(json) => Some((senders, json)),
                                    Err(e) => {
                                        log::error!("Failed to serialize message: {}", e);
                                        None
                                    }
                                }
                            }
                        }
                    } else {
                        None
                    }
                }; // Locks released here

                // Send messages without holding any locks (P-RS01 fix)
                if let Some((senders, json)) = broadcast_data {
                    let warp_msg = warp::ws::Message::text(json);
                    for sender in senders {
                        if let Err(e) = sender.try_send(Ok(warp_msg.clone())) {
                            log::warn!("Failed to send player event (buffer full or closed): {}", e);
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
        "client_log" => {
            // Forward client logs to server stdout for debugging
            if let Some(payload) = &parsed.payload {
                let category = payload.get("category").and_then(|v| v.as_str()).unwrap_or("LOG");
                let message = payload.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let short_id = &client_id[..8];
                info!("[CLIENT:{}:{}] {}", short_id, category, message);
            }
        },
        "quality_update" => {
            // Host broadcasts quality settings to all clients in the room
            if let Some(ref room_id) = parsed.room {
                // P-RS01 fix: Collect senders while holding lock, then send after releasing
                let broadcast_data: Option<(Vec<mpsc::Sender<_>>, String)> = {
                    let locked_rooms = rooms.read().await;
                    let locked_clients = clients.read().await;

                    if let Some(room) = locked_rooms.get(room_id) {
                        // Only host can change quality settings
                        if room.host_id != client_id {
                            None
                        } else {
                            info!("Host {} updated quality settings for room {}", client_id, room_id);

                            let msg = WsMessage {
                                msg_type: "quality_update".to_string(),
                                room: Some(room_id.clone()),
                                client: Some(client_id.to_string()),
                                payload: parsed.payload.clone(),
                                ts: now_ms(),
                                server_ts: Some(now_ms()),
                            };

                            // Collect senders for clients in the room (excluding sender)
                            let senders: Vec<_> = room.clients.iter()
                                .filter(|id| *id != client_id)
                                .filter_map(|id| locked_clients.get(id).map(|c| c.sender.clone()))
                                .collect();

                            match serde_json::to_string(&msg) {
                                Ok(json) => Some((senders, json)),
                                Err(e) => {
                                    log::error!("Failed to serialize quality_update: {}", e);
                                    None
                                }
                            }
                        }
                    } else {
                        None
                    }
                }; // Locks released here

                // Send messages without holding any locks
                if let Some((senders, json)) = broadcast_data {
                    let warp_msg = warp::ws::Message::text(json);
                    for sender in senders {
                        if let Err(e) = sender.try_send(Ok(warp_msg.clone())) {
                            log::warn!("Failed to send quality_update (buffer full or closed): {}", e);
                        }
                    }
                }
            }
        },
        other => {
            debug!("Unknown message type '{}' from {}", other, client_id);
        }
    }
}
