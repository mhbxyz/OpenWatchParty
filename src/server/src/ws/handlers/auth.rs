use super::super::dispatch::{send_error, ErrorCode};
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
            let Some(user_name) = sanitize_name(&claims.name) else {
                warn!("Auth failed for {client_id}: JWT name is empty after sanitization");
                return false;
            };
            let sender = {
                let mut state = state.write().await;
                let sender = state.clients.get(client_id).map(|c| c.sender.clone());
                if let Some(client) = state.clients.get_mut(client_id) {
                    client.authenticated = true;
                    client.user_id = claims.sub;
                    client.user_name = user_name.clone();
                    client.session_expires_at = jwt_config.enabled.then_some(claims.exp as u64);
                    client.authentication_version = client.authentication_version.wrapping_add(1);
                    info!("Client {client_id} authenticated as {user_name}");
                }
                sender
            };
            send_message(
                sender,
                &WsMessage {
                    msg_type: "auth_success".to_string(),
                    room: None,
                    client: Some(client_id.to_string()),
                    payload: Some(serde_json::json!({ "user_name": user_name })),
                    ts: now_ms(),
                    server_ts: Some(now_ms()),
                },
                Some(client_id),
            );
            send_room_list(client_id, state).await;
            true
        }
        Err(e) => {
            warn!("Auth failed for {client_id}: {e}");
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
            info!("Client {client_id} identified as {name}");
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
            send_error(
                client_id,
                state,
                ErrorCode::AuthenticationFailed,
                "Authentication failed",
            )
            .await;
            return;
        }
        if !jwt_config.enabled {
            handle_identity(client_id, payload, state).await;
        } else {
            warn!("Client {client_id} sent auth without token but JWT is required");
            send_error(
                client_id,
                state,
                ErrorCode::AuthenticationRequired,
                "Authentication required: no token provided",
            )
            .await;
        }
    } else if jwt_config.enabled {
        warn!("Client {client_id} sent auth with no payload but JWT is required");
        send_error(
            client_id,
            state,
            ErrorCode::AuthenticationRequired,
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

    fn assert_error_code(message: WsMessage, code: &str) {
        assert_eq!(message.msg_type, "error");
        assert_eq!(message.payload.unwrap()["code"], code);
    }

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

    #[tokio::test]
    async fn jwt_names_are_sanitized_and_empty_names_are_rejected() {
        let state = test_helpers::create_state();
        let (client, _rx) = test_helpers::create_client_with_rx("user", "", false);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);
        let jwt_config = Arc::new(JwtConfig {
            secret: "test-secret".to_string(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: true,
        });
        let now = (crate::utils::now_ms() / 1000) as usize;
        let token_for = |name: String| {
            encode(
                &Header::default(),
                &Claims {
                    sub: "user".to_string(),
                    name,
                    aud: jwt_config.audience.clone(),
                    iss: jwt_config.issuer.clone(),
                    exp: now + 3600,
                    iat: now,
                },
                &EncodingKey::from_secret(jwt_config.secret.as_bytes()),
            )
            .unwrap()
        };

        assert!(
            handle_jwt_auth(
                "client",
                &token_for(format!("  Alice\0{}  ", "界".repeat(120))),
                &state,
                &jwt_config,
            )
            .await
        );
        let stored_name = state.read().await.clients["client"].user_name.clone();
        assert!(
            stored_name.starts_with("Alice"),
            "stored name: {stored_name:?}"
        );
        assert!(!stored_name.chars().any(char::is_control));
        assert!(stored_name.chars().count() <= super::super::super::constants::MAX_NAME_LENGTH);

        assert!(
            !handle_jwt_auth(
                "client",
                &token_for("\0\n\r".to_string()),
                &state,
                &jwt_config,
            )
            .await
        );
    }

    #[tokio::test]
    async fn authentication_failures_have_stable_codes() {
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

        let invalid = IncomingMessage {
            msg_type: crate::types::ClientMessageType::Auth,
            room: None,
            client: None,
            payload: Some(serde_json::json!({ "token": "invalid" })),
            ts: 0,
            server_ts: None,
        };
        handle_auth("client", &invalid, &state, &jwt_config).await;
        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "AUTHENTICATION_FAILED",
        );

        let missing = IncomingMessage {
            payload: Some(serde_json::json!({})),
            ..invalid
        };
        handle_auth("client", &missing, &state, &jwt_config).await;
        assert_error_code(
            test_helpers::recv_msg(&mut rx).unwrap(),
            "AUTHENTICATION_REQUIRED",
        );
    }
}
