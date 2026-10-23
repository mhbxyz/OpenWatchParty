//! A play the room holds until its members are ready (`ready`, and for
//! clients with `start_when_ready` their `readiness`), up to a deadline. Those
//! clients are told who the room waits for and why (`start_state`), and the
//! play that starts the room's item counts down.

use super::constants::{
    COMMAND_COOLDOWN_MS, COUNTDOWN_MS, MAX_READY_WAIT_MS, PLAY_SCHEDULE_MS, START_WAIT_MS,
};
use crate::messaging::{collect_room_senders, send_to_senders, ClientSender};
use crate::types::{
    Client, NotReadyReason, PlayState, Room, ServerMessageType, SharedState, WsMessage,
};
use crate::utils::now_ms;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::{sleep, Instant};

pub(crate) fn all_ready(room: &Room) -> bool {
    room.clients.iter().all(|client_id| {
        room.ready_clients.contains(client_id) && !room.not_ready.contains_key(client_id)
    })
}

/// Whether the pending play is the one a queue advance armed to start the new
/// item from 0. Until it starts, the host may still report its previous item.
pub(super) fn starting_queue_item(room: &Room) -> bool {
    room.pending_play
        .as_ref()
        .is_some_and(|pending| room.queue.advance_generation == Some(pending.generation))
}

/// A member the room waits for, and why.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct WaitingMember {
    pub client: String,
    pub name: String,
    pub reason: NotReadyReason,
}

/// The members that aren't ready, in the room's order. One that hasn't
/// reported the room media ready is `loading` unless its client said more.
pub(crate) fn waiting_for(room: &Room, clients: &HashMap<String, Client>) -> Vec<WaitingMember> {
    room.clients
        .iter()
        .filter_map(|id| {
            let reason = room.not_ready.get(id).copied().or_else(|| {
                (!room.ready_clients.contains(id)).then_some(NotReadyReason::Loading)
            })?;
            Some(WaitingMember {
                client: id.clone(),
                name: clients
                    .get(id)
                    .map(|client| client.user_name.clone())
                    .unwrap_or_default(),
                reason,
            })
        })
        .collect()
}

pub(crate) fn shows_start(clients: &HashMap<String, Client>, client_id: &str) -> bool {
    clients
        .get(client_id)
        .is_some_and(|client| client.supports_start_when_ready)
}

/// How long a play `initiator_id` asked for waits for the members: a client
/// with `start_when_ready` shows the wait, an older one doesn't.
pub(crate) fn wait_ms(clients: &HashMap<String, Client>, initiator_id: &str) -> u64 {
    if shows_start(clients, initiator_id) {
        START_WAIT_MS
    } else {
        MAX_READY_WAIT_MS
    }
}

/// The lead time of a play, and whether it counts down: it does when it starts
/// the room's item and the client that asked for it shows the countdown (an
/// older client has already started its video). Any play starts the item.
pub(crate) fn play_lead(room: &mut Room, initiator_shows_start: bool) -> (u64, bool) {
    let countdown = room.countdown_pending && initiator_shows_start;
    room.countdown_pending = false;
    if countdown {
        (COUNTDOWN_MS, true)
    } else {
        (PLAY_SCHEDULE_MS, false)
    }
}

/// Sends `start_state` to the members with `start_when_ready`.
pub(crate) fn send_start_state(
    room: &Room,
    clients: &HashMap<String, Client>,
    payload: serde_json::Value,
) {
    let senders: Vec<ClientSender> = room
        .clients
        .iter()
        .filter_map(|id| clients.get(id))
        .filter(|client| client.supports_start_when_ready)
        .map(|client| client.sender.clone())
        .collect();
    if senders.is_empty() {
        return;
    }
    let message = WsMessage {
        msg_type: ServerMessageType::StartState,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(payload),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    send_to_senders(&senders, &message, "start state");
}

/// Tells who the pending play waits for, if there is one.
pub(crate) fn send_waiting(room: &Room, clients: &HashMap<String, Client>) {
    let Some(pending) = room.pending_play.as_ref() else {
        return;
    };
    send_start_state(
        room,
        clients,
        serde_json::json!({
            "state": "waiting",
            "position": pending.position,
            "waiting_for": waiting_for(room, clients),
            "deadline_server_ts": pending.deadline_server_ts,
        }),
    );
}

/// Tells that the room no longer waits to start (a pause ended the wait).
pub(crate) fn send_idle(room: &Room, clients: &HashMap<String, Client>) {
    send_start_state(room, clients, serde_json::json!({ "state": "idle" }));
}

fn send_starting(
    room: &Room,
    clients: &HashMap<String, Client>,
    target_server_ts: u64,
    countdown: bool,
    without: Vec<WaitingMember>,
) {
    send_start_state(
        room,
        clients,
        serde_json::json!({
            "state": "starting",
            "target_server_ts": target_server_ts,
            "countdown": countdown,
            "without": without,
        }),
    );
}

/// Tells that a play the room didn't wait for counts down.
pub(crate) fn send_countdown(
    room: &Room,
    clients: &HashMap<String, Client>,
    target_server_ts: u64,
) {
    send_starting(room, clients, target_server_ts, true, Vec::new());
}

pub(super) fn prepare_scheduled_play(
    room: &mut Room,
    clients: &HashMap<String, Client>,
    position: f64,
    event_server_ts: u64,
    target_server_ts: u64,
    lead_ms: u64,
) -> (Vec<ClientSender>, WsMessage) {
    // Members project the position from `event_server_ts`. After a queue
    // advance they were loading the new item, not playing it, so it starts
    // from 0 when the play does instead of from when the advance was made.
    let event_server_ts = if starting_queue_item(room) {
        target_server_ts
    } else {
        event_server_ts
    };
    let initiator_id = room
        .pending_play
        .take()
        .map_or_else(|| room.host_id.clone(), |pending| pending.initiator_id);
    room.state.position = position;
    room.state.play_state = PlayState::Playing;
    let now = Instant::now();
    room.state_server_ts = event_server_ts;
    room.target_server_ts = Some(target_server_ts);
    room.target_at = now.checked_add(Duration::from_millis(lead_ms));
    room.last_state_at = Some(now);
    room.command_cooldown_until =
        now.checked_add(Duration::from_millis(lead_ms + COMMAND_COOLDOWN_MS));
    // A guest's pending play keeps holding until the host has applied it.
    if room
        .guest_command_until
        .is_some_and(|deadline| now < deadline)
    {
        room.guest_command_until = room.command_cooldown_until;
    }
    let msg = WsMessage {
        msg_type: ServerMessageType::PlayerEvent,
        room: Some(room.room_id.clone()),
        client: Some(initiator_id),
        payload: Some(
            serde_json::to_value(crate::types::ScheduledPlayerEventPayload {
                action: crate::types::PlaybackAction::Play,
                position,
                play_state: PlayState::Playing,
                target_server_ts,
            })
            .expect("typed payload serializes"),
        ),
        ts: now_ms(),
        server_ts: Some(event_server_ts),
    };
    let senders = collect_room_senders(room, clients, None);
    (senders, msg)
}

/// Starts the pending play now: everyone is ready, the wait ran out, or a
/// member asked to start (`start_now`). Members still not ready are named.
pub(crate) fn start_pending_play(room: &mut Room, clients: &HashMap<String, Client>) {
    let Some(pending) = room.pending_play.clone() else {
        return;
    };
    let without = waiting_for(room, clients);
    let (lead_ms, countdown) = play_lead(room, pending.shows_start);
    let target_server_ts = now_ms() + lead_ms;
    let (senders, msg) = prepare_scheduled_play(
        room,
        clients,
        pending.position,
        pending.position_ts,
        target_server_ts,
        lead_ms,
    );
    send_starting(room, clients, target_server_ts, countdown, without);
    send_to_senders(&senders, &msg, "scheduled play");
}

/// After the members or their readiness changed: starts the pending play once
/// everyone is ready, or tells who the room still waits for.
pub(crate) fn recheck_pending_play(room: &mut Room, clients: &HashMap<String, Client>) {
    if room.pending_play.is_none() {
        return;
    }
    if all_ready(room) {
        start_pending_play(room, clients);
    } else {
        send_waiting(room, clients);
    }
}

pub(super) fn schedule_pending_play(
    room_id: String,
    generation: u64,
    wait_ms: u64,
    state: SharedState,
    tasks: &crate::tasks::AppTasks,
) -> tokio::task::JoinHandle<()> {
    let cancellation = tasks.cancellation_token();
    tasks.spawn(async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            _ = sleep(Duration::from_millis(wait_ms)) => {}
        }
        if cancellation.is_cancelled() {
            return;
        }
        let mut state = state.write().await;
        if cancellation.is_cancelled() {
            return;
        }
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let Some(room) = rooms.get_mut(&room_id) else {
            return;
        };
        if room
            .pending_play
            .as_ref()
            .is_some_and(|pending| pending.generation == generation)
        {
            start_pending_play(room, clients);
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

        let (_, message) =
            prepare_scheduled_play(&mut room, &clients, 12.0, 4000, 5000, PLAY_SCHEDULE_MS);

        assert_eq!(room.state_server_ts, 4000);
        assert_eq!(room.target_server_ts, Some(5000));
        assert_eq!(message.server_ts, Some(4000));
        assert_eq!(message.payload.unwrap()["play_state"], "playing");
    }

    #[test]
    fn a_play_that_counts_down_takes_effect_and_holds_until_its_target() {
        let mut room = test_helpers::create_room("r1", "host");
        let before = Instant::now();

        prepare_scheduled_play(&mut room, &HashMap::new(), 12.0, 4000, 7000, COUNTDOWN_MS);

        let target_at = room.target_at.unwrap();
        assert!(target_at >= before + Duration::from_millis(COUNTDOWN_MS));
        assert!(target_at <= Instant::now() + Duration::from_millis(COUNTDOWN_MS));
        assert_eq!(
            room.command_cooldown_until.unwrap() - target_at,
            Duration::from_millis(COMMAND_COOLDOWN_MS)
        );
    }

    #[test]
    fn a_queue_advance_plays_from_the_start_when_its_play_does() {
        let mut room = test_helpers::create_room("r1", "host");
        let generation = crate::types::next_pending_play_generation();
        room.pending_play = Some(crate::types::PendingPlay {
            initiator_id: "host".into(),
            position: 0.0,
            generation,
            position_ts: 4000,
            deadline_server_ts: 0,
            shows_start: false,
        });
        room.queue.advance_generation = Some(generation);

        let (_, message) = prepare_scheduled_play(
            &mut room,
            &HashMap::new(),
            0.0,
            4000,
            9000,
            PLAY_SCHEDULE_MS,
        );

        assert_eq!(room.state_server_ts, 9000);
        assert_eq!(message.server_ts, Some(9000));
        assert_eq!(message.payload.unwrap()["position"], 0.0);
    }

    #[tokio::test(start_paused = true)]
    async fn pending_play_timeout_retains_the_guest_initiator_for_every_member() {
        let state = test_helpers::create_state();
        let (host, mut host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        let mut room = test_helpers::create_room("r1", "host");
        room.clients.push("guest".into());
        let generation = crate::types::next_pending_play_generation();
        room.pending_play = Some(crate::types::PendingPlay {
            initiator_id: "guest".into(),
            position: 12.0,
            generation,
            position_ts: now_ms(),
            deadline_server_ts: 0,
            shows_start: false,
        });
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".into(), host);
            locked.clients.insert("guest".into(), guest);
            locked.rooms.insert("r1".into(), room);
        }
        let tasks = crate::tasks::AppTasks::new();
        let timer = schedule_pending_play(
            "r1".into(),
            generation,
            MAX_READY_WAIT_MS,
            state.clone(),
            &tasks,
        );
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(MAX_READY_WAIT_MS + 1)).await;
        timer.await.unwrap();
        for rx in [&mut host_rx, &mut guest_rx] {
            let event = test_helpers::recv_msg(rx).unwrap();
            assert_eq!(event.client.as_deref(), Some("guest"));
            assert_eq!(event.payload.unwrap()["action"], "play");
        }
        assert!(state.read().await.rooms["r1"].pending_play.is_none());
        tasks.cancel();
        tasks.wait().await;
    }

    #[tokio::test(start_paused = true)]
    async fn pending_play_timer_is_reaped_on_shutdown() {
        let state = test_helpers::create_state();
        let created_at = now_ms();
        let mut room = test_helpers::create_room("r1", "host");
        room.pending_play = Some(crate::types::PendingPlay {
            initiator_id: "host".to_string(),
            position: 12.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: created_at,
            deadline_server_ts: 0,
            shows_start: false,
        });
        let generation = room.pending_play.as_ref().unwrap().generation;
        state.write().await.rooms.insert("r1".to_string(), room);
        let tasks = crate::tasks::AppTasks::new();
        let timer = schedule_pending_play(
            "r1".to_string(),
            generation,
            MAX_READY_WAIT_MS,
            state.clone(),
            &tasks,
        );
        tokio::task::yield_now().await;

        tasks.cancel();
        timer.await.unwrap();
        tasks.wait().await;
        tokio::time::advance(Duration::from_millis(MAX_READY_WAIT_MS + 1)).await;

        assert_eq!(tasks.active_count(), 0);
        assert!(state.read().await.rooms["r1"].pending_play.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn pending_play_cancelled_while_waiting_for_state_lock_has_no_effect() {
        let state = test_helpers::create_state();
        let created_at = now_ms();
        let mut room = test_helpers::create_room("r1", "host");
        room.pending_play = Some(crate::types::PendingPlay {
            initiator_id: "host".to_string(),
            position: 12.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: created_at,
            deadline_server_ts: 0,
            shows_start: false,
        });
        let generation = room.pending_play.as_ref().unwrap().generation;
        state.write().await.rooms.insert("r1".to_string(), room);
        let tasks = crate::tasks::AppTasks::new();
        let timer = schedule_pending_play(
            "r1".to_string(),
            generation,
            MAX_READY_WAIT_MS,
            state.clone(),
            &tasks,
        );
        tokio::task::yield_now().await;
        let state_guard = state.write().await;

        tokio::time::advance(Duration::from_millis(MAX_READY_WAIT_MS + 1)).await;
        tokio::task::yield_now().await;
        tasks.cancel();
        drop(state_guard);
        timer.await.unwrap();
        tasks.wait().await;

        let room = &state.read().await.rooms["r1"];
        assert!(room.pending_play.is_some());
        assert_eq!(room.state.play_state, PlayState::Paused);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_timer_cannot_match_replaced_play_after_wall_clock_rollback() {
        let state = test_helpers::create_state();
        let mut room = test_helpers::create_room("r1", "host");
        let old_generation = crate::types::next_pending_play_generation();
        room.pending_play = Some(crate::types::PendingPlay {
            initiator_id: "host".to_string(),
            position: 12.0,
            generation: old_generation,
            position_ts: 10_000,
            deadline_server_ts: 0,
            shows_start: false,
        });
        state.write().await.rooms.insert("r1".to_string(), room);
        let tasks = crate::tasks::AppTasks::new();
        let timer = schedule_pending_play(
            "r1".to_string(),
            old_generation,
            MAX_READY_WAIT_MS,
            state.clone(),
            &tasks,
        );
        tokio::task::yield_now().await;
        let mut locked = state.write().await;
        locked.rooms.get_mut("r1").unwrap().pending_play = Some(crate::types::PendingPlay {
            initiator_id: "host".to_string(),
            position: 8.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: 9_000,
            deadline_server_ts: 0,
            shows_start: false,
        });
        drop(locked);

        tokio::time::advance(Duration::from_millis(MAX_READY_WAIT_MS + 1)).await;
        timer.await.unwrap();

        let locked = state.read().await;
        let pending = locked.rooms["r1"].pending_play.as_ref().unwrap();
        assert_eq!(pending.position_ts, 9_000);
        assert_eq!(locked.rooms["r1"].state.play_state, PlayState::Paused);
    }
}
