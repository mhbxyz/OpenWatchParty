use crate::types::{Client, Room, ServerMessageType, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;

/// Sent only to clients that negotiated this extension: legacy payloads stay
/// unchanged, and shared controls follow the current host's capability.
pub(crate) fn send_room_capabilities(room: &Room, clients: &HashMap<String, Client>) {
    let enabled = clients
        .get(&room.host_id)
        .is_some_and(|client| client.supports_shared_playback_control);
    let features: Vec<&str> = if enabled {
        vec!["shared_playback_control"]
    } else {
        vec![]
    };
    let senders = room
        .clients
        .iter()
        .filter_map(|id| clients.get(id))
        .filter(|client| client.supports_shared_playback_control)
        .map(|client| client.sender.clone())
        .collect::<Vec<_>>();
    crate::messaging::send_to_senders(
        &senders,
        &WsMessage {
            msg_type: ServerMessageType::RoomCapabilities,
            room: Some(room.room_id.clone()),
            client: None,
            payload: Some(serde_json::json!({ "features": features })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        },
        "room capabilities",
    );
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn capabilities_follow_the_host_and_never_reach_legacy_clients() {
        let (host, mut host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        guest.supports_shared_playback_control = true;
        let mut room = test_helpers::create_room("r1", "host");
        room.clients.push("guest".into());
        let mut clients = HashMap::from([("host".into(), host), ("guest".into(), guest)]);
        send_room_capabilities(&room, &clients);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx)
                .unwrap()
                .payload
                .unwrap()["features"],
            serde_json::json!([])
        );
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        room.host_id = "guest".into();
        send_room_capabilities(&room, &clients);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx)
                .unwrap()
                .payload
                .unwrap()["features"],
            serde_json::json!(["shared_playback_control"])
        );
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        clients
            .get_mut("guest")
            .unwrap()
            .supports_shared_playback_control = false;
        send_room_capabilities(&room, &clients);
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
    }
}

/// Builds the `participant_list` message: the display names of the room's
/// members in join order, with the host flagged.
///
/// It is a message type of its own, rather than new fields on `room_state` or
/// `participants_update`, because clients validate those payloads strictly and
/// would drop them. A client that does not know `participant_list` ignores it
/// and keeps showing the participant count.
pub fn participant_list_message(room: &Room, clients: &HashMap<String, Client>) -> WsMessage {
    let participants: Vec<serde_json::Value> = room
        .clients
        .iter()
        .filter_map(|client_id| {
            clients.get(client_id).map(|client| {
                serde_json::json!({
                    "name": client.user_name,
                    "is_host": *client_id == room.host_id,
                })
            })
        })
        .collect();
    WsMessage {
        msg_type: ServerMessageType::ParticipantList,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(serde_json::json!({ "participants": participants })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

/// Builds the `participant_statuses` message: each member's last reported
/// status, or null, in the same order as `participant_list`. It is sent right
/// after every `participant_list` and whenever a status changes. Clients that
/// do not know it ignore it, as `participant_list` rejects unknown fields.
pub fn participant_statuses_message(room: &Room) -> WsMessage {
    let statuses: Vec<serde_json::Value> = room
        .clients
        .iter()
        .map(|client_id| {
            room.statuses
                .get(client_id)
                .map_or(serde_json::Value::Null, |status| serde_json::json!(status))
        })
        .collect();
    WsMessage {
        msg_type: ServerMessageType::ParticipantStatuses,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(serde_json::json!({ "statuses": statuses })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

/// Builds the `participant_tracks` message: each member's last reported audio
/// and subtitle tracks, or null, in the same order as `participant_list`. It
/// is sent right after every `participant_statuses` and whenever a member's
/// tracks change. Clients that do not know it ignore it.
pub fn participant_tracks_message(room: &Room) -> WsMessage {
    let tracks: Vec<serde_json::Value> = room
        .clients
        .iter()
        .map(|client_id| {
            room.tracks
                .get(client_id)
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        })
        .collect();
    WsMessage {
        msg_type: ServerMessageType::ParticipantTracks,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(serde_json::json!({ "tracks": tracks })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn lists_names_in_join_order_with_the_host_flagged() {
        let mut clients = HashMap::new();
        let (host, _host_rx) = test_helpers::create_client_with_rx("u1", "Franco", true);
        let (guest, _guest_rx) = test_helpers::create_client_with_rx("u2", "Ana", true);
        clients.insert("host".to_string(), host);
        clients.insert("guest".to_string(), guest);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("guest".to_string());

        let message = participant_list_message(&room, &clients);

        assert_eq!(message.msg_type, ServerMessageType::ParticipantList);
        assert_eq!(message.room.as_deref(), Some("room"));
        assert_eq!(
            message.payload.unwrap(),
            serde_json::json!({
                "participants": [
                    { "name": "Franco", "is_host": true },
                    { "name": "Ana", "is_host": false }
                ]
            })
        );
    }

    #[test]
    fn skips_members_without_a_connected_client() {
        let mut clients = HashMap::new();
        let (host, _host_rx) = test_helpers::create_client_with_rx("u1", "Franco", true);
        clients.insert("host".to_string(), host);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("gone".to_string());

        let message = participant_list_message(&room, &clients);

        assert_eq!(
            message.payload.unwrap()["participants"],
            serde_json::json!([{ "name": "Franco", "is_host": true }])
        );
    }

    #[test]
    fn statuses_follow_the_list_order_with_null_when_unknown() {
        let mut room = test_helpers::create_room("room", "host");
        room.clients = vec!["host".to_string(), "ana".to_string(), "bruno".to_string()];
        room.statuses.insert("bruno".to_string(), "buffering");
        room.statuses.insert("host".to_string(), "playing");

        let message = participant_statuses_message(&room);

        assert_eq!(message.msg_type, ServerMessageType::ParticipantStatuses);
        assert_eq!(message.room.as_deref(), Some("room"));
        assert_eq!(
            message.payload.unwrap()["statuses"],
            serde_json::json!(["playing", null, "buffering"])
        );
    }

    #[test]
    fn tracks_follow_the_list_order_with_null_when_unknown() {
        let mut room = test_helpers::create_room("room", "host");
        room.clients = vec!["host".to_string(), "ana".to_string()];
        let english = serde_json::json!({ "media_id": "0".repeat(32), "audio": { "title": "English" }, "subtitle": null });
        room.tracks.insert("ana".to_string(), english.clone());

        let message = participant_tracks_message(&room);

        assert_eq!(message.msg_type, ServerMessageType::ParticipantTracks);
        assert_eq!(message.room.as_deref(), Some("room"));
        assert_eq!(
            message.payload.unwrap()["tracks"],
            serde_json::json!([null, english])
        );
    }
}
