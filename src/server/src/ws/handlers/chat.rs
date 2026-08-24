use super::super::constants::MAX_CHAT_MESSAGE_LENGTH;
use super::super::dispatch::{send_error, ErrorCode};
use crate::messaging::ClientSender;
use crate::types::{IncomingMessage, SharedState, WsMessage};
use crate::utils::now_ms;

fn validate_chat(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err("Chat message cannot be empty");
    }
    if text.len() > MAX_CHAT_MESSAGE_LENGTH {
        return Err("Chat message too long");
    }
    Ok(())
}

type BroadcastData = (Vec<ClientSender>, WsMessage);

fn collect_chat_senders(
    room_id: &str,
    client_id: &str,
    username: &str,
    chat_text: &str,
    rooms: &std::collections::HashMap<String, crate::types::Room>,
    clients: &std::collections::HashMap<String, crate::types::Client>,
) -> Option<BroadcastData> {
    let room = rooms.get(room_id)?;
    if !room.clients.contains(&client_id.to_string()) {
        return None;
    }
    let msg = WsMessage {
        msg_type: "chat_message".to_string(),
        room: Some(room_id.to_string()),
        client: Some(client_id.to_string()),
        payload: Some(serde_json::json!({
            "username": username,
            "text": chat_text
        })),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    };
    let senders: Vec<_> = room
        .clients
        .iter()
        .filter_map(|id| clients.get(id).map(|c| c.sender.clone()))
        .collect();
    Some((senders, msg))
}

pub(in crate::ws) async fn handle_chat_message(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    let Some(ref room_id) = parsed.room else {
        send_error(
            client_id,
            state,
            ErrorCode::RoomIdRequired,
            "Room ID required for chat",
        )
        .await;
        return;
    };

    let Some(chat_text) = parsed
        .payload
        .as_ref()
        .and_then(|p| p.get("text"))
        .and_then(|v| v.as_str())
    else {
        send_error(
            client_id,
            state,
            ErrorCode::InvalidChatPayload,
            "Chat payload must contain text",
        )
        .await;
        return;
    };

    if let Err(msg) = validate_chat(chat_text) {
        let (code, detail) = if chat_text.len() > MAX_CHAT_MESSAGE_LENGTH {
            (
                ErrorCode::ChatMessageTooLong,
                format!("{msg} (max {MAX_CHAT_MESSAGE_LENGTH} characters)"),
            )
        } else {
            (ErrorCode::ChatMessageEmpty, msg.to_string())
        };
        send_error(client_id, state, code, &detail).await;
        return;
    }

    let result = {
        let locked = state.read().await;
        if let Some(room) = locked.rooms.get(room_id) {
            if room.clients.iter().any(|id| id == client_id) {
                let username = locked
                    .clients
                    .get(client_id)
                    .map(|c| c.user_name.clone())
                    .unwrap_or_else(|| "Anonymous".to_string());
                let delivery = collect_chat_senders(
                    room_id,
                    client_id,
                    &username,
                    chat_text,
                    &locked.rooms,
                    &locked.clients,
                )
                .expect("room membership checked");
                crate::messaging::send_to_senders(&delivery.0, &delivery.1, "chat message");
                Ok(())
            } else {
                Err((
                    ErrorCode::NotRoomMember,
                    "Client is not a member of this room",
                ))
            }
        } else {
            Err((ErrorCode::RoomNotFound, "Room not found"))
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

    fn chat_message(room: Option<&str>, payload: Option<serde_json::Value>) -> IncomingMessage {
        IncomingMessage {
            msg_type: crate::types::ClientMessageType::ChatMessage,
            room: room.map(str::to_string),
            client: None,
            payload,
            ts: 0,
            server_ts: None,
        }
    }

    fn assert_error_code(message: WsMessage, code: &str) {
        assert_eq!(message.msg_type, "error");
        assert_eq!(message.payload.unwrap()["code"], code);
    }

    #[test]
    fn validate_chat_valid() {
        assert!(validate_chat("Hello world").is_ok());
    }

    #[test]
    fn validate_chat_empty() {
        assert!(validate_chat("").is_err());
    }

    #[test]
    fn validate_chat_too_long() {
        let long = "a".repeat(MAX_CHAT_MESSAGE_LENGTH + 1);
        assert!(validate_chat(&long).is_err());
    }

    #[test]
    fn validate_chat_at_limit() {
        let exact = "a".repeat(MAX_CHAT_MESSAGE_LENGTH);
        assert!(validate_chat(&exact).is_ok());
    }

    #[tokio::test]
    async fn chat_validation_errors_have_stable_codes() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("client", "Client", true);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);

        handle_chat_message("client", &chat_message(None, None), &state).await;
        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "ROOM_ID_REQUIRED");

        handle_chat_message("client", &chat_message(Some("room"), None), &state).await;
        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "INVALID_CHAT_PAYLOAD",
        );

        handle_chat_message(
            "client",
            &chat_message(Some("room"), Some(serde_json::json!({ "text": "" }))),
            &state,
        )
        .await;
        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "CHAT_MESSAGE_EMPTY",
        );

        handle_chat_message(
            "client",
            &chat_message(
                Some("room"),
                Some(serde_json::json!({
                    "text": "a".repeat(MAX_CHAT_MESSAGE_LENGTH + 1)
                })),
            ),
            &state,
        )
        .await;
        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "CHAT_MESSAGE_TOO_LONG",
        );
    }

    #[tokio::test]
    async fn chat_rejects_missing_room_and_non_member() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("client", "Client", true);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);
        let message = chat_message(Some("room"), Some(serde_json::json!({ "text": "hello" })));

        handle_chat_message("client", &message, &state).await;
        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "ROOM_NOT_FOUND");

        state.write().await.rooms.insert(
            "room".to_string(),
            test_helpers::create_room("room", "host"),
        );
        handle_chat_message("client", &message, &state).await;
        assert_error_code(test_helpers::recv_msg(&mut rx).unwrap(), "NOT_ROOM_MEMBER");
    }
}
