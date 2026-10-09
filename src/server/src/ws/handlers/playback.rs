use super::super::constants::{
    COMMAND_COOLDOWN_MS, CONTROL_SCHEDULE_MS, MAX_READY_WAIT_MS, MIN_STATE_UPDATE_INTERVAL_MS,
    PLAY_SCHEDULE_MS, POSITION_JITTER_THRESHOLD,
};
use super::super::dispatch::{send_error, ErrorCode};
use super::super::pending_play::{all_ready, schedule_pending_play};
use super::super::validation::is_valid_position;
use crate::messaging::{collect_room_senders, send_to_senders};
use crate::types::{ClientMessageType, IncomingMessage, PendingPlay, Room, SharedState, WsMessage};
use crate::utils::now_ms;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::Instant;

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

enum PlaybackOutcome {
    Accepted,
    Schedule(String, u64),
    Error(ErrorCode, &'static str),
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

    /// Play and pause are the room's: any member may send them. Seeking,
    /// buffering and the position updates stay with the host.
    fn is_open_to_guests(&self) -> bool {
        matches!(
            self.action(),
            Some(PlaybackAction::Play | PlaybackAction::Pause)
        )
    }

    /// Puts a guest's play or pause where the room is: only the host seeks,
    /// so a guest's own position is never used.
    fn set_room_position(&mut self, room_position: f64) {
        if let Self::PlayerEvent(payload) = self {
            payload.position = Some(room_position);
        }
    }
}

/// Where the room's video is now: its last known position, moved on by the
/// time since it took effect while the room plays.
fn room_position_now(room: &Room, current_ts: u64) -> f64 {
    if room.state.play_state != "playing" {
        return room.state.position;
    }
    let since = room
        .target_server_ts
        .map_or(room.state_server_ts, |target| {
            target.max(room.state_server_ts)
        });
    room.state.position + current_ts.saturating_sub(since) as f64 / 1000.0
}

fn handle_play_not_ready(
    room: &mut Room,
    position: f64,
    current_ts: u64,
    now: Instant,
) -> Option<(String, u64)> {
    room.state.position = position;
    if let Some(pending) = room.pending_play.as_mut() {
        pending.position = position;
        pending.position_ts = current_ts;
        None
    } else {
        room.pending_play = Some(PendingPlay {
            position,
            generation: crate::types::next_pending_play_generation(),
            position_ts: current_ts,
        });
        room.state_server_ts = current_ts;
        room.last_state_at = Some(now);
        Some((
            room.room_id.clone(),
            room.pending_play.as_ref().unwrap().generation,
        ))
    }
}

fn absorb_during_pending(
    room: &mut Room,
    message: &PlaybackMessage,
    current_ts: u64,
    now: Instant,
) -> bool {
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
    room.state_server_ts = current_ts;
    room.last_state_at = Some(now);
    true
}

fn should_process_state_update(room: &Room, payload: &StateUpdatePayload, now: Instant) -> bool {
    let new_pos = payload.position;
    let new_play_state = payload.play_state.as_str();

    if new_play_state != room.state.play_state {
        // A guest's play or pause holds against the host's updates sent
        // before the host applied it.
        return room
            .guest_command_until
            .is_none_or(|deadline| now >= deadline);
    }

    let pos_diff = new_pos - room.state.position;
    let in_command_cooldown = room
        .command_cooldown_until
        .is_some_and(|deadline| now < deadline);
    let too_frequent = room.last_state_at.is_some_and(|last_state_at| {
        crate::utils::elapsed_saturating(now, last_state_at)
            < Duration::from_millis(MIN_STATE_UPDATE_INTERVAL_MS)
    });
    let small_backward_jitter = (-2.0..-POSITION_JITTER_THRESHOLD).contains(&pos_diff);
    let small_forward_jitter = (0.0..POSITION_JITTER_THRESHOLD).contains(&pos_diff);

    !(in_command_cooldown || too_frequent || small_backward_jitter || small_forward_jitter)
}

fn apply_state_changes(
    room: &mut Room,
    message: &PlaybackMessage,
    client_id: &str,
    current_ts: u64,
    now: Instant,
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
            room.target_server_ts = Some(target_server_ts);
            room.target_at = now.checked_add(Duration::from_millis(schedule_delay));
            room.command_cooldown_until =
                now.checked_add(Duration::from_millis(schedule_delay + COMMAND_COOLDOWN_MS));
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
    room.state_server_ts = current_ts;
    room.last_state_at = Some(now);

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
    tasks: &crate::tasks::AppTasks,
) {
    let Some(room_id) = parsed.room.clone() else {
        send_error(
            client_id,
            state,
            ErrorCode::RoomIdRequired,
            "Room ID is required for playback",
        )
        .await;
        return;
    };
    let Some(mut message) = PlaybackMessage::parse(&parsed) else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidPlaybackPayload,
            "Invalid playback payload",
        )
        .await;
        return;
    };

    let outcome = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;

        if let Some(room) = rooms.get_mut(&room_id) {
            if !room.clients.iter().any(|id| id == client_id) {
                PlaybackOutcome::Error(
                    ErrorCode::NotRoomMember,
                    "Client is not a member of this room",
                )
            } else if room.host_id != client_id && !message.is_open_to_guests() {
                PlaybackOutcome::Error(
                    ErrorCode::HostPermissionRequired,
                    "Only the room host can control playback",
                )
            } else {
                let current_ts = now_ms();
                let now = Instant::now();
                let action = message.action();
                let from_guest = room.host_id != client_id;
                if from_guest {
                    message.set_room_position(room_position_now(room, current_ts));
                }

                if action == Some(PlaybackAction::Pause) {
                    room.pending_play = None;
                }
                // A host command ends a guest's hold; a guest's command
                // starts a new one below.
                if action.is_some() {
                    room.guest_command_until = None;
                }

                if action == Some(PlaybackAction::Play) && !all_ready(room) {
                    if from_guest {
                        // Until the pending play starts; then until the host
                        // has applied it (see prepare_scheduled_play).
                        room.guest_command_until = now.checked_add(Duration::from_millis(
                            MAX_READY_WAIT_MS + PLAY_SCHEDULE_MS + COMMAND_COOLDOWN_MS,
                        ));
                    }
                    let position = message.position().unwrap_or(room.state.position);
                    match handle_play_not_ready(room, position, current_ts, now) {
                        Some((room_id, generation)) => {
                            PlaybackOutcome::Schedule(room_id, generation)
                        }
                        None => PlaybackOutcome::Accepted,
                    }
                } else if absorb_during_pending(room, &message, current_ts, now) {
                    PlaybackOutcome::Accepted
                } else {
                    let filtered = match &message {
                        PlaybackMessage::StateUpdate(payload) => {
                            !should_process_state_update(room, payload, now)
                        }
                        PlaybackMessage::PlayerEvent(_) => false,
                    };
                    if filtered {
                        PlaybackOutcome::Accepted
                    } else {
                        let outgoing =
                            apply_state_changes(room, &message, client_id, current_ts, now);
                        if from_guest {
                            room.guest_command_until = room.command_cooldown_until;
                        }
                        let senders = collect_room_senders(room, clients, Some(client_id));
                        send_to_senders(&senders, &outgoing, "playback");
                        PlaybackOutcome::Accepted
                    }
                }
            }
        } else {
            PlaybackOutcome::Error(ErrorCode::RoomNotFound, "Room not found")
        }
    };
    match outcome {
        PlaybackOutcome::Accepted => {}
        PlaybackOutcome::Schedule(room_id, generation) => {
            std::mem::drop(schedule_pending_play(
                room_id,
                generation,
                state.clone(),
                tasks,
            ));
        }
        PlaybackOutcome::Error(code, message) => {
            send_error(client_id, state, code, message).await;
        }
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
        mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
    ) {
        let state = test_helpers::create_state();
        let (mut host, host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
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
        (state, host_rx, guest_rx)
    }

    fn assert_error_code(message: WsMessage, code: &str) {
        assert_eq!(message.msg_type, "error");
        assert_eq!(message.payload.unwrap()["code"], code);
    }

    #[test]
    fn should_process_state_update_play_state_change() {
        let room = test_helpers::create_room("r1", "host");
        let payload = StateUpdatePayload {
            position: 0.0,
            play_state: PlayState::Playing,
        };
        assert!(should_process_state_update(&room, &payload, Instant::now()));
    }

    #[test]
    fn should_process_state_update_during_cooldown() {
        let mut room = test_helpers::create_room("r1", "host");
        let now = Instant::now();
        room.command_cooldown_until = Some(now + Duration::from_millis(COMMAND_COOLDOWN_MS));
        room.last_state_at = Some(now);
        let payload = StateUpdatePayload {
            position: 0.1,
            play_state: PlayState::Paused,
        };
        assert!(!should_process_state_update(
            &room,
            &payload,
            now + Duration::from_millis(100)
        ));
    }

    #[test]
    fn cooldown_and_interval_ignore_wall_clock_rollback() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        let start = Instant::now();
        room.last_state_at = Some(start);
        room.command_cooldown_until = Some(start + Duration::from_millis(COMMAND_COOLDOWN_MS));
        let payload = StateUpdatePayload {
            position: 15.0,
            play_state: PlayState::Paused,
        };
        let wall_before = 10_000_u64;
        let wall_after = 9_000_u64;

        assert!(wall_after < wall_before);
        assert!(!should_process_state_update(
            &room,
            &payload,
            start + Duration::from_millis(MIN_STATE_UPDATE_INTERVAL_MS + 1)
        ));
        let after_cooldown = start + Duration::from_millis(COMMAND_COOLDOWN_MS + 1);
        assert!(should_process_state_update(&room, &payload, after_cooldown));

        let outgoing = apply_state_changes(
            &mut room,
            &state_update(15.0, PlayState::Paused),
            "host",
            wall_after,
            after_cooldown,
        );
        assert_eq!(outgoing.server_ts, Some(wall_after));
        assert_eq!(room.state_server_ts, wall_after);
    }

    #[test]
    fn should_process_state_update_jitter() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_at = None;
        let payload = StateUpdatePayload {
            position: 10.2,
            play_state: PlayState::Paused,
        };
        // 0.2 < POSITION_JITTER_THRESHOLD (0.5), should be filtered
        assert!(!should_process_state_update(
            &room,
            &payload,
            Instant::now()
        ));
    }

    #[test]
    fn should_process_state_update_significant_move() {
        let mut room = test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.last_state_at = None;
        let payload = StateUpdatePayload {
            position: 15.0,
            play_state: PlayState::Paused,
        };
        assert!(should_process_state_update(&room, &payload, Instant::now()));
    }

    #[test]
    fn absorb_during_pending_state_update() {
        let mut room = test_helpers::create_room("r1", "host");
        let created_at = now_ms();
        room.pending_play = Some(PendingPlay {
            position: 5.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: created_at,
        });
        let message = state_update(6.0, PlayState::Paused);
        let update_ts = created_at + 10;
        assert!(absorb_during_pending(
            &mut room,
            &message,
            update_ts,
            Instant::now()
        ));
        assert_eq!(room.pending_play.as_ref().unwrap().position_ts, update_ts);
    }

    #[test]
    fn absorb_during_pending_pause_not_absorbed() {
        let mut room = test_helpers::create_room("r1", "host");
        room.pending_play = Some(PendingPlay {
            position: 5.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: now_ms(),
        });
        let message = PlaybackMessage::PlayerEvent(PlayerEventPayload {
            action: PlaybackAction::Pause,
            position: None,
            play_state: None,
        });
        assert!(!absorb_during_pending(
            &mut room,
            &message,
            now_ms(),
            Instant::now()
        ));
    }

    #[test]
    fn absorb_no_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        let message = state_update(6.0, PlayState::Paused);
        assert!(!absorb_during_pending(
            &mut room,
            &message,
            now_ms(),
            Instant::now()
        ));
    }

    #[test]
    fn handle_play_not_ready_creates_pending() {
        let mut room = test_helpers::create_room("r1", "host");
        assert!(room.pending_play.is_none());
        let result = handle_play_not_ready(&mut room, 10.0, now_ms(), Instant::now());
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
            generation: crate::types::next_pending_play_generation(),
            position_ts: created_at,
        });
        let update_ts = created_at + 10;
        let result = handle_play_not_ready(&mut room, 15.0, update_ts, Instant::now());
        assert!(result.is_none()); // Returns None when pending already exists
        assert!((room.pending_play.as_ref().unwrap().position - 15.0).abs() < f64::EPSILON);
        assert_eq!(room.pending_play.as_ref().unwrap().position_ts, update_ts);
    }

    #[test]
    fn apply_state_changes_updates_room_and_builds_canonical_state_update() {
        let mut room = test_helpers::create_room("r1", "host");
        let message = state_update(42.0, PlayState::Playing);
        let now = now_ms();
        let outgoing = apply_state_changes(&mut room, &message, "host", now, Instant::now());
        assert!((room.state.position - 42.0).abs() < f64::EPSILON);
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.state_server_ts, now);
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
        let outgoing = apply_state_changes(&mut room, &message, "host", now, Instant::now());
        assert_eq!(room.state.play_state, "playing");
        assert_eq!(room.target_server_ts, Some(now + PLAY_SCHEDULE_MS));
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

            let outgoing = apply_state_changes(&mut room, &message, "host", now, Instant::now());

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

        let outgoing = apply_state_changes(&mut room, &message, "host", now_ms(), Instant::now());

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
        let (state, _host_rx, mut guest_rx) = setup_room().await;
        let parsed = incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({
                "action": "seek",
                "position": 12.0,
                "play_state": "paused"
            })),
        );

        handle_playback("host", parsed, &state, &crate::tasks::AppTasks::new()).await;

        let outgoing = test_helpers::recv_msg(&mut guest_rx).expect("canonical broadcast");
        assert_eq!(outgoing.client.as_deref(), Some("host"));
        assert_eq!(outgoing.room.as_deref(), Some("r1"));
        assert_ne!(outgoing.ts, 1);
        assert_ne!(outgoing.server_ts, Some(2));
    }

    #[tokio::test]
    async fn invalid_message_does_not_mutate_or_broadcast() {
        let (state, mut host_rx, mut guest_rx) = setup_room().await;
        let parsed = incoming(
            ClientMessageType::StateUpdate,
            Some(serde_json::json!({ "position": -1.0, "play_state": "playing" })),
        );

        handle_playback("host", parsed, &state, &crate::tasks::AppTasks::new()).await;

        let locked = state.read().await;
        assert_eq!(locked.rooms["r1"].state.position, 0.0);
        assert_eq!(locked.rooms["r1"].state.play_state, "paused");
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
        assert_error_code(
            test_helpers::recv_msg(&mut host_rx).unwrap(),
            "INVALID_PLAYBACK_PAYLOAD",
        );
    }

    #[tokio::test]
    async fn playback_requires_room_id() {
        let (state, mut host_rx, _guest_rx) = setup_room().await;
        let mut parsed = incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({ "action": "pause" })),
        );
        parsed.room = None;

        handle_playback("host", parsed, &state, &crate::tasks::AppTasks::new()).await;

        assert_error_code(
            test_helpers::recv_msg(&mut host_rx).unwrap(),
            "ROOM_ID_REQUIRED",
        );
    }

    #[tokio::test]
    async fn playback_rejects_non_member_and_non_host() {
        let (state, _host_rx, mut guest_rx) = setup_room().await;
        let valid = || {
            incoming(
                ClientMessageType::PlayerEvent,
                Some(serde_json::json!({ "action": "pause" })),
            )
        };
        let host_only = [
            incoming(
                ClientMessageType::PlayerEvent,
                Some(serde_json::json!({ "action": "seek", "position": 30.0 })),
            ),
            incoming(
                ClientMessageType::PlayerEvent,
                Some(serde_json::json!({ "action": "buffering", "position": 30.0 })),
            ),
            incoming(
                ClientMessageType::StateUpdate,
                Some(serde_json::json!({ "position": 30.0, "play_state": "playing" })),
            ),
        ];

        for parsed in host_only {
            handle_playback("guest", parsed, &state, &crate::tasks::AppTasks::new()).await;
            assert_error_code(
                test_helpers::recv_msg(&mut guest_rx).unwrap(),
                "HOST_PERMISSION_REQUIRED",
            );
        }
        assert_eq!(state.read().await.rooms["r1"].state.position, 0.0);

        let (mut outsider, mut outsider_rx) =
            test_helpers::create_client_with_rx("outsider", "Outsider", true);
        outsider.room_id = Some("r1".to_string());
        state
            .write()
            .await
            .clients
            .insert("outsider".to_string(), outsider);
        handle_playback("outsider", valid(), &state, &crate::tasks::AppTasks::new()).await;
        assert_error_code(
            test_helpers::recv_msg(&mut outsider_rx).unwrap(),
            "NOT_ROOM_MEMBER",
        );
    }

    #[tokio::test]
    async fn transferred_host_controls_playback_and_rejoined_old_host_cannot() {
        let (state, mut old_host_rx, mut new_host_rx) = setup_room().await;
        {
            let mut locked = state.write().await;
            locked
                .clients
                .get_mut("guest")
                .unwrap()
                .supports_host_transfer = true;
            let crate::types::ServerState { clients, rooms } = &mut *locked;
            let notification = crate::room::handle_leave("host", clients, rooms).unwrap();
            crate::room::send_leave_notification(&notification, "test transfer");
            clients.get_mut("host").unwrap().room_id = Some("r1".to_string());
            rooms
                .get_mut("r1")
                .unwrap()
                .clients
                .push("host".to_string());
        }
        while test_helpers::recv_msg(&mut new_host_rx).is_some() {}

        let pause = || {
            incoming(
                ClientMessageType::PlayerEvent,
                Some(serde_json::json!({ "action": "pause" })),
            )
        };
        handle_playback("guest", pause(), &state, &crate::tasks::AppTasks::new()).await;
        assert_eq!(
            test_helpers::recv_msg(&mut old_host_rx).unwrap().msg_type,
            "player_event"
        );

        // Back as a guest, the old host can still pause, but not seek.
        let seek = incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({ "action": "seek", "position": 30.0 })),
        );
        handle_playback("host", seek, &state, &crate::tasks::AppTasks::new()).await;
        assert_error_code(
            test_helpers::recv_msg(&mut old_host_rx).unwrap(),
            "HOST_PERMISSION_REQUIRED",
        );
    }

    async fn set_room_playing(state: &SharedState, position: f64) {
        let mut locked = state.write().await;
        let room = locked.rooms.get_mut("r1").unwrap();
        room.state.position = position;
        room.state.play_state = "playing".to_string();
        room.state_server_ts = now_ms();
        room.target_server_ts = None;
    }

    #[tokio::test]
    async fn a_guest_cannot_move_the_room_with_its_play_or_pause() {
        let (state, mut host_rx, _guest_rx) = setup_room().await;
        set_room_playing(&state, 40.0).await;

        handle_playback(
            "guest",
            player_event("pause", 3600.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let payload = test_helpers::recv_msg(&mut host_rx)
            .unwrap()
            .payload
            .unwrap();
        let position = payload["position"].as_f64().unwrap();
        assert!((40.0..41.0).contains(&position), "paused at {position}");
        assert_eq!(state.read().await.rooms["r1"].state.position, position);
    }

    #[tokio::test]
    async fn a_guest_play_or_pause_without_a_position_uses_the_room_one() {
        let (state, mut host_rx, _guest_rx) = setup_room().await;
        {
            let mut locked = state.write().await;
            let room = locked.rooms.get_mut("r1").unwrap();
            room.state.position = 25.0;
            room.state.play_state = "paused".to_string();
        }

        handle_playback(
            "guest",
            incoming(
                ClientMessageType::PlayerEvent,
                Some(serde_json::json!({ "action": "play" })),
            ),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let payload = test_helpers::recv_msg(&mut host_rx)
            .unwrap()
            .payload
            .unwrap();
        assert_eq!(payload["position"], 25.0);
    }

    #[test]
    fn the_room_position_moves_on_from_when_it_took_effect() {
        let mut room = crate::test_helpers::create_room("r1", "host");
        room.state.position = 10.0;
        room.state.play_state = "playing".to_string();
        room.state_server_ts = 1_000;
        room.target_server_ts = Some(1_500);
        assert_eq!(room_position_now(&room, 4_500), 13.0);
        room.target_server_ts = None;
        assert_eq!(room_position_now(&room, 4_500), 13.5);
        room.state.play_state = "paused".to_string();
        assert_eq!(room_position_now(&room, 4_500), 10.0);
    }

    fn player_event(action: &str, position: f64) -> IncomingMessage {
        incoming(
            ClientMessageType::PlayerEvent,
            Some(serde_json::json!({ "action": action, "position": position })),
        )
    }

    #[tokio::test]
    async fn a_guest_pause_pauses_the_room_and_reaches_the_host() {
        let (state, mut host_rx, mut guest_rx) = setup_room().await;
        set_room_playing(&state, 40.0).await;

        handle_playback(
            "guest",
            player_event("pause", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let outgoing = test_helpers::recv_msg(&mut host_rx).expect("pause for the host");
        assert_eq!(outgoing.msg_type, "player_event");
        assert_eq!(outgoing.client.as_deref(), Some("guest"));
        let payload = outgoing.payload.unwrap();
        assert_eq!(payload["action"], "pause");
        // Where the room is, not where the guest said (42): only the host seeks.
        let position = payload["position"].as_f64().unwrap();
        assert!((40.0..41.0).contains(&position), "paused at {position}");
        assert_eq!(payload["play_state"], "paused");
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
        let locked = state.read().await;
        assert_eq!(locked.rooms["r1"].state.play_state, "paused");
        assert_eq!(locked.rooms["r1"].state.position, position);
        assert!(locked.rooms["r1"].guest_command_until.is_some());
        assert_eq!(
            locked.rooms["r1"].guest_command_until,
            locked.rooms["r1"].command_cooldown_until
        );
    }

    #[tokio::test]
    async fn a_guest_play_resumes_the_room() {
        let (state, mut host_rx, _guest_rx) = setup_room().await;

        handle_playback(
            "guest",
            player_event("play", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let outgoing = test_helpers::recv_msg(&mut host_rx).expect("play for the host");
        assert_eq!(outgoing.client.as_deref(), Some("guest"));
        let payload = outgoing.payload.unwrap();
        assert_eq!(payload["action"], "play");
        assert_eq!(payload["play_state"], "playing");
        assert!(payload["target_server_ts"].as_u64().is_some());
        assert_eq!(state.read().await.rooms["r1"].state.play_state, "playing");
    }

    #[tokio::test]
    async fn the_host_updates_sent_before_a_guest_pause_do_not_undo_it() {
        let (state, _host_rx, mut guest_rx) = setup_room().await;
        set_room_playing(&state, 40.0).await;
        handle_playback(
            "guest",
            player_event("pause", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let stale = incoming(
            ClientMessageType::StateUpdate,
            Some(serde_json::json!({ "position": 42.4, "play_state": "playing" })),
        );
        handle_playback("host", stale, &state, &crate::tasks::AppTasks::new()).await;

        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
        assert_eq!(state.read().await.rooms["r1"].state.play_state, "paused");
    }

    #[test]
    fn a_guest_hold_only_lasts_until_its_deadline() {
        let mut room = test_helpers::create_room("r1", "host");
        let now = Instant::now();
        room.guest_command_until = Some(now + Duration::from_millis(100));
        let payload = StateUpdatePayload {
            position: 10.0,
            play_state: PlayState::Playing,
        };

        assert!(!should_process_state_update(&room, &payload, now));
        assert!(should_process_state_update(
            &room,
            &payload,
            now + Duration::from_millis(101)
        ));
    }

    #[tokio::test]
    async fn a_host_command_ends_the_guest_hold() {
        let (state, _host_rx, mut guest_rx) = setup_room().await;
        set_room_playing(&state, 40.0).await;
        handle_playback(
            "guest",
            player_event("pause", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        handle_playback(
            "host",
            player_event("play", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let outgoing = test_helpers::recv_msg(&mut guest_rx).expect("the host's play");
        assert_eq!(outgoing.payload.unwrap()["action"], "play");
        let locked = state.read().await;
        assert_eq!(locked.rooms["r1"].state.play_state, "playing");
        assert!(locked.rooms["r1"].guest_command_until.is_none());
    }

    #[tokio::test]
    async fn a_guest_play_waiting_for_ready_clients_holds_until_the_host_applies_it() {
        let (state, mut host_rx, _guest_rx) = setup_room().await;
        {
            let mut locked = state.write().await;
            let room = locked.rooms.get_mut("r1").unwrap();
            room.ready_clients.remove("guest");
        }
        let before = Instant::now();

        handle_playback(
            "guest",
            player_event("play", 42.0),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        let mut locked = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *locked;
        let room = rooms.get_mut("r1").unwrap();
        assert!(room.pending_play.is_some());
        let hold = room.guest_command_until.expect("hold while the play waits");
        assert!(hold >= before + Duration::from_millis(MAX_READY_WAIT_MS + PLAY_SCHEDULE_MS));

        let (_, message) = super::super::super::pending_play::prepare_scheduled_play(
            room, clients, 42.0, 4000, 5000,
        );
        assert_eq!(message.payload.unwrap()["action"], "play");
        assert!(room.guest_command_until.is_some());
        assert_eq!(room.guest_command_until, room.command_cooldown_until);
    }

    #[test]
    fn a_stale_guest_hold_is_not_renewed_by_a_host_pending_play() {
        let mut room = test_helpers::create_room("r1", "host");
        let clients = std::collections::HashMap::new();
        room.guest_command_until = Instant::now().checked_sub(Duration::from_millis(1));

        super::super::super::pending_play::prepare_scheduled_play(
            &mut room, &clients, 42.0, 4000, 5000,
        );

        assert!(room.guest_command_until < room.command_cooldown_until);
    }
}
