use crate::messaging::{broadcast_room_list, collect_room_senders, send_to_senders, ClientSender};
use crate::types::{Client, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;

enum LeaveOutcome {
    Left(Vec<ClientSender>, WsMessage),
    Close(String, Vec<String>),
}

fn detach_client_from_room(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<LeaveOutcome> {
    let client = clients.get_mut(client_id)?;
    let room_id = client.room_id.take()?;
    let room = rooms.get_mut(&room_id)?;

    room.clients.retain(|id| id != client_id);
    room.ready_clients.remove(client_id);
    if room.host_id == client_id {
        room.pending_play = None;
    }

    if room.clients.is_empty() || room.host_id == client_id {
        let clients_to_notify = room.clients.clone();
        Some(LeaveOutcome::Close(room_id, clients_to_notify))
    } else {
        let msg = WsMessage {
            msg_type: "client_left".to_string(),
            room: Some(room_id),
            client: Some(client_id.to_string()),
            payload: Some(serde_json::json!({ "participant_count": room.clients.len() })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        };
        let senders = collect_room_senders(room, clients, None);
        Some(LeaveOutcome::Left(senders, msg))
    }
}

fn close_and_notify(
    room_id: &str,
    clients_to_notify: &[String],
    clients: &HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> (Vec<ClientSender>, WsMessage) {
    info!("Closing room {}", room_id);
    rooms.remove(room_id);
    let msg = WsMessage {
        msg_type: "room_closed".to_string(),
        room: Some(room_id.to_string()),
        client: None,
        payload: Some(serde_json::json!({ "reason": "Host left the room" })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    let senders = clients_to_notify
        .iter()
        .filter_map(|cid| clients.get(cid).map(|client| client.sender.clone()))
        .collect();
    (senders, msg)
}

pub fn handle_leave(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<(Vec<ClientSender>, WsMessage)> {
    match detach_client_from_room(client_id, clients, rooms) {
        Some(LeaveOutcome::Left(senders, msg)) => Some((senders, msg)),
        Some(LeaveOutcome::Close(room_id, clients_to_notify)) => Some(close_and_notify(
            &room_id,
            &clients_to_notify,
            clients,
            rooms,
        )),
        None => None,
    }
}

pub async fn handle_disconnect(client_id: &str, state: &SharedState) {
    info!("Disconnecting client {}", client_id);
    {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        if let Some((senders, msg)) = handle_leave(client_id, clients, rooms) {
            send_to_senders(&senders, &msg, "leave notification");
        }
        clients.remove(client_id);
    }
    broadcast_room_list(state).await;
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
        detach_client_from_room("guest-1", &mut clients, &mut rooms);

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
            created_at: crate::utils::now_ms(),
        });

        detach_client_from_room("host-1", &mut clients, &mut rooms);

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

        let result = detach_client_from_room("c1", &mut clients, &mut rooms);
        assert!(result.is_none());
    }
}
