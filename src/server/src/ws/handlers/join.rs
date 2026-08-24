use super::super::constants::MAX_CLIENTS_PER_ROOM;
use super::super::dispatch::{is_authenticated, send_error};
use super::super::validation::sanitize_name;
use crate::messaging::{collect_room_senders, send_message, send_to_senders, ClientSender};
use crate::types::{Client, IncomingMessage, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;

type JoinNotifications = (
    Option<ClientSender>,
    WsMessage,
    Option<(Vec<ClientSender>, WsMessage)>,
);

fn add_client_to_room(
    client_id: &str,
    room: &mut Room,
    locked_clients: &mut HashMap<String, Client>,
    payload_name: &Option<String>,
) {
    if !room.clients.contains(&client_id.to_string()) {
        room.clients.push(client_id.to_string());
    }
    room.ready_clients.remove(client_id);
    if let Some(client) = locked_clients.get_mut(client_id) {
        client.room_id = Some(room.room_id.clone());
        if let Some(ref name) = payload_name {
            client.user_name = name.clone();
        }
    }
}

fn prepare_join_notifications(
    client_id: &str,
    room: &Room,
    locked_clients: &HashMap<String, Client>,
) -> JoinNotifications {
    (
        locked_clients.get(client_id).map(|c| c.sender.clone()),
        WsMessage {
            msg_type: "room_state".to_string(),
            room: Some(room.room_id.clone()),
            client: Some(client_id.to_string()),
            payload: Some(serde_json::json!({
                "name": room.name,
                "host_id": room.host_id,
                "state": room.state,
                "participant_count": room.clients.len(),
                "media_id": room.media_id
            })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        },
        Some((
            collect_room_senders(room, locked_clients, Some(client_id)),
            WsMessage {
                msg_type: "participants_update".to_string(),
                room: Some(room.room_id.clone()),
                client: None,
                payload: Some(serde_json::json!({ "participant_count": room.clients.len() })),
                ts: now_ms(),
                server_ts: Some(now_ms()),
            },
        )),
    )
}

pub(in crate::ws) async fn handle_join_room(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if !is_authenticated(client_id, state).await {
        send_error(client_id, state, "Authentication required").await;
        return;
    }
    let Some(ref room_id) = parsed.room else {
        return;
    };

    let payload_name = parsed
        .payload
        .as_ref()
        .and_then(|p| p.get("user_name"))
        .and_then(|v| v.as_str())
        .and_then(sanitize_name);

    {
        let mut state = state.write().await;
        let full = state
            .rooms
            .get(room_id)
            .map(|room| {
                !room.clients.contains(&client_id.to_string())
                    && room.clients.len() >= MAX_CLIENTS_PER_ROOM
            })
            .unwrap_or(false);
        if full {
            let sender = state.clients.get(client_id).map(|c| c.sender.clone());
            let notifications = (
                sender,
                WsMessage {
                    msg_type: "error".to_string(),
                    room: Some(room_id.clone()),
                    client: Some(client_id.to_string()),
                    payload: Some(serde_json::json!({ "message": "Room is full" })),
                    ts: now_ms(),
                    server_ts: Some(now_ms()),
                },
                None,
            );
            enqueue_join_notifications(client_id, notifications);
        } else if state.rooms.contains_key(room_id) {
            info!("Client {} joining room {}", client_id, room_id);
            let crate::types::ServerState { clients, rooms } = &mut *state;
            let room = rooms.get_mut(room_id).expect("room existence checked");
            add_client_to_room(client_id, room, clients, &payload_name);
            let notifications = prepare_join_notifications(client_id, room, clients);
            enqueue_join_notifications(client_id, notifications);
        }
    }
}

fn enqueue_join_notifications(client_id: &str, notifications: JoinNotifications) {
    let (sender, direct_msg, broadcast) = notifications;
    send_message(sender, &direct_msg, Some(client_id));
    if let Some((senders, broadcast_msg)) = broadcast {
        send_to_senders(&senders, &broadcast_msg, "participants update");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn add_client_to_room_updates_state() {
        let mut clients = HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u2", "Guest", true);
        clients.insert("guest-1".to_string(), client);
        let mut room = test_helpers::create_room("room-1", "host-1");

        add_client_to_room("guest-1", &mut room, &mut clients, &None);

        assert!(room.clients.contains(&"guest-1".to_string()));
        assert_eq!(
            clients.get("guest-1").unwrap().room_id,
            Some("room-1".to_string())
        );
    }

    #[test]
    fn add_client_to_room_clears_ready() {
        let mut clients = HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u2", "Guest", true);
        clients.insert("guest-1".to_string(), client);
        let mut room = test_helpers::create_room("room-1", "host-1");
        room.ready_clients.insert("guest-1".to_string());

        add_client_to_room("guest-1", &mut room, &mut clients, &None);

        assert!(!room.ready_clients.contains("guest-1"));
    }

    #[test]
    fn add_client_to_room_with_payload_name() {
        let mut clients = HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u2", "OldName", true);
        clients.insert("guest-1".to_string(), client);
        let mut room = test_helpers::create_room("room-1", "host-1");

        let payload_name = Some("NewName".to_string());
        add_client_to_room("guest-1", &mut room, &mut clients, &payload_name);

        assert_eq!(clients.get("guest-1").unwrap().user_name, "NewName");
    }
}
