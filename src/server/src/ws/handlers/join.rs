use super::super::constants::MAX_CLIENTS_PER_ROOM;
use super::super::dispatch::{error_message, is_authenticated, send_error, ErrorCode};
use super::super::validation::sanitize_name;
use crate::messaging::{collect_room_senders, send_message, send_to_senders, ClientSender};
use crate::room::handle_leave;
use crate::types::{Client, IncomingMessage, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;
use tokio::time::Instant;

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
    prepare_join_notifications_at(client_id, room, locked_clients, Instant::now(), now_ms())
}

fn prepare_join_notifications_at(
    client_id: &str,
    room: &Room,
    locked_clients: &HashMap<String, Client>,
    now: Instant,
    wall_now_ms: u64,
) -> JoinNotifications {
    let target_server_ts = match (room.target_at, room.target_server_ts) {
        (Some(deadline), Some(target)) if now < deadline && wall_now_ms < target => Some(target),
        _ => None,
    };
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
                "state_server_ts": room.state_server_ts,
                "target_server_ts": target_server_ts,
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
        send_error(
            client_id,
            state,
            ErrorCode::AuthenticationRequired,
            "Authentication required",
        )
        .await;
        return;
    }
    let Some(ref room_id) = parsed.room else {
        send_error(
            client_id,
            state,
            ErrorCode::RoomIdRequired,
            "Room ID is required",
        )
        .await;
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
        let (notifications, previous_leave) = if !state.rooms.contains_key(room_id) {
            let sender = state.clients.get(client_id).map(|c| c.sender.clone());
            let error = error_message(
                client_id,
                Some(room_id.clone()),
                ErrorCode::RoomNotFound,
                "Room not found",
            );
            ((sender, error, None), None)
        } else {
            let room = state.rooms.get(room_id).expect("room existence checked");
            let full = !room.clients.iter().any(|id| id == client_id)
                && room.clients.len() >= MAX_CLIENTS_PER_ROOM;
            if full {
                let sender = state.clients.get(client_id).map(|c| c.sender.clone());
                (
                    (
                        sender,
                        error_message(
                            client_id,
                            Some(room_id.clone()),
                            ErrorCode::RoomFull,
                            "Room is full",
                        ),
                        None,
                    ),
                    None,
                )
            } else {
                info!("Client {} joining room {}", client_id, room_id);
                let previous_room = state
                    .clients
                    .get(client_id)
                    .and_then(|client| client.room_id.as_deref());
                let previous_leave = if previous_room.is_some_and(|previous| previous != room_id) {
                    let crate::types::ServerState { clients, rooms } = &mut *state;
                    handle_leave(client_id, clients, rooms)
                } else {
                    None
                };
                let crate::types::ServerState { clients, rooms } = &mut *state;
                let room = rooms.get_mut(room_id).expect("room existence checked");
                add_client_to_room(client_id, room, clients, &payload_name);
                let notifications = prepare_join_notifications(client_id, room, clients);
                (notifications, previous_leave)
            }
        };
        if let Some((senders, msg)) = previous_leave {
            send_to_senders(&senders, &msg, "previous room leave");
        }
        enqueue_join_notifications(client_id, notifications);
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

    fn assert_error_code(message: WsMessage, code: &str) {
        assert_eq!(message.msg_type, "error");
        assert_eq!(message.payload.unwrap()["code"], code);
    }

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

    #[test]
    fn room_state_preserves_future_command_timing() {
        let mut clients = HashMap::new();
        let (host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        clients.insert("host".to_string(), host);
        clients.insert("guest".to_string(), guest);
        let now = now_ms();
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("guest".to_string());
        room.state_server_ts = now;
        room.target_server_ts = Some(now + 1000);
        room.target_at = Some(Instant::now() + std::time::Duration::from_secs(1));

        let (_, message, _) = prepare_join_notifications("guest", &room, &clients);
        let payload = message.payload.unwrap();

        assert_eq!(payload["state_server_ts"], serde_json::json!(now));
        assert_eq!(payload["target_server_ts"], serde_json::json!(now + 1000));
    }

    #[test]
    fn expired_target_is_not_revived_by_wall_clock_rollback() {
        let mut clients = HashMap::new();
        let (guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        clients.insert("guest".to_string(), guest);
        let start = Instant::now();
        let mut room = test_helpers::create_room("room", "host");
        room.state_server_ts = 10_000;
        room.target_server_ts = Some(11_000);
        room.target_at = Some(start + std::time::Duration::from_secs(1));

        let (_, message, _) = prepare_join_notifications_at(
            "guest",
            &room,
            &clients,
            start + std::time::Duration::from_secs(2),
            0,
        );
        let payload = message.payload.unwrap();

        assert_eq!(payload["state_server_ts"], serde_json::json!(10_000));
        assert!(payload["target_server_ts"].is_null());
    }

    #[test]
    fn wall_clock_jump_expires_target_even_if_monotonic_deadline_is_future() {
        let mut clients = HashMap::new();
        let (guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        clients.insert("guest".to_string(), guest);
        let start = Instant::now();
        let mut room = test_helpers::create_room("room", "host");
        room.target_server_ts = Some(11_000);
        room.target_at = Some(start + std::time::Duration::from_secs(1));

        let (_, message, _) = prepare_join_notifications_at(
            "guest",
            &room,
            &clients,
            start + std::time::Duration::from_millis(500),
            12_000,
        );

        assert!(message.payload.unwrap()["target_server_ts"].is_null());
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
    async fn missing_room_id_returns_explicit_error() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        state
            .write()
            .await
            .clients
            .insert("guest".to_string(), client);
        let mut message = join_message("unused");
        message.room = None;

        handle_join_room("guest", &message, &state).await;

        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "ROOM_ID_REQUIRED");
    }

    #[tokio::test]
    async fn missing_room_returns_explicit_error() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        state
            .write()
            .await
            .clients
            .insert("guest".to_string(), client);

        handle_join_room("guest", &join_message("missing"), &state).await;

        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "ROOM_NOT_FOUND");
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

    #[tokio::test]
    async fn full_room_returns_explicit_error() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        let mut room = test_helpers::create_room("full", "host");
        room.clients = (0..MAX_CLIENTS_PER_ROOM)
            .map(|index| format!("member-{index}"))
            .collect();
        {
            let mut locked = state.write().await;
            locked.clients.insert("guest".to_string(), client);
            locked.rooms.insert("full".to_string(), room);
        }

        handle_join_room("guest", &join_message("full"), &state).await;

        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "ROOM_FULL");
    }

    #[tokio::test]
    async fn host_joining_another_room_clears_previous_guests() {
        let state = test_helpers::create_state();
        let (mut host_a, _host_a_rx) =
            test_helpers::create_client_with_rx("host-a", "Host A", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        let (mut host_b, _host_b_rx) =
            test_helpers::create_client_with_rx("host-b", "Host B", true);
        host_a.room_id = Some("room-a".to_string());
        guest.room_id = Some("room-a".to_string());
        host_b.room_id = Some("room-b".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host-a".to_string(), host_a);
            locked.clients.insert("guest".to_string(), guest);
            locked.clients.insert("host-b".to_string(), host_b);
            let mut room_a = test_helpers::create_room("room-a", "host-a");
            room_a.clients.push("guest".to_string());
            locked.rooms.insert("room-a".to_string(), room_a);
            locked.rooms.insert(
                "room-b".to_string(),
                test_helpers::create_room("room-b", "host-b"),
            );
        }

        handle_join_room("host-a", &join_message("room-b"), &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms.contains_key("room-a"));
        assert!(locked.clients["guest"].room_id.is_none());
        assert_eq!(locked.clients["host-a"].room_id.as_deref(), Some("room-b"));
        drop(locked);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "room_closed"
        );
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
