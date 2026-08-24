use super::super::constants::MAX_CLIENTS_PER_ROOM;
use super::super::dispatch::{is_authenticated, send_error};
use super::super::validation::sanitize_name;
use crate::messaging::{collect_room_senders, send_message, send_to_senders, ClientSender};
use crate::room::handle_leave;
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
            let previous_room = state
                .clients
                .get(client_id)
                .and_then(|client| client.room_id.as_deref());
            if previous_room.is_some_and(|previous| previous != room_id) {
                let crate::types::ServerState { clients, rooms } = &mut *state;
                if let Some((senders, msg)) = handle_leave(client_id, clients, rooms) {
                    send_to_senders(&senders, &msg, "previous room leave");
                }
            }
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
    use crate::types::{ClientMessageType, IncomingMessage};

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

    #[tokio::test]
    async fn joining_another_room_detaches_the_previous_membership() {
        let state = test_helpers::create_state();
        let (mut host_a, mut host_a_rx) =
            test_helpers::create_client_with_rx("host-a", "Host A", true);
        let (mut host_b, mut host_b_rx) =
            test_helpers::create_client_with_rx("host-b", "Host B", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host_a.room_id = Some("room-a".to_string());
        host_b.room_id = Some("room-b".to_string());
        guest.room_id = Some("room-a".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host-a".to_string(), host_a);
            locked.clients.insert("host-b".to_string(), host_b);
            locked.clients.insert("guest".to_string(), guest);
            let mut room_a = test_helpers::create_room("room-a", "host-a");
            room_a.clients.push("guest".to_string());
            locked.rooms.insert("room-a".to_string(), room_a);
            locked.rooms.insert(
                "room-b".to_string(),
                test_helpers::create_room("room-b", "host-b"),
            );
        }

        handle_join_room("guest", &join_message("room-b"), &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms["room-a"]
            .clients
            .contains(&"guest".to_string()));
        assert_eq!(
            locked.rooms["room-b"]
                .clients
                .iter()
                .filter(|id| id.as_str() == "guest")
                .count(),
            1
        );
        assert_eq!(locked.clients["guest"].room_id.as_deref(), Some("room-b"));
        drop(locked);

        assert_eq!(
            test_helpers::recv_msg(&mut host_a_rx).unwrap().msg_type,
            "client_left"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "room_state"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut host_b_rx).unwrap().msg_type,
            "participants_update"
        );
    }

    #[tokio::test]
    async fn joining_the_same_room_is_idempotent() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            locked.rooms.insert("room".to_string(), room);
        }

        handle_join_room("guest", &join_message("room"), &state).await;

        let locked = state.read().await;
        assert_eq!(
            locked.rooms["room"]
                .clients
                .iter()
                .filter(|id| id.as_str() == "guest")
                .count(),
            1
        );
        assert_eq!(locked.clients["guest"].room_id.as_deref(), Some("room"));
        assert!(!locked.rooms["room"].ready_clients.contains("guest"));
    }

    #[tokio::test]
    async fn missing_destination_preserves_previous_membership() {
        let state = state_with_guest_in_previous_room().await;

        handle_join_room("guest", &join_message("missing"), &state).await;

        assert_previous_membership(&state).await;
    }

    #[tokio::test]
    async fn full_destination_preserves_previous_membership() {
        let state = state_with_guest_in_previous_room().await;
        {
            let mut locked = state.write().await;
            let mut full_room = test_helpers::create_room("full", "full-host");
            full_room.clients = (0..MAX_CLIENTS_PER_ROOM)
                .map(|index| format!("member-{index}"))
                .collect();
            locked.rooms.insert("full".to_string(), full_room);
        }

        handle_join_room("guest", &join_message("full"), &state).await;

        assert_previous_membership(&state).await;
    }

    async fn state_with_guest_in_previous_room() -> SharedState {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("previous".to_string());
        guest.room_id = Some("previous".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("previous", "host");
            room.clients.push("guest".to_string());
            locked.rooms.insert("previous".to_string(), room);
        }
        state
    }

    async fn assert_previous_membership(state: &SharedState) {
        let locked = state.read().await;
        assert_eq!(locked.clients["guest"].room_id.as_deref(), Some("previous"));
        assert!(locked.rooms["previous"]
            .clients
            .contains(&"guest".to_string()));
    }

    fn join_message(room_id: &str) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::JoinRoom,
            room: Some(room_id.to_string()),
            client: Some("guest".to_string()),
            payload: None,
            ts: crate::utils::now_ms(),
            server_ts: None,
        }
    }
}
