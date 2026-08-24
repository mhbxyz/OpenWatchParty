use super::super::constants::PLAY_SCHEDULE_MS;
use super::super::dispatch::{is_authenticated, send_error};
use super::super::pending_play::{all_ready, prepare_scheduled_play};
use crate::messaging::{broadcast_room_list, send_to_client, send_to_senders};
use crate::room::handle_leave;
use crate::types::{IncomingMessage, SharedState, WsMessage};
use crate::utils::now_ms;
use log::{info, warn};

pub(in crate::ws) async fn handle_ping(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    send_to_client(
        client_id,
        state,
        &WsMessage {
            msg_type: "pong".to_string(),
            room: parsed.room.clone(),
            client: parsed.client.clone(),
            payload: parsed.payload.clone(),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        },
    )
    .await;
}

pub(in crate::ws) fn handle_client_log(client_id: &str, parsed: &IncomingMessage) {
    if let Some(payload) = &parsed.payload {
        let category = payload
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("LOG");
        let message = payload
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let short_id = &client_id[..8];
        info!("[CLIENT:{}:{}] {}", short_id, category, message);
    }
}

pub(in crate::ws) async fn handle_unknown(client_id: &str, state: &SharedState) {
    warn!("Unknown message type from client {}", client_id);
    send_error(client_id, state, "Unknown message type").await;
}

pub(in crate::ws) async fn handle_ready(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if !is_authenticated(client_id, state).await {
        send_error(client_id, state, "Authentication required").await;
        return;
    }
    let Some(ref room_id) = parsed.room else {
        return;
    };

    let accepted = {
        let mut state = state.write().await;
        let belongs_to_room = state
            .clients
            .get(client_id)
            .and_then(|client| client.room_id.as_deref())
            == Some(room_id.as_str())
            && state
                .rooms
                .get(room_id)
                .is_some_and(|room| room.clients.iter().any(|id| id == client_id));
        if belongs_to_room {
            let crate::types::ServerState { clients, rooms } = &mut *state;
            let room = rooms
                .get_mut(room_id)
                .expect("membership check requires an existing room");
            room.ready_clients.insert(client_id.to_string());
            if room.pending_play.is_some() && all_ready(room) {
                let target_server_ts = now_ms() + PLAY_SCHEDULE_MS;
                let pending = room.pending_play.clone();
                let position = pending
                    .as_ref()
                    .map(|pending| pending.position)
                    .unwrap_or(room.state.position);
                let event_server_ts = pending
                    .as_ref()
                    .map(|pending| pending.position_ts)
                    .unwrap_or_else(now_ms);
                room.pending_play = None;
                let (senders, msg) = prepare_scheduled_play(
                    room,
                    clients,
                    position,
                    event_server_ts,
                    target_server_ts,
                );
                send_to_senders(&senders, &msg, "scheduled play");
            }
            true
        } else {
            false
        }
    };

    if !accepted {
        send_error(client_id, state, "Client is not a member of this room").await;
    }
}

pub(in crate::ws) async fn handle_leave_room(client_id: &str, state: &SharedState) {
    info!("Client {} leaving room", client_id);
    {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        if let Some((senders, msg)) = handle_leave(client_id, clients, rooms) {
            send_to_senders(&senders, &msg, "leave notification");
        }
    }
    broadcast_room_list(state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[tokio::test]
    async fn handle_ping_responds_pong() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u1", "User", true);
        state.write().await.clients.insert("c1".to_string(), client);

        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Ping,
            room: Some("room-1".to_string()),
            client: Some("c1".to_string()),
            payload: Some(serde_json::json!({ "seq": 42 })),
            ts: 12345,
            server_ts: None,
        };
        handle_ping("c1", &parsed, &state).await;

        let msg = test_helpers::recv_msg(&mut rx).unwrap();
        assert_eq!(msg.msg_type, "pong");
        assert_eq!(msg.room, Some("room-1".to_string()));
        let seq = msg.payload.unwrap().get("seq").unwrap().as_i64().unwrap();
        assert_eq!(seq, 42);
    }

    #[tokio::test]
    async fn handle_ready_adds_to_set() {
        let state = test_helpers::create_state();
        let (host, _rx_h) = test_helpers::create_client_with_rx("uh", "Host", true);
        let (mut guest, _rx_g) = test_helpers::create_client_with_rx("ug", "Guest", true);
        guest.room_id = Some("room-1".to_string());

        {
            let mut state = state.write().await;
            state.clients.insert("host".to_string(), host);
            state.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room-1", "host");
            room.clients.push("guest".to_string());
            room.ready_clients.clear();
            state.rooms.insert("room-1".to_string(), room);
        }

        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Ready,
            room: Some("room-1".to_string()),
            client: Some("guest".to_string()),
            payload: None,
            ts: 0,
            server_ts: None,
        };
        handle_ready("guest", &parsed, &state).await;

        let state = state.read().await;
        let room = state.rooms.get("room-1").unwrap();
        assert!(room.ready_clients.contains("guest"));
    }

    #[tokio::test]
    async fn handle_ready_all_ready_triggers_play() {
        let state = test_helpers::create_state();
        let (host, mut rx_h) = test_helpers::create_client_with_rx("uh", "Host", true);
        let (mut guest, mut rx_g) = test_helpers::create_client_with_rx("ug", "Guest", true);
        guest.room_id = Some("room-1".to_string());

        {
            let mut state = state.write().await;
            state.clients.insert("host".to_string(), host);
            state.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room-1", "host");
            room.clients = vec!["host".to_string(), "guest".to_string()];
            room.ready_clients.clear();
            room.ready_clients.insert("host".to_string());
            room.pending_play = Some(crate::types::PendingPlay {
                position: 10.0,
                generation: crate::types::next_pending_play_generation(),
                position_ts: crate::utils::now_ms(),
            });
            state.rooms.insert("room-1".to_string(), room);
        }

        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Ready,
            room: Some("room-1".to_string()),
            client: Some("guest".to_string()),
            payload: None,
            ts: 0,
            server_ts: None,
        };
        handle_ready("guest", &parsed, &state).await;

        // Both should receive a player_event (play broadcast)
        let msg_h = test_helpers::recv_msg(&mut rx_h).unwrap();
        assert_eq!(msg_h.msg_type, "player_event");
        let msg_g = test_helpers::recv_msg(&mut rx_g).unwrap();
        assert_eq!(msg_g.msg_type, "player_event");

        // pending_play should be cleared
        let state = state.read().await;
        assert!(state.rooms.get("room-1").unwrap().pending_play.is_none());
    }

    #[tokio::test]
    async fn handle_ready_rejects_unauthenticated_client() {
        let (state, mut rx) = ready_test_state(false, true).await;

        handle_ready("guest", &ready_message("room-1"), &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms["room-1"].ready_clients.contains("guest"));
        drop(locked);
        assert_eq!(test_helpers::recv_msg(&mut rx).unwrap().msg_type, "error");
    }

    #[tokio::test]
    async fn handle_ready_rejects_non_member() {
        let (state, mut rx) = ready_test_state(true, false).await;

        handle_ready("guest", &ready_message("room-1"), &state).await;

        let locked = state.read().await;
        assert!(!locked.rooms["room-1"].ready_clients.contains("guest"));
        drop(locked);
        assert_eq!(test_helpers::recv_msg(&mut rx).unwrap().msg_type, "error");
    }

    #[tokio::test]
    async fn unrelated_ready_ids_cannot_trigger_pending_play() {
        let (state, mut rx) = ready_test_state(true, true).await;
        {
            let mut locked = state.write().await;
            let room = locked.rooms.get_mut("room-1").unwrap();
            room.ready_clients.clear();
            room.ready_clients.insert("outsider-a".to_string());
            room.ready_clients.insert("outsider-b".to_string());
            room.pending_play = Some(crate::types::PendingPlay {
                position: 10.0,
                generation: crate::types::next_pending_play_generation(),
                position_ts: crate::utils::now_ms(),
            });
        }

        handle_ready("guest", &ready_message("room-1"), &state).await;

        let locked = state.read().await;
        assert!(locked.rooms["room-1"].pending_play.is_some());
        drop(locked);
        assert!(test_helpers::recv_msg(&mut rx).is_none());
    }

    async fn ready_test_state(
        authenticated: bool,
        include_guest: bool,
    ) -> (
        SharedState,
        tokio::sync::mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
    ) {
        let state = test_helpers::create_state();
        let (host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, guest_rx) =
            test_helpers::create_client_with_rx("guest", "Guest", authenticated);
        if include_guest {
            guest.room_id = Some("room-1".to_string());
        }
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room-1", "host");
            room.ready_clients.clear();
            if include_guest {
                room.clients.push("guest".to_string());
            }
            locked.rooms.insert("room-1".to_string(), room);
        }
        (state, guest_rx)
    }

    fn ready_message(room_id: &str) -> IncomingMessage {
        IncomingMessage {
            msg_type: crate::types::ClientMessageType::Ready,
            room: Some(room_id.to_string()),
            client: Some("forged-client".to_string()),
            payload: Some(serde_json::json!({ "client": "forged-client" })),
            ts: 0,
            server_ts: None,
        }
    }
}
