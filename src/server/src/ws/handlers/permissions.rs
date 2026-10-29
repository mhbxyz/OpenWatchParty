use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use crate::types::{IncomingMessage, RoomPermissions, ServerState, SharedState};

pub(in crate::ws) async fn handle_set_room_permissions(
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
    let Some(permissions) = parsed
        .payload
        .clone()
        .and_then(|payload| serde_json::from_value::<RoomPermissions>(payload).ok())
    else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidPermissionsPayload,
            "Invalid permissions payload",
        )
        .await;
        return;
    };

    let error = {
        let mut state = state.write().await;
        let ServerState { clients, rooms } = &mut *state;
        let room = clients
            .get(client_id)
            .and_then(|client| client.room_id.as_ref())
            .and_then(|room_id| rooms.get_mut(room_id));
        match room {
            None => Some((ErrorCode::NotInRoom, "Client is not in a room")),
            Some(room) if room.host_id != client_id => Some((
                ErrorCode::HostPermissionRequired,
                "Only the room host can change guest permissions",
            )),
            Some(room) if room.permissions == permissions => None,
            Some(room) => {
                room.permissions = permissions;
                crate::room::send_room_permissions(room, clients, None);
                None
            }
        }
    };
    if let Some((code, message)) = error {
        send_error(client_id, state, code, message).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::{ClientMessageType, ServerMessageType};

    fn message(payload: serde_json::Value) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::SetRoomPermissions,
            room: None,
            client: None,
            payload: Some(payload),
            ts: 0,
            server_ts: None,
        }
    }

    async fn room_with_members() -> (
        SharedState,
        tokio::sync::mpsc::Receiver<crate::messaging::OutboundMessage>,
        tokio::sync::mpsc::Receiver<crate::messaging::OutboundMessage>,
        tokio::sync::mpsc::Receiver<crate::messaging::OutboundMessage>,
    ) {
        let state = test_helpers::create_state();
        let (mut host, host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        let (mut legacy, legacy_rx) = test_helpers::create_client_with_rx("legacy", "Legacy", true);
        for client in [&mut host, &mut guest, &mut legacy] {
            client.room_id = Some("room".to_string());
        }
        host.supports_room_permissions = true;
        guest.supports_room_permissions = true;
        let mut room = test_helpers::create_room("room", "host");
        room.clients = vec!["host".into(), "guest".into(), "legacy".into()];
        let mut locked = state.write().await;
        locked.clients.insert("host".into(), host);
        locked.clients.insert("guest".into(), guest);
        locked.clients.insert("legacy".into(), legacy);
        locked.rooms.insert("room".into(), room);
        drop(locked);
        (state, host_rx, guest_rx, legacy_rx)
    }

    #[tokio::test]
    async fn host_changes_permissions_for_negotiated_members_only() {
        let (state, mut host_rx, mut guest_rx, mut legacy_rx) = room_with_members().await;
        let payload = serde_json::json!({
            "seek": true, "change_media": false, "edit_queue": true
        });

        handle_set_room_permissions("host", &message(payload.clone()), &state).await;

        assert!(state.read().await.rooms["room"].permissions.seek);
        for rx in [&mut host_rx, &mut guest_rx] {
            let notification = test_helpers::recv_msg(rx).unwrap();
            assert_eq!(notification.msg_type, ServerMessageType::RoomPermissions);
            assert_eq!(notification.payload.unwrap(), payload);
        }
        assert!(test_helpers::recv_msg(&mut legacy_rx).is_none());
    }

    #[tokio::test]
    async fn guest_is_refused_and_an_unchanged_value_sends_nothing() {
        let (state, mut host_rx, mut guest_rx, _legacy_rx) = room_with_members().await;
        let unchanged = serde_json::json!({
            "seek": false, "change_media": false, "edit_queue": false
        });

        handle_set_room_permissions("host", &message(unchanged.clone()), &state).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        handle_set_room_permissions("guest", &message(unchanged), &state).await;

        let error = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(error.payload.unwrap()["code"], "HOST_PERMISSION_REQUIRED");
    }

    #[tokio::test]
    async fn payload_requires_exactly_three_booleans() {
        let (state, mut host_rx, _guest_rx, _legacy_rx) = room_with_members().await;
        for payload in [
            serde_json::json!({"seek": true, "change_media": false}),
            serde_json::json!({
                "seek": true, "change_media": false, "edit_queue": false, "extra": false
            }),
            serde_json::json!({
                "seek": "true", "change_media": false, "edit_queue": false
            }),
        ] {
            handle_set_room_permissions("host", &message(payload), &state).await;
            let error = test_helpers::recv_msg(&mut host_rx).unwrap();
            assert_eq!(
                error.payload.unwrap()["code"],
                "INVALID_PERMISSIONS_PAYLOAD"
            );
        }
    }

    #[tokio::test]
    async fn authentication_and_room_membership_are_required() {
        let state = test_helpers::create_state();
        let (anonymous, mut anonymous_rx) =
            test_helpers::create_client_with_rx("anonymous", "Anonymous", false);
        let (outside, mut outside_rx) =
            test_helpers::create_client_with_rx("outside", "Outside", true);
        {
            let mut locked = state.write().await;
            locked.clients.insert("anonymous".into(), anonymous);
            locked.clients.insert("outside".into(), outside);
        }
        let valid = message(serde_json::json!({
            "seek": false, "change_media": false, "edit_queue": false
        }));

        handle_set_room_permissions("anonymous", &valid, &state).await;
        handle_set_room_permissions("outside", &valid, &state).await;

        assert_eq!(
            test_helpers::recv_msg(&mut anonymous_rx)
                .unwrap()
                .payload
                .unwrap()["code"],
            "AUTHENTICATION_REQUIRED"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut outside_rx)
                .unwrap()
                .payload
                .unwrap()["code"],
            "NOT_IN_ROOM"
        );
    }
}
