use crate::messaging::send_message;
use crate::types::{Client, Room, ServerMessageType, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;

pub(crate) fn message(
    room: &Room,
    kind: ServerMessageType,
    payload: serde_json::Value,
) -> WsMessage {
    WsMessage {
        msg_type: kind,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(payload),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

pub(crate) fn send_requests(room: &Room, clients: &HashMap<String, Client>) {
    if let Some(host) = clients
        .get(&room.host_id)
        .filter(|c| c.supports_room_access)
    {
        let requests: Vec<_> = room
            .join_requests
            .iter()
            .map(|r| serde_json::json!({ "id": r.id, "name": r.name }))
            .collect();
        send_message(
            Some(host.sender.clone()),
            &message(
                room,
                ServerMessageType::JoinRequests,
                serde_json::json!({ "requests": requests }),
            ),
            None,
        );
    }
}

pub(crate) fn send_access(room: &Room, clients: &HashMap<String, Client>) {
    let msg = message(
        room,
        ServerMessageType::RoomAccess,
        serde_json::json!(room.access),
    );
    for id in &room.clients {
        if let Some(client) = clients.get(id).filter(|c| c.supports_room_access) {
            send_message(Some(client.sender.clone()), &msg, None);
        }
    }
    send_requests(room, clients);
}

pub(crate) fn reject_waiting(room: &Room, clients: &HashMap<String, Client>, reason: &str) {
    let host_name = clients
        .get(&room.host_id)
        .map(|c| c.user_name.as_str())
        .unwrap_or_default();
    let msg = message(
        room,
        ServerMessageType::JoinRejected,
        serde_json::json!({ "reason": reason, "host_name": host_name }),
    );
    for request in &room.join_requests {
        if let Some(client) = clients
            .get(&request.client_id)
            .filter(|c| c.supports_room_access)
        {
            send_message(Some(client.sender.clone()), &msg, None);
        }
    }
}

pub(crate) fn host_changed(room: &mut Room, clients: &HashMap<String, Client>) {
    if !clients
        .get(&room.host_id)
        .is_some_and(|c| c.supports_room_access)
    {
        room.access.approval = false;
        reject_waiting(room, clients, "unavailable");
        room.join_requests.clear();
    }
    send_access(room, clients);
}

pub(crate) fn cancel(
    client_id: &str,
    rooms: &mut HashMap<String, Room>,
    clients: &HashMap<String, Client>,
) {
    for room in rooms.values_mut() {
        let before = room.join_requests.len();
        room.join_requests.retain(|r| r.client_id != client_id);
        if room.join_requests.len() != before {
            send_requests(room, clients);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::JoinRequest;

    #[test]
    fn new_hosts_receive_access_or_release_waiters_as_unavailable() {
        for supports in [false, true] {
            let (mut host, mut host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
            host.supports_room_access = supports;
            let (mut guest, mut guest_rx) =
                test_helpers::create_client_with_rx("guest", "Guest", true);
            guest.supports_room_access = true;
            let clients = HashMap::from([("host".to_string(), host), ("guest".to_string(), guest)]);
            let mut room = test_helpers::create_room("room", "host");
            room.access.approval = true;
            room.access.unlisted = true;
            room.join_requests.push(JoinRequest {
                id: "request".to_string(),
                client_id: "guest".to_string(),
                name: "Guest".to_string(),
            });
            host_changed(&mut room, &clients);
            assert_eq!(room.access.approval, supports);
            assert!(room.access.unlisted);
            assert_eq!(room.join_requests.is_empty(), !supports);
            if supports {
                assert_eq!(
                    test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
                    ServerMessageType::RoomAccess
                );
                assert_eq!(
                    test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
                    ServerMessageType::JoinRequests
                );
                assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
            } else {
                assert!(test_helpers::recv_msg(&mut host_rx).is_none());
                assert_eq!(
                    test_helpers::recv_msg(&mut guest_rx)
                        .unwrap()
                        .payload
                        .unwrap()["reason"],
                    "unavailable"
                );
            }
        }
    }
}

#[cfg(test)]
mod recipient_tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn only_negotiated_members_receive_access() {
        let (mut host, mut host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (legacy, mut legacy_rx) = test_helpers::create_client_with_rx("legacy", "Legacy", true);
        host.supports_room_access = true;
        let clients = HashMap::from([("host".to_string(), host), ("legacy".to_string(), legacy)]);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("legacy".to_string());
        send_access(&room, &clients);
        assert_eq!(
            test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
            ServerMessageType::RoomAccess
        );
        assert!(test_helpers::recv_msg(&mut legacy_rx).is_none());
    }
}
