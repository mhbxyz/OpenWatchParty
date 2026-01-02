use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use warp::Filter;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

type Clients = Arc<Mutex<HashMap<String, Client>>>;
type Rooms = Arc<Mutex<HashMap<String, Room>>>;

#[derive(Debug, Clone)]
struct Client {
    sender: mpsc::UnboundedSender<std::result::Result<warp::ws::Message, warp::Error>>,
    room_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Room {
    room_id: String,
    name: String,
    host_id: String,
    clients: Vec<String>,
    state: PlaybackState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlaybackState {
    position: f64,
    play_state: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
    ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ts: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::main]
async fn main() {
    let clients: Clients = Arc::new(Mutex::new(HashMap::new()));
    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));

    let clients_filter = warp::any().map(move || clients.clone());
    let rooms_filter = warp::any().map(move || rooms.clone());

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .map(|ws: warp::ws::Ws, clients, rooms| {
            ws.on_upgrade(move |socket| client_connection(socket, clients, rooms))
        });

    println!("OpenSyncParty Rust Server running on 0.0.0.0:3000");
    warp::serve(ws_route).run(([0, 0, 0, 0], 3000)).await;
}

async fn client_connection(ws: warp::ws::WebSocket, clients: Clients, rooms: Rooms) {
    use futures::StreamExt;
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();
    let client_rcv = tokio_stream::wrappers::UnboundedReceiverStream::new(client_rcv);
    
    tokio::task::spawn(async move {
        let _ = client_rcv.forward(client_ws_sender).await;
    });

    let temp_id = uuid::Uuid::new_v4().to_string();
    println!("[server] Client connected: {}", temp_id);
    clients.lock().unwrap().insert(temp_id.clone(), Client { sender: client_sender, room_id: None });

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

    handle_disconnect(&temp_id, &clients, &rooms);
}

async fn client_msg(client_id: &str, msg: warp::ws::Message, clients: &Clients, rooms: &Rooms) {
    let msg_str = if let Ok(s) = msg.to_str() { s } else { return };
    println!("[server] Received from {}: {}", client_id, msg_str);
    
    let parsed: WsMessage = match serde_json::from_str(msg_str) {
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
            drop(locked_rooms); drop(locked_clients);
            send_room_list(client_id, clients, rooms);
        },
        "create_room" => {
            if let Some(payload) = &parsed.payload {
                let room_name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("New Room").to_string();
                let room_id = uuid::Uuid::new_v4().to_string();
                let start_pos = payload.get("start_pos").and_then(|v| v.as_f64()).unwrap_or(0.0);
                
                println!("[server] Creating room '{}' ({}) for {}", room_name, room_id, client_id);
                
                let room = Room {
                    room_id: room_id.clone(),
                    name: room_name,
                    host_id: client_id.to_string(),
                    clients: vec![client_id.to_string()],
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
                    payload: Some(serde_json::json!({ "name": room.name, "host_id": room.host_id, "state": room.state, "participant_count": 1 })),
                    ts: now_ms(),
                    server_ts: Some(now_ms()),
                });
                
                drop(locked_rooms); drop(locked_clients);
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
                    if let Some(client) = locked_clients.get_mut(client_id) {
                        client.room_id = Some(room_id.clone());
                    }

                    send_to_client(client_id, &locked_clients, &WsMessage {
                        msg_type: "room_state".to_string(),
                        room: Some(room_id.clone()),
                        client: Some(client_id.to_string()),
                        payload: Some(serde_json::json!({ "name": room.name, "host_id": room.host_id, "state": room.state, "participant_count": room.clients.len() })),
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
        "leave_room" => {
            println!("[server] Client {} requested leave", client_id);
            handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
            drop(locked_rooms); drop(locked_clients);
            broadcast_room_list(clients, rooms);
        },
        "player_event" | "state_update" => {
            if let Some(ref room_id) = parsed.room {
                if let Some(room) = locked_rooms.get_mut(room_id) {
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
                    for dest_id in &room.clients {
                        if dest_id != client_id { send_to_client(dest_id, &locked_clients, &parsed); }
                    }
                }
            }
        },
        "ping" => {
            send_to_client(client_id, &locked_clients, &WsMessage {
                msg_type: "pong".to_string(), room: parsed.room, client: parsed.client, payload: parsed.payload, ts: now_ms(), server_ts: Some(now_ms()),
            });
        },
        _ => {}
    }
}

fn handle_disconnect(client_id: &str, clients: &Clients, rooms: &Rooms) {
    println!("[server] Disconnecting client {}", client_id);
    let mut locked_clients = clients.lock().unwrap();
    let mut locked_rooms = rooms.lock().unwrap();
    handle_leave(client_id, &mut locked_clients, &mut locked_rooms);
    locked_clients.remove(client_id);
    drop(locked_rooms); drop(locked_clients);
    broadcast_room_list(clients, rooms);
}

fn handle_leave(client_id: &str, clients: &mut HashMap<String, Client>, rooms: &mut HashMap<String, Room>) {
    let mut room_to_remove = None;
    let mut clients_to_notify = Vec::new();

    if let Some(client) = clients.get_mut(client_id) {
        if let Some(room_id) = client.room_id.take() {
            if let Some(room) = rooms.get_mut(&room_id) {
                room.clients.retain(|id| id != client_id);
                if room.clients.is_empty() || room.host_id == client_id {
                    clients_to_notify = room.clients.clone();
                    room_to_remove = Some(room_id.clone());
                } else {
                    let msg = WsMessage { msg_type: "client_left".to_string(), room: Some(room_id), client: Some(client_id.to_string()), payload: None, ts: now_ms(), server_ts: Some(now_ms()) };
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

fn send_room_list(client_id: &str, clients: &Clients, rooms: &Rooms) {
    let locked_rooms = rooms.lock().unwrap();
    let list: Vec<serde_json::Value> = locked_rooms.values().map(|r| {
        serde_json::json!({ "id": r.room_id, "name": r.name, "count": r.clients.len() })
    }).collect();
    
    let msg = WsMessage {
        msg_type: "room_list".to_string(),
        room: None, client: None,
        payload: Some(serde_json::json!(list)),
        ts: now_ms(), server_ts: Some(now_ms()),
    };
    
    let locked_clients = clients.lock().unwrap();
    send_to_client(client_id, &locked_clients, &msg);
}

fn broadcast_room_list(clients: &Clients, rooms: &Rooms) {
    let client_ids: Vec<String> = {
        let locked_clients = clients.lock().unwrap();
        locked_clients.keys().cloned().collect()
    };
    for id in client_ids {
        send_room_list(&id, clients, rooms);
    }
}

fn send_to_client(client_id: &str, clients: &HashMap<String, Client>, msg: &WsMessage) {
    if let Some(client) = clients.get(client_id) {
        let json = serde_json::to_string(msg).unwrap();
        let _ = client.sender.send(Ok(warp::ws::Message::text(json)));
    }
}

fn broadcast_to_room(room: &Room, clients: &HashMap<String, Client>, msg: &WsMessage, exclude: Option<&str>) {
    let json = serde_json::to_string(msg).unwrap();
    let warp_msg = warp::ws::Message::text(json);
    for client_id in &room.clients {
        if Some(client_id.as_str()) == exclude { continue; }
        if let Some(client) = clients.get(client_id) {
            let _ = client.sender.send(Ok(warp_msg.clone()));
        }
    }
}
