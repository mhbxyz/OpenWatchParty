use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use super::super::validation::{is_valid_media_id, is_valid_position, sanitize_name};
use crate::messaging::{broadcast_room_list, send_message, send_to_senders, ClientSender};
use crate::room::close_room_in_state;
use crate::room::handle_leave;
use crate::types::{IncomingMessage, PlaybackState, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashSet;
use tokio::time::Instant;

fn resolve_host_name(
    payload: Option<&serde_json::Value>,
    clients: &std::collections::HashMap<String, crate::types::Client>,
    client_id: &str,
) -> (String, Option<String>) {
    let payload_name = payload
        .and_then(|p| p.get("user_name"))
        .and_then(|v| v.as_str())
        .and_then(sanitize_name);
    let host_name = match &payload_name {
        Some(name) => name.clone(),
        None => clients
            .get(client_id)
            .map(|c| c.user_name.clone())
            .unwrap_or_else(|| "Anonymous".to_string()),
    };
    (host_name, payload_name)
}

fn build_room(client_id: &str, host_name: &str, payload: Option<&serde_json::Value>) -> Room {
    let room_id = uuid::Uuid::new_v4().to_string();
    let raw_start_pos = payload
        .and_then(|p| p.get("start_pos"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let start_pos = if is_valid_position(raw_start_pos) {
        raw_start_pos
    } else {
        0.0
    };
    let media_id = payload
        .and_then(|p| p.get("media_id"))
        .and_then(|v| v.as_str())
        .filter(|id| is_valid_media_id(id))
        .map(|v| v.to_string());
    let room_name = format!("Room de {host_name}");

    info!("Creating room '{room_name}' ({room_id}) for {client_id}");

    let state_server_ts = now_ms();
    Room {
        room_id,
        name: room_name,
        host_id: client_id.to_string(),
        media_id,
        clients: vec![client_id.to_string()],
        ready_clients: HashSet::from([client_id.to_string()]),
        pending_play: None,
        state: PlaybackState {
            position: start_pos,
            play_state: "paused".to_string(),
        },
        state_server_ts,
        target_server_ts: None,
        target_at: None,
        last_state_at: Some(Instant::now()),
        command_cooldown_until: None,
    }
}

fn insert_and_notify(
    client_id: &str,
    room: Room,
    payload_name: &Option<String>,
    locked_clients: &mut std::collections::HashMap<String, crate::types::Client>,
    locked_rooms: &mut std::collections::HashMap<String, Room>,
) -> (Option<ClientSender>, WsMessage) {
    let room_id = room.room_id.clone();
    locked_rooms.insert(room_id.clone(), room.clone());
    if let Some(client) = locked_clients.get_mut(client_id) {
        client.room_id = Some(room_id.clone());
        if let Some(ref name) = payload_name {
            client.user_name = name.clone();
        }
    }
    (
        locked_clients.get(client_id).map(|c| c.sender.clone()),
        WsMessage {
            msg_type: "room_state".to_string(),
            room: Some(room_id),
            client: Some(client_id.to_string()),
            payload: Some(serde_json::json!({
                "name": room.name,
                "host_id": room.host_id,
                "state": room.state,
                "state_server_ts": room.state_server_ts,
                "target_server_ts": null,
                "participant_count": 1,
                "media_id": room.media_id
            })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        },
    )
}

pub(in crate::ws) async fn handle_create_room(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if !is_authenticated(client_id, state).await {
        send_error(
            client_id,
            state,
            ErrorCode::AuthenticationRequired,
            "Authentication required",
        )
        .await;
        return;
    }

    info!("create_room payload: {:?}", parsed.payload);

    let payload_ref = parsed.payload.as_ref();
    {
        let mut state = state.write().await;
        let should_leave_guest_room = state
            .clients
            .get(client_id)
            .and_then(|client| client.room_id.as_ref())
            .and_then(|room_id| state.rooms.get(room_id))
            .is_some_and(|room| room.host_id != client_id);
        let previous_leave = if should_leave_guest_room {
            let crate::types::ServerState { clients, rooms } = &mut *state;
            handle_leave(client_id, clients, rooms)
        } else {
            None
        };
        let existing_room_id = state
            .rooms
            .values()
            .find(|room| room.host_id == client_id)
            .map(|room| room.room_id.clone());
        let closed = existing_room_id.and_then(|room_id| {
            close_room_in_state(&room_id, &mut state).map(|senders| (room_id, senders))
        });
        let (host_name, payload_name) = resolve_host_name(payload_ref, &state.clients, client_id);
        let room = build_room(client_id, &host_name, payload_ref);
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let (sender, room_msg) = insert_and_notify(client_id, room, &payload_name, clients, rooms);
        if let Some((senders, msg)) = previous_leave {
            send_to_senders(&senders, &msg, "previous room leave");
        }
        if let Some((closed_room_id, closed_senders)) = closed {
            send_to_senders(
                &closed_senders,
                &WsMessage {
                    msg_type: "room_closed".to_string(),
                    room: Some(closed_room_id),
                    client: None,
                    payload: Some(serde_json::json!({ "reason": "Host started a new room" })),
                    ts: now_ms(),
                    server_ts: Some(now_ms()),
                },
                "room closed",
            );
        }
        send_message(sender, &room_msg, Some(client_id));
    }

    broadcast_room_list(state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn build_room_valid() {
        let room = build_room(
            "host-1",
            "Alice",
            Some(&serde_json::json!({
                "media_id": "550e8400e29b41d4a716446655440000",
                "start_pos": 42.5
            })),
        );
        assert_eq!(room.host_id, "host-1");
        assert_eq!(room.name, "Room de Alice");
        assert_eq!(
            room.media_id,
            Some("550e8400e29b41d4a716446655440000".to_string())
        );
        assert!((room.state.position - 42.5).abs() < f64::EPSILON);
        assert_eq!(room.state.play_state, "paused");
        assert!(room.clients.contains(&"host-1".to_string()));
    }

    #[test]
    fn build_room_no_media_id() {
        let room = build_room("host-1", "Bob", Some(&serde_json::json!({})));
        assert_eq!(room.media_id, None);
    }

    #[test]
    fn build_room_invalid_media_id() {
        let room = build_room(
            "host-1",
            "Bob",
            Some(&serde_json::json!({ "media_id": "not-valid-hex" })),
        );
        assert_eq!(room.media_id, None);
    }

    #[test]
    fn build_room_clamps_position() {
        let room = build_room(
            "host-1",
            "Bob",
            Some(&serde_json::json!({ "start_pos": -10.0 })),
        );
        assert!((room.state.position - 0.0).abs() < f64::EPSILON);

        let room2 = build_room(
            "host-1",
            "Bob",
            Some(&serde_json::json!({ "start_pos": 100000.0 })),
        );
        assert!((room2.state.position - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn resolve_host_name_from_payload() {
        let mut clients = std::collections::HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u1", "Default", true);
        clients.insert("c1".to_string(), client);
        let (name, payload_name) = resolve_host_name(
            Some(&serde_json::json!({ "user_name": "Custom" })),
            &clients,
            "c1",
        );
        assert_eq!(name, "Custom");
        assert_eq!(payload_name, Some("Custom".to_string()));
    }

    #[test]
    fn resolve_host_name_from_client() {
        let mut clients = std::collections::HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u1", "FromClient", true);
        clients.insert("c1".to_string(), client);
        let (name, payload_name) = resolve_host_name(Some(&serde_json::json!({})), &clients, "c1");
        assert_eq!(name, "FromClient");
        assert_eq!(payload_name, None);
    }

    #[tokio::test]
    async fn guest_creating_room_leaves_previous_room() {
        let state = test_helpers::create_state();
        let (mut host, mut host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("old-room".to_string());
        guest.room_id = Some("old-room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("old-room", "host");
            room.clients.push("guest".to_string());
            locked.rooms.insert("old-room".to_string(), room);
        }
        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::CreateRoom,
            room: None,
            client: Some("guest".to_string()),
            payload: Some(serde_json::json!({ "user_name": "Guest" })),
            ts: crate::utils::now_ms(),
            server_ts: None,
        };

        handle_create_room("guest", &parsed, &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms["old-room"]
            .clients
            .contains(&"guest".to_string()));
        let new_room_id = locked.clients["guest"].room_id.as_ref().unwrap();
        let new_room = &locked.rooms[new_room_id];
        assert_eq!(new_room.host_id, "guest");
        assert_eq!(new_room.clients, vec!["guest".to_string()]);
        drop(locked);

        assert_eq!(
            test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
            "client_left"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "room_state"
        );
    }
}
