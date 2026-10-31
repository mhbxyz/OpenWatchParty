use super::super::dispatch::{error_message, ErrorCode};
use crate::auth::JwtConfig;
use crate::messaging::{broadcast_room_list, send_message};
use crate::room::access::{cancel, message, send_access, send_requests};
use crate::types::{
    ClientMessageType, IncomingMessage, JoinRequest, RoomAccess, ServerMessageType, ServerState,
    SharedState,
};
use std::sync::Arc;

pub(super) fn request_join(
    client_id: &str,
    room_id: &str,
    name: &Option<String>,
    state: &mut ServerState,
) {
    let Some(client) = state.clients.get(client_id) else {
        return;
    };
    if !client.supports_room_access {
        send_message(
            Some(client.sender.clone()),
            &error_message(
                client_id,
                Some(room_id.to_string()),
                ErrorCode::RoomApprovalRequired,
                "This room asks the host's approval to join. Update OpenWatchParty to ask to join.",
            ),
            None,
        );
        return;
    }
    let name = name.clone().unwrap_or_else(|| client.user_name.clone());
    let sender = client.sender.clone();
    let exists = state.rooms[room_id]
        .join_requests
        .iter()
        .any(|r| r.client_id == client_id);
    if !exists {
        cancel(client_id, &mut state.rooms, &state.clients);
        let room = state.rooms.get_mut(room_id).expect("join target exists");
        if room.join_requests.len() >= 20 {
            send_message(
                Some(sender),
                &error_message(
                    client_id,
                    Some(room_id.to_string()),
                    ErrorCode::RoomFull,
                    "Too many people are waiting to join",
                ),
                None,
            );
            return;
        }
        room.join_requests.push(JoinRequest {
            id: uuid::Uuid::new_v4().to_string(),
            client_id: client_id.to_string(),
            name,
        });
    }
    let room = &state.rooms[room_id];
    let host_name = state
        .clients
        .get(&room.host_id)
        .map(|c| c.user_name.as_str())
        .unwrap_or_default();
    send_message(
        Some(sender),
        &message(
            room,
            ServerMessageType::JoinPending,
            serde_json::json!({ "host_name": host_name }),
        ),
        None,
    );
    send_requests(room, &state.clients);
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    id: String,
    admit: bool,
}

pub(crate) async fn handle_access(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
    jwt_config: &Arc<JwtConfig>,
) {
    let (room_id, admissions) = {
        let mut locked = state.write().await;
        let Some(client) = locked.clients.get(client_id) else {
            return;
        };
        if !client.supports_room_access {
            return;
        }
        let sender = client.sender.clone();
        if parsed.msg_type == ClientMessageType::CancelJoin {
            let ServerState { clients, rooms } = &mut *locked;
            cancel(client_id, rooms, clients);
            return;
        }
        let room_id = client.room_id.clone();
        let error = match room_id.as_ref().and_then(|id| locked.rooms.get(id)) {
            None => Some((ErrorCode::NotInRoom, "Not in a room")),
            Some(room) if room.host_id != client_id => Some((
                ErrorCode::HostPermissionRequired,
                "Only the room host can do that",
            )),
            _ => None,
        };
        if let Some((code, text)) = error {
            send_message(
                Some(sender),
                &error_message(client_id, room_id, code, text),
                None,
            );
            return;
        }
        let room_id = room_id.expect("membership checked");
        let payload = parsed.payload.clone().unwrap_or(serde_json::Value::Null);
        let ServerState { rooms, clients } = &mut *locked;
        let room = rooms.get_mut(&room_id).expect("membership checked");
        let mut admissions = Vec::new();
        if parsed.msg_type == ClientMessageType::SetRoomAccess {
            let Ok(access) = serde_json::from_value::<RoomAccess>(payload) else {
                send_message(
                    Some(sender),
                    &error_message(
                        client_id,
                        Some(room_id),
                        ErrorCode::InvalidAccessPayload,
                        "Invalid room access",
                    ),
                    None,
                );
                return;
            };
            let release = room.access.approval && !access.approval;
            room.access = access;
            if release {
                admissions = std::mem::take(&mut room.join_requests);
            }
            send_access(room, clients);
        } else {
            let Ok(answer) = serde_json::from_value::<Answer>(payload) else {
                return;
            };
            let Some(index) = room.join_requests.iter().position(|r| r.id == answer.id) else {
                return;
            };
            let request = room.join_requests.remove(index);
            if answer.admit {
                admissions.push(request);
            } else {
                let host_name = clients
                    .get(client_id)
                    .map(|c| c.user_name.as_str())
                    .unwrap_or_default();
                let msg = message(
                    room,
                    ServerMessageType::JoinRejected,
                    serde_json::json!({ "reason": "rejected", "host_name": host_name }),
                );
                send_message(
                    clients.get(&request.client_id).map(|c| c.sender.clone()),
                    &msg,
                    None,
                );
            }
            send_requests(room, clients);
        }
        (room_id, admissions)
    };
    for request in admissions {
        let join = IncomingMessage {
            msg_type: ClientMessageType::JoinRoom,
            room: Some(room_id.clone()),
            client: Some(request.client_id.clone()),
            payload: Some(serde_json::json!({ "user_name": request.name })),
            ts: crate::utils::now_ms(),
            server_ts: None,
        };
        super::join::join_room(&request.client_id, &join, state, jwt_config, true).await;
    }
    broadcast_room_list(state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::WsMessage;
    use tokio::sync::mpsc::Receiver;

    type Messages = Receiver<crate::messaging::OutboundMessage>;

    fn config() -> Arc<JwtConfig> {
        Arc::new(JwtConfig {
            secret: "test-room-access-secret".to_string(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: true,
        })
    }

    fn incoming(
        kind: ClientMessageType,
        room: Option<&str>,
        payload: serde_json::Value,
    ) -> IncomingMessage {
        IncomingMessage {
            msg_type: kind,
            room: room.map(str::to_string),
            client: None,
            payload: Some(payload),
            ts: 0,
            server_ts: None,
        }
    }

    fn drain(rx: &mut Messages) -> Vec<WsMessage> {
        std::iter::from_fn(|| test_helpers::recv_msg(rx)).collect()
    }

    fn has(messages: &[WsMessage], kind: ServerMessageType) -> bool {
        messages.iter().any(|m| m.msg_type == kind)
    }

    async fn setup() -> (SharedState, Messages, Messages) {
        let state = test_helpers::create_state();
        let (mut host, host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.supports_room_access = true;
        host.room_id = Some("room".to_string());
        guest.supports_room_access = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.access.approval = true;
            locked.rooms.insert("room".to_string(), room);
        }
        (state, host_rx, guest_rx)
    }

    async fn join(state: &SharedState, id: &str, room: &str) {
        super::super::join::handle_join_room(
            id,
            &incoming(
                ClientMessageType::JoinRoom,
                Some(room),
                serde_json::json!({}),
            ),
            state,
            &config(),
        )
        .await;
    }

    async fn access(
        state: &SharedState,
        id: &str,
        kind: ClientMessageType,
        payload: serde_json::Value,
    ) {
        handle_access(id, &incoming(kind, None, payload), state, &config()).await;
    }

    #[tokio::test]
    async fn admitted_user_reconnects_without_another_request() {
        let (state, _host_rx, mut guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        let id = state.read().await.rooms["room"].join_requests[0].id.clone();
        access(
            &state,
            "host",
            ClientMessageType::AnswerJoin,
            serde_json::json!({"id": id, "admit": true}),
        )
        .await;
        assert!(state.read().await.rooms["room"]
            .admitted_users
            .contains("guest"));
        drain(&mut guest_rx);
        let tasks = crate::tasks::AppTasks::new();
        crate::room::handle_disconnect("guest", &state, &tasks).await;
        let (mut replacement, mut replacement_rx) =
            test_helpers::create_client_with_rx("guest", "Guest", true);
        replacement.supports_room_access = true;
        state
            .write()
            .await
            .clients
            .insert("replacement".to_string(), replacement);
        join(&state, "replacement", "room").await;
        let messages = drain(&mut replacement_rx);
        assert!(has(&messages, ServerMessageType::RoomState));
        assert!(!has(&messages, ServerMessageType::JoinPending));
        assert!(state.read().await.rooms["room"].join_requests.is_empty());

        let (mut newcomer, mut newcomer_rx) =
            test_helpers::create_client_with_rx("new-user", "New guest", true);
        newcomer.supports_room_access = true;
        state
            .write()
            .await
            .clients
            .insert("newcomer".to_string(), newcomer);
        join(&state, "newcomer", "room").await;
        let messages = drain(&mut newcomer_rx);
        assert!(has(&messages, ServerMessageType::JoinPending));
        assert!(!has(&messages, ServerMessageType::RoomState));
        assert!(!state.read().await.rooms["room"]
            .admitted_users
            .contains("new-user"));
    }

    #[tokio::test]
    async fn requests_are_idempotent_and_move_between_rooms() {
        let (state, mut host_rx, mut guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        let pending = drain(&mut guest_rx);
        assert!(has(&pending, ServerMessageType::JoinPending));
        assert!(!has(&pending, ServerMessageType::RoomState));
        assert!(has(&drain(&mut host_rx), ServerMessageType::JoinRequests));
        let first = state.read().await.rooms["room"].join_requests[0].id.clone();
        join(&state, "guest", "room").await;
        assert_eq!(state.read().await.rooms["room"].join_requests.len(), 1);
        assert_eq!(state.read().await.rooms["room"].join_requests[0].id, first);
        {
            let mut locked = state.write().await;
            let mut other = test_helpers::create_room("other", "host");
            other.access.approval = true;
            locked.rooms.insert("other".to_string(), other);
        }
        join(&state, "guest", "other").await;
        assert!(state.read().await.rooms["room"].join_requests.is_empty());
        assert_eq!(state.read().await.rooms["other"].join_requests.len(), 1);
        access(
            &state,
            "guest",
            ClientMessageType::CancelJoin,
            serde_json::json!({}),
        )
        .await;
        assert!(state.read().await.rooms["other"].join_requests.is_empty());
    }

    #[tokio::test]
    async fn legacy_and_overflow_requests_are_refused() {
        let (state, _host_rx, mut guest_rx) = setup().await;
        state
            .write()
            .await
            .clients
            .get_mut("guest")
            .unwrap()
            .supports_room_access = false;
        join(&state, "guest", "room").await;
        assert_eq!(
            drain(&mut guest_rx)[0].payload.as_ref().unwrap()["code"],
            "ROOM_APPROVAL_REQUIRED"
        );
        {
            let mut locked = state.write().await;
            locked
                .clients
                .get_mut("guest")
                .unwrap()
                .supports_room_access = true;
            locked.rooms.get_mut("room").unwrap().join_requests = (0..20)
                .map(|i| JoinRequest {
                    id: i.to_string(),
                    client_id: i.to_string(),
                    name: i.to_string(),
                })
                .collect();
        }
        join(&state, "guest", "room").await;
        assert_eq!(
            drain(&mut guest_rx)[0].payload.as_ref().unwrap()["code"],
            "ROOM_FULL"
        );
    }

    #[tokio::test]
    async fn answers_reject_or_admit_through_normal_join() {
        let (state, mut host_rx, mut guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        drain(&mut guest_rx);
        drain(&mut host_rx);
        let id = state.read().await.rooms["room"].join_requests[0].id.clone();
        access(
            &state,
            "host",
            ClientMessageType::AnswerJoin,
            serde_json::json!({"id": "missing", "admit": true}),
        )
        .await;
        assert!(drain(&mut host_rx).is_empty());
        access(
            &state,
            "host",
            ClientMessageType::AnswerJoin,
            serde_json::json!({"id": id, "admit": false}),
        )
        .await;
        let rejected = drain(&mut guest_rx);
        assert_eq!(
            rejected[0].payload.as_ref().unwrap(),
            &serde_json::json!({"reason": "rejected", "host_name": "Host"})
        );
        join(&state, "guest", "room").await;
        let id = state.read().await.rooms["room"].join_requests[0].id.clone();
        access(
            &state,
            "host",
            ClientMessageType::AnswerJoin,
            serde_json::json!({"id": id, "admit": true}),
        )
        .await;
        let messages = drain(&mut guest_rx);
        assert!(has(&messages, ServerMessageType::RoomState));
        assert!(has(&messages, ServerMessageType::ParticipantList));
        assert!(has(&messages, ServerMessageType::RoomAccess));
        assert_eq!(
            state.read().await.clients["guest"].room_id.as_deref(),
            Some("room")
        );
    }

    #[tokio::test]
    async fn access_requires_host_and_strict_payload_and_broadcasts_lists() {
        let (state, mut host_rx, mut guest_rx) = setup().await;
        access(
            &state,
            "guest",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            drain(&mut guest_rx)[0].payload.as_ref().unwrap()["code"],
            "NOT_IN_ROOM"
        );
        state
            .write()
            .await
            .clients
            .get_mut("guest")
            .unwrap()
            .room_id = Some("room".to_string());
        access(
            &state,
            "guest",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(
            drain(&mut guest_rx)[0].payload.as_ref().unwrap()["code"],
            "HOST_PERMISSION_REQUIRED"
        );
        access(
            &state,
            "host",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({"approval": false}),
        )
        .await;
        assert_eq!(
            drain(&mut host_rx)[0].payload.as_ref().unwrap()["code"],
            "INVALID_ACCESS_PAYLOAD"
        );
        access(
            &state,
            "host",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({"approval": false, "unlisted": true}),
        )
        .await;
        assert!(has(&drain(&mut host_rx), ServerMessageType::RoomAccess));
        let lists = drain(&mut guest_rx);
        assert!(has(&lists, ServerMessageType::RoomList));
        assert!(!has(&lists, ServerMessageType::RoomAccess));
        assert!(lists
            .iter()
            .find(|m| m.msg_type == ServerMessageType::RoomList)
            .unwrap()
            .payload
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn disabling_approval_admits_waiters_in_order() {
        let (state, _host_rx, _guest_rx) = setup().await;
        let (mut second, _second_rx) =
            test_helpers::create_client_with_rx("second", "Second", true);
        second.supports_room_access = true;
        state
            .write()
            .await
            .clients
            .insert("second".to_string(), second);
        join(&state, "guest", "room").await;
        join(&state, "second", "room").await;
        access(
            &state,
            "host",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({"approval": false, "unlisted": false}),
        )
        .await;
        assert_eq!(
            state.read().await.rooms["room"].clients,
            vec!["host", "guest", "second"]
        );
    }

    #[tokio::test]
    async fn disabling_approval_reports_capacity_overflow() {
        let (state, _host_rx, mut guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        drain(&mut guest_rx);
        {
            let mut locked = state.write().await;
            let room = locked.rooms.get_mut("room").unwrap();
            room.clients = (0..super::super::super::constants::MAX_CLIENTS_PER_ROOM)
                .map(|i| format!("member-{i}"))
                .collect();
        }
        access(
            &state,
            "host",
            ClientMessageType::SetRoomAccess,
            serde_json::json!({"approval": false, "unlisted": false}),
        )
        .await;
        let messages = drain(&mut guest_rx);
        assert!(messages
            .iter()
            .any(|m| m.msg_type == ServerMessageType::Error
                && m.payload.as_ref().unwrap()["code"] == "ROOM_FULL"));
        assert!(state.read().await.rooms["room"].join_requests.is_empty());
    }

    #[tokio::test]
    async fn invite_and_member_bypass_approval() {
        let (state, _host_rx, mut guest_rx) = setup().await;
        let config = config();
        let (ticket, _) = config.mint_invite_ticket("room", None).unwrap();
        let request = incoming(
            ClientMessageType::JoinRoom,
            Some("room"),
            serde_json::json!({"invite_ticket": ticket}),
        );
        super::super::join::handle_join_room("guest", &request, &state, &config).await;
        assert!(has(&drain(&mut guest_rx), ServerMessageType::RoomState));
        join(&state, "guest", "room").await;
        assert!(has(&drain(&mut guest_rx), ServerMessageType::RoomState));
        assert!(state.read().await.rooms["room"].join_requests.is_empty());
    }

    #[tokio::test]
    async fn disconnect_and_close_clear_waiting_requests() {
        let (state, _host_rx, mut guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        drain(&mut guest_rx);
        crate::room::close_room("room", &state).await;
        let messages = drain(&mut guest_rx);
        assert_eq!(messages[0].payload.as_ref().unwrap()["reason"], "closed");
        let (state, mut host_rx, _guest_rx) = setup().await;
        join(&state, "guest", "room").await;
        drain(&mut host_rx);
        let tasks = crate::tasks::AppTasks::new();
        crate::room::handle_disconnect("guest", &state, &tasks).await;
        assert!(state.read().await.rooms["room"].join_requests.is_empty());
        assert!(has(&drain(&mut host_rx), ServerMessageType::JoinRequests));
    }
}

#[cfg(test)]
mod membership_tests {
    use super::*;
    use crate::test_helpers;

    #[tokio::test]
    async fn admitted_guest_leaves_previous_room_and_non_host_cannot_answer() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        let (mut previous_host, _previous_rx) =
            test_helpers::create_client_with_rx("previous-host", "Previous", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("previous".to_string());
        previous_host.room_id = Some("previous".to_string());
        host.supports_room_access = true;
        guest.supports_room_access = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            locked
                .clients
                .insert("previous-host".to_string(), previous_host);
            let mut previous = test_helpers::create_room("previous", "previous-host");
            previous.clients.push("guest".to_string());
            locked.rooms.insert("previous".to_string(), previous);
            let mut room = test_helpers::create_room("room", "host");
            room.access.approval = true;
            locked.rooms.insert("room".to_string(), room);
        }
        let config = Arc::new(JwtConfig {
            secret: String::new(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: false,
        });
        let join = IncomingMessage {
            msg_type: ClientMessageType::JoinRoom,
            room: Some("room".to_string()),
            client: None,
            payload: Some(serde_json::json!({})),
            ts: 0,
            server_ts: None,
        };
        super::super::join::handle_join_room("guest", &join, &state, &config).await;
        assert_eq!(
            state.read().await.clients["guest"].room_id.as_deref(),
            Some("previous")
        );
        let id = state.read().await.rooms["room"].join_requests[0].id.clone();
        let answer = IncomingMessage {
            msg_type: ClientMessageType::AnswerJoin,
            room: None,
            client: None,
            payload: Some(serde_json::json!({"id": id, "admit": true})),
            ts: 0,
            server_ts: None,
        };
        handle_access("guest", &answer, &state, &config).await;
        assert_eq!(state.read().await.rooms["room"].join_requests.len(), 1);
        handle_access("host", &answer, &state, &config).await;
        assert!(!state.read().await.rooms["previous"]
            .clients
            .contains(&"guest".to_string()));
        assert_eq!(
            state.read().await.clients["guest"].room_id.as_deref(),
            Some("room")
        );
        let messages: Vec<_> =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut guest_rx)).collect();
        assert!(messages
            .iter()
            .any(|m| m.msg_type == ServerMessageType::RoomState));
    }
}
