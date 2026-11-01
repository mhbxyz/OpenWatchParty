//! Collaborative queue suggestions and per-member availability (#176).

use super::super::dispatch::{is_authenticated, send_error, ErrorCode};
use super::super::validation::is_valid_media_id;
use super::queue::validated_item;
use crate::messaging::send_message;
use crate::room::Suggestion;
use crate::types::{
    Client, ClientMessageType, IncomingMessage, Room, ServerMessageType, ServerState, SharedState,
    WsMessage,
};
use crate::utils::now_ms;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

const MAX_AVAILABILITY_IDS: usize = 30;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SuggestPayload {
    id: String,
    title: String,
    #[serde(default)]
    series: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DismissPayload {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AvailabilityPayload {
    missing: Vec<String>,
}

enum Command {
    Suggest(crate::room::QueueItem),
    Dismiss(String),
    Availability(HashSet<String>),
}

impl Command {
    fn parse(parsed: &IncomingMessage) -> Option<Self> {
        let payload = parsed.payload.clone()?;
        match parsed.msg_type {
            ClientMessageType::QueueSuggest => {
                let payload: SuggestPayload = serde_json::from_value(payload).ok()?;
                Some(Self::Suggest(validated_item(
                    payload.id,
                    payload.title,
                    payload.series,
                )?))
            }
            ClientMessageType::QueueDismiss => {
                let DismissPayload { id } = serde_json::from_value(payload).ok()?;
                is_valid_media_id(&id).then_some(Self::Dismiss(id))
            }
            ClientMessageType::QueueAvailability => {
                let AvailabilityPayload { missing } = serde_json::from_value(payload).ok()?;
                if missing.len() > MAX_AVAILABILITY_IDS
                    || missing.iter().any(|id| !is_valid_media_id(id))
                {
                    return None;
                }
                Some(Self::Availability(missing.into_iter().collect()))
            }
            _ => None,
        }
    }
}

fn user_key<'a>(client_id: &'a str, client: &'a Client) -> &'a str {
    if client.user_id.is_empty() {
        client_id
    } else {
        &client.user_id
    }
}

/// Sends each feature-aware member its own view, or only `only` when given.
pub(crate) fn send_queue_details(
    room: &Room,
    clients: &HashMap<String, Client>,
    only: Option<&str>,
) {
    for id in &room.clients {
        if only.is_some_and(|only| only != id) {
            continue;
        }
        let Some(client) = clients.get(id) else {
            continue;
        };
        if !client.supports_queue_suggestions {
            continue;
        }
        let message = WsMessage {
            msg_type: ServerMessageType::QueueDetails,
            room: Some(room.room_id.clone()),
            client: None,
            payload: Some(
                serde_json::to_value(room.queue.details(id, clients, &room.clients))
                    .expect("queue details serialize"),
            ),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        };
        send_message(Some(client.sender.clone()), &message, Some(id));
    }
}

pub(in crate::ws) async fn handle_queue_suggestions(
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
    let Some(command) = Command::parse(parsed) else {
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
        let mut locked = state.write().await;
        let ServerState { clients, rooms } = &mut *locked;
        let Some(client) = clients.get(client_id) else {
            return;
        };
        let by = client.user_name.clone();
        let by_user = user_key(client_id, client).to_string();
        match client
            .room_id
            .as_ref()
            .and_then(|room_id| rooms.get_mut(room_id))
        {
            None => Err((ErrorCode::NotInRoom, "Client is not in a room")),
            Some(room) => {
                let changed = match command {
                    Command::Suggest(item) => room.queue.suggest(Suggestion {
                        id: item.id,
                        title: item.title,
                        series: item.series,
                        by,
                        by_user,
                    }),
                    Command::Dismiss(id) => {
                        room.queue.dismiss(&id, &by_user, room.host_id == client_id)
                    }
                    Command::Availability(missing) => {
                        room.queue.report_availability(client_id, missing)
                    }
                };
                if changed {
                    send_queue_details(room, clients, None);
                }
                Ok(())
            }
        }
    };
    if let Err((code, message)) = result {
        send_error(client_id, state, code, message).await;
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

    fn suggest(id: &str) -> IncomingMessage {
        message(
            ClientMessageType::QueueSuggest,
            serde_json::json!({ "id": id, "title": "  Pilot\u{7}  " }),
        )
    }

    async fn room() -> (
        SharedState,
        Receiver<crate::messaging::OutboundMessage>,
        Receiver<crate::messaging::OutboundMessage>,
    ) {
        let state = test_helpers::create_state();
        let (mut host, host_rx) = test_helpers::create_client_with_rx("host-user", "Host", true);
        host.room_id = Some("room".to_string());
        let (mut guest, guest_rx) = test_helpers::create_client_with_rx("guest-user", "Ana", true);
        guest.room_id = Some("room".to_string());
        guest.supports_queue_suggestions = true;
        let mut locked = state.write().await;
        locked.clients.insert("host".to_string(), host);
        locked.clients.insert("guest".to_string(), guest);
        let mut room = test_helpers::create_room("room", "host");
        room.clients.push("guest".to_string());
        locked.rooms.insert("room".to_string(), room);
        drop(locked);
        (state, host_rx, guest_rx)
    }

    #[test]
    fn payloads_are_strict_and_bounded() {
        assert!(matches!(
            Command::parse(&suggest(A)),
            Some(Command::Suggest(_))
        ));
        let too_many = vec![A; MAX_AVAILABILITY_IDS + 1];
        for parsed in [
            message(
                ClientMessageType::QueueSuggest,
                serde_json::json!({ "id": A }),
            ),
            message(
                ClientMessageType::QueueSuggest,
                serde_json::json!({ "id": A, "title": "x", "extra": true }),
            ),
            message(
                ClientMessageType::QueueSuggest,
                serde_json::json!({ "id": "bad", "title": "x" }),
            ),
            message(
                ClientMessageType::QueueSuggest,
                serde_json::json!({ "id": A, "title": "x", "series": "bad" }),
            ),
            message(
                ClientMessageType::QueueDismiss,
                serde_json::json!({ "id": 1 }),
            ),
            message(
                ClientMessageType::QueueAvailability,
                serde_json::json!({ "missing": ["bad"] }),
            ),
            message(
                ClientMessageType::QueueAvailability,
                serde_json::json!({ "missing": too_many }),
            ),
        ] {
            assert!(Command::parse(&parsed).is_none(), "{parsed:?}");
        }
    }

    #[test]
    fn dismiss_rejects_an_invalid_media_id() {
        assert!(Command::parse(&message(
            ClientMessageType::QueueDismiss,
            serde_json::json!({ "id": "bad" }),
        ))
        .is_none());
    }

    #[tokio::test]
    async fn guest_and_host_can_suggest_but_only_feature_members_get_details() {
        let (state, mut host_rx, mut guest_rx) = room().await;
        handle_queue_suggestions("guest", &suggest(A), &state).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        let details = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(details.msg_type, ServerMessageType::QueueDetails);
        assert_eq!(details.payload.unwrap()["suggestions"][0]["mine"], true);

        handle_queue_suggestions("host", &suggest(B), &state).await;
        let details = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(details.payload.unwrap()["suggestions"][1]["by"], "Host");
    }

    #[tokio::test]
    async fn queue_details_immediately_follow_queue_state_for_the_same_member() {
        let (state, mut host_rx, mut guest_rx) = room().await;
        {
            let mut locked = state.write().await;
            locked
                .clients
                .get_mut("guest")
                .unwrap()
                .supports_media_queue = true;
            let ServerState { clients, rooms } = &mut *locked;
            super::super::queue::send_queue_state(&rooms["room"], clients, Some("guest"));
        }
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::QueueState
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::QueueDetails
        );
    }

    #[tokio::test]
    async fn queue_state_for_one_member_sends_details_only_to_that_member() {
        let (state, mut host_rx, mut guest_rx) = room().await;
        {
            let mut locked = state.write().await;
            locked
                .clients
                .get_mut("host")
                .unwrap()
                .supports_queue_suggestions = true;
            locked
                .clients
                .get_mut("guest")
                .unwrap()
                .supports_media_queue = true;
            let ServerState { clients, rooms } = &mut *locked;
            super::super::queue::send_queue_state(&rooms["room"], clients, Some("guest"));
        }

        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::QueueState
        );
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx).unwrap().msg_type,
            ServerMessageType::QueueDetails
        );
    }

    #[tokio::test]
    async fn queue_add_accepts_a_suggestion_and_sends_state_then_details() {
        let (state, mut host_rx, mut guest_rx) = room().await;
        {
            let mut locked = state.write().await;
            let host = locked.clients.get_mut("host").unwrap();
            host.supports_media_queue = true;
            host.supports_queue_suggestions = true;
        }
        handle_queue_suggestions("guest", &suggest(A), &state).await;
        test_helpers::recv_msg(&mut host_rx).unwrap();
        test_helpers::recv_msg(&mut guest_rx).unwrap();

        let add = message(
            ClientMessageType::QueueAdd,
            serde_json::json!({ "items": [{ "id": A, "title": "Pilot" }] }),
        );
        super::super::queue::handle_queue("host", &add, &state, &AppTasks::new()).await;

        assert_eq!(
            test_helpers::recv_msg(&mut host_rx).unwrap().msg_type,
            ServerMessageType::QueueState
        );
        let details = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(details.msg_type, ServerMessageType::QueueDetails);
        assert!(details.payload.unwrap()["suggestions"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn dismiss_permissions_and_identical_availability_are_silent() {
        let (state, _host_rx, mut guest_rx) = room().await;
        handle_queue_suggestions("guest", &suggest(A), &state).await;
        test_helpers::recv_msg(&mut guest_rx).unwrap();

        let dismiss = message(
            ClientMessageType::QueueDismiss,
            serde_json::json!({ "id": A }),
        );
        {
            let (mut other, _other_rx) =
                test_helpers::create_client_with_rx("other-user", "Bob", true);
            other.room_id = Some("room".to_string());
            let mut locked = state.write().await;
            locked.clients.insert("other".to_string(), other);
            locked
                .rooms
                .get_mut("room")
                .unwrap()
                .clients
                .push("other".to_string());
        }
        handle_queue_suggestions("other", &dismiss, &state).await;
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
        assert_eq!(state.read().await.rooms["room"].queue.suggestions.len(), 1);

        handle_queue_suggestions("host", &dismiss, &state).await;
        assert!(test_helpers::recv_msg(&mut guest_rx)
            .unwrap()
            .payload
            .unwrap()["suggestions"]
            .as_array()
            .unwrap()
            .is_empty());

        {
            let mut locked = state.write().await;
            locked.rooms.get_mut("room").unwrap().queue.add(
                vec![crate::room::QueueItem {
                    id: A.to_string(),
                    title: "Pilot".to_string(),
                    series: None,
                }],
                None,
            );
        }
        let availability = message(
            ClientMessageType::QueueAvailability,
            serde_json::json!({ "missing": [A] }),
        );
        handle_queue_suggestions("guest", &availability, &state).await;
        assert_eq!(
            test_helpers::recv_msg(&mut guest_rx)
                .unwrap()
                .payload
                .unwrap()["unavailable"][0]["you"],
            true
        );
        handle_queue_suggestions("guest", &availability, &state).await;
        assert!(test_helpers::recv_msg(&mut guest_rx).is_none());
        handle_queue_suggestions(
            "guest",
            &message(
                ClientMessageType::QueueAvailability,
                serde_json::json!({ "missing": [] }),
            ),
            &state,
        )
        .await;
        assert!(test_helpers::recv_msg(&mut guest_rx)
            .unwrap()
            .payload
            .unwrap()["unavailable"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn suggester_can_dismiss_after_reconnecting_with_the_same_user_id() {
        let (state, _host_rx, mut old_rx) = room().await;
        handle_queue_suggestions("guest", &suggest(A), &state).await;
        test_helpers::recv_msg(&mut old_rx).unwrap();
        let (mut reconnected, mut new_rx) =
            test_helpers::create_client_with_rx("guest-user", "Ana", true);
        reconnected.room_id = Some("room".to_string());
        reconnected.supports_queue_suggestions = true;
        {
            let mut locked = state.write().await;
            locked.clients.insert("guest-new".to_string(), reconnected);
            locked.rooms.get_mut("room").unwrap().clients =
                vec!["host".to_string(), "guest-new".to_string()];
        }

        handle_queue_suggestions(
            "guest-new",
            &message(
                ClientMessageType::QueueDismiss,
                serde_json::json!({ "id": A }),
            ),
            &state,
        )
        .await;

        assert!(test_helpers::recv_msg(&mut new_rx)
            .unwrap()
            .payload
            .unwrap()["suggestions"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn malformed_outside_and_unauthenticated_messages_get_the_queue_errors() {
        let state = test_helpers::create_state();
        let (outside, mut outside_rx) = test_helpers::create_client_with_rx("u", "Outside", true);
        let (anon, mut anon_rx) = test_helpers::create_client_with_rx("", "", false);
        {
            let mut locked = state.write().await;
            locked.clients.insert("outside".to_string(), outside);
            locked.clients.insert("anon".to_string(), anon);
        }
        handle_queue_suggestions("outside", &suggest(A), &state).await;
        assert_eq!(
            test_helpers::recv_msg(&mut outside_rx)
                .unwrap()
                .payload
                .unwrap()["code"],
            "NOT_IN_ROOM"
        );
        handle_queue_suggestions(
            "outside",
            &message(ClientMessageType::QueueDismiss, serde_json::json!({})),
            &state,
        )
        .await;
        assert_eq!(
            test_helpers::recv_msg(&mut outside_rx)
                .unwrap()
                .payload
                .unwrap()["code"],
            "INVALID_QUEUE_PAYLOAD"
        );
        handle_queue_suggestions("anon", &suggest(A), &state).await;
        assert_eq!(
            test_helpers::recv_msg(&mut anon_rx)
                .unwrap()
                .payload
                .unwrap()["code"],
            "AUTHENTICATION_REQUIRED"
        );
    }
}
