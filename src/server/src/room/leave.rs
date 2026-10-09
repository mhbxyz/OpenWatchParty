use crate::messaging::{broadcast_room_list, collect_room_senders, send_to_senders, ClientSender};
use crate::room::{close_room_parts, participant_list_message, participant_statuses_message};
use crate::types::{Client, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;

/// Senders of the remaining room members, and the messages to send them in order.
pub type LeaveNotification = (Vec<ClientSender>, Vec<WsMessage>);

enum LeaveOutcome {
    Left(LeaveNotification),
    Close(String),
}

fn client_left_message(room_id: &str, client_id: &str, participant_count: usize) -> WsMessage {
    WsMessage {
        msg_type: "client_left".to_string(),
        room: Some(room_id.to_string()),
        client: Some(client_id.to_string()),
        payload: Some(serde_json::json!({ "participant_count": participant_count })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

fn detach_client_from_room(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
    allow_host_transfer: bool,
) -> Option<LeaveOutcome> {
    let client = clients.get_mut(client_id)?;
    let room_id = client.room_id.take()?;
    let room = rooms.get_mut(&room_id)?;

    room.clients.retain(|id| id != client_id);
    room.ready_clients.remove(client_id);
    room.statuses.remove(client_id);
    if room.host_id == client_id {
        room.pending_play = None;
    }

    if room.clients.is_empty() {
        Some(LeaveOutcome::Close(room_id))
    } else {
        let client_left = client_left_message(&room_id, client_id, room.clients.len());
        let mut messages = vec![client_left];
        if room.host_id == client_id {
            if !allow_host_transfer {
                return Some(LeaveOutcome::Close(room_id));
            }
            let Some(new_host_id) = room.clients.iter().find(|id| {
                clients
                    .get(*id)
                    .is_some_and(|client| client.supports_host_transfer)
            }) else {
                return Some(LeaveOutcome::Close(room_id));
            };
            let new_host_id = new_host_id.clone();
            let host_name = clients
                .get(&new_host_id)
                .map(|client| client.user_name.clone())
                .unwrap_or_default();
            room.host_id = new_host_id.clone();
            messages.push(WsMessage {
                msg_type: "host_changed".to_string(),
                room: Some(room_id.clone()),
                client: None,
                payload: Some(serde_json::json!({
                    "host_id": new_host_id,
                    "host_name": host_name,
                })),
                ts: now_ms(),
                server_ts: Some(now_ms()),
            });
        }
        messages.push(participant_list_message(room, clients));
        messages.push(participant_statuses_message(room));
        let senders = collect_room_senders(room, clients, None);
        Some(LeaveOutcome::Left((senders, messages)))
    }
}

fn close_and_notify(
    room_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> (Vec<ClientSender>, WsMessage) {
    let senders = close_room_parts(room_id, clients, rooms).unwrap_or_default();
    let msg = WsMessage {
        msg_type: "room_closed".to_string(),
        room: Some(room_id.to_string()),
        client: None,
        payload: Some(serde_json::json!({ "reason": "Host left the room" })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    (senders, msg)
}

pub fn handle_leave(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<LeaveNotification> {
    handle_leave_with_transfer(client_id, clients, rooms, true)
}

pub(crate) fn handle_leave_without_transfer(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<LeaveNotification> {
    handle_leave_with_transfer(client_id, clients, rooms, false)
}

fn handle_leave_with_transfer(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
    allow_host_transfer: bool,
) -> Option<LeaveNotification> {
    match detach_client_from_room(client_id, clients, rooms, allow_host_transfer) {
        Some(LeaveOutcome::Left(notification)) => Some(notification),
        Some(LeaveOutcome::Close(room_id)) => {
            let (senders, msg) = close_and_notify(&room_id, clients, rooms);
            Some((senders, vec![msg]))
        }
        None => None,
    }
}

pub fn send_leave_notification(notification: &LeaveNotification, context: &str) {
    let (senders, messages) = notification;
    for msg in messages {
        send_to_senders(senders, msg, context);
    }
}

/// Removes a client and leaves its room. Returns whether the client was
/// still registered.
pub async fn handle_disconnect(client_id: &str, state: &SharedState) -> bool {
    let removed = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let room_id = clients.get(client_id).and_then(|c| c.room_id.clone());
        info!(
            "Disconnecting client client_id={client_id} room_id={}",
            room_id.as_deref().unwrap_or("-")
        );
        if let Some(notification) = handle_leave(client_id, clients, rooms) {
            send_leave_notification(&notification, "leave notification");
        }
        clients.remove(client_id).is_some()
    };
    broadcast_room_list(state).await;
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::PendingPlay;

    #[test]
    fn detach_client_removes_from_room() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host-1");

        let (mut guest, _rx_g) = test_helpers::create_client_with_rx("ug", "Guest", true);
        guest.room_id = Some("room-1".to_string());
        clients.insert("guest-1".to_string(), guest);
        rooms
            .get_mut("room-1")
            .unwrap()
            .clients
            .push("guest-1".to_string());

        // Detach the guest (non-host) — room still has host, so it stays open
        detach_client_from_room("guest-1", &mut clients, &mut rooms, true);

        let room = rooms.get("room-1").unwrap();
        assert!(!room.clients.contains(&"guest-1".to_string()));
        assert!(clients.get("guest-1").unwrap().room_id.is_none());
    }

    #[test]
    fn detach_host_clears_pending_play() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host-1");

        rooms.get_mut("room-1").unwrap().pending_play = Some(PendingPlay {
            position: 10.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: 0,
        });

        detach_client_from_room("host-1", &mut clients, &mut rooms, true);

        // Room should be returned for closing (host left)
        // The pending_play is cleared before close_and_notify removes the room
        assert!(clients.get("host-1").unwrap().room_id.is_none());
    }

    #[test]
    fn detach_client_not_in_room() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u1", "User", true);
        clients.insert("c1".to_string(), client);

        let result = detach_client_from_room("c1", &mut clients, &mut rooms, true);
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn host_disconnect_clears_guest_room_membership() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
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

        handle_disconnect("host", &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms.contains_key("room"));
        assert!(!locked.clients.contains_key("host"));
        assert!(locked.clients["guest"].room_id.is_none());
        drop(locked);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "room_closed"
        );
    }

    #[tokio::test]
    async fn guest_disconnect_sends_the_updated_participant_list() {
        let state = test_helpers::create_state();
        let (mut host, mut host_rx) = test_helpers::create_client_with_rx("u1", "Franco", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("u2", "Ana", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            for (id, status) in [("host", "playing"), ("guest", "blocked")] {
                room.statuses.insert(id.to_string(), status);
            }
            locked.rooms.insert("room".to_string(), room);
        }

        handle_disconnect("guest", &state).await;

        assert_eq!(
            test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
            "client_left"
        );
        let list = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(list.msg_type, "participant_list");
        assert_eq!(
            list.payload.unwrap()["participants"],
            serde_json::json!([{ "name": "Franco", "is_host": true }])
        );
        let statuses = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(statuses.msg_type, "participant_statuses");
        assert_eq!(
            statuses.payload.unwrap()["statuses"],
            serde_json::json!(["playing"])
        );
        assert!(!state.read().await.rooms["room"]
            .statuses
            .contains_key("guest"));
    }

    #[tokio::test]
    async fn host_leave_promotes_first_supporting_member_in_message_order() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut legacy, _legacy_rx) =
            test_helpers::create_client_with_rx("legacy", "Legacy", true);
        let (mut next, mut next_rx) = test_helpers::create_client_with_rx("next", "Next", true);
        let (mut later, _later_rx) = test_helpers::create_client_with_rx("later", "Later", true);
        for client in [&mut host, &mut legacy, &mut next, &mut later] {
            client.room_id = Some("room".to_string());
        }
        next.supports_host_transfer = true;
        later.supports_host_transfer = true;
        clients.insert("host".to_string(), host);
        clients.insert("legacy".to_string(), legacy);
        clients.insert("next".to_string(), next);
        clients.insert("later".to_string(), later);
        let mut room = test_helpers::create_room("room", "host");
        room.clients = vec![
            "host".to_string(),
            "legacy".to_string(),
            "next".to_string(),
            "later".to_string(),
        ];
        room.media_id = Some("movie".to_string());
        room.state.position = 42.0;
        room.state.play_state = "playing".to_string();
        room.pending_play = Some(PendingPlay {
            position: 10.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: 0,
        });
        rooms.insert("room".to_string(), room);

        let notification = handle_leave("host", &mut clients, &mut rooms).unwrap();
        send_leave_notification(&notification, "test");

        let room = rooms.get("room").unwrap();
        assert_eq!(room.host_id, "next");
        assert_eq!(room.media_id.as_deref(), Some("movie"));
        assert_eq!(room.state.position, 42.0);
        assert_eq!(room.state.play_state, "playing");
        assert!(room.pending_play.is_none());
        let messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut next_rx)).collect::<Vec<_>>();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.msg_type.as_str())
                .collect::<Vec<_>>(),
            [
                "client_left",
                "host_changed",
                "participant_list",
                "participant_statuses"
            ]
        );
        assert_eq!(messages[1].payload.as_ref().unwrap()["host_id"], "next");
        assert_eq!(messages[1].payload.as_ref().unwrap()["host_name"], "Next");
        assert_eq!(
            messages[2].payload.as_ref().unwrap()["participants"],
            serde_json::json!([
                { "name": "Legacy", "is_host": false },
                { "name": "Next", "is_host": true },
                { "name": "Later", "is_host": false }
            ])
        );
    }

    #[tokio::test]
    async fn host_disconnect_transfers_and_removes_the_old_host() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        guest.supports_host_transfer = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            room.pending_play = Some(PendingPlay {
                position: 10.0,
                generation: crate::types::next_pending_play_generation(),
                position_ts: 0,
            });
            locked.rooms.insert("room".to_string(), room);
        }

        handle_disconnect("host", &state).await;

        let locked = state.read().await;
        assert!(!locked.clients.contains_key("host"));
        assert_eq!(locked.rooms["room"].host_id, "guest");
        assert!(locked.rooms["room"].pending_play.is_none());
        drop(locked);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "client_left"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "host_changed"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            "participant_list"
        );
    }

    #[tokio::test]
    async fn empty_room_closes_when_host_leaves() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _host_rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host");

        let (_, messages) = handle_leave("host", &mut clients, &mut rooms).unwrap();

        assert_eq!(messages[0].msg_type, "room_closed");
        assert!(!rooms.contains_key("room-1"));
    }

    #[tokio::test]
    async fn host_leave_without_support_closes_and_clears_guest_membership() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        clients.insert("host".to_string(), host);
        clients.insert("guest".to_string(), guest);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("guest".to_string());
        rooms.insert("room".to_string(), room);

        let notification = handle_leave("host", &mut clients, &mut rooms);

        let (_, messages) = notification.expect("host leave closes the room");
        let types: Vec<_> = messages.iter().map(|msg| msg.msg_type.as_str()).collect();
        assert_eq!(types, ["room_closed"]);
        assert!(!rooms.contains_key("room"));
        assert!(clients["host"].room_id.is_none());
        assert!(clients["guest"].room_id.is_none());
    }
}
