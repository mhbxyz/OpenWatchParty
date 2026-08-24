use super::super::dispatch::send_error;
use super::super::validation::sanitize_name;
use crate::auth::JwtConfig;
use crate::messaging::{send_message, send_room_list};
use crate::types::{IncomingMessage, SharedState, WsMessage};
use crate::utils::now_ms;
use log::{info, warn};
use std::sync::Arc;

async fn handle_jwt_auth(
    client_id: &str,
    token: &str,
    state: &SharedState,
    jwt_config: &Arc<JwtConfig>,
) -> bool {
    match jwt_config.validate_token(token) {
        Ok(claims) => {
            {
                let mut state = state.write().await;
                let sender = state.clients.get(client_id).map(|c| c.sender.clone());
                if let Some(client) = state.clients.get_mut(client_id) {
                    client.authenticated = true;
                    client.user_id = claims.sub;
                    client.user_name = claims.name.clone();
                    client.session_expires_at = jwt_config.enabled.then_some(claims.exp as u64);
                    client.authentication_version = client.authentication_version.wrapping_add(1);
                    info!("Client {} authenticated as {}", client_id, claims.name);
                }
                send_message(
                    sender,
                    &WsMessage {
                        msg_type: "auth_success".to_string(),
                        room: None,
                        client: Some(client_id.to_string()),
                        payload: Some(serde_json::json!({ "user_name": claims.name })),
                        ts: now_ms(),
                        server_ts: Some(now_ms()),
                    },
                    Some(client_id),
                );
            }
            send_room_list(client_id, state).await;
            true
        }
        Err(e) => {
            warn!("Auth failed for {}: {}", client_id, e);
            false
        }
    }
}

async fn handle_identity(client_id: &str, payload: &serde_json::Value, state: &SharedState) {
    let user_name = payload
        .get("user_name")
        .and_then(|v| v.as_str())
        .and_then(sanitize_name);
    let user_id = payload.get("user_id").and_then(|v| v.as_str());
    if let Some(name) = user_name {
        let mut state = state.write().await;
        if let Some(client) = state.clients.get_mut(client_id) {
            client.user_name = name.clone();
            if let Some(uid) = user_id {
                client.user_id = uid.to_string();
            }
            info!("Client {} identified as {}", client_id, name);
        }
    }
}

pub(in crate::ws) async fn handle_auth(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
    jwt_config: &Arc<JwtConfig>,
) {
    if let Some(payload) = &parsed.payload {
        if let Some(token) = payload.get("token").and_then(|v| v.as_str()) {
            if handle_jwt_auth(client_id, token, state, jwt_config).await {
                return;
            }
            send_error(client_id, state, "Authentication failed").await;
            return;
        }
        if !jwt_config.enabled {
            handle_identity(client_id, payload, state).await;
        } else {
            warn!(
                "Client {} sent auth without token but JWT is required",
                client_id
            );
            send_error(
                client_id,
                state,
                "Authentication required: no token provided",
            )
            .await;
        }
    } else if jwt_config.enabled {
        warn!(
            "Client {} sent auth with no payload but JWT is required",
            client_id
        );
        send_error(
            client_id,
            state,
            "Authentication required: no token provided",
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Claims;
    use crate::test_helpers;
    use jsonwebtoken::{encode, EncodingKey, Header};

    #[tokio::test]
    async fn successful_auth_sends_success_before_room_list() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("user", "", false);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);
        let jwt_config = Arc::new(JwtConfig {
            secret: "test-secret-with-at-least-32-characters".to_string(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: true,
        });
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token = encode(
            &Header::default(),
            &Claims {
                sub: "user".to_string(),
                name: "Alice".to_string(),
                aud: jwt_config.audience.clone(),
                iss: jwt_config.issuer.clone(),
                exp: now + 3600,
                iat: now,
            },
            &EncodingKey::from_secret(jwt_config.secret.as_bytes()),
        )
        .unwrap();
        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Auth,
            room: None,
            client: Some("forged".to_string()),
            payload: Some(serde_json::json!({ "token": token })),
            ts: crate::utils::now_ms(),
            server_ts: None,
        };

        handle_auth("client", &parsed, &state, &jwt_config).await;

        assert_eq!(
            test_helpers::recv_msg(&mut rx).unwrap().msg_type,
            "auth_success"
        );
        assert_eq!(
            test_helpers::recv_msg(&mut rx).unwrap().msg_type,
            "room_list"
        );
        assert!(state.read().await.clients["client"].authenticated);
        assert_eq!(
            state.read().await.clients["client"].session_expires_at,
            Some((now + 3600) as u64)
        );
    }

    #[tokio::test]
    async fn insecure_auth_with_token_remains_non_expiring() {
        let state = test_helpers::create_state();
        let (client, _rx) = test_helpers::create_client_with_rx("anonymous", "Anonymous", true);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);
        let jwt_config = Arc::new(JwtConfig {
            secret: String::new(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: false,
        });
        let parsed = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Auth,
            room: None,
            client: None,
            payload: Some(serde_json::json!({ "token": "ignored-in-insecure-mode" })),
            ts: crate::utils::now_ms(),
            server_ts: None,
        };

        handle_auth("client", &parsed, &state, &jwt_config).await;

        assert_eq!(
            state.read().await.clients["client"].session_expires_at,
            None
        );
    }
}
