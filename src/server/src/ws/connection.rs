use super::constants::CLIENT_CHANNEL_BUFFER;
use super::dispatch::{client_msg, close_with_policy, is_authenticated};
use crate::auth::JwtConfig;
use crate::messaging::{send_message, send_room_list};
use crate::types::{SharedState, WsMessage};
use crate::utils::now_ms;
use futures::StreamExt;
use log::info;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

fn register_client(
    client_sender: mpsc::Sender<Result<warp::ws::Message, warp::Error>>,
    jwt_config: &Arc<JwtConfig>,
) -> crate::types::Client {
    let now = now_ms();
    let authenticated = !jwt_config.enabled;
    let (user_id, user_name) = if authenticated {
        ("anonymous".to_string(), "Anonymous".to_string())
    } else {
        ("".to_string(), "".to_string())
    };

    crate::types::Client {
        sender: client_sender,
        room_id: None,
        user_id,
        user_name,
        authenticated,
        message_count: 0,
        last_reset: now,
        last_seen: now,
    }
}

fn send_client_hello(client_id: &str, sender: Option<crate::messaging::ClientSender>) {
    send_message(
        sender,
        &WsMessage {
            msg_type: "client_hello".to_string(),
            room: None,
            client: Some(client_id.to_string()),
            payload: Some(serde_json::json!({ "client_id": client_id })),
            ts: now_ms(),
            server_ts: Some(now_ms()),
        },
        Some(client_id),
    );
}

fn should_send_initial_room_list(jwt_config: &JwtConfig) -> bool {
    !jwt_config.enabled
}

pub async fn client_connection(
    ws: warp::ws::WebSocket,
    state: SharedState,
    jwt_config: Arc<JwtConfig>,
    auth_timeout: Duration,
) {
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::channel(CLIENT_CHANNEL_BUFFER);
    let client_rcv = ReceiverStream::new(client_rcv);

    let mut writer_task = tokio::task::spawn(async move {
        let _ = client_rcv.forward(client_ws_sender).await;
    });

    let temp_id = uuid::Uuid::new_v4().to_string();
    info!(
        "Client connected: {} (auth_required: {})",
        temp_id, jwt_config.enabled
    );

    let client = register_client(client_sender, &jwt_config);
    {
        let mut state = state.write().await;
        state.clients.insert(temp_id.clone(), client);
        let sender = state.clients.get(&temp_id).map(|c| c.sender.clone());
        send_client_hello(&temp_id, sender);
    }

    if should_send_initial_room_list(&jwt_config) {
        send_room_list(&temp_id, &state).await;
    }

    let authentication_timeout = tokio::time::sleep(auth_timeout);
    tokio::pin!(authentication_timeout);
    let mut authentication_pending = jwt_config.enabled;

    loop {
        tokio::select! {
            result = client_ws_rcv.next() => {
                let Some(result) = result else { break };
                if let Ok(msg) = result {
                    if client_msg(&temp_id, msg, &state, &jwt_config).await {
                        break;
                    }
                    if authentication_pending && is_authenticated(&temp_id, &state).await {
                        authentication_pending = false;
                    }
                }
            }
            _ = &mut authentication_timeout, if authentication_pending => {
                info!("Authentication timed out for client {}", temp_id);
                close_with_policy(&temp_id, &state, "Authentication timeout").await;
                break;
            }
        }
    }

    crate::room::handle_disconnect(&temp_id, &state).await;
    if tokio::time::timeout(
        Duration::from_millis(super::constants::WRITER_SHUTDOWN_TIMEOUT_MS),
        &mut writer_task,
    )
    .await
    .is_err()
    {
        writer_task.abort();
        let _ = writer_task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_client_jwt_disabled() {
        let (tx, _rx) = mpsc::channel(10);
        let jwt_config = Arc::new(JwtConfig {
            secret: String::new(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: false,
        });
        let client = register_client(tx, &jwt_config);
        assert!(client.authenticated);
        assert_eq!(client.user_id, "anonymous");
        assert_eq!(client.user_name, "Anonymous");
    }

    #[test]
    fn register_client_jwt_enabled() {
        let (tx, _rx) = mpsc::channel(10);
        let jwt_config = Arc::new(JwtConfig {
            secret: "some-secret".to_string(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: true,
        });
        let client = register_client(tx, &jwt_config);
        assert!(!client.authenticated);
        assert_eq!(client.user_id, "");
        assert_eq!(client.user_name, "");
    }

    #[test]
    fn room_list_is_deferred_only_when_authentication_is_required() {
        let enabled = JwtConfig {
            secret: "some-secret".to_string(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: true,
        };
        let disabled = JwtConfig {
            enabled: false,
            ..enabled.clone()
        };

        assert!(!should_send_initial_room_list(&enabled));
        assert!(should_send_initial_room_list(&disabled));
    }

    #[test]
    fn insecure_mode_has_no_authentication_deadline() {
        let config = JwtConfig {
            secret: String::new(),
            audience: "test".to_string(),
            issuer: "test".to_string(),
            enabled: false,
        };

        assert!(!config.enabled);
        assert!(should_send_initial_room_list(&config));
    }
}
