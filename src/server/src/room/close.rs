use crate::messaging::ClientSender;
#[cfg(test)]
use crate::messaging::{broadcast_room_list, send_to_senders};
use crate::types::{Client, ServerState};
#[cfg(test)]
use crate::types::{SharedState, WsMessage};
#[cfg(test)]
use crate::utils::now_ms;
use log::info;
use std::collections::HashMap;

fn notify_room_closed(
    clients_list: &[String],
    locked_clients: &HashMap<String, Client>,
) -> Vec<ClientSender> {
    clients_list
        .iter()
        .filter_map(|cid| locked_clients.get(cid).map(|client| client.sender.clone()))
        .collect()
}

fn clear_room_from_clients(
    room_id: &str,
    client_ids: &[String],
    locked_clients: &mut HashMap<String, Client>,
) {
    for cid in client_ids {
        if let Some(client) = locked_clients.get_mut(cid) {
            if client.room_id.as_deref() == Some(room_id) {
                client.room_id = None;
            }
        }
    }
}

#[cfg(test)]
pub async fn close_room(room_id: &str, state: &SharedState) {
    {
        let mut state = state.write().await;
        let Some(senders) = close_room_in_state(room_id, &mut state) else {
            return;
        };
        send_to_senders(
            &senders,
            &WsMessage {
                msg_type: "room_closed".to_string(),
                room: Some(room_id.to_string()),
                client: None,
                payload: Some(serde_json::json!({ "reason": "Host started a new room" })),
                ts: now_ms(),
                server_ts: Some(now_ms()),
            },
            "room closed",
        );
    }

    broadcast_room_list(state).await;
}

pub(crate) fn close_room_in_state(
    room_id: &str,
    state: &mut ServerState,
) -> Option<Vec<ClientSender>> {
    let room = state.rooms.remove(room_id)?;
    info!("Closing room {} (host creating new room)", room_id);
    let clients_to_notify = room.clients;
    let senders = notify_room_closed(&clients_to_notify, &state.clients);
    clear_room_from_clients(room_id, &clients_to_notify, &mut state.clients);
    Some(senders)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn clear_room_from_clients_clears_room_id() {
        let mut clients = HashMap::new();
        let (mut c1, _rx1) = test_helpers::create_client_with_rx("u1", "A", true);
        let (mut c2, _rx2) = test_helpers::create_client_with_rx("u2", "B", true);
        c1.room_id = Some("room-1".to_string());
        c2.room_id = Some("room-1".to_string());
        clients.insert("c1".to_string(), c1);
        clients.insert("c2".to_string(), c2);

        let ids = vec!["c1".to_string(), "c2".to_string()];
        clear_room_from_clients("room-1", &ids, &mut clients);

        assert!(clients.get("c1").unwrap().room_id.is_none());
        assert!(clients.get("c2").unwrap().room_id.is_none());
    }

    #[test]
    fn clear_room_from_clients_ignores_other_rooms() {
        let mut clients = HashMap::new();
        let (mut c1, _rx1) = test_helpers::create_client_with_rx("u1", "A", true);
        c1.room_id = Some("room-2".to_string()); // In a DIFFERENT room
        clients.insert("c1".to_string(), c1);

        let ids = vec!["c1".to_string()];
        clear_room_from_clients("room-1", &ids, &mut clients);

        // Should NOT clear room_id since client is in room-2, not room-1
        assert_eq!(
            clients.get("c1").unwrap().room_id,
            Some("room-2".to_string())
        );
    }
}
