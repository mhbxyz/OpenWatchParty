//! Room queue messages (#69). Only the host changes the queue. Members that
//! negotiated `media_queue` get `queue_state` after each change and when they
//! join. Moving to another item is also announced with `room_state`, so
//! members without the feature still follow it.
//!
//! The "up next" countdown runs on the server, so it doesn't depend on the
//! host's tab timers, which browsers slow down in the background. A pause the
//! server accepts ends it (see `handle_playback`); the host's client also
//! cancels it when its video pauses or seeks back out of the credits.

use super::super::constants::QUEUE_COUNTDOWN_MS;
use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use super::super::pending_play::{schedule_pending_play, send_waiting, shows_start, wait_ms};
use super::super::validation::{is_valid_media_id, sanitize_name};
use super::join::room_state_message;
use crate::messaging::{broadcast_room_list, send_message, send_to_senders};
use crate::room::{Countdown, QueueItem, MAX_QUEUE_ITEMS};
use crate::tasks::AppTasks;
use crate::types::{
    Client, ClientMessageType, IncomingMessage, PendingPlay, PlayState, PlaybackState, Room,
    ServerMessageType, ServerState, SharedState, WsMessage,
};
use crate::utils::now_ms;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Instant};

/// Tells countdowns apart, so a cancelled one's timer can't advance the room.
static NEXT_COUNTDOWN: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddPayload {
    items: Vec<ItemPayload>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemPayload {
    id: String,
    title: String,
    /// The Jellyfin series of an episode, from clients with `start_when_ready`.
    #[serde(default)]
    series: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdPayload {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MovePayload {
    id: String,
    to: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CountdownPayload {
    start: bool,
}

#[derive(Debug, PartialEq)]
enum QueueCommand {
    Add(Vec<QueueItem>),
    Remove(String),
    Move(String, usize),
    Advance(String),
    Countdown(bool),
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Unchanged,
    Changed,
    /// The room moved to another item and armed the pending play with this
    /// generation.
    Advanced(u64),
    /// A countdown with this generation started.
    CountdownStarted(u64),
}

/// What to start once the state lock is released.
enum FollowUp {
    PendingPlay(String, u64, u64),
    Countdown(String, u64),
}

fn valid_id(id: String) -> Option<String> {
    is_valid_media_id(&id).then_some(id)
}

impl QueueCommand {
    fn parse(parsed: &IncomingMessage) -> Option<Self> {
        let payload = parsed.payload.clone()?;
        let command = match parsed.msg_type {
            ClientMessageType::QueueAdd => {
                let AddPayload { items } = serde_json::from_value(payload).ok()?;
                if items.is_empty() || items.len() > MAX_QUEUE_ITEMS {
                    return None;
                }
                let items = items
                    .into_iter()
                    .map(|item| {
                        Some(QueueItem {
                            id: valid_id(item.id)?,
                            title: sanitize_name(&item.title)?,
                            series: match item.series {
                                Some(series) => Some(valid_id(series)?),
                                None => None,
                            },
                        })
                    })
                    .collect::<Option<_>>()?;
                Self::Add(items)
            }
            ClientMessageType::QueueRemove => {
                let IdPayload { id } = serde_json::from_value(payload).ok()?;
                Self::Remove(valid_id(id)?)
            }
            ClientMessageType::QueueMove => {
                let MovePayload { id, to } = serde_json::from_value(payload).ok()?;
                Self::Move(valid_id(id)?, to)
            }
            ClientMessageType::QueueAdvance => {
                let IdPayload { id } = serde_json::from_value(payload).ok()?;
                Self::Advance(valid_id(id)?)
            }
            ClientMessageType::QueueCountdown => {
                let CountdownPayload { start } = serde_json::from_value(payload).ok()?;
                Self::Countdown(start)
            }
            _ => return None,
        };
        Some(command)
    }
}

/// Moves the room to a queued item from the start, as on joining: every
/// member loads it and reports `ready`, and the pending play starts it at 0
/// once they all have or the wait runs out.
fn advance(
    room: &mut Room,
    clients: &HashMap<String, Client>,
    id: String,
    current_ts: u64,
    now: Instant,
) -> u64 {
    let generation = crate::types::next_pending_play_generation();
    // The next episode of the same series goes on without counting down; any
    // other item counts down like the room's first.
    let series = |id: Option<&str>| {
        id.and_then(|id| room.queue.items.iter().find(|item| item.id == id))
            .and_then(|item| item.series.clone())
    };
    let same_series = series(room.media_id.as_deref())
        .is_some_and(|previous| series(Some(&id)) == Some(previous));
    room.countdown_pending = !same_series;
    room.media_id = Some(id);
    room.state = PlaybackState {
        position: 0.0,
        play_state: PlayState::Paused,
    };
    room.state_server_ts = current_ts;
    room.target_server_ts = None;
    room.target_at = None;
    room.last_state_at = Some(now);
    room.command_cooldown_until = None;
    room.guest_command_until = None;
    // Members without the queue (an older client) never report ready for the
    // new item: waiting for them would hold this play and every later one.
    room.ready_clients = room
        .clients
        .iter()
        .filter(|id| {
            clients
                .get(*id)
                .is_some_and(|client| !client.supports_media_queue)
        })
        .cloned()
        .collect();
    // What the members said was about the previous item.
    room.not_ready.clear();
    room.pending_play = Some(PendingPlay {
        initiator_id: room.host_id.clone(),
        position: 0.0,
        generation,
        position_ts: current_ts,
        deadline_server_ts: current_ts + wait_ms(clients, &room.host_id),
        shows_start: shows_start(clients, &room.host_id),
    });
    room.queue.countdown = None;
    room.queue.advance_generation = Some(generation);
    generation
}

fn apply(
    room: &mut Room,
    clients: &HashMap<String, Client>,
    command: QueueCommand,
    current_ts: u64,
    now: Instant,
) -> Outcome {
    let media_id = room.media_id.as_deref();
    let changed = match command {
        QueueCommand::Add(items) => room.queue.add(items, media_id),
        QueueCommand::Remove(id) => room.queue.remove(&id, media_id),
        QueueCommand::Move(id, to) => room.queue.move_to(&id, to, media_id),
        QueueCommand::Advance(id) => {
            if !room.queue.contains(&id) || media_id == Some(id.as_str()) {
                return Outcome::Unchanged;
            }
            return Outcome::Advanced(advance(room, clients, id, current_ts, now));
        }
        QueueCommand::Countdown(true) => {
            if room.queue.countdown.is_some() || room.queue.next(media_id).is_none() {
                return Outcome::Unchanged;
            }
            let generation = NEXT_COUNTDOWN.fetch_add(1, Ordering::Relaxed);
            room.queue.countdown = Some(Countdown {
                until: current_ts + QUEUE_COUNTDOWN_MS,
                generation,
            });
            return Outcome::CountdownStarted(generation);
        }
        QueueCommand::Countdown(false) => room.queue.countdown.take().is_some(),
    };
    // A countdown runs toward the next item, so it ends with it.
    if room.queue.next(room.media_id.as_deref()).is_none() {
        room.queue.countdown = None;
    }
    if changed {
        Outcome::Changed
    } else {
        Outcome::Unchanged
    }
}

/// Sends `queue_state` to the members that negotiated `media_queue`, or only
/// to `only` when given.
pub(super) fn send_queue_state(room: &Room, clients: &HashMap<String, Client>, only: Option<&str>) {
    let senders: Vec<_> = room
        .clients
        .iter()
        .filter(|id| only.is_none_or(|only| only == id.as_str()))
        .filter_map(|id| clients.get(id))
        .filter(|client| client.supports_media_queue)
        .map(|client| client.sender.clone())
        .collect();
    if senders.is_empty() {
        return;
    }
    let message = WsMessage {
        msg_type: ServerMessageType::QueueState,
        room: Some(room.room_id.clone()),
        client: None,
        payload: Some(room.queue.payload(room.media_id.as_deref())),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    send_to_senders(&senders, &message, "queue state");
}

/// Tells every member the room moved: `room_state` to all of them, then
/// `queue_state` to those with the queue.
fn announce_advance(room: &Room, clients: &HashMap<String, Client>) {
    let now = Instant::now();
    let wall_now_ms = now_ms();
    for id in &room.clients {
        if let Some(client) = clients.get(id) {
            send_message(
                Some(client.sender.clone()),
                &room_state_message(id, room, now, wall_now_ms),
                Some(id),
            );
        }
    }
    send_queue_state(room, clients, None);
    send_waiting(room, clients);
}

/// After an advance, once the state lock is released: waits for the members'
/// `ready`, and shows the new item in the room list.
async fn arm_pending_play(
    room_id: String,
    generation: u64,
    wait: u64,
    state: &SharedState,
    tasks: &AppTasks,
) {
    std::mem::drop(schedule_pending_play(
        room_id,
        generation,
        wait,
        state.clone(),
        tasks,
    ));
    broadcast_room_list(state).await;
}

/// Moves the room to the next item when its countdown ends, unless the
/// countdown was cancelled or replaced first.
fn schedule_countdown(
    room_id: String,
    generation: u64,
    delay: Duration,
    state: SharedState,
    tasks: &AppTasks,
) -> JoinHandle<()> {
    let cancellation = tasks.cancellation_token();
    let advance_tasks = tasks.clone();
    tasks.spawn(async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            _ = sleep(delay) => {}
        }
        let pending_play = {
            let mut state = state.write().await;
            if cancellation.is_cancelled() {
                return;
            }
            let ServerState { clients, rooms } = &mut *state;
            let Some(room) = rooms.get_mut(&room_id) else {
                return;
            };
            if room.queue.countdown.map(|countdown| countdown.generation) != Some(generation) {
                return;
            }
            room.queue.countdown = None;
            let Some(next) = room.queue.next(room.media_id.as_deref()) else {
                send_queue_state(room, clients, None);
                return;
            };
            let next = next.id.clone();
            let pending_play = advance(room, clients, next, now_ms(), Instant::now());
            announce_advance(room, clients);
            (pending_play, wait_ms(clients, &room.host_id))
        };
        arm_pending_play(
            room_id,
            pending_play.0,
            pending_play.1,
            &state,
            &advance_tasks,
        )
        .await;
    })
}

/// `queue_add`, `queue_remove`, `queue_move`, `queue_advance` and
/// `queue_countdown`. A command that changes nothing (a queued item, an
/// unknown id, the current item, a countdown already running) is ignored
/// without an error.
pub(in crate::ws) async fn handle_queue(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
    tasks: &AppTasks,
) {
    if !is_authenticated(client_id, state).await {
        send_error(
            client_id,
            state,
            ErrorCode::AuthenticationRequired,
            "Authentication required",
        )
        .await;
        return;
    }
    let Some(command) = QueueCommand::parse(parsed) else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidQueuePayload,
            "Invalid queue payload",
        )
        .await;
        return;
    };
    let result = {
        let mut state = state.write().await;
        let ServerState { clients, rooms } = &mut *state;
        let room = clients
            .get(client_id)
            .and_then(|client| client.room_id.as_ref())
            .and_then(|room_id| rooms.get_mut(room_id));
        match room {
            None => Err((ErrorCode::NotInRoom, "Client is not in a room")),
            Some(room) if room.host_id != client_id => Err((
                ErrorCode::HostPermissionRequired,
                "Only the room host can change the queue",
            )),
            Some(room) => match apply(room, clients, command, now_ms(), Instant::now()) {
                Outcome::Unchanged => Ok(None),
                Outcome::Changed => {
                    send_queue_state(room, clients, None);
                    Ok(None)
                }
                Outcome::Advanced(generation) => {
                    announce_advance(room, clients);
                    Ok(Some(FollowUp::PendingPlay(
                        room.room_id.clone(),
                        generation,
                        wait_ms(clients, &room.host_id),
                    )))
                }
                Outcome::CountdownStarted(generation) => {
                    send_queue_state(room, clients, None);
                    Ok(Some(FollowUp::Countdown(room.room_id.clone(), generation)))
                }
            },
        }
    };
    match result {
        Err((code, message)) => send_error(client_id, state, code, message).await,
        Ok(None) => {}
        Ok(Some(FollowUp::PendingPlay(room_id, generation, wait))) => {
            arm_pending_play(room_id, generation, wait, state, tasks).await;
        }
        Ok(Some(FollowUp::Countdown(room_id, generation))) => {
            std::mem::drop(schedule_countdown(
                room_id,
                generation,
                Duration::from_millis(QUEUE_COUNTDOWN_MS),
                state.clone(),
                tasks,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::AppTasks;
    use crate::test_helpers;
    use tokio::sync::mpsc::Receiver;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccc";

    fn message(msg_type: ClientMessageType, payload: serde_json::Value) -> IncomingMessage {
        IncomingMessage {
            msg_type,
            room: Some("room".to_string()),
            client: None,
            payload: Some(payload),
            ts: now_ms(),
            server_ts: None,
        }
    }

    fn add(ids: &[&str]) -> IncomingMessage {
        let items: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id, "title": format!("Episode {}", &id[..1]) }))
            .collect();
        message(
            ClientMessageType::QueueAdd,
            serde_json::json!({ "items": items }),
        )
    }

    fn drain(rx: &mut Receiver<crate::messaging::OutboundMessage>) -> Vec<WsMessage> {
        std::iter::from_fn(|| test_helpers::recv_msg(rx)).collect()
    }

    fn types(messages: &[WsMessage]) -> Vec<ServerMessageType> {
        messages.iter().map(|msg| msg.msg_type.clone()).collect()
    }

    /// A room playing `A` with a host and a guest that negotiated
    /// `media_queue`, and a guest that didn't.
    async fn room_with_members() -> (
        SharedState,
        Vec<Receiver<crate::messaging::OutboundMessage>>,
    ) {
        let state = test_helpers::create_state();
        let mut receivers = Vec::new();
        {
            let mut locked = state.write().await;
            for (id, supports_queue) in [("host", true), ("guest", true), ("legacy", false)] {
                let (mut client, rx) = test_helpers::create_client_with_rx(id, id, true);
                client.room_id = Some("room".to_string());
                client.supports_media_queue = supports_queue;
                locked.clients.insert(id.to_string(), client);
                receivers.push(rx);
            }
            let mut room = test_helpers::create_room("room", "host");
            room.clients = vec!["host".into(), "guest".into(), "legacy".into()];
            room.media_id = Some(A.to_string());
            locked.rooms.insert("room".to_string(), room);
        }
        (state, receivers)
    }

    #[test]
    fn parse_validates_ids_titles_and_shape() {
        let parsed = QueueCommand::parse(&message(
            ClientMessageType::QueueAdd,
            serde_json::json!({ "items": [{ "id": A, "title": "  Pilot\u{7}  " }] }),
        ));
        assert_eq!(
            parsed,
            Some(QueueCommand::Add(vec![QueueItem {
                id: A.to_string(),
                title: "Pilot".to_string(),
                series: None,
            }]))
        );
        assert_eq!(
            QueueCommand::parse(&message(
                ClientMessageType::QueueMove,
                serde_json::json!({ "id": B, "to": 2 }),
            )),
            Some(QueueCommand::Move(B.to_string(), 2))
        );

        let too_many: Vec<_> = (0..=MAX_QUEUE_ITEMS)
            .map(|_| serde_json::json!({ "id": A, "title": "x" }))
            .collect();
        for (msg_type, payload) in [
            (
                ClientMessageType::QueueAdd,
                serde_json::json!({ "items": [] }),
            ),
            (
                ClientMessageType::QueueAdd,
                serde_json::json!({ "items": too_many }),
            ),
            (
                ClientMessageType::QueueAdd,
                serde_json::json!({ "items": [{ "id": "not-hex", "title": "x" }] }),
            ),
            (
                ClientMessageType::QueueAdd,
                serde_json::json!({ "items": [{ "id": A, "title": "   " }] }),
            ),
            (
                ClientMessageType::QueueAdd,
                serde_json::json!({ "items": [{ "id": A, "title": "x", "extra": 1 }] }),
            ),
            (
                ClientMessageType::QueueRemove,
                serde_json::json!({ "id": A, "extra": 1 }),
            ),
            (
                ClientMessageType::QueueMove,
                serde_json::json!({ "id": A, "to": -1 }),
            ),
            (
                ClientMessageType::QueueAdvance,
                serde_json::json!({ "id": 7 }),
            ),
        ] {
            assert_eq!(
                QueueCommand::parse(&message(msg_type, payload.clone())),
                None,
                "{payload}"
            );
        }
    }

    #[tokio::test]
    async fn only_the_host_of_a_room_changes_the_queue() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("guest", &add(&[B]), &state, &tasks).await;
        let guest_messages = drain(&mut receivers[1]);
        assert_eq!(guest_messages.len(), 1);
        assert_eq!(
            guest_messages[0].payload.as_ref().unwrap()["code"],
            "HOST_PERMISSION_REQUIRED"
        );

        let (outsider, mut outsider_rx) =
            test_helpers::create_client_with_rx("outsider", "Outsider", true);
        state
            .write()
            .await
            .clients
            .insert("outsider".to_string(), outsider);
        handle_queue("outsider", &add(&[B]), &state, &tasks).await;
        assert_eq!(
            drain(&mut outsider_rx)[0].payload.as_ref().unwrap()["code"],
            "NOT_IN_ROOM"
        );

        handle_queue(
            "host",
            &message(ClientMessageType::QueueAdd, serde_json::json!({})),
            &state,
            &tasks,
        )
        .await;
        assert_eq!(
            drain(&mut receivers[0])[0].payload.as_ref().unwrap()["code"],
            "INVALID_QUEUE_PAYLOAD"
        );
        assert!(state.read().await.rooms["room"].queue.items.is_empty());
    }

    #[tokio::test]
    async fn unauthenticated_clients_are_refused() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("anon", "Anon", false);
        state
            .write()
            .await
            .clients
            .insert("anon".to_string(), client);
        handle_queue("anon", &add(&[A]), &state, &AppTasks::new()).await;
        assert_eq!(
            drain(&mut rx)[0].payload.as_ref().unwrap()["code"],
            "AUTHENTICATION_REQUIRED"
        );
    }

    #[tokio::test]
    async fn changes_reach_the_members_that_negotiated_the_queue() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A, B, C]), &state, &tasks).await;

        for rx in &mut receivers[..2] {
            let messages = drain(rx);
            assert_eq!(types(&messages), [ServerMessageType::QueueState]);
            let payload = messages[0].payload.as_ref().unwrap();
            assert_eq!(payload["items"].as_array().unwrap().len(), 3);
            assert_eq!(payload["current"], 0);
        }
        assert!(drain(&mut receivers[2]).is_empty());

        // Nothing changes: nobody hears about it.
        handle_queue("host", &add(&[B]), &state, &tasks).await;
        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueRemove,
                serde_json::json!({ "id": A }),
            ),
            &state,
            &tasks,
        )
        .await;
        assert!(receivers.iter_mut().all(|rx| drain(rx).is_empty()));

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueMove,
                serde_json::json!({ "id": C, "to": 1 }),
            ),
            &state,
            &tasks,
        )
        .await;
        let payload = drain(&mut receivers[1])[0].payload.clone().unwrap();
        assert_eq!(payload["items"][1]["id"], C);

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueRemove,
                serde_json::json!({ "id": B }),
            ),
            &state,
            &tasks,
        )
        .await;
        let payload = drain(&mut receivers[1])[0].payload.clone().unwrap();
        assert_eq!(payload["items"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn advancing_restarts_the_room_on_the_new_item_for_everyone() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A, B]), &state, &tasks).await;
        {
            let mut locked = state.write().await;
            let room = locked.rooms.get_mut("room").unwrap();
            room.state = PlaybackState {
                position: 1300.0,
                play_state: PlayState::Playing,
            };
            room.ready_clients
                .extend(["guest".to_string(), "legacy".to_string()]);
        }
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueAdvance,
                serde_json::json!({ "id": B }),
            ),
            &state,
            &tasks,
        )
        .await;

        {
            let locked = state.read().await;
            let room = &locked.rooms["room"];
            assert_eq!(room.media_id.as_deref(), Some(B));
            assert_eq!(room.state.position, 0.0);
            assert_eq!(room.state.play_state, PlayState::Paused);
            // Only the member without the queue, which never reports ready.
            assert_eq!(
                room.ready_clients,
                std::collections::HashSet::from(["legacy".to_string()])
            );
            let pending = room.pending_play.as_ref().unwrap();
            assert_eq!(pending.position, 0.0);
            assert_eq!(pending.initiator_id, "host");
            assert_eq!(room.queue.advance_generation, Some(pending.generation));
        }
        let with_queue = vec![
            ServerMessageType::RoomState,
            ServerMessageType::QueueState,
            ServerMessageType::RoomList,
        ];
        let without_queue = vec![ServerMessageType::RoomState, ServerMessageType::RoomList];
        for (rx, (id, expected)) in receivers.iter_mut().zip([
            ("host", &with_queue),
            ("guest", &with_queue),
            ("legacy", &without_queue),
        ]) {
            let messages = drain(rx);
            assert_eq!(&types(&messages), expected, "{id}");
            assert_eq!(messages[0].client.as_deref(), Some(id));
            let payload = messages[0].payload.as_ref().unwrap();
            assert_eq!(payload["media_id"], B);
            assert_eq!(payload["state"]["position"], 0.0);
            assert_eq!(payload["state"]["play_state"], "paused");
        }
    }

    const SERIES: &str = "dddddddddddddddddddddddddddddddd";
    const OTHER_SERIES: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn add_with_series(items: &[(&str, Option<&str>)]) -> IncomingMessage {
        let items: Vec<_> = items
            .iter()
            .map(|(id, series)| {
                let mut item =
                    serde_json::json!({ "id": id, "title": format!("Episode {}", &id[..1]) });
                if let Some(series) = series {
                    item["series"] = serde_json::json!(series);
                }
                item
            })
            .collect();
        message(
            ClientMessageType::QueueAdd,
            serde_json::json!({ "items": items }),
        )
    }

    #[test]
    fn parse_reads_the_series_and_the_queue_never_sends_it() {
        let Some(QueueCommand::Add(items)) =
            QueueCommand::parse(&add_with_series(&[(A, Some(SERIES)), (B, None)]))
        else {
            panic!("a valid add");
        };
        assert_eq!(items[0].series.as_deref(), Some(SERIES));
        assert_eq!(items[1].series, None);
        assert_eq!(
            QueueCommand::parse(&add_with_series(&[(A, Some("not-hex"))])),
            None
        );

        let mut queue = crate::room::MediaQueue::default();
        queue.add(items, Some(A));
        let payload = queue.payload(Some(A));
        assert!(payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("series").is_none()));
    }

    #[tokio::test]
    async fn the_next_episode_of_the_same_series_goes_on_without_a_countdown() {
        let (state, mut receivers) = room_with_members().await;
        {
            let mut locked = state.write().await;
            for id in ["host", "guest"] {
                locked
                    .clients
                    .get_mut(id)
                    .unwrap()
                    .supports_start_when_ready = true;
            }
        }
        let tasks = AppTasks::new();
        handle_queue(
            "host",
            &add_with_series(&[
                (A, Some(SERIES)),
                (B, Some(SERIES)),
                (C, Some(OTHER_SERIES)),
            ]),
            &state,
            &tasks,
        )
        .await;
        state
            .write()
            .await
            .rooms
            .get_mut("room")
            .unwrap()
            .not_ready
            .insert("guest".into(), crate::types::NotReadyReason::Buffering);
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        let before = now_ms();
        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueAdvance,
                serde_json::json!({ "id": B }),
            ),
            &state,
            &tasks,
        )
        .await;
        {
            let locked = state.read().await;
            let room = &locked.rooms["room"];
            assert!(!room.countdown_pending);
            // What the guest said was about the previous episode.
            assert!(room.not_ready.is_empty());
            let deadline = room.pending_play.as_ref().unwrap().deadline_server_ts;
            assert!((before + super::super::super::constants::START_WAIT_MS
                ..=now_ms() + super::super::super::constants::START_WAIT_MS)
                .contains(&deadline));
        }
        for (rx, expected) in receivers.iter_mut().zip([true, true, false]) {
            let messages = drain(rx);
            let waiting: Vec<_> = messages
                .iter()
                .filter(|msg| msg.msg_type == ServerMessageType::StartState)
                .collect();
            assert_eq!(waiting.len(), usize::from(expected));
            if expected {
                assert_eq!(waiting[0].payload.as_ref().unwrap()["state"], "waiting");
                assert_eq!(waiting[0].payload.as_ref().unwrap()["position"], 0.0);
            }
        }

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueAdvance,
                serde_json::json!({ "id": C }),
            ),
            &state,
            &tasks,
        )
        .await;
        assert!(state.read().await.rooms["room"].countdown_pending);
    }

    #[tokio::test]
    async fn an_item_without_a_series_counts_down_and_an_older_host_waits_briefly() {
        let (state, _receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue(
            "host",
            &add_with_series(&[(A, None), (B, None)]),
            &state,
            &tasks,
        )
        .await;
        let before = now_ms();

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueAdvance,
                serde_json::json!({ "id": B }),
            ),
            &state,
            &tasks,
        )
        .await;

        let locked = state.read().await;
        let room = &locked.rooms["room"];
        assert!(room.countdown_pending);
        let deadline = room.pending_play.as_ref().unwrap().deadline_server_ts;
        assert!((before + super::super::super::constants::MAX_READY_WAIT_MS
            ..=now_ms() + super::super::super::constants::MAX_READY_WAIT_MS)
            .contains(&deadline));
    }

    #[tokio::test]
    async fn advancing_to_the_current_or_an_unknown_item_does_nothing() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A, B]), &state, &tasks).await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        for id in [A, C] {
            handle_queue(
                "host",
                &message(
                    ClientMessageType::QueueAdvance,
                    serde_json::json!({ "id": id }),
                ),
                &state,
                &tasks,
            )
            .await;
        }

        let locked = state.read().await;
        assert_eq!(locked.rooms["room"].media_id.as_deref(), Some(A));
        assert!(locked.rooms["room"].pending_play.is_none());
        drop(locked);
        assert!(receivers.iter_mut().all(|rx| drain(rx).is_empty()));
    }

    fn countdown(start: bool) -> IncomingMessage {
        message(
            ClientMessageType::QueueCountdown,
            serde_json::json!({ "start": start }),
        )
    }

    async fn countdown_until(state: &SharedState) -> Option<u64> {
        state.read().await.rooms["room"]
            .queue
            .countdown
            .map(|countdown| countdown.until)
    }

    /// Lets the spawned timers that are due run.
    async fn run_due_timers(state: &SharedState, until_media: &str) {
        for _ in 0..50 {
            if state.read().await.rooms["room"].media_id.as_deref() == Some(until_media) {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn parse_reads_the_countdown_command() {
        assert_eq!(
            QueueCommand::parse(&countdown(true)),
            Some(QueueCommand::Countdown(true))
        );
        assert_eq!(
            QueueCommand::parse(&message(
                ClientMessageType::QueueCountdown,
                serde_json::json!({ "start": "yes" }),
            )),
            None
        );
    }

    #[tokio::test]
    async fn a_countdown_needs_a_next_item_and_runs_once() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A]), &state, &tasks).await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        handle_queue("host", &countdown(true), &state, &tasks).await;
        assert_eq!(countdown_until(&state).await, None);
        assert!(receivers.iter_mut().all(|rx| drain(rx).is_empty()));

        handle_queue("host", &add(&[B]), &state, &tasks).await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });
        let before = now_ms();
        handle_queue("host", &countdown(true), &state, &tasks).await;
        let until = countdown_until(&state).await.expect("countdown started");
        assert!((before + QUEUE_COUNTDOWN_MS..=now_ms() + QUEUE_COUNTDOWN_MS).contains(&until));
        for rx in &mut receivers[..2] {
            let messages = drain(rx);
            assert_eq!(types(&messages), [ServerMessageType::QueueState]);
            assert_eq!(
                messages[0].payload.as_ref().unwrap()["countdown_until"],
                until
            );
        }
        assert!(drain(&mut receivers[2]).is_empty());

        // Starting again keeps the running countdown.
        handle_queue("host", &countdown(true), &state, &tasks).await;
        assert_eq!(countdown_until(&state).await, Some(until));
        assert!(receivers.iter_mut().all(|rx| drain(rx).is_empty()));

        handle_queue("host", &countdown(false), &state, &tasks).await;
        assert_eq!(countdown_until(&state).await, None);
        let messages = drain(&mut receivers[1]);
        assert_eq!(
            messages[0].payload.as_ref().unwrap()["countdown_until"],
            serde_json::Value::Null
        );
        drain(&mut receivers[0]);
        handle_queue("host", &countdown(false), &state, &tasks).await;
        assert!(receivers.iter_mut().all(|rx| drain(rx).is_empty()));
    }

    #[tokio::test]
    async fn removing_the_next_item_ends_the_countdown() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A, B]), &state, &tasks).await;
        handle_queue("host", &countdown(true), &state, &tasks).await;
        drain(&mut receivers[1]);

        handle_queue(
            "host",
            &message(
                ClientMessageType::QueueRemove,
                serde_json::json!({ "id": B }),
            ),
            &state,
            &tasks,
        )
        .await;

        assert_eq!(countdown_until(&state).await, None);
        let payload = drain(&mut receivers[1])[0].payload.clone().unwrap();
        assert_eq!(payload["countdown_until"], serde_json::Value::Null);
    }

    #[tokio::test(start_paused = true)]
    async fn the_countdown_moves_the_room_to_the_next_item_once() {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        handle_queue("host", &add(&[A, B, C]), &state, &tasks).await;
        // A cancelled countdown's timer must not advance the room again.
        handle_queue("host", &countdown(true), &state, &tasks).await;
        handle_queue("host", &countdown(false), &state, &tasks).await;
        handle_queue("host", &countdown(true), &state, &tasks).await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        sleep(Duration::from_millis(QUEUE_COUNTDOWN_MS + 1)).await;
        run_due_timers(&state, B).await;

        {
            let locked = state.read().await;
            let room = &locked.rooms["room"];
            assert_eq!(room.media_id.as_deref(), Some(B));
            assert_eq!(room.queue.countdown, None);
            let pending = room.pending_play.as_ref().expect("advance arms a play");
            assert_eq!(room.queue.advance_generation, Some(pending.generation));
        }
        let messages = drain(&mut receivers[1]);
        assert_eq!(
            types(&messages),
            [
                ServerMessageType::RoomState,
                ServerMessageType::QueueState,
                ServerMessageType::RoomList,
            ]
        );
        assert_eq!(messages[0].payload.as_ref().unwrap()["media_id"], B);
        assert_eq!(
            messages[1].payload.as_ref().unwrap()["countdown_until"],
            serde_json::Value::Null
        );
    }

    fn player_event(action: &str) -> IncomingMessage {
        message(
            ClientMessageType::PlayerEvent,
            serde_json::json!({ "action": action, "position": 1300.0 }),
        )
    }

    /// The room plays `A` with a countdown toward `B`, and the host and the
    /// guest may play and pause it.
    async fn counting_down_room() -> (
        SharedState,
        Vec<Receiver<crate::messaging::OutboundMessage>>,
        AppTasks,
    ) {
        let (state, mut receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        {
            let mut locked = state.write().await;
            for id in ["host", "guest"] {
                locked
                    .clients
                    .get_mut(id)
                    .unwrap()
                    .supports_shared_playback_control = true;
            }
            locked.rooms.get_mut("room").unwrap().state = PlaybackState {
                position: 1300.0,
                play_state: PlayState::Playing,
            };
        }
        handle_queue("host", &add(&[A, B]), &state, &tasks).await;
        handle_queue("host", &countdown(true), &state, &tasks).await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });
        (state, receivers, tasks)
    }

    #[tokio::test(start_paused = true)]
    async fn a_pause_ends_the_countdown_before_its_timer_moves_the_room() {
        for member in ["host", "guest"] {
            let (state, mut receivers, tasks) = counting_down_room().await;

            super::super::playback::handle_playback(member, player_event("pause"), &state, &tasks)
                .await;

            assert_eq!(countdown_until(&state).await, None, "{member}");
            // The pause comes first, so the host's client doesn't start the
            // countdown again before it pauses.
            for rx in &mut receivers[..2] {
                let messages = drain(rx);
                assert_eq!(
                    types(&messages),
                    [
                        ServerMessageType::PlayerEvent,
                        ServerMessageType::QueueState
                    ],
                    "{member}"
                );
                assert_eq!(
                    messages[1].payload.as_ref().unwrap()["countdown_until"],
                    serde_json::Value::Null
                );
            }
            assert_eq!(
                types(&drain(&mut receivers[2])),
                [ServerMessageType::PlayerEvent]
            );

            sleep(Duration::from_millis(QUEUE_COUNTDOWN_MS + 1)).await;
            run_due_timers(&state, B).await;
            let locked = state.read().await;
            let room = &locked.rooms["room"];
            assert_eq!(room.media_id.as_deref(), Some(A), "{member}");
            assert_eq!(room.state.play_state, PlayState::Paused);
        }
    }

    #[tokio::test]
    async fn only_a_pause_that_ends_a_countdown_sends_the_queue() {
        let (state, mut receivers, tasks) = counting_down_room().await;
        // The host's player waits for data: the countdown goes on.
        super::super::playback::handle_playback("host", player_event("buffering"), &state, &tasks)
            .await;
        assert!(countdown_until(&state).await.is_some());
        super::super::playback::handle_playback("host", player_event("pause"), &state, &tasks)
            .await;
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });

        super::super::playback::handle_playback("host", player_event("pause"), &state, &tasks)
            .await;
        assert_eq!(
            types(&drain(&mut receivers[1])),
            [ServerMessageType::PlayerEvent]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_countdown_does_not_cut_the_next_one_short() {
        let (state, _receivers) = room_with_members().await;
        let tasks = AppTasks::new();
        let half = Duration::from_millis(QUEUE_COUNTDOWN_MS / 2);
        handle_queue("host", &add(&[A, B]), &state, &tasks).await;
        handle_queue("host", &countdown(true), &state, &tasks).await;
        handle_queue("host", &countdown(false), &state, &tasks).await;
        sleep(half).await;
        handle_queue("host", &countdown(true), &state, &tasks).await;

        // The cancelled countdown would have ended here.
        sleep(half + Duration::from_millis(1)).await;
        run_due_timers(&state, B).await;
        assert_eq!(
            state.read().await.rooms["room"].media_id.as_deref(),
            Some(A)
        );

        sleep(half).await;
        run_due_timers(&state, B).await;
        assert_eq!(
            state.read().await.rooms["room"].media_id.as_deref(),
            Some(B)
        );
    }
}
