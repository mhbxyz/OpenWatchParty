use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use crate::messaging::{broadcast_room_list, send_message, ClientSender};
use crate::room::{handle_leave, send_leave_notification};
use crate::types::{IncomingMessage, ServerMessageType, ServerState, SharedState, WsMessage};
use crate::utils::now_ms;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveParticipantPayload {
    id: String,
    block: bool,
}

fn removed_message(room_id: &str, blocked: bool) -> WsMessage {
    let reason = if blocked {
        "The host removed you from the room and blocked you from rejoining"
    } else {
        "The host removed you from the room"
    };
    WsMessage {
        msg_type: ServerMessageType::RoomClosed,
        room: Some(room_id.to_string()),
        client: None,
        payload: Some(serde_json::json!({ "reason": reason })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

enum Outcome {
    /// The removed clients, with their senders taken before they left, and the
    /// `room_closed` they get last.
    Removed(Vec<(String, Option<ClientSender>)>, WsMessage),
    Error(ErrorCode, &'static str),
}

/// Checks the request and takes the target (or, for a block, every connection
/// of the target's account) out of the sender's room through the normal leave
/// path, so every cleanup `leave_room` does also happens.
fn remove_from_room(
    client_id: &str,
    payload: &RemoveParticipantPayload,
    state: &mut ServerState,
) -> Outcome {
    let Some(room_id) = state
        .clients
        .get(client_id)
        .and_then(|client| client.room_id.clone())
    else {
        return Outcome::Error(ErrorCode::NotInRoom, "Client is not in a room");
    };
    let Some(room) = state.rooms.get(&room_id) else {
        return Outcome::Error(ErrorCode::NotInRoom, "Client is not in a room");
    };
    if room.host_id != client_id {
        return Outcome::Error(
            ErrorCode::HostPermissionRequired,
            "Only the room host can remove participants",
        );
    }
    let Some(target) = state
        .clients
        .get(&payload.id)
        .filter(|_| room.clients.iter().any(|id| id == &payload.id))
    else {
        return Outcome::Error(
            ErrorCode::ParticipantNotFound,
            "That participant is no longer in the room",
        );
    };
    if payload.id == client_id {
        return Outcome::Error(
            ErrorCode::InvalidModerationTarget,
            "The host cannot remove themselves",
        );
    }
    let target_user_id = target.user_id.clone();
    if payload.block
        && (target_user_id.is_empty() || target_user_id == state.clients[client_id].user_id)
    {
        return Outcome::Error(
            ErrorCode::InvalidModerationTarget,
            "You cannot block your own account",
        );
    }

    let target_ids = if payload.block {
        room.clients
            .iter()
            .filter(|id| {
                state
                    .clients
                    .get(*id)
                    .is_some_and(|client| client.user_id == target_user_id)
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        vec![payload.id.clone()]
    };
    if payload.block {
        let room = state.rooms.get_mut(&room_id).expect("room still exists");
        room.blocked_users.insert(target_user_id.clone());
        room.admitted_users.remove(&target_user_id);
        if room
            .pending_host_reconnect
            .as_ref()
            .is_some_and(|pending| pending.user_id == target_user_id)
        {
            room.pending_host_reconnect = None;
        }
    }
    let ServerState { clients, rooms } = state;
    let mut removed = Vec::new();
    for target_id in target_ids {
        let sender = clients.get(&target_id).map(|client| client.sender.clone());
        if let Some(notification) = handle_leave(&target_id, clients, rooms) {
            send_leave_notification(&notification, "participant removed");
        }
        removed.push((target_id, sender));
    }
    Outcome::Removed(removed, removed_message(&room_id, payload.block))
}

pub(in crate::ws) async fn handle_remove_participant(
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
    let payload = parsed
        .payload
        .clone()
        .and_then(|payload| serde_json::from_value::<RemoveParticipantPayload>(payload).ok());
    let Some(payload) = payload else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidModerationPayload,
            "Invalid remove participant payload",
        )
        .await;
        return;
    };

    let outcome = remove_from_room(client_id, &payload, &mut *state.write().await);

    match outcome {
        Outcome::Removed(removed, message) => {
            broadcast_room_list(state).await;
            for (target_id, sender) in removed {
                send_message(sender, &message, Some(&target_id));
            }
        }
        Outcome::Error(code, message) => send_error(client_id, state, code, message).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::JwtConfig;
    use crate::test_helpers;
    use crate::types::{ClientMessageType, PendingHostReconnect};
    use std::sync::Arc;

    type Receiver = tokio::sync::mpsc::Receiver<Result<warp::ws::Message, warp::Error>>;

    fn message(payload: Option<serde_json::Value>) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::RemoveParticipant,
            room: None,
            client: None,
            payload,
            ts: 0,
            server_ts: None,
        }
    }

    fn join_message(payload: Option<serde_json::Value>) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::JoinRoom,
            room: Some("room".to_string()),
            client: None,
            payload,
            ts: 0,
            server_ts: None,
        }
    }

    fn insecure_config() -> Arc<JwtConfig> {
        Arc::new(JwtConfig {
            secret: String::new(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: false,
        })
    }

    async fn setup_room(host_user: &str, target_user: &str) -> (SharedState, Receiver, Receiver) {
        let state = test_helpers::create_state();
        let (mut host, host_rx) = test_helpers::create_client_with_rx(host_user, "Host", true);
        let (mut target, target_rx) =
            test_helpers::create_client_with_rx(target_user, "Target", true);
        host.room_id = Some("room".to_string());
        target.room_id = Some("room".to_string());
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("target".to_string());
        let mut locked = state.write().await;
        locked.clients.insert("host".to_string(), host);
        locked.clients.insert("target".to_string(), target);
        locked.rooms.insert("room".to_string(), room);
        drop(locked);
        (state, host_rx, target_rx)
    }

    fn assert_error(rx: &mut Receiver, code: &str, message: &str) {
        let error = test_helpers::recv_msg(rx).expect("error response");
        assert_eq!(error.msg_type, ServerMessageType::Error);
        assert_eq!(error.payload.as_ref().unwrap()["code"], code);
        assert_eq!(error.payload.as_ref().unwrap()["message"], message);
    }

    #[tokio::test]
    async fn rejects_unauthenticated_and_every_malformed_payload_shape() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("", "", false);
        state
            .write()
            .await
            .clients
            .insert("guest".to_string(), client);
        handle_remove_participant(
            "guest",
            &message(Some(serde_json::json!({ "id": "target", "block": false }))),
            &state,
        )
        .await;
        assert_error(
            &mut rx,
            "AUTHENTICATION_REQUIRED",
            "Authentication required",
        );

        state
            .write()
            .await
            .clients
            .get_mut("guest")
            .unwrap()
            .authenticated = true;
        for payload in [
            None,
            Some(serde_json::json!({ "block": false })),
            Some(serde_json::json!({ "id": "target" })),
            Some(serde_json::json!({ "id": 7, "block": false })),
            Some(serde_json::json!({ "id": "target", "block": "false" })),
            Some(serde_json::json!({ "id": "target", "block": false, "extra": true })),
        ] {
            handle_remove_participant("guest", &message(payload), &state).await;
            assert_error(
                &mut rx,
                "INVALID_MODERATION_PAYLOAD",
                "Invalid remove participant payload",
            );
        }
    }

    #[tokio::test]
    async fn rejects_no_room_non_host_unknown_member_and_the_host() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u", "User", true);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);
        handle_remove_participant(
            "client",
            &message(Some(serde_json::json!({ "id": "target", "block": false }))),
            &state,
        )
        .await;
        assert_error(&mut rx, "NOT_IN_ROOM", "Client is not in a room");

        let (state, mut host_rx, mut target_rx) = setup_room("host-user", "target-user").await;
        handle_remove_participant(
            "target",
            &message(Some(serde_json::json!({ "id": "host", "block": false }))),
            &state,
        )
        .await;
        assert_error(
            &mut target_rx,
            "HOST_PERMISSION_REQUIRED",
            "Only the room host can remove participants",
        );
        handle_remove_participant(
            "host",
            &message(Some(serde_json::json!({ "id": "gone", "block": false }))),
            &state,
        )
        .await;
        assert_error(
            &mut host_rx,
            "PARTICIPANT_NOT_FOUND",
            "That participant is no longer in the room",
        );
        handle_remove_participant(
            "host",
            &message(Some(serde_json::json!({ "id": "host", "block": false }))),
            &state,
        )
        .await;
        assert_error(
            &mut host_rx,
            "INVALID_MODERATION_TARGET",
            "The host cannot remove themselves",
        );
        assert_eq!(state.read().await.rooms["room"].clients.len(), 2);
    }

    #[tokio::test]
    async fn rejects_connected_clients_who_are_not_members_of_the_hosts_room() {
        let state = test_helpers::create_state();
        let (mut host, mut host_rx) =
            test_helpers::create_client_with_rx("host-user", "Host", true);
        let (mut foreign, mut foreign_rx) =
            test_helpers::create_client_with_rx("foreign-user", "Foreign", true);
        let (unattached, mut unattached_rx) =
            test_helpers::create_client_with_rx("unattached-user", "Unattached", true);
        host.room_id = Some("room".to_string());
        foreign.room_id = Some("other-room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("foreign".to_string(), foreign);
            locked.clients.insert("unattached".to_string(), unattached);
            locked.rooms.insert(
                "room".to_string(),
                test_helpers::create_room("room", "host"),
            );
            locked.rooms.insert(
                "other-room".to_string(),
                test_helpers::create_room("other-room", "foreign"),
            );
        }

        for target in ["foreign", "unattached"] {
            handle_remove_participant(
                "host",
                &message(Some(serde_json::json!({ "id": target, "block": false }))),
                &state,
            )
            .await;
            assert_error(
                &mut host_rx,
                "PARTICIPANT_NOT_FOUND",
                "That participant is no longer in the room",
            );
        }

        let locked = state.read().await;
        assert!(locked.rooms["other-room"]
            .clients
            .contains(&"foreign".to_string()));
        assert_eq!(
            locked.clients["foreign"].room_id.as_deref(),
            Some("other-room")
        );
        assert!(locked.clients["unattached"].room_id.is_none());
        assert!(test_helpers::recv_msg(&mut foreign_rx).is_none());
        assert!(test_helpers::recv_msg(&mut unattached_rx).is_none());
    }

    #[tokio::test]
    async fn own_or_empty_account_cannot_be_blocked_but_can_be_removed() {
        for target_user in ["same-user", ""] {
            let host_user = if target_user.is_empty() {
                "host-user"
            } else {
                target_user
            };
            let (state, mut host_rx, mut target_rx) = setup_room(host_user, target_user).await;
            handle_remove_participant(
                "host",
                &message(Some(serde_json::json!({ "id": "target", "block": true }))),
                &state,
            )
            .await;
            assert_error(
                &mut host_rx,
                "INVALID_MODERATION_TARGET",
                "You cannot block your own account",
            );
            assert_eq!(
                state.read().await.clients["target"].room_id.as_deref(),
                Some("room")
            );

            handle_remove_participant(
                "host",
                &message(Some(serde_json::json!({ "id": "target", "block": false }))),
                &state,
            )
            .await;
            assert!(state.read().await.clients["target"].room_id.is_none());
            let messages =
                std::iter::from_fn(|| test_helpers::recv_msg(&mut target_rx)).collect::<Vec<_>>();
            assert_eq!(
                messages.last().unwrap().msg_type,
                ServerMessageType::RoomClosed
            );
            assert_eq!(
                messages.last().unwrap().payload.as_ref().unwrap()["reason"],
                "The host removed you from the room"
            );
        }
    }

    #[tokio::test]
    async fn remove_notifies_members_finishes_target_with_reason_and_allows_rejoin() {
        let (state, mut host_rx, mut target_rx) = setup_room("host-user", "target-user").await;
        state
            .write()
            .await
            .clients
            .get_mut("host")
            .unwrap()
            .supports_room_moderation = true;

        handle_remove_participant(
            "host",
            &message(Some(serde_json::json!({ "id": "target", "block": false }))),
            &state,
        )
        .await;

        let host_messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut host_rx)).collect::<Vec<_>>();
        assert_eq!(host_messages[0].msg_type, ServerMessageType::ClientLeft);
        assert_eq!(host_messages[0].client.as_deref(), Some("target"));
        let list = host_messages
            .iter()
            .find(|message| message.msg_type == ServerMessageType::ParticipantList)
            .unwrap();
        assert_eq!(
            list.payload.as_ref().unwrap()["participants"],
            serde_json::json!([{ "id": "host", "name": "Host", "is_host": true }])
        );
        let target_messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut target_rx)).collect::<Vec<_>>();
        assert_eq!(
            target_messages.last().unwrap().msg_type,
            ServerMessageType::RoomClosed
        );
        assert_eq!(
            target_messages.last().unwrap().payload.as_ref().unwrap()["reason"],
            "The host removed you from the room"
        );

        super::super::join::handle_join_room(
            "target",
            &join_message(None),
            &state,
            &insecure_config(),
        )
        .await;
        assert_eq!(
            state.read().await.clients["target"].room_id.as_deref(),
            Some("room")
        );
    }

    #[tokio::test]
    async fn blocking_revokes_admission_but_plain_removal_preserves_it() {
        for block in [false, true] {
            let (state, _host_rx, _target_rx) = setup_room("host-user", "target-user").await;
            {
                let mut locked = state.write().await;
                let room = locked.rooms.get_mut("room").unwrap();
                room.access.approval = true;
                room.admitted_users.insert("target-user".to_string());
            }

            handle_remove_participant(
                "host",
                &message(Some(serde_json::json!({ "id": "target", "block": block }))),
                &state,
            )
            .await;

            let locked = state.read().await;
            assert_eq!(
                locked.rooms["room"].admitted_users.contains("target-user"),
                !block
            );
        }
    }

    #[tokio::test]
    async fn block_removes_every_session_hides_room_and_refuses_all_joins() {
        let (state, _host_rx, mut target_rx) = setup_room("host-user", "blocked-user").await;
        let (mut second, mut second_rx) =
            test_helpers::create_client_with_rx("blocked-user", "Second", true);
        let (mut other, mut other_rx) =
            test_helpers::create_client_with_rx("other-user", "Other", true);
        second.room_id = Some("room".to_string());
        second.supports_host_transfer = true;
        other.room_id = Some("room".to_string());
        other.supports_host_transfer = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("second".to_string(), second);
            locked.clients.insert("other".to_string(), other);
            locked
                .clients
                .get_mut("target")
                .unwrap()
                .supports_room_access = true;
            let room = locked.rooms.get_mut("room").unwrap();
            room.access.approval = true;
            room.clients
                .extend(["second".to_string(), "other".to_string()]);
            room.pending_host_reconnect = Some(PendingHostReconnect {
                user_id: "blocked-user".to_string(),
                generation: 7,
            });
        }

        handle_remove_participant(
            "host",
            &message(Some(serde_json::json!({ "id": "target", "block": true }))),
            &state,
        )
        .await;

        {
            let locked = state.read().await;
            assert!(locked.clients["target"].room_id.is_none());
            assert!(locked.clients["second"].room_id.is_none());
            assert_eq!(locked.clients["other"].room_id.as_deref(), Some("room"));
            assert!(locked.rooms["room"].blocked_users.contains("blocked-user"));
            assert!(locked.rooms["room"].pending_host_reconnect.is_none());
        }
        for rx in [&mut target_rx, &mut second_rx] {
            let messages = std::iter::from_fn(|| test_helpers::recv_msg(rx)).collect::<Vec<_>>();
            assert_eq!(
                messages.last().unwrap().msg_type,
                ServerMessageType::RoomClosed
            );
            assert_eq!(
                messages.last().unwrap().payload.as_ref().unwrap()["reason"],
                "The host removed you from the room and blocked you from rejoining"
            );
            let list = messages
                .iter()
                .find(|message| message.msg_type == ServerMessageType::RoomList)
                .unwrap();
            assert_eq!(list.payload.as_ref().unwrap(), &serde_json::json!([]));
        }
        let other_messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut other_rx)).collect::<Vec<_>>();
        assert!(other_messages.iter().any(|message| {
            message.msg_type == ServerMessageType::RoomList
                && message.payload.as_ref().unwrap().as_array().unwrap().len() == 1
        }));

        crate::messaging::send_room_list("target", &state).await;
        crate::messaging::send_room_list("other", &state).await;
        assert_eq!(
            test_helpers::recv_msg(&mut target_rx)
                .unwrap()
                .payload
                .unwrap(),
            serde_json::json!([])
        );
        assert_eq!(
            test_helpers::recv_msg(&mut other_rx)
                .unwrap()
                .payload
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // A valid invite ticket does not get a blocked user back in either.
        let ticket_config = Arc::new(JwtConfig {
            secret: "B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=".to_string(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: true,
        });
        let (ticket, _) = ticket_config.mint_invite_ticket("room", Some(300)).unwrap();
        for (payload, config) in [
            (None, insecure_config()),
            (
                Some(serde_json::json!({ "invite_ticket": ticket })),
                ticket_config,
            ),
        ] {
            super::super::join::handle_join_room("target", &join_message(payload), &state, &config)
                .await;
            assert_error(
                &mut target_rx,
                "BLOCKED_FROM_ROOM",
                "The host blocked you from this room",
            );
        }
        assert!(state.read().await.rooms["room"].join_requests.is_empty());

        let notification = {
            let mut locked = state.write().await;
            let crate::types::ServerState { clients, rooms } = &mut *locked;
            crate::room::handle_leave("host", clients, rooms).unwrap()
        };
        crate::room::send_leave_notification(&notification, "test host change");
        let locked = state.read().await;
        assert_eq!(locked.rooms["room"].host_id, "other");
        assert!(locked.rooms["room"].blocked_users.contains("blocked-user"));
    }
}
