use crate::messaging::{broadcast_room_list, collect_room_senders, send_to_senders, ClientSender};
use crate::room::{close_room_parts, participant_list_message, participant_statuses_message};
use crate::tasks::AppTasks;
use crate::types::{Client, PendingHostReconnect, Room, ServerMessageType, SharedState, WsMessage};
use crate::utils::now_ms;
use crate::ws::pending_play::{recheck_pending_play, send_idle};
use log::info;
use std::collections::HashMap;
use std::time::Duration;

const HOST_RECONNECT_GRACE: Duration = Duration::from_secs(10);

/// Senders of the remaining room members, and the messages to send them in order.
pub type LeaveNotification = (Vec<ClientSender>, Vec<WsMessage>);

enum LeaveOutcome {
    Left(LeaveNotification),
    Close(String),
}

fn client_left_message(room_id: &str, client_id: &str, participant_count: usize) -> WsMessage {
    WsMessage {
        msg_type: ServerMessageType::ClientLeft,
        room: Some(room_id.to_string()),
        client: Some(client_id.to_string()),
        payload: Some(serde_json::json!({ "participant_count": participant_count })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

pub(crate) fn host_changed_message(room_id: &str, host_id: &str, host_name: &str) -> WsMessage {
    WsMessage {
        msg_type: ServerMessageType::HostChanged,
        room: Some(room_id.to_string()),
        client: None,
        payload: Some(serde_json::json!({
            "host_id": host_id,
            "host_name": host_name,
        })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

fn promote_next_host(
    room_id: &str,
    room: &mut Room,
    clients: &HashMap<String, Client>,
) -> Option<WsMessage> {
    let new_host_id = room
        .clients
        .iter()
        .find(|id| {
            clients
                .get(*id)
                .is_some_and(|client| client.supports_host_transfer)
        })?
        .clone();
    let host_name = clients
        .get(&new_host_id)
        .map(|client| client.user_name.clone())
        .unwrap_or_default();
    room.host_id = new_host_id.clone();
    room.pending_host_reconnect = None;
    crate::room::send_room_capabilities(room, clients);
    Some(host_changed_message(room_id, &new_host_id, &host_name))
}

fn detach_client_from_room(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
    allow_host_transfer: bool,
) -> Option<LeaveOutcome> {
    let client = clients.get_mut(client_id)?;
    let room_id = client.room_id.take()?;
    let room = rooms.get_mut(&room_id)?;

    room.clients.retain(|id| id != client_id);
    room.ready_clients.remove(client_id);
    room.statuses.remove(client_id);
    room.not_ready.remove(client_id);
    // The host's play waits no more; another member's goes on without the
    // one that left.
    let wait_ended = room.host_id == client_id && room.pending_play.take().is_some();

    if room.clients.is_empty() && room.pending_host_reconnect.is_none() {
        Some(LeaveOutcome::Close(room_id))
    } else {
        if wait_ended {
            send_idle(room, clients);
        } else {
            recheck_pending_play(room, clients);
        }
        let client_left = client_left_message(&room_id, client_id, room.clients.len());
        let mut messages = vec![client_left];
        if room.host_id == client_id {
            if !allow_host_transfer {
                return Some(LeaveOutcome::Close(room_id));
            }
            room.pending_host_reconnect = None;
            let Some(host_changed) = promote_next_host(&room_id, room, clients) else {
                return Some(LeaveOutcome::Close(room_id));
            };
            messages.push(host_changed);
        }
        messages.push(participant_list_message(room, clients));
        messages.push(participant_statuses_message(room));
        let senders = collect_room_senders(room, clients, None);
        Some(LeaveOutcome::Left((senders, messages)))
    }
}

fn begin_host_reconnect_grace(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<(String, u64, LeaveNotification)> {
    let client = clients.get_mut(client_id)?;
    let room_id = client.room_id.clone()?;
    if client.user_id.is_empty()
        || client.session_expires_at.is_none()
        || !client.supports_host_transfer
    {
        return None;
    }
    let room = rooms.get_mut(&room_id)?;
    if room.host_id != client_id {
        return None;
    }

    let generation = crate::types::next_host_reconnect_generation();
    let user_id = client.user_id.clone();
    client.room_id = None;
    room.clients.retain(|id| id != client_id);
    room.ready_clients.remove(client_id);
    room.statuses.remove(client_id);
    room.not_ready.remove(client_id);
    if room.pending_play.take().is_some() {
        send_idle(room, clients);
    }
    room.pending_host_reconnect = Some(PendingHostReconnect {
        user_id,
        generation,
    });

    let messages = vec![
        client_left_message(&room_id, client_id, room.clients.len()),
        participant_list_message(room, clients),
        participant_statuses_message(room),
    ];
    let senders = collect_room_senders(room, clients, None);
    Some((room_id, generation, (senders, messages)))
}

async fn expire_host_reconnect(room_id: String, generation: u64, state: SharedState) {
    let notification = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        let matches_pending = rooms
            .get(&room_id)
            .and_then(|room| room.pending_host_reconnect.as_ref())
            .is_some_and(|pending| pending.generation == generation);
        if !matches_pending {
            None
        } else {
            let room = rooms.get_mut(&room_id).expect("pending room still exists");
            room.pending_host_reconnect = None;
            if let Some(host_changed) = promote_next_host(&room_id, room, clients) {
                info!("Host reconnect grace expired for room {room_id}; transferred host role");
                let messages = vec![
                    host_changed,
                    participant_list_message(room, clients),
                    participant_statuses_message(room),
                ];
                Some((collect_room_senders(room, clients, None), messages))
            } else {
                info!("Host reconnect grace expired for room {room_id}; closing room");
                let (senders, message) = close_and_notify(&room_id, clients, rooms);
                Some((senders, vec![message]))
            }
        }
    };

    if let Some(notification) = notification {
        send_leave_notification(&notification, "host reconnect grace expiry");
        broadcast_room_list(&state).await;
    }
}

fn schedule_host_reconnect_expiry(
    room_id: String,
    generation: u64,
    state: SharedState,
    tasks: &AppTasks,
) {
    let cancellation = tasks.cancellation_token();
    drop(tasks.spawn(async move {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(HOST_RECONNECT_GRACE) => {}
        }
        if !cancellation.is_cancelled() {
            expire_host_reconnect(room_id, generation, state).await;
        }
    }));
}

fn close_and_notify(
    room_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> (Vec<ClientSender>, WsMessage) {
    let senders = close_room_parts(room_id, clients, rooms).unwrap_or_default();
    let msg = WsMessage {
        msg_type: ServerMessageType::RoomClosed,
        room: Some(room_id.to_string()),
        client: None,
        payload: Some(serde_json::json!({ "reason": "Host left the room" })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    (senders, msg)
}

pub fn handle_leave(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<LeaveNotification> {
    handle_leave_with_transfer(client_id, clients, rooms, true)
}

pub(crate) fn handle_leave_without_transfer(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
) -> Option<LeaveNotification> {
    handle_leave_with_transfer(client_id, clients, rooms, false)
}

fn handle_leave_with_transfer(
    client_id: &str,
    clients: &mut HashMap<String, Client>,
    rooms: &mut HashMap<String, Room>,
    allow_host_transfer: bool,
) -> Option<LeaveNotification> {
    match detach_client_from_room(client_id, clients, rooms, allow_host_transfer) {
        Some(LeaveOutcome::Left(notification)) => Some(notification),
        Some(LeaveOutcome::Close(room_id)) => {
            let (senders, msg) = close_and_notify(&room_id, clients, rooms);
            Some((senders, vec![msg]))
        }
        None => None,
    }
}

pub fn send_leave_notification(notification: &LeaveNotification, context: &str) {
    let (senders, messages) = notification;
    for msg in messages {
        send_to_senders(senders, msg, context);
    }
}

/// Removes a client and leaves its room. Returns whether the client was
/// still registered.
pub async fn handle_disconnect(client_id: &str, state: &SharedState, tasks: &AppTasks) -> bool {
    handle_disconnect_if(client_id, state, tasks, |_| true).await
}

/// Like [`handle_disconnect`], but keeps a registered client for which
/// `should_remove` is false. The check runs under the write lock that removes
/// the client, so nothing can change it in between.
pub(crate) async fn handle_disconnect_if(
    client_id: &str,
    state: &SharedState,
    tasks: &AppTasks,
    should_remove: impl FnOnce(&Client) -> bool,
) -> bool {
    let (reconnect_grace, removed, left_room) = {
        let mut state = state.write().await;
        let crate::types::ServerState { clients, rooms } = &mut *state;
        if clients
            .get(client_id)
            .is_some_and(|client| !should_remove(client))
        {
            return false;
        }
        let room_id = clients.get(client_id).and_then(|c| c.room_id.clone());
        info!(
            "Disconnecting client client_id={client_id} room_id={}",
            room_id.as_deref().unwrap_or("-")
        );
        let reconnect_grace = begin_host_reconnect_grace(client_id, clients, rooms);
        let mut left_room = reconnect_grace.is_some();
        if let Some((room_id, _, notification)) = &reconnect_grace {
            info!("Holding host role in room {room_id} for reconnect grace");
            send_leave_notification(notification, "host reconnect grace");
        } else if let Some(notification) = handle_leave(client_id, clients, rooms) {
            left_room = true;
            send_leave_notification(&notification, "leave notification");
        }
        let removed = clients.remove(client_id).is_some();
        (
            reconnect_grace.map(|(room_id, generation, _)| (room_id, generation)),
            removed,
            left_room,
        )
    };
    if let Some((room_id, generation)) = reconnect_grace {
        schedule_host_reconnect_expiry(room_id, generation, state.clone(), tasks);
    }
    // Only a client that was in a room changes the room list.
    if left_room {
        broadcast_room_list(state).await;
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::AppTasks;
    use crate::test_helpers;
    use crate::types::PendingPlay;

    #[test]
    fn detach_client_removes_from_room() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host-1");

        let (mut guest, _rx_g) = test_helpers::create_client_with_rx("ug", "Guest", true);
        guest.room_id = Some("room-1".to_string());
        clients.insert("guest-1".to_string(), guest);
        rooms
            .get_mut("room-1")
            .unwrap()
            .clients
            .push("guest-1".to_string());

        // Detach the guest (non-host) — room still has host, so it stays open
        detach_client_from_room("guest-1", &mut clients, &mut rooms, true);

        let room = rooms.get("room-1").unwrap();
        assert!(!room.clients.contains(&"guest-1".to_string()));
        assert!(clients.get("guest-1").unwrap().room_id.is_none());
    }

    #[test]
    fn detach_host_clears_pending_play() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host-1");

        rooms.get_mut("room-1").unwrap().pending_play = Some(PendingPlay {
            initiator_id: "host".to_string(),
            position: 10.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: 0,
            deadline_server_ts: 0,
            shows_start: false,
        });

        detach_client_from_room("host-1", &mut clients, &mut rooms, true);

        // Room should be returned for closing (host left)
        // The pending_play is cleared before close_and_notify removes the room
        assert!(clients.get("host-1").unwrap().room_id.is_none());
    }

    #[test]
    fn detach_client_not_in_room() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (client, _rx) = test_helpers::create_client_with_rx("u1", "User", true);
        clients.insert("c1".to_string(), client);

        let result = detach_client_from_room("c1", &mut clients, &mut rooms, true);
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn host_disconnect_clears_guest_room_membership() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            locked.rooms.insert("room".to_string(), room);
        }

        handle_disconnect("host", &state, &AppTasks::new()).await;

        let locked = state.read().await;
        assert!(!locked.rooms.contains_key("room"));
        assert!(!locked.clients.contains_key("host"));
        assert!(locked.clients["guest"].room_id.is_none());
        drop(locked);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::RoomClosed
        );
    }

    #[tokio::test]
    async fn guest_disconnect_sends_the_updated_participant_list() {
        let state = test_helpers::create_state();
        let (mut host, mut host_rx) = test_helpers::create_client_with_rx("u1", "Franco", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("u2", "Ana", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            for (id, status) in [("host", "playing"), ("guest", "blocked")] {
                room.statuses.insert(id.to_string(), status);
            }
            locked.rooms.insert("room".to_string(), room);
        }

        handle_disconnect("guest", &state, &AppTasks::new()).await;

        assert_eq!(
            test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
            ServerMessageType::ClientLeft
        );
        let list = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(list.msg_type, ServerMessageType::ParticipantList);
        assert_eq!(
            list.payload.unwrap()["participants"],
            serde_json::json!([{ "name": "Franco", "is_host": true }])
        );
        let statuses = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(statuses.msg_type, ServerMessageType::ParticipantStatuses);
        assert_eq!(
            statuses.payload.unwrap()["statuses"],
            serde_json::json!(["playing"])
        );
        assert!(!state.read().await.rooms["room"]
            .statuses
            .contains_key("guest"));
    }

    #[tokio::test]
    async fn host_leave_promotes_first_supporting_member_in_message_order() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut legacy, _legacy_rx) =
            test_helpers::create_client_with_rx("legacy", "Legacy", true);
        let (mut next, mut next_rx) = test_helpers::create_client_with_rx("next", "Next", true);
        let (mut later, _later_rx) = test_helpers::create_client_with_rx("later", "Later", true);
        for client in [&mut host, &mut legacy, &mut next, &mut later] {
            client.room_id = Some("room".to_string());
        }
        next.supports_host_transfer = true;
        later.supports_host_transfer = true;
        clients.insert("host".to_string(), host);
        clients.insert("legacy".to_string(), legacy);
        clients.insert("next".to_string(), next);
        clients.insert("later".to_string(), later);
        let mut room = test_helpers::create_room("room", "host");
        room.clients = vec![
            "host".to_string(),
            "legacy".to_string(),
            "next".to_string(),
            "later".to_string(),
        ];
        room.media_id = Some("movie".to_string());
        room.state.position = 42.0;
        room.state.play_state = crate::types::PlayState::Playing;
        room.pending_play = Some(PendingPlay {
            initiator_id: "host".to_string(),
            position: 10.0,
            generation: crate::types::next_pending_play_generation(),
            position_ts: 0,
            deadline_server_ts: 0,
            shows_start: false,
        });
        rooms.insert("room".to_string(), room);

        let notification = handle_leave("host", &mut clients, &mut rooms).unwrap();
        send_leave_notification(&notification, "test");

        let room = rooms.get("room").unwrap();
        assert_eq!(room.host_id, "next");
        assert_eq!(room.media_id.as_deref(), Some("movie"));
        assert_eq!(room.state.position, 42.0);
        assert_eq!(room.state.play_state, crate::types::PlayState::Playing);
        assert!(room.pending_play.is_none());
        let messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut next_rx)).collect::<Vec<_>>();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.msg_type.as_str())
                .collect::<Vec<_>>(),
            [
                "client_left",
                "host_changed",
                "participant_list",
                "participant_statuses"
            ]
        );
        assert_eq!(messages[1].payload.as_ref().unwrap()["host_id"], "next");
        assert_eq!(messages[1].payload.as_ref().unwrap()["host_name"], "Next");
        assert_eq!(
            messages[2].payload.as_ref().unwrap()["participants"],
            serde_json::json!([
                { "name": "Legacy", "is_host": false },
                { "name": "Next", "is_host": true },
                { "name": "Later", "is_host": false }
            ])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn host_disconnect_waits_before_transferring_and_removes_the_old_host() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, mut guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        host.supports_host_transfer = true;
        host.session_expires_at = Some(u64::MAX);
        guest.room_id = Some("room".to_string());
        guest.supports_host_transfer = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            room.pending_play = Some(PendingPlay {
                initiator_id: "host".to_string(),
                position: 10.0,
                generation: crate::types::next_pending_play_generation(),
                position_ts: 0,
                deadline_server_ts: 0,
                shows_start: false,
            });
            locked.rooms.insert("room".to_string(), room);
        }

        let tasks = AppTasks::new();
        handle_disconnect("host", &state, &tasks).await;
        tokio::task::yield_now().await;

        {
            let locked = state.read().await;
            assert!(!locked.clients.contains_key("host"));
            assert_eq!(locked.rooms["room"].host_id, "host");
            assert!(locked.rooms["room"].pending_host_reconnect.is_some());
            assert!(locked.rooms["room"].pending_play.is_none());
        }
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::ClientLeft
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::ParticipantList
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::ParticipantStatuses
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::RoomList
        );

        tokio::time::advance(HOST_RECONNECT_GRACE).await;
        tokio::task::yield_now().await;

        let locked = state.read().await;
        assert_eq!(locked.rooms["room"].host_id, "guest");
        assert!(locked.rooms["room"].pending_host_reconnect.is_none());
        drop(locked);
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::HostChanged
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::ParticipantList
        );

        tasks.cancel();
        tasks.wait().await;
    }

    #[tokio::test]
    async fn only_a_disconnect_that_leaves_a_room_sends_the_room_list() {
        let state = test_helpers::create_state();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("u1", "Host", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("u2", "Guest", true);
        let (outsider, _outsider_rx) = test_helpers::create_client_with_rx("u3", "Out", true);
        let (watcher, mut watcher_rx) = test_helpers::create_client_with_rx("u4", "Watch", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        {
            let mut locked = state.write().await;
            locked.clients.insert("host".to_string(), host);
            locked.clients.insert("guest".to_string(), guest);
            locked.clients.insert("outsider".to_string(), outsider);
            locked.clients.insert("watcher".to_string(), watcher);
            let mut room = test_helpers::create_room("room", "host");
            room.clients.push("guest".to_string());
            locked.rooms.insert("room".to_string(), room);
        }
        let tasks = AppTasks::new();
        let lists = |rx: &mut tokio::sync::mpsc::Receiver<_>| {
            std::iter::from_fn(|| test_helpers::recv_msg(rx))
                .filter(|message| message.msg_type == ServerMessageType::RoomList)
                .collect::<Vec<_>>()
        };

        assert!(handle_disconnect("outsider", &state, &tasks).await);
        assert!(lists(&mut watcher_rx).is_empty());

        assert!(handle_disconnect("guest", &state, &tasks).await);
        let sent = lists(&mut watcher_rx);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].payload.as_ref().unwrap()[0]["count"], 1);

        tasks.cancel();
        tasks.wait().await;
    }

    #[tokio::test]
    async fn empty_room_closes_when_host_leaves() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let _host_rx = test_helpers::setup_room_with_host(&mut clients, &mut rooms, "host");

        let (_, messages) = handle_leave("host", &mut clients, &mut rooms).unwrap();

        assert_eq!(messages[0].msg_type, ServerMessageType::RoomClosed);
        assert!(!rooms.contains_key("room-1"));
    }

    #[tokio::test]
    async fn host_leave_without_support_closes_and_clears_guest_membership() {
        let mut clients = HashMap::new();
        let mut rooms = HashMap::new();
        let (mut host, _host_rx) = test_helpers::create_client_with_rx("host", "Host", true);
        let (mut guest, _guest_rx) = test_helpers::create_client_with_rx("guest", "Guest", true);
        host.room_id = Some("room".to_string());
        guest.room_id = Some("room".to_string());
        clients.insert("host".to_string(), host);
        clients.insert("guest".to_string(), guest);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("guest".to_string());
        rooms.insert("room".to_string(), room);

        let notification = handle_leave("host", &mut clients, &mut rooms);

        let (_, messages) = notification.expect("host leave closes the room");
        let types: Vec<_> = messages.iter().map(|msg| msg.msg_type.as_str()).collect();
        assert_eq!(types, ["room_closed"]);
        assert!(!rooms.contains_key("room"));
        assert!(clients["host"].room_id.is_none());
        assert!(clients["guest"].room_id.is_none());
    }
}
