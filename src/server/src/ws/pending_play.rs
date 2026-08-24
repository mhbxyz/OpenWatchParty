use super::constants::{MAX_READY_WAIT_MS, PLAY_SCHEDULE_MS};
use crate::messaging::{collect_room_senders, send_to_senders, ClientSender};
use crate::types::{Client, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::sleep;

pub(super) fn all_ready(room: &Room) -> bool {
    room.clients
        .iter()
        .all(|client_id| room.ready_clients.contains(client_id))
}

pub(super) fn prepare_scheduled_play(
    room: &mut Room,
    clients: &HashMap<String, Client>,
    position: f64,
    event_server_ts: u64,
    target_server_ts: u64,
) -> (Vec<ClientSender>, WsMessage) {
    room.state.position = position;
    room.state.play_state = "playing".to_string();
    room.last_state_ts = event_server_ts;
    room.last_command_ts = target_server_ts;
    let msg = WsMessage {
        msg_type: "player_event".to_string(),
        room: Some(room.room_id.clone()),
        client: Some(room.host_id.clone()),
        payload: Some(serde_json::json!({
            "action": "play",
            "position": position,
            "play_state": "playing",
            "target_server_ts": target_server_ts
        })),
        ts: now_ms(),
        server_ts: Some(event_server_ts),
    };
    let senders = collect_room_senders(room, clients, None);
    (senders, msg)
}

pub(super) fn schedule_pending_play(
    room_id: String,
    created_at: u64,
    state: SharedState,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        sleep(Duration::from_millis(MAX_READY_WAIT_MS)).await;
        {
            let mut state = state.write().await;
            let crate::types::ServerState { clients, rooms } = &mut *state;
            let Some(room) = rooms.get_mut(&room_id) else {
                return;
            };
            let pending = match room.pending_play.clone() {
                Some(pending) if pending.created_at == created_at => pending,
                _ => return,
            };
            room.pending_play = None;
            let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
            let (senders, msg) = prepare_scheduled_play(
                room,
                clients,
                pending.position,
                pending.position_ts,
                target_server_ts,
            );
            send_to_senders(&senders, &msg, "scheduled play");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use std::collections::HashSet;

    #[test]
    fn all_ready_true() {
        let mut room = test_helpers::create_room("r1", "host");
        room.clients = vec!["host".to_string(), "guest".to_string()];
        room.ready_clients = HashSet::from(["host".to_string(), "guest".to_string()]);
        assert!(all_ready(&room));
    }

    #[test]
    fn all_ready_false() {
        let mut room = test_helpers::create_room("r1", "host");
        room.clients = vec!["host".to_string(), "guest".to_string()];
        room.ready_clients = HashSet::from(["host".to_string()]);
        assert!(!all_ready(&room));
    }

    #[test]
    fn all_ready_empty_room() {
        let mut room = test_helpers::create_room("r1", "host");
        room.clients.clear();
        room.ready_clients.clear();
        assert!(all_ready(&room));
    }

    #[test]
    fn all_ready_ignores_unrelated_client_ids() {
        let mut room = test_helpers::create_room("r1", "host");
        room.clients = vec!["host".to_string(), "guest".to_string()];
        room.ready_clients = HashSet::from(["host".to_string(), "outsider".to_string()]);

        assert!(!all_ready(&room));
    }

    #[test]
    fn scheduled_play_marks_state_effective_at_target() {
        let mut room = test_helpers::create_room("r1", "host");
        let clients = HashMap::new();

        let (_, message) = prepare_scheduled_play(&mut room, &clients, 12.0, 4000, 5000);

        assert_eq!(room.last_state_ts, 4000);
        assert_eq!(room.last_command_ts, 5000);
        assert_eq!(message.server_ts, Some(4000));
        assert_eq!(message.payload.unwrap()["play_state"], "playing");
    }
}
