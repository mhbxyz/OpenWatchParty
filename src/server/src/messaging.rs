use crate::types::{Client, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use std::collections::HashMap;
use tokio::sync::{mpsc, watch};

pub type OutboundMessage = Result<warp::ws::Message, warp::Error>;

#[derive(Clone, Debug)]
pub struct ClientSender {
    outbound: mpsc::Sender<OutboundMessage>,
    disconnect: watch::Sender<bool>,
}

impl ClientSender {
    pub fn channel(
        capacity: usize,
    ) -> (Self, mpsc::Receiver<OutboundMessage>, watch::Receiver<bool>) {
        let (outbound, receiver) = mpsc::channel(capacity);
        let (disconnect, disconnect_receiver) = watch::channel(false);
        (
            Self {
                outbound,
                disconnect,
            },
            receiver,
            disconnect_receiver,
        )
    }

    pub fn try_send(
        &self,
        message: OutboundMessage,
    ) -> Result<(), mpsc::error::TrySendError<OutboundMessage>> {
        self.outbound.try_send(message).inspect_err(|_| {
            self.request_disconnect();
        })
    }

    pub async fn send(
        &self,
        message: OutboundMessage,
    ) -> Result<(), mpsc::error::SendError<OutboundMessage>> {
        self.outbound.send(message).await
    }

    pub(crate) fn request_disconnect(&self) {
        self.disconnect.send_replace(true);
    }
}

fn build_room_list_msg(rooms: &HashMap<String, Room>) -> WsMessage {
    let list: Vec<serde_json::Value> = rooms
        .values()
        .map(|r| {
            serde_json::json!({ "id": r.room_id, "name": r.name, "count": r.clients.len(), "media_id": r.media_id })
        })
        .collect();
    WsMessage {
        msg_type: "room_list".to_string(),
        room: None,
        client: None,
        payload: Some(serde_json::json!(list)),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

pub async fn send_room_list(client_id: &str, state: &SharedState) {
    let state = state.read().await;
    let sender = state.clients.get(client_id).map(|c| c.sender.clone());
    let msg = build_room_list_msg(&state.rooms);
    send_message(sender, &msg, Some(client_id));
}

pub async fn broadcast_room_list(state: &SharedState) {
    let state = state.read().await;
    let senders = state
        .clients
        .values()
        .map(|c| c.sender.clone())
        .collect::<Vec<_>>();
    let msg = build_room_list_msg(&state.rooms);
    send_to_senders(&senders, &msg, "room list");
}

pub async fn send_to_client(client_id: &str, state: &SharedState, msg: &WsMessage) {
    let state = state.read().await;
    let sender = state.clients.get(client_id).map(|c| c.sender.clone());
    send_message(sender, msg, Some(client_id));
}

pub fn send_message(sender: Option<ClientSender>, msg: &WsMessage, client_id: Option<&str>) {
    let Some(sender) = sender else { return };
    match serde_json::to_string(msg) {
        Ok(json) => {
            if let Err(e) = sender.try_send(Ok(warp::ws::Message::text(json))) {
                log::warn!(
                    "Failed to send to client {} (buffer full or closed): {}",
                    client_id.unwrap_or("unknown"),
                    e
                );
            }
        }
        Err(e) => {
            log::error!(
                "Failed to serialize message for client {}: {}",
                client_id.unwrap_or("unknown"),
                e
            );
        }
    }
}

pub fn collect_room_senders(
    room: &Room,
    clients: &HashMap<String, Client>,
    exclude: Option<&str>,
) -> Vec<ClientSender> {
    room.clients
        .iter()
        .filter(|client_id| Some(client_id.as_str()) != exclude)
        .filter_map(|client_id| clients.get(client_id).map(|client| client.sender.clone()))
        .collect()
}

pub fn send_to_senders(senders: &[ClientSender], msg: &WsMessage, context: &str) {
    let Ok(json) = serde_json::to_string(msg) else {
        log::error!("Failed to serialize {} message", context);
        return;
    };
    send_serialized(senders, json, context);
}

pub fn send_serialized(senders: &[ClientSender], json: String, context: &str) {
    let warp_msg = warp::ws::Message::text(json);
    for sender in senders {
        if let Err(e) = sender.try_send(Ok(warp_msg.clone())) {
            log::warn!("Failed to send {} (buffer full or closed): {}", context, e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::PlaybackState;
    use std::collections::HashSet;

    fn message(msg_type: &str) -> WsMessage {
        WsMessage {
            msg_type: msg_type.to_string(),
            room: None,
            client: None,
            payload: None,
            ts: 0,
            server_ts: None,
        }
    }

    #[test]
    fn build_room_list_msg_empty() {
        let rooms = HashMap::new();
        let msg = build_room_list_msg(&rooms);
        assert_eq!(msg.msg_type, "room_list");
        let payload = msg.payload.unwrap();
        let list = payload.as_array().unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn build_room_list_msg_multiple() {
        let mut rooms = HashMap::new();
        rooms.insert(
            "r1".to_string(),
            Room {
                room_id: "r1".to_string(),
                name: "Room 1".to_string(),
                host_id: "host1".to_string(),
                media_id: None,
                clients: vec!["a".to_string(), "b".to_string()],
                ready_clients: HashSet::new(),
                pending_play: None,
                state: PlaybackState {
                    position: 0.0,
                    play_state: "paused".to_string(),
                },
                last_state_ts: 0,
                last_command_ts: 0,
            },
        );
        rooms.insert(
            "r2".to_string(),
            Room {
                room_id: "r2".to_string(),
                name: "Room 2".to_string(),
                host_id: "host2".to_string(),
                media_id: Some("abc".to_string()),
                clients: vec!["c".to_string()],
                ready_clients: HashSet::new(),
                pending_play: None,
                state: PlaybackState {
                    position: 10.0,
                    play_state: "playing".to_string(),
                },
                last_state_ts: 0,
                last_command_ts: 0,
            },
        );
        let msg = build_room_list_msg(&rooms);
        let list = msg.payload.unwrap();
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn send_to_client_success() {
        let (client, mut rx) = test_helpers::create_client_with_rx("user1", "User1", true);
        let mut clients = HashMap::new();
        clients.insert("c1".to_string(), client);
        let msg = WsMessage {
            msg_type: "test".to_string(),
            room: None,
            client: None,
            payload: None,
            ts: 0,
            server_ts: None,
        };
        let sender = clients.get("c1").map(|client| client.sender.clone());
        send_message(sender, &msg, Some("c1"));
        let received = test_helpers::recv_msg(&mut rx);
        assert!(received.is_some());
        assert_eq!(received.unwrap().msg_type, "test");
    }

    #[test]
    fn send_to_client_not_found() {
        let msg = WsMessage {
            msg_type: "test".to_string(),
            room: None,
            client: None,
            payload: None,
            ts: 0,
            server_ts: None,
        };
        // Should not panic
        send_message(None, &msg, Some("nonexistent"));
    }

    #[test]
    fn broadcast_to_room_excludes_sender() {
        let (client_a, mut _rx_a) = test_helpers::create_client_with_rx("ua", "A", true);
        let (client_b, mut rx_b) = test_helpers::create_client_with_rx("ub", "B", true);
        let (client_c, mut rx_c) = test_helpers::create_client_with_rx("uc", "C", true);
        let mut clients = HashMap::new();
        clients.insert("a".to_string(), client_a);
        clients.insert("b".to_string(), client_b);
        clients.insert("c".to_string(), client_c);
        let mut room = test_helpers::create_room("room-1", "a");
        room.clients = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let msg = WsMessage {
            msg_type: "event".to_string(),
            room: None,
            client: None,
            payload: None,
            ts: 0,
            server_ts: None,
        };
        let senders = collect_room_senders(&room, &clients, Some("a"));
        send_to_senders(&senders, &msg, "event");
        // a should NOT receive (excluded)
        assert!(_rx_a.try_recv().is_err());
        // b and c should receive
        assert!(test_helpers::recv_msg(&mut rx_b).is_some());
        assert!(test_helpers::recv_msg(&mut rx_c).is_some());
    }

    #[test]
    fn broadcast_to_room_no_exclude() {
        let (client_a, mut rx_a) = test_helpers::create_client_with_rx("ua", "A", true);
        let (client_b, mut rx_b) = test_helpers::create_client_with_rx("ub", "B", true);
        let mut clients = HashMap::new();
        clients.insert("a".to_string(), client_a);
        clients.insert("b".to_string(), client_b);
        let mut room = test_helpers::create_room("room-1", "a");
        room.clients = vec!["a".to_string(), "b".to_string()];
        let msg = WsMessage {
            msg_type: "event".to_string(),
            room: None,
            client: None,
            payload: None,
            ts: 0,
            server_ts: None,
        };
        let senders = collect_room_senders(&room, &clients, None);
        send_to_senders(&senders, &msg, "event");
        assert!(test_helpers::recv_msg(&mut rx_a).is_some());
        assert!(test_helpers::recv_msg(&mut rx_b).is_some());
    }

    #[tokio::test]
    async fn full_channel_signals_disconnect_and_keeps_other_clients_ordered() {
        let (slow, _slow_rx, mut disconnect) = ClientSender::channel(1);
        let (fast, mut fast_rx, _fast_disconnect) = ClientSender::channel(8);
        slow.try_send(Ok(warp::ws::Message::text("already queued")))
            .unwrap();

        for msg_type in ["room_closed", "player_event", "participants_update"] {
            send_to_senders(&[slow.clone(), fast.clone()], &message(msg_type), msg_type);
        }
        send_message(Some(slow), &message("room_state"), Some("slow"));
        send_message(Some(fast), &message("room_state"), Some("fast"));

        disconnect.changed().await.unwrap();
        assert!(*disconnect.borrow());
        let received: Vec<_> = std::iter::from_fn(|| test_helpers::recv_msg(&mut fast_rx))
            .map(|message| message.msg_type)
            .collect();
        assert_eq!(
            received,
            [
                "room_closed",
                "player_event",
                "participants_update",
                "room_state"
            ]
        );
    }

    #[tokio::test]
    async fn closed_channel_signals_disconnect() {
        let (sender, receiver, mut disconnect) = ClientSender::channel(1);
        drop(receiver);

        send_to_senders(
            &[sender],
            &message("participants_update"),
            "participants update",
        );

        disconnect.changed().await.unwrap();
        assert!(*disconnect.borrow());
    }
}
