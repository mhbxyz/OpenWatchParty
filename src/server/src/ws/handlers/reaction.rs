use super::super::constants::{ALLOWED_REACTIONS, REACTION_RATE_LIMIT_MS};
use super::super::dispatch::{send_error, ErrorCode};
use crate::messaging::send_to_senders;
use crate::types::{IncomingMessage, ServerMessageType, SharedState, WsMessage};
use crate::utils::now_ms;
use std::time::Duration;
use tokio::time::Instant;

pub(in crate::ws) async fn handle_reaction(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    let Some(ref room_id) = parsed.room else {
        send_error(
            client_id,
            state,
            ErrorCode::RoomIdRequired,
            "Room ID required for reaction",
        )
        .await;
        return;
    };

    let Some(emoji) = parsed
        .payload
        .as_ref()
        .and_then(|p| p.get("emoji"))
        .and_then(|v| v.as_str())
    else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidReactionPayload,
            "Reaction payload must contain emoji",
        )
        .await;
        return;
    };

    if !ALLOWED_REACTIONS.contains(&emoji) {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidReactionEmoji,
            "Emoji is not in the allowed reactions list",
        )
        .await;
        return;
    }

    let now = Instant::now();
    let result = {
        let mut locked = state.write().await;
        let room_clients = match locked.rooms.get(room_id) {
            None => Err((ErrorCode::RoomNotFound, "Room not found")),
            Some(room) if !room.clients.iter().any(|id| id == client_id) => {
                Err((
                    ErrorCode::NotRoomMember,
                    "Client is not a member of this room",
                ))
            }
            Some(room) => Ok(room.clients.clone()),
        };

        match room_clients {
            Err(err) => Err(err),
            Ok(clients) => {
                let Some(client) = locked.clients.get_mut(client_id) else {
                    return;
                };
                let is_limited = client.last_reaction.is_some_and(|last| {
                    crate::utils::elapsed_saturating(now, last)
                        < Duration::from_millis(REACTION_RATE_LIMIT_MS)
                });
                if is_limited {
                    Err((
                        ErrorCode::ReactionRateLimited,
                        "Reaction rate limit exceeded",
                    ))
                } else {
                    client.last_reaction = Some(now);
                    let username = if client.user_name.is_empty() {
                        "Anonymous".to_string()
                    } else {
                        client.user_name.clone()
                    };
                    let msg = WsMessage {
                        msg_type: ServerMessageType::Reaction,
                        room: Some(room_id.to_string()),
                        client: Some(client_id.to_string()),
                        payload: Some(serde_json::json!({
                            "username": username,
                            "emoji": emoji
                        })),
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    };
                    let senders: Vec<_> = clients
                        .iter()
                        .filter_map(|id| locked.clients.get(id).map(|c| c.sender.clone()))
                        .collect();
                    send_to_senders(&senders, &msg, "reaction");
                    Ok(())
                }
            }
        }
    };

    match result {
        Ok(()) => {}
        Err((code, message)) => send_error(client_id, state, code, message).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;

    fn reaction_message(room: Option<&str>, payload: Option<serde_json::Value>) -> IncomingMessage {
        IncomingMessage {
            msg_type: crate::types::ClientMessageType::Reaction,
            room: room.map(str::to_string),
            client: None,
            payload,
            ts: 0,
            server_ts: None,
        }
    }

    fn assert_error_code(message: WsMessage, code: &str) {
        assert_eq!(message.msg_type, ServerMessageType::Error);
        assert_eq!(message.payload.unwrap()["code"], code);
    }

    #[tokio::test]
    async fn missing_room_is_rejected() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u1", "User", true);
        state.write().await.clients.insert("c1".to_string(), client);

        let msg = reaction_message(None, Some(serde_json::json!({ "emoji": "👍" })));
        handle_reaction("c1", &msg, &state).await;

        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "ROOM_ID_REQUIRED",
        );
    }

    #[tokio::test]
    async fn missing_payload_is_rejected() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u1", "User", true);
        state.write().await.clients.insert("c1".to_string(), client);

        let msg = reaction_message(Some("r1"), None);
        handle_reaction("c1", &msg, &state).await;

        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "INVALID_REACTION_PAYLOAD",
        );
    }

    #[tokio::test]
    async fn disallowed_emoji_is_rejected() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u1", "User", true);
        state.write().await.clients.insert("c1".to_string(), client);

        let msg = reaction_message(Some("r1"), Some(serde_json::json!({ "emoji": "💩" })));
        handle_reaction("c1", &msg, &state).await;

        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "INVALID_REACTION_EMOJI",
        );
    }

    #[tokio::test]
    async fn non_member_is_rejected() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("u1", "User", true);
        state.write().await.clients.insert("c1".to_string(), client);
        let room = test_helpers::create_room("r1", "host");
        state.write().await.rooms.insert("r1".to_string(), room);

        let msg = reaction_message(Some("r1"), Some(serde_json::json!({ "emoji": "👍" })));
        handle_reaction("c1", &msg, &state).await;

        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "NOT_ROOM_MEMBER",
        );
    }

    #[tokio::test]
    async fn reaction_broadcasts_to_room_members() {
        let state = test_helpers::create_state();
        let (host, mut host_rx) = test_helpers::create_client_with_rx("u1", "Alice", true);
        let (guest, mut guest_rx) = test_helpers::create_client_with_rx("u2", "Bob", true);
        state.write().await.clients.insert("c1".to_string(), host);
        state.write().await.clients.insert("c2".to_string(), guest);

        let mut room = test_helpers::create_room("r1", "c1");
        room.clients.push("c2".to_string());
        state.write().await.rooms.insert("r1".to_string(), room);

        let msg = reaction_message(Some("r1"), Some(serde_json::json!({ "emoji": "🔥" })));
        handle_reaction("c1", &msg, &state).await;

        let host_msg = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(host_msg.msg_type, ServerMessageType::Reaction);
        assert_eq!(host_msg.payload.unwrap()["emoji"], "🔥");
        assert_eq!(host_msg.client.unwrap(), "c1");

        let guest_msg = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(guest_msg.msg_type, ServerMessageType::Reaction);
        assert_eq!(guest_msg.payload.as_ref().unwrap()["emoji"], "🔥");
        assert_eq!(guest_msg.payload.unwrap()["username"], "Alice");
        assert_eq!(guest_msg.client.unwrap(), "c1");
    }

    #[tokio::test]
    async fn reaction_rate_limiting_enforces_cooldown() {
        let state = test_helpers::create_state();
        let (host, mut host_rx) = test_helpers::create_client_with_rx("u1", "Alice", true);
        state.write().await.clients.insert("c1".to_string(), host);
        let room = test_helpers::create_room("r1", "c1");
        state.write().await.rooms.insert("r1".to_string(), room);

        let msg = reaction_message(Some("r1"), Some(serde_json::json!({ "emoji": "👍" })));

        // First reaction succeeds
        handle_reaction("c1", &msg, &state).await;
        let first = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(first.msg_type, ServerMessageType::Reaction);

        // Immediate second reaction is rate limited
        handle_reaction("c1", &msg, &state).await;
        let second = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_error_code(second, "REACTION_RATE_LIMITED");

        // After cooldown expires, reaction succeeds again
        {
            let mut locked = state.write().await;
            let client = locked.clients.get_mut("c1").unwrap();
            client.last_reaction = Some(Instant::now() - Duration::from_millis(1500));
        }

        handle_reaction("c1", &msg, &state).await;
        let third = test_helpers::recv_msg(&mut host_rx).unwrap();
        assert_eq!(third.msg_type, ServerMessageType::Reaction);
    }
}
