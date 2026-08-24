use super::super::constants::{
    COMMAND_COOLDOWN_MS, CONTROL_SCHEDULE_MS, MIN_STATE_UPDATE_INTERVAL_MS, PLAY_SCHEDULE_MS,
    POSITION_JITTER_THRESHOLD,
};
use super::super::pending_play::{all_ready, schedule_pending_play};
use super::super::validation::is_valid_position;
use crate::messaging::{collect_room_senders, send_to_senders};
use crate::types::{ClientMessageType, IncomingMessage, PendingPlay, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PlaybackAction {
    Play,
    Pause,
    Seek,
    Buffering,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PlayState {
    Playing,
    Paused,
}

impl PlayState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Playing => "playing",
            Self::Paused => "paused",
        }
    }

    fn from_room(room: &Room) -> Self {
        if room.state.play_state == "playing" {
            Self::Playing
        } else {
            Self::Paused
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PlayerEventPayload {
    action: PlaybackAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    play_state: Option<PlayState>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StateUpdatePayload {
    position: f64,
    play_state: PlayState,
}

#[derive(Debug, Clone)]
enum PlaybackMessage {
    PlayerEvent(PlayerEventPayload),
    StateUpdate(StateUpdatePayload),
}

impl PlaybackMessage {
    fn parse(parsed: &IncomingMessage) -> Option<Self> {
        let payload = parsed.payload.clone()?;
        let message = match parsed.msg_type {
            ClientMessageType::PlayerEvent => {
                Self::PlayerEvent(serde_json::from_value(payload).ok()?)
            }
            ClientMessageType::StateUpdate => {
                Self::StateUpdate(serde_json::from_value(payload).ok()?)
            }
            _ => return None,
        };
        message.is_valid().then_some(message)
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::PlayerEvent(payload) => {
                payload.position.is_none_or(is_valid_position)
                    && (payload.action != PlaybackAction::Seek || payload.position.is_some())
            }
            Self::StateUpdate(payload) => is_valid_position(payload.position),
        }
    }

    fn position(&self) -> Option<f64> {
        match self {
            Self::PlayerEvent(payload) => payload.position,
            Self::StateUpdate(payload) => Some(payload.position),
        }
    }

    fn action(&self) -> Option<PlaybackAction> {
        match self {
            Self::PlayerEvent(payload) => Some(payload.action),
            Self::StateUpdate(_) => None,
        }
    }
}

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

fn absorb_during_pending(room: &mut Room, message: &PlaybackMessage, current_ts: u64) -> bool {
    if room.pending_play.is_none() {
        return false;
    }
    if message.action() == Some(PlaybackAction::Pause) {
        return false;
    }

    let position = message.position().unwrap_or(room.state.position);
    room.state.position = position;
    if let Some(pending) = room.pending_play.as_mut() {
        pending.position = position;
        pending.position_ts = current_ts;
    }
    room.last_state_ts = current_ts;
    true
}

fn should_process_state_update(room: &Room, payload: &StateUpdatePayload, current_ts: u64) -> bool {
    let new_pos = payload.position;
    let new_play_state = payload.play_state.as_str();

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
    message: &PlaybackMessage,
    client_id: &str,
    current_ts: u64,
) -> WsMessage {
    if let Some(position) = message.position() {
        room.state.position = position;
    }

    let (msg_type, payload) = match message {
        PlaybackMessage::PlayerEvent(payload) => {
            let canonical_play_state = match payload.action {
                PlaybackAction::Play => PlayState::Playing,
                PlaybackAction::Pause | PlaybackAction::Buffering => PlayState::Paused,
                PlaybackAction::Seek => payload
                    .play_state
                    .unwrap_or_else(|| PlayState::from_room(room)),
            };
            room.state.play_state = canonical_play_state.as_str().to_string();
            let schedule_delay = if payload.action == PlaybackAction::Play {
                PLAY_SCHEDULE_MS
            } else {
                CONTROL_SCHEDULE_MS
            };
            let target_server_ts = current_ts + schedule_delay;
            room.last_command_ts = target_server_ts;
            let canonical_payload = PlayerEventPayload {
                action: payload.action,
                position: Some(room.state.position),
                play_state: Some(canonical_play_state),
            };
            let mut canonical =
                serde_json::to_value(canonical_payload).expect("typed payload serializes");
            canonical["target_server_ts"] = serde_json::json!(target_server_ts);
            ("player_event", canonical)
        }
        PlaybackMessage::StateUpdate(payload) => {
            room.state.play_state = payload.play_state.as_str().to_string();
            (
                "state_update",
                serde_json::to_value(payload).expect("typed payload serializes"),
            )
        }
    };
    room.last_state_ts = current_ts;

    WsMessage {
        msg_type: msg_type.to_string(),
        room: Some(room.room_id.clone()),
        client: Some(client_id.to_string()),
        payload: Some(payload),
        ts: current_ts,
        server_ts: Some(current_ts),
    }
}

pub(in crate::ws) async fn handle_playback(
    client_id: &str,
    parsed: IncomingMessage,
    state: &SharedState,
) {
    let Some(room_id) = parsed.room.clone() else {
        return;
    };
    let Some(message) = PlaybackMessage::parse(&parsed) else {
        return;
    };

    let mut pending_schedule: Option<(String, u64)> = None;
    {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;

        let Some(room) = rooms.get_mut(&room_id) else {
            return;
        };
        if room.host_id != client_id {
            return;
        }

        let current_ts = now_ms();
        let action = message.action();

        if action == Some(PlaybackAction::Pause) {
            room.pending_play = None;
        }

        let broadcast_data = if action == Some(PlaybackAction::Play) && !all_ready(room) {
            let position = message.position().unwrap_or(room.state.position);
            pending_schedule = handle_play_not_ready(room, position, current_ts);
            None
        } else if absorb_during_pending(room, &message, current_ts) {
            None
        } else {
            if let PlaybackMessage::StateUpdate(payload) = &message {
                if !should_process_state_update(room, payload, current_ts) {
                    return;
                }
            }

            let outgoing = apply_state_changes(room, &message, client_id, current_ts);
            let senders = collect_room_senders(room, clients, Some(client_id));
            Some((senders, outgoing))
        };

        if let Some((senders, outgoing)) = broadcast_data {
            send_to_senders(&senders, &outgoing, "playback");
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
    use tokio::sync::mpsc;

    fn state_update(position: f64, play_state: PlayState) -> PlaybackMessage {
        PlaybackMessage::StateUpdate(StateUpdatePayload {
            position,
            play_state,
        })
    }

    fn incoming(
        msg_type: ClientMessageType,
        payload: Option<serde_json::Value>,
    ) -> IncomingMessage {
        IncomingMessage {
            msg_type,
            room: Some("r1".to_string()),
            client: Some("forged-client".to_string()),
            payload,
            ts: 1,
            server_ts: Some(2),
        }
    }

    async fn setup_room() -> (
        SharedState,
        mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
    ) {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("r1".to_string());
        guest.room_id = Some("r1".to_string());
        let mut room = test_helpers::create_room("r1", "host");
        room.clients.push("guest".to_string());
        room.ready_clients.insert("guest".to_string());
        let mut locked = state.write().await;
        locked.clients.insert("host".to_string(), host);
        locked.clients.insert("guest".to_string(), guest);
        locked.rooms.insert("r1".to_string(), room);
        drop(locked);
        (state, guest_rx)
    }

    #[test]
    fn should_process_state_update_play_state_change() {
        let room = test_helpers::create_room("r1", "host");
        let payload = StateUpdatePayload {
            position: 0.0,
            play_state: PlayState::Playing,
        };
        assert!(should_process_state_update(&room, &payload, now_ms()));
    }

    #[test]
    fn should_process_state_update_during_cooldown() {
        let mut room = test_helpers::create_room("r1", "host");
        let now = now_ms();
        room.last_command_ts = now; // Just issued a command
        room.last_state_ts = now;
        let payload = StateUpdatePayload {
            position: 0.1,
            play_state: PlayState::Paused,
        };
        assert!(!should_process_state_update(&room, &payload, now + 100));
    }

    #[test]
    fn should_process_state_update_jitter() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_ts = 0;
        let payload = StateUpdatePayload {
            position: 10.2,
            play_state: PlayState::Paused,
        };
        // 0.2 < POSITION_JITTER_THRESHOLD (0.5), should be filtered
        assert!(!should_process_state_update(&room, &payload, now_ms()));
    }

    #[test]
    fn should_process_state_update_significant_move() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_ts = 0;
        let payload = StateUpdatePayload {
            position: 15.0,
            play_state: PlayState::Paused,
        };
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
        let message = state_update(6.0, PlayState::Paused);
        let update_ts = created_at + 10;
        assert!(absorb_during_pending(&mut room, &message, update_ts));
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
        let message = PlaybackMessage::PlayerEvent(PlayerEventPayload {
            action: PlaybackAction::Pause,
            position: None,
            play_state: None,
        });
        assert!(!absorb_during_pending(&mut room, &message, now_ms()));
    }

    #[test]
    fn absorb_no_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        let message = state_update(6.0, PlayState::Paused);
        assert!(!absorb_during_pending(&mut room, &message, now_ms()));
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
    fn apply_state_changes_updates_room_and_builds_canonical_state_update() {
        let mut room = test_helpers::create_room("r1", "host");
        let message = state_update(42.0, PlayState::Playing);
        let now = now_ms();
        let outgoing = apply_state_changes(&mut room, &message, "host", now);
        assert!((room.state.position - 42.0).abs() < f64::EPSILON);
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.last_state_ts, now);
        assert_eq!(outgoing.msg_type, "state_update");
        assert_eq!(outgoing.room.as_deref(), Some("r1"));
        assert_eq!(outgoing.client.as_deref(), Some("host"));
        assert_eq!(outgoing.ts, now);
        assert_eq!(outgoing.server_ts, Some(now));
        assert_eq!(
            outgoing.payload,
            Some(serde_json::json!({ "position": 42.0, "play_state": "playing" }))
        );
    }

    #[test]
    fn apply_state_changes_builds_canonical_player_event() {
        let mut room = test_helpers::create_room("r1", "host");
        let message = PlaybackMessage::PlayerEvent(PlayerEventPayload {
            action: PlaybackAction::Play,
            position: Some(10.0),
            play_state: Some(PlayState::Paused),
        });
        let now = now_ms();
        let outgoing = apply_state_changes(&mut room, &message, "host", now);
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.last_command_ts, now + PLAY_SCHEDULE_MS);
        assert_eq!(
            outgoing.payload,
            Some(serde_json::json!({
                "action": "play",
                "position": 10.0,
                "play_state": "playing",
                "target_server_ts": now + PLAY_SCHEDULE_MS
            }))
        );
        assert_eq!(outgoing.client.as_deref(), Some("host"));
        assert_eq!(outgoing.room.as_deref(), Some("r1"));
        assert_eq!(outgoing.ts, now);
        assert_eq!(outgoing.server_ts, Some(now));
    }

    #[test]
    fn apply_state_changes_schedules_every_control_action() {
        for action in [
            PlaybackAction::Pause,
            PlaybackAction::Seek,
            PlaybackAction::Buffering,
        ] {
            let mut room = test_helpers::create_room("r1", "host");
            let message = PlaybackMessage::PlayerEvent(PlayerEventPayload {
                action,
                position: Some(10.0),
                play_state: None,
            });
            let now = now_ms();

            let outgoing = apply_state_changes(&mut room, &message, "host", now);

            assert_eq!(
                outgoing.payload.as_ref().unwrap()["target_server_ts"],
                serde_json::json!(now + CONTROL_SCHEDULE_MS)
            );
        }
    }

    #[test]
    fn seek_without_play_state_uses_canonical_room_state() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.play_state = "playing".to_string();
        let message = PlaybackMessage::PlayerEvent(PlayerEventPayload {
            action: PlaybackAction::Seek,
            position: Some(10.0),
            play_state: None,
        });

        let outgoing = apply_state_changes(&mut room, &message, "host", now_ms());

        assert_eq!(outgoing.payload.unwrap()["play_state"], "playing");
        assert_eq!(room.state.play_state, "playing");
    }

    #[test]
    fn rejects_non_finite_negative_and_excessive_positions() {
        for position in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -0.1,
            super::super::super::constants::MAX_POSITION_SECONDS + 0.1,
        ] {
            assert!(!state_update(position, PlayState::Paused).is_valid());
            assert!(!PlaybackMessage::PlayerEvent(PlayerEventPayload {
                action: PlaybackAction::Seek,
                position: Some(position),
                play_state: None,
            })
            .is_valid());
        }
    }

    #[test]
    fn rejects_unknown_actions_states_missing_payload_and_extra_fields() {
        assert!(PlaybackMessage::parse(&incoming(ClientMessageType::PlayerEvent, None)).is_none());
        assert!(PlaybackMessage::parse(&incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({ "action": "stop", "position": 1.0 }))
        ))
        .is_none());
        assert!(PlaybackMessage::parse(&incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({ "action": "seek" }))
        ))
        .is_none());
        assert!(PlaybackMessage::parse(&incoming(
            ClientMessageType::StateUpdate,
            Some(serde_json::json!({ "position": 1.0, "play_state": "buffering" }))
        ))
        .is_none());
        assert!(PlaybackMessage::parse(&incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({
                "action": "seek",
                "position": 1.0,
                "target_server_ts": 999
            }))
        ))
        .is_none());
        assert!(PlaybackMessage::parse(&incoming(
            ClientMessageType::StateUpdate,
            Some(serde_json::json!({
                "position": 1.0,
                "play_state": "paused",
                "extra": true
            }))
        ))
        .is_none());
    }

    #[tokio::test]
    async fn forged_envelope_fields_are_replaced_in_broadcast() {
        let (state, mut guest_rx) = setup_room().await;
        let parsed = incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({
                "action": "seek",
                "position": 12.0,
                "play_state": "paused"
            })),
        );

        handle_playback("host", parsed, &state).await;

        let outgoing = test_helpers::recv_msg(&mut guest_rx).expect("canonical broadcast");
        assert_eq!(outgoing.client.as_deref(), Some("host"));
        assert_eq!(outgoing.room.as_deref(), Some("r1"));
        assert_ne!(outgoing.ts, 1);
        assert_ne!(outgoing.server_ts, Some(2));
    }

    #[tokio::test]
    async fn invalid_message_does_not_mutate_or_broadcast() {
        let (state, mut guest_rx) = setup_room().await;
        let parsed = incoming(
            ClientMessageType::StateUpdate,
            Some(serde_json::json!({ "position": -1.0, "play_state": "playing" })),
        );

        handle_playback("host", parsed, &state).await;

        let locked = state.read().await;
        assert_eq!(locked.rooms["r1"].state.position, 0.0);
        assert_eq!(locked.rooms["r1"].state.play_state, "paused");
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
    }
}
