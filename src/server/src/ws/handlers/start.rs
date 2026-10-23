//! Starting a play when the room is ready (`start_when_ready`): members say
//! why they can't play yet (`readiness`), and a member who may play can start
//! a waiting play at once (`start_now`). See `pending_play`.

use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use super::super::pending_play::{recheck_pending_play, start_pending_play};
use crate::types::{IncomingMessage, NotReadyReason, SharedState};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessPayload {
    ready: bool,
    #[serde(default)]
    reason: Option<NotReadyReason>,
}

impl ReadinessPayload {
    /// `None` when ready; a reason otherwise. `Err` for a mismatch.
    fn reason(self) -> Result<Option<NotReadyReason>, ()> {
        match (self.ready, self.reason) {
            (true, None) => Ok(None),
            (false, Some(reason)) => Ok(Some(reason)),
            _ => Err(()),
        }
    }
}

pub(in crate::ws) async fn handle_readiness(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
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
    let Some(reason) = parsed
        .payload
        .clone()
        .and_then(|payload| serde_json::from_value::<ReadinessPayload>(payload).ok())
        .and_then(|payload| payload.reason().ok())
    else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidReady,
            "Invalid readiness payload",
        )
        .await;
        return;
    };

    let in_room = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let room = clients
            .get(client_id)
            .and_then(|client| client.room_id.as_deref())
            .and_then(|room_id| rooms.get_mut(room_id))
            .filter(|room| room.clients.iter().any(|id| id == client_id));
        if let Some(room) = room {
            let changed = match reason {
                Some(reason) => {
                    room.not_ready.insert(client_id.to_string(), reason) != Some(reason)
                }
                None => room.not_ready.remove(client_id).is_some(),
            };
            if changed {
                recheck_pending_play(room, clients);
            }
            true
        } else {
            false
        }
    };
    if !in_room {
        send_error(
            client_id,
            state,
            ErrorCode::NotInRoom,
            "Client is not in a room",
        )
        .await;
    }
}

pub(in crate::ws) async fn handle_start_now(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if parsed
        .payload
        .as_ref()
        .is_some_and(|payload| payload.as_object().is_none_or(|fields| !fields.is_empty()))
    {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidPlaybackPayload,
            "Invalid start payload",
        )
        .await;
        return;
    }
    let outcome = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let room = parsed
            .room
            .as_deref()
            .and_then(|room_id| rooms.get_mut(room_id));
        match room {
            None => Some((ErrorCode::RoomNotFound, "Room not found")),
            Some(room) if !room.clients.iter().any(|id| id == client_id) => Some((
                ErrorCode::NotRoomMember,
                "Client is not a member of this room",
            )),
            // As for a play: the host, or a guest when both share the controls.
            Some(room)
                if room.host_id != client_id
                    && !(clients
                        .get(client_id)
                        .is_some_and(|client| client.supports_shared_playback_control)
                        && clients
                            .get(&room.host_id)
                            .is_some_and(|client| client.supports_shared_playback_control)) =>
            {
                Some((
                    ErrorCode::HostPermissionRequired,
                    "Only the room host can control playback",
                ))
            }
            Some(room) => {
                // Nothing waits any more (it started or was paused): no error.
                start_pending_play(room, clients);
                None
            }
        }
    };
    if let Some((code, message)) = outcome {
        send_error(client_id, state, code, message).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::constants::{
        COUNTDOWN_MS, MAX_READY_WAIT_MS, PLAY_SCHEDULE_MS, START_WAIT_MS,
    };
    use super::super::{handle_leave_room, handle_playback, handle_ready};
    use super::*;
    use crate::messaging::OutboundMessage;
    use crate::test_helpers;
    use crate::types::{ClientMessageType, ServerMessageType, WsMessage};
    use crate::utils::now_ms;
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::sync::mpsc::Receiver;

    const MEMBERS: [(&str, &str); 3] = [("host", "Host"), ("ana", "Ana"), ("pablo", "Pablo")];

    fn message(msg_type: ClientMessageType, payload: Option<Value>) -> IncomingMessage {
        IncomingMessage {
            msg_type,
            room: Some("r1".to_string()),
            client: None,
            payload,
            ts: 1,
            server_ts: None,
        }
    }

    fn player_event(action: &str) -> IncomingMessage {
        message(
            ClientMessageType::PlayerEvent,
            Some(json!({ "action": action, "position": 30.0 })),
        )
    }

    fn readiness(payload: Value) -> IncomingMessage {
        message(ClientMessageType::Readiness, Some(payload))
    }

    /// A paused room `r1`: the host, Ana and Pablo, all ready and sharing the
    /// controls. `new` tells who has `start_when_ready`.
    async fn room(new: [bool; 3]) -> (SharedState, Vec<Receiver<OutboundMessage>>) {
        let state = test_helpers::create_state();
        let mut receivers = Vec::new();
        {
            let mut locked = state.write().await;
            for ((id, name), new) in MEMBERS.into_iter().zip(new) {
                let (mut client, rx) = test_helpers::create_client_with_rx(id, name, true);
                client.room_id = Some("r1".to_string());
                client.supports_shared_playback_control = true;
                client.supports_start_when_ready = new;
                locked.clients.insert(id.to_string(), client);
                receivers.push(rx);
            }
            let mut room = test_helpers::create_room("r1", "host");
            room.clients = MEMBERS.iter().map(|(id, _)| id.to_string()).collect();
            room.ready_clients = room.clients.iter().cloned().collect();
            room.state.position = 30.0;
            locked.rooms.insert("r1".to_string(), room);
        }
        (state, receivers)
    }

    fn drain(rx: &mut Receiver<OutboundMessage>) -> Vec<WsMessage> {
        std::iter::from_fn(|| test_helpers::recv_msg(rx)).collect()
    }

    fn of_type(messages: &[WsMessage], msg_type: ServerMessageType) -> Vec<Value> {
        messages
            .iter()
            .filter(|msg| msg.msg_type == msg_type)
            .map(|msg| msg.payload.clone().unwrap())
            .collect()
    }

    fn start_states(rx: &mut Receiver<OutboundMessage>) -> Vec<Value> {
        of_type(&drain(rx), ServerMessageType::StartState)
    }

    fn drain_all(receivers: &mut [Receiver<OutboundMessage>]) {
        receivers.iter_mut().for_each(|rx| {
            drain(rx);
        });
    }

    async fn set_not_ready(state: &SharedState, id: &str, reason: Option<NotReadyReason>) {
        let mut locked = state.write().await;
        let room = locked.rooms.get_mut("r1").unwrap();
        match reason {
            Some(NotReadyReason::Loading) => {
                room.ready_clients.remove(id);
            }
            Some(reason) => {
                room.not_ready.insert(id.to_string(), reason);
            }
            None => {}
        }
    }

    fn awaited(payload: &Value) -> Vec<(String, String)> {
        payload["waiting_for"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| {
                (
                    member["name"].as_str().unwrap().to_string(),
                    member["reason"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    fn named(names: &[(&str, &str)]) -> Vec<(String, String)> {
        names
            .iter()
            .map(|(name, reason)| (name.to_string(), reason.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn a_play_waits_for_the_members_that_are_not_ready_and_says_why() {
        let (state, mut rx) = room([true, true, false]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Loading)).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Buffering)).await;
        let tasks = crate::tasks::AppTasks::new();
        let before = now_ms();

        handle_playback("host", player_event("play"), &state, &tasks).await;

        let deadline = state.read().await.rooms["r1"]
            .pending_play
            .as_ref()
            .unwrap()
            .deadline_server_ts;
        assert!((before + START_WAIT_MS..=now_ms() + START_WAIT_MS).contains(&deadline));
        for rx in &mut rx[..2] {
            let messages = drain(rx);
            assert!(of_type(&messages, ServerMessageType::PlayerEvent).is_empty());
            let states = of_type(&messages, ServerMessageType::StartState);
            assert_eq!(states.len(), 1);
            assert_eq!(states[0]["state"], "waiting");
            assert_eq!(states[0]["position"], 30.0);
            assert_eq!(states[0]["deadline_server_ts"], deadline);
            assert_eq!(
                awaited(&states[0]),
                named(&[("Ana", "loading"), ("Pablo", "buffering")])
            );
            assert_eq!(states[0]["waiting_for"][0]["client"], "ana");
        }
        // Pablo's client doesn't know start_state.
        assert!(drain(&mut rx[2]).is_empty());
    }

    #[tokio::test]
    async fn an_older_client_play_keeps_the_short_wait() {
        let (state, _rx) = room([false, true, true]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Loading)).await;
        let before = now_ms();

        handle_playback(
            "host",
            player_event("play"),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let deadline = state.read().await.rooms["r1"]
            .pending_play
            .as_ref()
            .unwrap()
            .deadline_server_ts;
        assert!((before + MAX_READY_WAIT_MS..=now_ms() + MAX_READY_WAIT_MS).contains(&deadline));
    }

    #[tokio::test]
    async fn the_play_starts_when_the_last_member_is_ready() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Transcoding)).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Loading)).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Buffering)).await;
        let tasks = crate::tasks::AppTasks::new();
        handle_playback("host", player_event("play"), &state, &tasks).await;
        drain_all(&mut rx);

        // Ana's video loaded: what she said about loading is over.
        handle_ready(
            "ana",
            &message(ClientMessageType::Ready, Some(json!({}))),
            &state,
        )
        .await;
        let states = start_states(&mut rx[0]);
        assert_eq!(states.len(), 1);
        assert_eq!(awaited(&states[0]), named(&[("Pablo", "buffering")]));
        assert!(state.read().await.rooms["r1"].pending_play.is_some());
        drain_all(&mut rx);

        handle_readiness("pablo", &readiness(json!({ "ready": true })), &state).await;
        let before = now_ms();
        for rx in &mut rx {
            let messages = drain(rx);
            let plays = of_type(&messages, ServerMessageType::PlayerEvent);
            assert_eq!(plays.len(), 1);
            assert_eq!(plays[0]["action"], "play");
            let target = plays[0]["target_server_ts"].as_u64().unwrap();
            assert!(
                target <= before + PLAY_SCHEDULE_MS && target + 1000 >= before + PLAY_SCHEDULE_MS
            );
            let states = of_type(&messages, ServerMessageType::StartState);
            assert_eq!(states.len(), 1);
            assert_eq!(states[0]["state"], "starting");
            assert_eq!(states[0]["countdown"], false);
            assert_eq!(states[0]["target_server_ts"], target);
            assert_eq!(states[0]["without"], json!([]));
        }
        assert!(state.read().await.rooms["r1"].pending_play.is_none());
    }

    #[tokio::test]
    async fn ready_ends_loading_reasons_but_not_buffering() {
        let (state, _rx) = room([true, true, true]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Transcoding)).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Buffering)).await;
        for id in ["ana", "pablo"] {
            handle_ready(
                id,
                &message(ClientMessageType::Ready, Some(json!({}))),
                &state,
            )
            .await;
        }
        let locked = state.read().await;
        let not_ready = &locked.rooms["r1"].not_ready;
        assert!(!not_ready.contains_key("ana"));
        assert_eq!(not_ready.get("pablo"), Some(&NotReadyReason::Buffering));
    }

    #[tokio::test(start_paused = true)]
    async fn when_the_wait_runs_out_the_room_starts_and_names_who_was_left_behind() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::AutoplayBlocked)).await;
        let tasks = crate::tasks::AppTasks::new();
        handle_playback("pablo", player_event("play"), &state, &tasks).await;
        drain_all(&mut rx);
        // The timer starts waiting.
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_millis(START_WAIT_MS - 10)).await;
        tokio::task::yield_now().await;
        assert!(state.read().await.rooms["r1"].pending_play.is_some());

        tokio::time::advance(Duration::from_millis(20)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert!(state.read().await.rooms["r1"].pending_play.is_none());
        let messages = drain(&mut rx[0]);
        let plays = of_type(&messages, ServerMessageType::PlayerEvent);
        assert_eq!(plays.len(), 1);
        let states = of_type(&messages, ServerMessageType::StartState);
        assert_eq!(states[0]["state"], "starting");
        assert_eq!(
            states[0]["without"],
            json!([{ "client": "ana", "name": "Ana", "reason": "autoplay_blocked" }])
        );
    }

    #[tokio::test]
    async fn start_now_starts_a_waiting_play_without_the_ones_not_ready() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Loading)).await;
        let tasks = crate::tasks::AppTasks::new();
        handle_playback("host", player_event("play"), &state, &tasks).await;
        drain_all(&mut rx);

        handle_start_now("ana", &message(ClientMessageType::StartNow, None), &state).await;

        assert!(state.read().await.rooms["r1"].pending_play.is_none());
        let messages = drain(&mut rx[1]);
        assert!(of_type(&messages, ServerMessageType::Error).is_empty());
        assert_eq!(of_type(&messages, ServerMessageType::PlayerEvent).len(), 1);
        let states = of_type(&messages, ServerMessageType::StartState);
        assert_eq!(
            states[0]["without"],
            json!([{ "client": "pablo", "name": "Pablo", "reason": "loading" }])
        );
        drain_all(&mut rx);

        // Nothing waits any more: no error, no message.
        handle_start_now(
            "host",
            &message(ClientMessageType::StartNow, Some(json!({}))),
            &state,
        )
        .await;
        assert!(drain(&mut rx[0]).is_empty());
    }

    #[tokio::test]
    async fn start_now_is_for_those_who_may_play() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Loading)).await;
        handle_playback(
            "host",
            player_event("play"),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;
        drain_all(&mut rx);
        state
            .write()
            .await
            .clients
            .get_mut("ana")
            .unwrap()
            .supports_shared_playback_control = false;
        let (outsider, mut outsider_rx) = test_helpers::create_client_with_rx("out", "Out", true);
        state.write().await.clients.insert("out".into(), outsider);

        for (id, rx, code) in [
            ("ana", &mut rx[1], "HOST_PERMISSION_REQUIRED"),
            ("out", &mut outsider_rx, "NOT_ROOM_MEMBER"),
        ] {
            handle_start_now(id, &message(ClientMessageType::StartNow, None), &state).await;
            let errors = of_type(&drain(rx), ServerMessageType::Error);
            assert_eq!(errors[0]["code"], code);
        }
        handle_start_now(
            "host",
            &message(ClientMessageType::StartNow, Some(json!({ "now": true }))),
            &state,
        )
        .await;
        assert_eq!(
            of_type(&drain(&mut rx[0]), ServerMessageType::Error)[0]["code"],
            "INVALID_PLAYBACK_PAYLOAD"
        );
        assert!(state.read().await.rooms["r1"].pending_play.is_some());
    }

    #[tokio::test]
    async fn a_pause_ends_the_wait() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Loading)).await;
        let tasks = crate::tasks::AppTasks::new();
        handle_playback("host", player_event("play"), &state, &tasks).await;
        drain_all(&mut rx);

        handle_playback("ana", player_event("pause"), &state, &tasks).await;

        assert!(state.read().await.rooms["r1"].pending_play.is_none());
        let messages = drain(&mut rx[0]);
        assert_eq!(
            of_type(&messages, ServerMessageType::PlayerEvent)[0]["action"],
            "pause"
        );
        assert_eq!(
            of_type(&messages, ServerMessageType::StartState),
            vec![json!({ "state": "idle" })]
        );
        // A pause with nothing waiting says nothing more.
        handle_playback("ana", player_event("pause"), &state, &tasks).await;
        assert!(start_states(&mut rx[0]).is_empty());
    }

    #[tokio::test]
    async fn the_first_play_of_the_item_counts_down_once() {
        let (state, mut rx) = room([true, true, false]).await;
        state
            .write()
            .await
            .rooms
            .get_mut("r1")
            .unwrap()
            .countdown_pending = true;
        let tasks = crate::tasks::AppTasks::new();

        handle_playback("host", player_event("play"), &state, &tasks).await;

        let messages = drain(&mut rx[1]);
        let play = &of_type(&messages, ServerMessageType::PlayerEvent)[0];
        let event_ts = messages
            .iter()
            .find(|msg| msg.msg_type == ServerMessageType::PlayerEvent)
            .unwrap()
            .server_ts
            .unwrap();
        assert_eq!(
            play["target_server_ts"].as_u64().unwrap() - event_ts,
            COUNTDOWN_MS
        );
        let states = of_type(&messages, ServerMessageType::StartState);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["state"], "starting");
        assert_eq!(states[0]["countdown"], true);
        assert_eq!(states[0]["target_server_ts"], play["target_server_ts"]);
        // Pablo's older client starts at the target too, without the countdown.
        let older = drain(&mut rx[2]);
        assert_eq!(
            of_type(&older, ServerMessageType::PlayerEvent)[0]["target_server_ts"],
            play["target_server_ts"]
        );
        assert!(of_type(&older, ServerMessageType::StartState).is_empty());
        assert!(!state.read().await.rooms["r1"].countdown_pending);

        // A later play doesn't count down.
        tokio::time::sleep(Duration::from_millis(1)).await;
        handle_playback("host", player_event("pause"), &state, &tasks).await;
        handle_playback("host", player_event("play"), &state, &tasks).await;
        let messages = drain(&mut rx[1]);
        let last = messages
            .iter()
            .rev()
            .find(|msg| msg.msg_type == ServerMessageType::PlayerEvent)
            .unwrap();
        assert_eq!(
            last.payload.as_ref().unwrap()["target_server_ts"]
                .as_u64()
                .unwrap()
                - last.server_ts.unwrap(),
            PLAY_SCHEDULE_MS
        );
        assert!(of_type(&messages, ServerMessageType::StartState).is_empty());
    }

    #[tokio::test]
    async fn whether_a_waiting_play_counts_down_is_set_when_it_is_asked() {
        for (asked_new, later_new, counts_down) in [(true, false, true), (false, true, false)] {
            let (state, mut rx) = room([asked_new, true, true]).await;
            state
                .write()
                .await
                .rooms
                .get_mut("r1")
                .unwrap()
                .countdown_pending = true;
            set_not_ready(&state, "ana", Some(NotReadyReason::Loading)).await;
            handle_playback(
                "host",
                player_event("play"),
                &state,
                &crate::tasks::AppTasks::new(),
            )
            .await;
            drain_all(&mut rx);
            // The host's client reconnects with another feature set meanwhile.
            state
                .write()
                .await
                .clients
                .get_mut("host")
                .unwrap()
                .supports_start_when_ready = later_new;

            handle_ready(
                "ana",
                &message(ClientMessageType::Ready, Some(json!({}))),
                &state,
            )
            .await;

            let messages = drain(&mut rx[1]);
            let event = messages
                .iter()
                .find(|msg| msg.msg_type == ServerMessageType::PlayerEvent)
                .unwrap();
            let lead = event.payload.as_ref().unwrap()["target_server_ts"]
                .as_u64()
                .unwrap()
                - now_ms();
            if counts_down {
                assert!(lead > PLAY_SCHEDULE_MS, "{lead}");
            } else {
                assert!(lead <= PLAY_SCHEDULE_MS, "{lead}");
            }
            assert_eq!(
                of_type(&messages, ServerMessageType::StartState)[0]["countdown"],
                counts_down
            );
        }
    }

    #[tokio::test]
    async fn an_older_client_play_never_counts_down() {
        let (state, mut rx) = room([false, true, true]).await;
        state
            .write()
            .await
            .rooms
            .get_mut("r1")
            .unwrap()
            .countdown_pending = true;

        handle_playback(
            "host",
            player_event("play"),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        let messages = drain(&mut rx[1]);
        let event = messages
            .iter()
            .find(|msg| msg.msg_type == ServerMessageType::PlayerEvent)
            .unwrap();
        assert_eq!(
            event.payload.as_ref().unwrap()["target_server_ts"]
                .as_u64()
                .unwrap()
                - event.server_ts.unwrap(),
            PLAY_SCHEDULE_MS
        );
        assert!(of_type(&messages, ServerMessageType::StartState).is_empty());
        assert!(!state.read().await.rooms["r1"].countdown_pending);
    }

    #[tokio::test]
    async fn the_host_playing_on_its_own_starts_the_item() {
        let (state, _rx) = room([true, true, true]).await;
        state
            .write()
            .await
            .rooms
            .get_mut("r1")
            .unwrap()
            .countdown_pending = true;

        handle_playback(
            "host",
            message(
                ClientMessageType::StateUpdate,
                Some(json!({ "position": 31.0, "play_state": "playing" })),
            ),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;

        assert!(!state.read().await.rooms["r1"].countdown_pending);
    }

    #[tokio::test]
    async fn a_member_that_leaves_is_no_longer_awaited() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "ana", Some(NotReadyReason::Loading)).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Buffering)).await;
        let tasks = crate::tasks::AppTasks::new();
        handle_playback("host", player_event("play"), &state, &tasks).await;
        drain_all(&mut rx);

        handle_leave_room("pablo", &state).await;
        let states = start_states(&mut rx[0]);
        assert_eq!(awaited(&states[0]), named(&[("Ana", "loading")]));
        assert!(!state.read().await.rooms["r1"]
            .not_ready
            .contains_key("pablo"));

        handle_leave_room("ana", &state).await;
        let messages = drain(&mut rx[0]);
        assert_eq!(of_type(&messages, ServerMessageType::PlayerEvent).len(), 1);
        assert_eq!(
            of_type(&messages, ServerMessageType::StartState)[0]["state"],
            "starting"
        );
    }

    #[tokio::test]
    async fn the_host_leaving_ends_the_wait() {
        let (state, mut rx) = room([true, true, true]).await;
        for id in ["ana", "pablo"] {
            state
                .write()
                .await
                .clients
                .get_mut(id)
                .unwrap()
                .supports_host_transfer = true;
        }
        set_not_ready(&state, "pablo", Some(NotReadyReason::Loading)).await;
        handle_playback(
            "host",
            player_event("play"),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;
        drain_all(&mut rx);

        handle_leave_room("host", &state).await;

        assert!(state.read().await.rooms["r1"].pending_play.is_none());
        let messages = drain(&mut rx[1]);
        assert!(of_type(&messages, ServerMessageType::PlayerEvent).is_empty());
        assert_eq!(
            of_type(&messages, ServerMessageType::StartState),
            vec![json!({ "state": "idle" })]
        );
    }

    #[tokio::test]
    async fn readiness_is_stored_and_checked() {
        let (state, mut rx) = room([true, true, true]).await;
        for (id, payload) in [
            ("ana", json!({ "ready": false, "reason": "transcoding" })),
            ("pablo", json!({ "ready": false, "reason": "buffering" })),
        ] {
            handle_readiness(id, &readiness(payload), &state).await;
        }
        {
            let locked = state.read().await;
            let room = &locked.rooms["r1"];
            assert_eq!(
                room.not_ready.get("ana"),
                Some(&NotReadyReason::Transcoding)
            );
            assert_eq!(
                room.not_ready.get("pablo"),
                Some(&NotReadyReason::Buffering)
            );
            assert!(!crate::ws::pending_play::all_ready(room));
        }
        handle_readiness("pablo", &readiness(json!({ "ready": true })), &state).await;
        assert!(!state.read().await.rooms["r1"]
            .not_ready
            .contains_key("pablo"));

        for payload in [
            json!({ "ready": true, "reason": "loading" }),
            json!({ "ready": false }),
            json!({ "ready": false, "reason": "sleepy" }),
            json!({ "ready": true, "extra": 1 }),
            json!("ready"),
        ] {
            handle_readiness("ana", &readiness(payload), &state).await;
            assert_eq!(
                of_type(&drain(&mut rx[1]), ServerMessageType::Error)[0]["code"],
                "INVALID_READY"
            );
        }
        handle_readiness("ana", &message(ClientMessageType::Readiness, None), &state).await;
        assert_eq!(
            of_type(&drain(&mut rx[1]), ServerMessageType::Error)[0]["code"],
            "INVALID_READY"
        );
        assert_eq!(
            state.read().await.rooms["r1"].not_ready.get("ana"),
            Some(&NotReadyReason::Transcoding)
        );

        let (outsider, mut outsider_rx) = test_helpers::create_client_with_rx("out", "Out", true);
        state.write().await.clients.insert("out".into(), outsider);
        handle_readiness("out", &readiness(json!({ "ready": true })), &state).await;
        assert_eq!(
            of_type(&drain(&mut outsider_rx), ServerMessageType::Error)[0]["code"],
            "NOT_IN_ROOM"
        );
    }

    #[tokio::test]
    async fn the_waiting_list_is_sent_again_only_when_it_changes() {
        let (state, mut rx) = room([true, true, true]).await;
        set_not_ready(&state, "pablo", Some(NotReadyReason::Loading)).await;
        handle_playback(
            "host",
            player_event("play"),
            &state,
            &crate::tasks::AppTasks::new(),
        )
        .await;
        drain_all(&mut rx);

        let buffering = json!({ "ready": false, "reason": "buffering" });
        handle_readiness("ana", &readiness(buffering.clone()), &state).await;
        let states = start_states(&mut rx[0]);
        assert_eq!(
            awaited(&states[0]),
            named(&[("Ana", "buffering"), ("Pablo", "loading")])
        );
        handle_readiness("ana", &readiness(buffering), &state).await;
        assert!(start_states(&mut rx[0]).is_empty());
    }
}
