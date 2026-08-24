use super::super::constants::{
    COMMAND_COOLDOWN_MS, CONTROL_SCHEDULE_MS, MIN_STATE_UPDATE_INTERVAL_MS, PLAY_SCHEDULE_MS,
    POSITION_JITTER_THRESHOLD,
};
use super::super::pending_play::{all_ready, schedule_pending_play};
use super::super::validation::{is_valid_play_state, is_valid_position};
use crate::types::{ClientMessageType, IncomingMessage, PendingPlay, Room, SharedState};
use crate::utils::now_ms;
use tokio::sync::mpsc;

fn handle_play_not_ready(room: &mut Room, position: f64, current_ts: u64) -> Option<(String, u64)> {
    room.state.position = position;
    if let Some(pending) = room.pending_play.as_mut() {
        pending.position = position;
        pending.position_ts = current_ts;
        None
    } else {
        room.pending_play = Some(PendingPlay {
            position,
            created_at: current_ts,
            position_ts: current_ts,
        });
        room.last_state_ts = current_ts;
        Some((room.room_id.clone(), current_ts))
    }
}

fn absorb_during_pending(
    room: &mut Room,
    parsed: &IncomingMessage,
    action: Option<&str>,
    current_ts: u64,
) -> bool {
    if room.pending_play.is_none() {
        return false;
    }
    let is_player_event = parsed.msg_type == ClientMessageType::PlayerEvent;

    if is_player_event && action == Some("pause") {
        return false;
    }

    let position = parsed
        .payload
        .as_ref()
        .and_then(|p| p.get("position"))
        .and_then(|v| v.as_f64())
        .filter(|pos| is_valid_position(*pos))
        .unwrap_or(room.state.position);
    room.state.position = position;
    if let Some(pending) = room.pending_play.as_mut() {
        pending.position = position;
        pending.position_ts = current_ts;
    }
    room.last_state_ts = current_ts;
    true
}

fn should_process_state_update(room: &Room, payload: &serde_json::Value, current_ts: u64) -> bool {
    let new_pos = payload
        .get("position")
        .and_then(|v| v.as_f64())
        .unwrap_or(room.state.position);
    let new_play_state = payload
        .get("play_state")
        .and_then(|v| v.as_str())
        .unwrap_or(&room.state.play_state);

    if new_play_state != room.state.play_state {
        return true;
    }

    let pos_diff = new_pos - room.state.position;
    let in_command_cooldown = room.last_command_ts > 0
        && current_ts.saturating_sub(room.last_command_ts) < COMMAND_COOLDOWN_MS;
    let too_frequent = current_ts.saturating_sub(room.last_state_ts) < MIN_STATE_UPDATE_INTERVAL_MS;
    let small_backward_jitter = (-2.0..-POSITION_JITTER_THRESHOLD).contains(&pos_diff);
    let small_forward_jitter = (0.0..POSITION_JITTER_THRESHOLD).contains(&pos_diff);

    !(in_command_cooldown || too_frequent || small_backward_jitter || small_forward_jitter)
}

fn apply_state_changes(
    room: &mut Room,
    parsed: &mut IncomingMessage,
    action: Option<&str>,
    current_ts: u64,
) {
    if let Some(payload) = &parsed.payload {
        if let Some(pos) = payload.get("position").and_then(|v| v.as_f64()) {
            if is_valid_position(pos) {
                room.state.position = pos;
            }
        }
        if let Some(st) = payload.get("play_state").and_then(|v| v.as_str()) {
            if is_valid_play_state(st) {
                room.state.play_state = st.to_string();
            }
        }
        if parsed.msg_type == ClientMessageType::PlayerEvent {
            if let Some(action) = action {
                if action == "play" {
                    room.state.play_state = "playing".to_string();
                }
                if action == "pause" || action == "buffering" {
                    room.state.play_state = "paused".to_string();
                }
            }
        }
    }
    room.last_state_ts = current_ts;

    if parsed.msg_type == ClientMessageType::PlayerEvent {
        let schedule_delay = if action == Some("play") {
            PLAY_SCHEDULE_MS
        } else {
            CONTROL_SCHEDULE_MS
        };
        let target_server_ts = current_ts + schedule_delay;
        room.last_command_ts = target_server_ts;
        if let Some(payload) = parsed.payload.as_mut() {
            payload["target_server_ts"] = serde_json::json!(target_server_ts);
        }
        parsed.server_ts = Some(current_ts);
    } else {
        parsed.server_ts = Some(current_ts);
    }
}

pub(in crate::ws) async fn handle_playback(
    client_id: &str,
    mut parsed: IncomingMessage,
    state: &SharedState,
) {
    let Some(ref room_id) = parsed.room else {
        return;
    };

    let mut pending_schedule: Option<(String, u64)> = None;
    {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;

        let Some(room) = rooms.get_mut(room_id) else {
            return;
        };
        if room.host_id != client_id {
            return;
        }

        let current_ts = now_ms();
        let is_player_event = parsed.msg_type == ClientMessageType::PlayerEvent;
        let action: Option<String> = if is_player_event {
            parsed
                .payload
                .as_ref()
                .and_then(|p| p.get("action"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        } else {
            None
        };

        if is_player_event && action.as_deref() == Some("pause") {
            room.pending_play = None;
        }

        let broadcast_data =
            if is_player_event && action.as_deref() == Some("play") && !all_ready(room) {
                let position = parsed
                    .payload
                    .as_ref()
                    .and_then(|p| p.get("position"))
                    .and_then(|v| v.as_f64())
                    .filter(|pos| is_valid_position(*pos))
                    .unwrap_or(room.state.position);
                pending_schedule = handle_play_not_ready(room, position, current_ts);
                None
            } else if absorb_during_pending(room, &parsed, action.as_deref(), current_ts) {
                None
            } else {
                if parsed.msg_type == ClientMessageType::StateUpdate {
                    let should_process = parsed
                        .payload
                        .as_ref()
                        .map(|p| should_process_state_update(room, p, current_ts))
                        .unwrap_or(true);
                    if !should_process {
                        return;
                    }
                }

                apply_state_changes(room, &mut parsed, action.as_deref(), current_ts);

                let senders: Vec<mpsc::Sender<_>> = room
                    .clients
                    .iter()
                    .filter(|id| *id != client_id)
                    .filter_map(|id| clients.get(id).map(|c| c.sender.clone()))
                    .collect();
                Some(senders)
            };

        if let Some(senders) = broadcast_data {
            match serde_json::to_string(&parsed) {
                Ok(json) => {
                    let warp_msg = warp::ws::Message::text(json);
                    for sender in senders {
                        if let Err(e) = sender.try_send(Ok(warp_msg.clone())) {
                            log::warn!(
                                "Failed to send player event (buffer full or closed): {}",
                                e
                            );
                        }
                    }
                }
                Err(e) => log::error!("Failed to serialize message: {}", e),
            }
        }
    }
    if let Some((room_id, created_at)) = pending_schedule {
        std::mem::drop(schedule_pending_play(room_id, created_at, state.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    #[test]
    fn should_process_state_update_play_state_change() {
        let room = test_helpers::create_room("r1", "host");
        let payload = serde_json::json!({ "position": 0.0, "play_state": "playing" });
        assert!(should_process_state_update(&room, &payload, now_ms()));
    }

    #[test]
    fn should_process_state_update_during_cooldown() {
        let mut room = test_helpers::create_room("r1", "host");
        let now = now_ms();
        room.last_command_ts = now; // Just issued a command
        room.last_state_ts = now;
        let payload = serde_json::json!({ "position": 0.1, "play_state": "paused" });
        assert!(!should_process_state_update(&room, &payload, now + 100));
    }

    #[test]
    fn should_process_state_update_jitter() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_ts = 0;
        let payload = serde_json::json!({ "position": 10.2, "play_state": "paused" });
        // 0.2 < POSITION_JITTER_THRESHOLD (0.5), should be filtered
        assert!(!should_process_state_update(&room, &payload, now_ms()));
    }

    #[test]
    fn should_process_state_update_significant_move() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_ts = 0;
        let payload = serde_json::json!({ "position": 15.0, "play_state": "paused" });
        assert!(should_process_state_update(&room, &payload, now_ms()));
    }

    #[test]
    fn absorb_during_pending_state_update() {
        let mut room = test_helpers::create_room("r1", "host");
        let created_at = now_ms();
        room.pending_play = Some(PendingPlay {
            position: 5.0,
            created_at,
            position_ts: created_at,
        });
        let parsed = IncomingMessage {
            msg_type: ClientMessageType::StateUpdate,
            room: Some("r1".to_string()),
            client: None,
            payload: Some(serde_json::json!({ "position": 6.0 })),
            ts: 0,
            server_ts: None,
        };
        let update_ts = created_at + 10;
        assert!(absorb_during_pending(&mut room, &parsed, None, update_ts));
        assert_eq!(room.pending_play.as_ref().unwrap().position_ts, update_ts);
    }

    #[test]
    fn absorb_during_pending_pause_not_absorbed() {
        let mut room = test_helpers::create_room("r1", "host");
        room.pending_play = Some(PendingPlay {
            position: 5.0,
            created_at: now_ms(),
            position_ts: now_ms(),
        });
        let parsed = IncomingMessage {
            msg_type: ClientMessageType::PlayerEvent,
            room: Some("r1".to_string()),
            client: None,
            payload: Some(serde_json::json!({ "action": "pause" })),
            ts: 0,
            server_ts: None,
        };
        assert!(!absorb_during_pending(
            &mut room,
            &parsed,
            Some("pause"),
            now_ms()
        ));
    }

    #[test]
    fn absorb_no_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        let parsed = IncomingMessage {
            msg_type: ClientMessageType::StateUpdate,
            room: Some("r1".to_string()),
            client: None,
            payload: Some(serde_json::json!({ "position": 6.0 })),
            ts: 0,
            server_ts: None,
        };
        assert!(!absorb_during_pending(&mut room, &parsed, None, now_ms()));
    }

    #[test]
    fn handle_play_not_ready_creates_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        assert!(room.pending_play.is_none());
        let result = handle_play_not_ready(&mut room, 10.0, now_ms());
        assert!(result.is_some());
        assert!(room.pending_play.is_some());
        assert!((room.pending_play.as_ref().unwrap().position - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn handle_play_not_ready_existing_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        let created_at = now_ms();
        room.pending_play = Some(PendingPlay {
            position: 5.0,
            created_at,
            position_ts: created_at,
        });
        let update_ts = created_at + 10;
        let result = handle_play_not_ready(&mut room, 15.0, update_ts);
        assert!(result.is_none()); // Returns None when pending already exists
        assert!((room.pending_play.as_ref().unwrap().position - 15.0).abs() < f64::EPSILON);
        assert_eq!(room.pending_play.as_ref().unwrap().position_ts, update_ts);
    }

    #[test]
    fn apply_state_changes_updates_room() {
        let mut room = test_helpers::create_room("r1", "host");
        let mut parsed = IncomingMessage {
            msg_type: ClientMessageType::StateUpdate,
            room: Some("r1".to_string()),
            client: None,
            payload: Some(serde_json::json!({ "position": 42.0, "play_state": "playing" })),
            ts: 0,
            server_ts: None,
        };
        let now = now_ms();
        apply_state_changes(&mut room, &mut parsed, None, now);
        assert!((room.state.position - 42.0).abs() < f64::EPSILON);
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.last_state_ts, now);
    }

    #[test]
    fn apply_state_changes_player_event_play() {
        let mut room = test_helpers::create_room("r1", "host");
        let mut parsed = IncomingMessage {
            msg_type: ClientMessageType::PlayerEvent,
            room: Some("r1".to_string()),
            client: None,
            payload: Some(serde_json::json!({ "action": "play", "position": 10.0 })),
            ts: 0,
            server_ts: None,
        };
        let now = now_ms();
        apply_state_changes(&mut room, &mut parsed, Some("play"), now);
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.last_command_ts, now + PLAY_SCHEDULE_MS);
        // server_ts should be set to target_server_ts
        assert_eq!(parsed.server_ts, Some(now));
        assert_eq!(
            parsed.payload.as_ref().unwrap()["target_server_ts"],
            serde_json::json!(now + PLAY_SCHEDULE_MS)
        );
    }

    #[test]
    fn apply_state_changes_schedules_every_control_action() {
        for action in ["pause", "seek", "buffering"] {
            let mut room = test_helpers::create_room("r1", "host");
            let mut parsed = IncomingMessage {
                msg_type: ClientMessageType::PlayerEvent,
                room: Some("r1".to_string()),
                client: None,
                payload: Some(serde_json::json!({ "action": action, "position": 10.0 })),
                ts: 0,
                server_ts: None,
            };
            let now = now_ms();

            apply_state_changes(&mut room, &mut parsed, Some(action), now);

            assert_eq!(parsed.server_ts, Some(now));
            assert_eq!(
                parsed.payload.as_ref().unwrap()["target_server_ts"],
                serde_json::json!(now + CONTROL_SCHEDULE_MS)
            );
        }
    }
}
