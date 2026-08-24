use super::super::constants::MAX_CHAT_MESSAGE_LENGTH;
use super::super::dispatch::send_error;
use crate::types::{IncomingMessage, SharedState, WsMessage};
use crate::utils::now_ms;
use tokio::sync::mpsc;

fn validate_chat(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err("Chat message cannot be empty");
    }
    if text.len() > MAX_CHAT_MESSAGE_LENGTH {
        return Err("Chat message too long");
    }
    Ok(())
}

type BroadcastData = (
    Vec<mpsc::Sender<Result<warp::ws::Message, warp::Error>>>,
    WsMessage,
);

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
        send_error(client_id, state, "Room ID required for chat").await;
        return;
    };

    let chat_text = parsed
        .payload
        .as_ref()
        .and_then(|p| p.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if let Err(msg) = validate_chat(chat_text) {
        let detail = if chat_text.len() > MAX_CHAT_MESSAGE_LENGTH {
            format!("{} (max {} characters)", msg, MAX_CHAT_MESSAGE_LENGTH)
        } else {
            msg.to_string()
        };
        send_error(client_id, state, &detail).await;
        return;
    }

    {
        let state = state.read().await;
        let username = state
            .clients
            .get(client_id)
            .map(|c| c.user_name.clone())
            .unwrap_or_else(|| "Anonymous".to_string());
        if let Some((senders, msg)) = collect_chat_senders(
            room_id,
            client_id,
            &username,
            chat_text,
            &state.rooms,
            &state.clients,
        ) {
            crate::messaging::send_to_senders(&senders, &msg, "chat message");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
