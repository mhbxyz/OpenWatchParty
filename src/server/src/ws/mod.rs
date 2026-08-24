mod connection;
mod constants;
mod dispatch;
mod handlers;
mod pending_play;
mod validation;

pub use connection::client_connection;

#[cfg(test)]
mod concurrency_tests {
    use super::handlers::{
        handle_create_room, handle_join_room, handle_leave_room, handle_playback, handle_ready,
    };
    use super::pending_play::schedule_pending_play;
    use crate::messaging::broadcast_room_list;
    use crate::room::{close_room, handle_disconnect};
    use crate::test_helpers;
    use crate::types::{ClientMessageType, IncomingMessage, PendingPlay};
    use crate::utils::now_ms;
    use std::time::Duration;

    fn create_room_message() -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::CreateRoom,
            room: None,
            client: Some("host".to_string()),
            payload: Some(serde_json::json!({ "user_name": "Host" })),
            ts: now_ms(),
            server_ts: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_state_transitions_and_notifications_do_not_deadlock() {
        let state = test_helpers::create_state();
        let mut receivers = Vec::new();
        {
            let mut locked = state.write().await;
            for id in [
                "host",
                "leaver-host",
                "leaver",
                "disconnect",
                "pending-host",
            ] {
                let (mut client, rx) = test_helpers::create_client_with_rx(id, id, true);
                if id == "leaver-host" || id == "leaver" {
                    client.room_id = Some("leaver-room".to_string());
                }
                if id == "pending-host" {
                    client.room_id = Some("pending-room".to_string());
                }
                locked.clients.insert(id.to_string(), client);
                receivers.push(rx);
            }

            let mut leaver_room = test_helpers::create_room("leaver-room", "leaver-host");
            leaver_room.clients.push("leaver".to_string());
            locked.rooms.insert("leaver-room".to_string(), leaver_room);

            let created_at = now_ms();
            let mut pending_room = test_helpers::create_room("pending-room", "pending-host");
            pending_room.ready_clients.clear();
            pending_room.pending_play = Some(PendingPlay {
                position: 12.0,
                created_at,
                position_ts: created_at,
            });
            locked
                .rooms
                .insert("pending-room".to_string(), pending_room);
        }

        let created_at = {
            let locked = state.read().await;
            locked.rooms["pending-room"]
                .pending_play
                .as_ref()
                .unwrap()
                .created_at
        };
        let pending = schedule_pending_play("pending-room".to_string(), created_at, state.clone());

        let create_state = state.clone();
        let create = tokio::spawn(async move {
            for _ in 0..40 {
                handle_create_room("host", &create_room_message(), &create_state).await;
                tokio::task::yield_now().await;
            }
        });

        let close_state = state.clone();
        let close = tokio::spawn(async move {
            for _ in 0..40 {
                let room_id = {
                    let locked = close_state.read().await;
                    locked
                        .rooms
                        .values()
                        .find(|room| room.host_id == "host")
                        .map(|room| room.room_id.clone())
                };
                if let Some(room_id) = room_id {
                    close_room(&room_id, &close_state).await;
                }
                tokio::task::yield_now().await;
            }
        });

        let leave_state = state.clone();
        let leave = tokio::spawn(async move {
            for _ in 0..40 {
                handle_leave_room("leaver", &leave_state).await;
                tokio::task::yield_now().await;
            }
        });

        let disconnect_state = state.clone();
        let disconnect = tokio::spawn(async move {
            for _ in 0..40 {
                handle_disconnect("disconnect", &disconnect_state).await;
                tokio::task::yield_now().await;
            }
        });

        let broadcast_state = state.clone();
        let broadcast = tokio::spawn(async move {
            for _ in 0..80 {
                broadcast_room_list(&broadcast_state).await;
                tokio::task::yield_now().await;
            }
        });

        tokio::time::timeout(Duration::from_secs(5), async {
            create.await.unwrap();
            close.await.unwrap();
            leave.await.unwrap();
            disconnect.await.unwrap();
            broadcast.await.unwrap();
            pending.await.unwrap();
        })
        .await
        .expect("concurrent state operations deadlocked");

        let locked = state.read().await;
        assert!(!locked.clients.contains_key("disconnect"));
        assert!(locked.rooms["pending-room"].pending_play.is_none());
        drop(receivers);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pending_play_is_never_enqueued_after_a_concurrent_pause() {
        for _ in 0..100 {
            let state = test_helpers::create_state();
            let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
            let (mut guest, mut guest_rx) =
                test_helpers::create_client_with_rx("guest", "Guest", true);
            host.room_id = Some("room".to_string());
            guest.room_id = Some("room".to_string());
            {
                let mut locked = state.write().await;
                locked.clients.insert("host".to_string(), host);
                locked.clients.insert("guest".to_string(), guest);
                let mut room = test_helpers::create_room("room", "host");
                room.clients = vec!["host".to_string(), "guest".to_string()];
                room.ready_clients.clear();
                room.ready_clients.insert("host".to_string());
                room.pending_play = Some(PendingPlay {
                    position: 12.0,
                    created_at: now_ms(),
                    position_ts: now_ms(),
                });
                locked.rooms.insert("room".to_string(), room);
            }

            let ready = IncomingMessage {
                msg_type: ClientMessageType::Ready,
                room: Some("room".to_string()),
                client: Some("guest".to_string()),
                payload: None,
                ts: now_ms(),
                server_ts: None,
            };
            let pause = IncomingMessage {
                msg_type: ClientMessageType::PlayerEvent,
                room: Some("room".to_string()),
                client: Some("host".to_string()),
                payload: Some(serde_json::json!({ "action": "pause", "position": 12.0 })),
                ts: now_ms(),
                server_ts: None,
            };

            let ready_state = state.clone();
            let ready_task = tokio::spawn(async move {
                handle_ready("guest", &ready, &ready_state).await;
            });
            let pause_state = state.clone();
            let pause_task = tokio::spawn(async move {
                handle_playback("host", pause, &pause_state).await;
            });
            ready_task.await.unwrap();
            pause_task.await.unwrap();

            let mut pause_seen = false;
            while let Some(msg) = test_helpers::recv_msg(&mut guest_rx) {
                let action = msg
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("action"))
                    .and_then(|action| action.as_str());
                if action == Some("pause") {
                    pause_seen = true;
                }
                assert!(
                    !(pause_seen && action == Some("play")),
                    "a stale play was enqueued after pause"
                );
            }
            assert!(pause_seen);
        }
    }

    #[tokio::test]
    async fn join_state_is_enqueued_before_subsequent_room_closed() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            locked.rooms.insert(
                "room".to_string(),
                test_helpers::create_room("room", "host"),
            );
        }

        let join = IncomingMessage {
            msg_type: ClientMessageType::JoinRoom,
            room: Some("room".to_string()),
            client: Some("guest".to_string()),
            payload: None,
            ts: now_ms(),
            server_ts: None,
        };
        handle_join_room("guest", &join, &state).await;
        close_room("room", &state).await;

        let messages: Vec<_> =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut guest_rx)).collect();
        let room_state_index = messages
            .iter()
            .position(|msg| msg.msg_type == "room_state")
            .expect("join must enqueue room_state");
        let room_closed_index = messages
            .iter()
            .position(|msg| msg.msg_type == "room_closed")
            .expect("close must enqueue room_closed");
        assert!(room_state_index < room_closed_index);
    }

    #[tokio::test]
    async fn timed_pending_play_does_not_survive_a_pause() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        let created_at = now_ms();
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients = vec!["host".to_string(), "guest".to_string()];
            room.pending_play = Some(PendingPlay {
                position: 12.0,
                created_at,
                position_ts: created_at,
            });
            locked.rooms.insert("room".to_string(), room);
        }

        let timer = schedule_pending_play("room".to_string(), created_at, state.clone());
        let pause = IncomingMessage {
            msg_type: ClientMessageType::PlayerEvent,
            room: Some("room".to_string()),
            client: Some("host".to_string()),
            payload: Some(serde_json::json!({ "action": "pause", "position": 12.0 })),
            ts: now_ms(),
            server_ts: None,
        };
        handle_playback("host", pause, &state).await;
        timer.await.unwrap();

        let messages: Vec<_> =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut guest_rx)).collect();
        assert!(messages.iter().any(|msg| {
            msg.payload
                .as_ref()
                .and_then(|payload| payload.get("action"))
                .and_then(|action| action.as_str())
                == Some("pause")
        }));
        assert!(!messages.iter().any(|msg| {
            msg.payload
                .as_ref()
                .and_then(|payload| payload.get("action"))
                .and_then(|action| action.as_str())
                == Some("play")
        }));
    }
}
