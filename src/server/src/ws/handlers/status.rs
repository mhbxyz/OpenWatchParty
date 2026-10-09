use super::super::dispatch::is_authenticated;
use crate::messaging::{collect_room_senders, send_to_senders};
use crate::room::participant_statuses_message;
use crate::types::{Client, IncomingMessage, Room, ServerState, SharedState};
use log::debug;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time::{Duration, Instant};

/// The statuses a participant may report about themselves.
pub(crate) const PARTICIPANT_STATUSES: [&str; 8] = [
    "playing",
    "paused",
    "in_sync",
    "catching_up",
    "buffering",
    "loading",
    "blocked",
    "not_watching",
];

/// A room gets at most one `participant_statuses` per interval for status
/// changes: the first change goes out at once, and the ones that follow
/// within the interval go out together when it ends, with the latest
/// statuses. However many members change status, the room redraws its list at
/// most four times a second, and no change is dropped.
pub(crate) const STATUS_BROADCAST_INTERVAL: Duration = Duration::from_millis(250);

/// Tells scheduled flushes apart, also across rooms recreated under the same id.
static NEXT_FLUSH_TICKET: AtomicU64 = AtomicU64::new(0);

/// The payload must be exactly `{ "status": <one of PARTICIPANT_STATUSES> }`.
fn valid_status(payload: Option<&serde_json::Value>) -> Option<&'static str> {
    let object = payload?.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let status = object.get("status")?.as_str()?;
    PARTICIPANT_STATUSES
        .iter()
        .copied()
        .find(|known| *known == status)
}

/// Sends the room its statuses. Callers hold the state's write lock, as every
/// sender of participant messages does, so all members get them in the order
/// the state changed.
fn broadcast_statuses(room: &mut Room, clients: &HashMap<String, Client>) {
    room.status_broadcast.last_sent_at = Some(Instant::now());
    // This snapshot has every change so far: a flush still scheduled would
    // only repeat it.
    room.status_broadcast.scheduled_flush = None;
    let senders = collect_room_senders(room, clients, None);
    send_to_senders(
        &senders,
        &participant_statuses_message(room),
        "participant statuses",
    );
}

/// Stores a member's new status and either sends the room its statuses or
/// schedules the flush that will, returning the room, the time and the ticket
/// to flush with. Runs under the state's write lock.
fn record_status(
    state: &mut ServerState,
    client_id: &str,
    status: &'static str,
) -> Option<(String, Instant, u64)> {
    let ServerState { clients, rooms } = state;
    let room_id = clients.get(client_id)?.room_id.clone()?;
    let room = rooms.get_mut(&room_id)?;
    if !room.clients.iter().any(|id| id == client_id)
        || room.statuses.get(client_id) == Some(&status)
    {
        return None;
    }
    room.statuses.insert(client_id.to_string(), status);
    let next_allowed = room
        .status_broadcast
        .last_sent_at
        .map(|last| last + STATUS_BROADCAST_INTERVAL)
        .filter(|next| *next > Instant::now());
    let Some(flush_at) = next_allowed else {
        broadcast_statuses(room, clients);
        return None;
    };
    if room.status_broadcast.scheduled_flush.is_some() {
        return None;
    }
    let ticket = NEXT_FLUSH_TICKET.fetch_add(1, Ordering::Relaxed);
    room.status_broadcast.scheduled_flush = Some(ticket);
    Some((room_id, flush_at, ticket))
}

/// `participant_status`: a member reports how they are doing (in sync,
/// buffering, blocked by autoplay...). Informational only: an invalid or
/// unchanged status is ignored without an error, and the room gets the new
/// `participant_statuses` only when a status changes.
pub(in crate::ws) async fn handle_participant_status(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if !is_authenticated(client_id, state).await {
        return;
    }
    let Some(status) = valid_status(parsed.payload.as_ref()) else {
        debug!("Ignoring invalid participant status client_id={client_id}");
        return;
    };
    let Some((room_id, flush_at, ticket)) =
        record_status(&mut *state.write().await, client_id, status)
    else {
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(flush_at).await;
        let mut locked = state.write().await;
        let ServerState { clients, rooms } = &mut *locked;
        // Sent meanwhile, or another room under the same id: nothing to do.
        if let Some(room) = rooms
            .get_mut(&room_id)
            .filter(|room| room.status_broadcast.scheduled_flush == Some(ticket))
        {
            broadcast_statuses(room, clients);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::{ClientMessageType, WsMessage};

    fn status_message(payload: serde_json::Value) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::ParticipantStatus,
            room: None,
            client: None,
            payload: Some(payload),
            ts: 0,
            server_ts: None,
        }
    }

    fn statuses(message: &WsMessage) -> serde_json::Value {
        assert_eq!(message.msg_type, "participant_statuses");
        message.payload.as_ref().unwrap()["statuses"].clone()
    }

    // A room with a host and a guest, both members; returns their receivers.
    async fn room_with_guest(
        state: &SharedState,
    ) -> (
        tokio::sync::mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
        tokio::sync::mpsc::Receiver<Result<warp::ws::Message, warp::Error>>,
    ) {
        let mut locked = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *locked;
        let host_rx = test_helpers::setup_room_with_host(clients, rooms, "host");
        let (mut guest, guest_rx) = test_helpers::create_client_with_rx("guest", "Ana", true);
        guest.room_id = Some("room-1".to_string());
        clients.insert("guest".to_string(), guest);
        rooms
            .get_mut("room-1")
            .unwrap()
            .clients
            .push("guest".to_string());
        (host_rx, guest_rx)
    }

    #[test]
    fn accepts_only_the_known_statuses_alone() {
        for known in PARTICIPANT_STATUSES {
            assert_eq!(
                valid_status(Some(&serde_json::json!({ "status": known }))),
                Some(known)
            );
        }
        for payload in [
            serde_json::json!({ "status": "dancing" }),
            serde_json::json!({ "status": "IN_SYNC" }),
            serde_json::json!({ "status": 1 }),
            serde_json::json!({ "status": "in_sync", "extra": true }),
            serde_json::json!({}),
            serde_json::json!("in_sync"),
        ] {
            assert_eq!(valid_status(Some(&payload)), None, "{payload}");
        }
        assert_eq!(valid_status(None), None);
    }

    #[tokio::test]
    async fn a_new_status_reaches_the_whole_room_in_list_order() {
        let state = test_helpers::create_state();
        let (mut host_rx, mut guest_rx) = room_with_guest(&state).await;

        handle_participant_status(
            "guest",
            &status_message(serde_json::json!({ "status": "blocked" })),
            &state,
        )
        .await;

        let to_host = test_helpers::recv_msg(&mut host_rx).unwrap();
        let to_guest = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(statuses(&to_host), serde_json::json!([null, "blocked"]));
        assert_eq!(statuses(&to_guest), serde_json::json!([null, "blocked"]));
        assert_eq!(to_host.room.as_deref(), Some("room-1"));
    }

    async fn send_status(state: &SharedState, client_id: &str, status: &str) {
        handle_participant_status(
            client_id,
            &status_message(serde_json::json!({ "status": status })),
            state,
        )
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_unchanged_or_invalid_status_sends_nothing() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        send_status(&state, "guest", "in_sync").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());

        send_status(&state, "guest", "in_sync").await;
        send_status(&state, "guest", "dancing").await;
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL * 2).await;

        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn changes_within_the_interval_go_out_together_when_it_ends() {
        let state = test_helpers::create_state();
        let (mut host_rx, mut guest_rx) = room_with_guest(&state).await;
        send_status(&state, "guest", "in_sync").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());
        assert!(test_helpers::recv_msg(&mut guest_rx).is_some());

        send_status(&state, "guest", "buffering").await;
        send_status(&state, "host", "playing").await;
        // One flush per interval: later changes do not schedule another.
        assert!(record_status(&mut *state.write().await, "guest", "catching_up").is_none());
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL - Duration::from_millis(1)).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());

        tokio::time::sleep(Duration::from_millis(2)).await;
        for rx in [&mut host_rx, &mut guest_rx] {
            assert_eq!(
                statuses(&test_helpers::recv_msg(rx).unwrap()),
                serde_json::json!(["playing", "catching_up"])
            );
            assert!(test_helpers::recv_msg(rx).is_none());
        }

        // The flush starts a new interval, and the next change waits for it.
        send_status(&state, "guest", "in_sync").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL).await;
        assert_eq!(
            statuses(&test_helpers::recv_msg(&mut host_rx).unwrap()),
            serde_json::json!(["playing", "in_sync"])
        );
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL * 2).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_change_after_a_quiet_interval_goes_out_at_once() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        send_status(&state, "guest", "in_sync").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());

        tokio::time::sleep(STATUS_BROADCAST_INTERVAL).await;
        send_status(&state, "guest", "buffering").await;

        assert_eq!(
            statuses(&test_helpers::recv_msg(&mut host_rx).unwrap()),
            serde_json::json!([null, "buffering"])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_room_recreated_under_the_same_id_keeps_its_own_flush() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        send_status(&state, "guest", "in_sync").await;
        send_status(&state, "guest", "buffering").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL / 2).await;
        {
            let mut locked = state.write().await;
            let mut fresh = test_helpers::create_room("room-1", "host");
            fresh.clients.push("guest".to_string());
            locked.rooms.insert("room-1".to_string(), fresh);
        }
        // The new room sends its first change at once and schedules the next.
        send_status(&state, "guest", "in_sync").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());
        send_status(&state, "guest", "loading").await;

        // The old room's flush comes due first and leaves the new room alone.
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL / 2 + Duration::from_millis(1)).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());

        tokio::time::sleep(STATUS_BROADCAST_INTERVAL / 2).await;
        assert_eq!(
            statuses(&test_helpers::recv_msg(&mut host_rx).unwrap()),
            serde_json::json!([null, "loading"])
        );
        tokio::time::sleep(STATUS_BROADCAST_INTERVAL * 2).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_change_sent_while_a_due_flush_waits_for_the_lock_cancels_it() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        send_status(&state, "guest", "in_sync").await;
        send_status(&state, "guest", "buffering").await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_some());
        {
            // The flush comes due while the lock is taken, and a new change
            // gets the lock first.
            let mut locked = state.write().await;
            tokio::time::sleep(STATUS_BROADCAST_INTERVAL * 2).await;
            assert!(record_status(&mut locked, "host", "playing").is_none());
        }
        assert_eq!(
            statuses(&test_helpers::recv_msg(&mut host_rx).unwrap()),
            serde_json::json!(["playing", "buffering"])
        );

        tokio::time::sleep(STATUS_BROADCAST_INTERVAL).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }

    #[tokio::test]
    async fn clients_outside_a_room_are_ignored() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        let (outsider, _outsider_rx) = test_helpers::create_client_with_rx("outsider", "Eve", true);
        state
            .write()
            .await
            .clients
            .insert("outsider".to_string(), outsider);

        handle_participant_status(
            "outsider",
            &status_message(serde_json::json!({ "status": "playing" })),
            &state,
        )
        .await;
        handle_participant_status(
            "missing",
            &status_message(serde_json::json!({ "status": "playing" })),
            &state,
        )
        .await;

        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        assert!(state.read().await.rooms["room-1"].statuses.is_empty());
    }

    #[tokio::test]
    async fn a_client_whose_room_dropped_it_is_ignored() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        state
            .write()
            .await
            .rooms
            .get_mut("room-1")
            .unwrap()
            .clients
            .retain(|id| id != "guest");

        handle_participant_status(
            "guest",
            &status_message(serde_json::json!({ "status": "playing" })),
            &state,
        )
        .await;

        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }
}
