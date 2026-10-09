use super::super::constants::PROTOCOL_VERSION;
use super::super::dispatch::{close_with_policy, send_error, ErrorCode};
use super::super::validation::sanitize_name;
use crate::auth::JwtConfig;
use crate::messaging::{send_message, send_room_list};
use crate::types::{IncomingMessage, SharedState, WsMessage};
use crate::utils::now_ms;
use log::{info, warn};
use std::sync::Arc;

const HOST_TRANSFER_FEATURE: &str = "host_transfer";
const PARTICIPANT_STATUS_FEATURE: &str = "participant_status";

/// Reads the protocol version declared in the auth payload.
///
/// `Ok(None)` means the field was absent: the client is treated as version 1 so
/// pre-negotiation clients keep working. `Ok(Some(version))` is a declared
/// version and `Err(())` a present but malformed value.
fn declared_protocol_version(payload: Option<&serde_json::Value>) -> Result<Option<u64>, ()> {
    match payload.and_then(|value| value.get("protocol_version")) {
        None => Ok(None),
        Some(version) => version.as_u64().map(Some).ok_or(()),
    }
}

/// Returns `None` when the field was absent and the supported subset otherwise.
fn declared_features(payload: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let features = payload?.get("features")?;
    let declared: Vec<&str> = features
        .as_array()
        .map(|features| {
            features
                .iter()
                .filter_map(|feature| feature.as_str())
                .collect()
        })
        .unwrap_or_default();
    let mut supported = Vec::new();
    if declared.contains(&HOST_TRANSFER_FEATURE) {
        supported.push(HOST_TRANSFER_FEATURE.to_string());
    }
    if declared.contains(&PARTICIPANT_STATUS_FEATURE) {
        supported.push(PARTICIPANT_STATUS_FEATURE.to_string());
    }
    Some(supported)
}

fn auth_success_message(
    client_id: &str,
    user_name: &str,
    protocol_version: Option<u64>,
    features: Option<&[String]>,
) -> WsMessage {
    let mut payload = serde_json::json!({ "user_name": user_name });
    if let Some(protocol_version) = protocol_version {
        payload["protocol_version"] = serde_json::json!(protocol_version);
    }
    if let Some(features) = features {
        payload["features"] = serde_json::json!(features);
    }
    WsMessage {
        msg_type: "auth_success".to_string(),
        room: None,
        client: Some(client_id.to_string()),
        payload: Some(payload),
        ts: now_ms(),
        server_ts: Some(now_ms()),
    }
}

async fn reject_unsupported_protocol_version(client_id: &str, state: &SharedState, message: &str) {
    send_error(
        client_id,
        state,
        ErrorCode::ProtocolVersionUnsupported,
        message,
    )
    .await;
    close_with_policy(client_id, state, "Unsupported protocol version").await;
}

async fn handle_jwt_auth(
    client_id: &str,
    token: &str,
    state: &SharedState,
    jwt_config: &Arc<JwtConfig>,
    protocol_version: Option<u64>,
    features: Option<&[String]>,
) -> bool {
    match jwt_config.validate_token(token) {
        Ok(claims) => {
            let Some(user_name) = sanitize_name(&claims.name) else {
                warn!("Auth failed, JWT name is empty after sanitization client_id={client_id}");
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
                    client.supports_host_transfer = features.is_some_and(|features| {
                        features.iter().any(|f| f == HOST_TRANSFER_FEATURE)
                    });
                    info!("Client authenticated client_id={client_id} user={user_name:?}");
                }
                sender
            };
            send_message(
                sender,
                &auth_success_message(client_id, &user_name, protocol_version, features),
                Some(client_id),
            );
            send_room_list(client_id, state).await;
            true
        }
        Err(e) => {
            warn!(
                "Auth failed client_id={client_id} error={:?}",
                e.to_string()
            );
            false
        }
    }
}

async fn handle_identity(
    client_id: &str,
    payload: &serde_json::Value,
    state: &SharedState,
    protocol_version: Option<u64>,
    features: Option<&[String]>,
) {
    let user_name = payload
        .get("user_name")
        .and_then(|v| v.as_str())
        .and_then(sanitize_name);
    let user_id = payload.get("user_id").and_then(|v| v.as_str());
    let (sender, stored_name) = {
        let mut state = state.write().await;
        if let Some(client) = state.clients.get_mut(client_id) {
            if let Some(name) = user_name {
                client.user_name = name.clone();
                if let Some(uid) = user_id {
                    client.user_id = uid.to_string();
                }
                info!("Client identified client_id={client_id} user={name:?}");
            }
            client.supports_host_transfer = features
                .is_some_and(|features| features.iter().any(|f| f == HOST_TRANSFER_FEATURE));
            (Some(client.sender.clone()), client.user_name.clone())
        } else {
            (None, String::new())
        }
    };
    // Insecure clients were already authenticated at connection time. Only
    // feature-aware clients need the new acknowledgement.
    if features.is_some() {
        send_message(
            sender,
            &auth_success_message(client_id, &stored_name, protocol_version, features),
            Some(client_id),
        );
    }
}

pub(in crate::ws) async fn handle_auth(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
    jwt_config: &Arc<JwtConfig>,
) {
    let declared_version = match declared_protocol_version(parsed.payload.as_ref()) {
        Ok(version) => version,
        Err(()) => {
            warn!("Malformed protocol_version client_id={client_id}");
            reject_unsupported_protocol_version(
                client_id,
                state,
                &format!(
                    "Invalid protocol_version field (server protocol version {PROTOCOL_VERSION})"
                ),
            )
            .await;
            return;
        }
    };
    if let Some(version) = declared_version {
        if version != PROTOCOL_VERSION {
            warn!("Unsupported protocol version client_id={client_id} version={version}");
            reject_unsupported_protocol_version(
                client_id,
                state,
                &format!(
                    "Protocol version {version} is not supported (server protocol version {PROTOCOL_VERSION})"
                ),
            )
            .await;
            return;
        }
    }
    let features = declared_features(parsed.payload.as_ref());

    if let Some(payload) = &parsed.payload {
        if let Some(token) = payload.get("token").and_then(|v| v.as_str()) {
            if handle_jwt_auth(
                client_id,
                token,
                state,
                jwt_config,
                declared_version,
                features.as_deref(),
            )
            .await
            {
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
            handle_identity(
                client_id,
                payload,
                state,
                declared_version,
                features.as_deref(),
            )
            .await;
        } else {
            warn!("Auth without token while JWT is required client_id={client_id}");
            send_error(
                client_id,
                state,
                ErrorCode::AuthenticationRequired,
                "Authentication required: no token provided",
            )
            .await;
        }
    } else if jwt_config.enabled {
        warn!("Auth with no payload while JWT is required client_id={client_id}");
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
                None,
                None,
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
                None,
                None,
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

    fn insecure_jwt_config() -> Arc<JwtConfig> {
        Arc::new(JwtConfig {
            secret: String::new(),
            audience: "OpenWatchParty".to_string(),
            issuer: "Jellyfin".to_string(),
            enabled: false,
        })
    }

    fn auth_message(payload: serde_json::Value) -> IncomingMessage {
        IncomingMessage {
            msg_type: crate::types::ClientMessageType::Auth,
            room: None,
            client: None,
            payload: Some(payload),
            ts: crate::utils::now_ms(),
            server_ts: None,
        }
    }

    #[tokio::test]
    async fn missing_protocol_version_defaults_to_v1() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("user", "", false);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);

        handle_auth(
            "client",
            &auth_message(serde_json::json!({ "user_name": "Bob" })),
            &state,
            &insecure_jwt_config(),
        )
        .await;

        assert_eq!(state.read().await.clients["client"].user_name, "Bob");
        assert!(test_helpers::recv_msg(&mut rx).is_none());
    }

    #[tokio::test]
    async fn current_protocol_version_is_accepted() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("user", "", false);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);

        handle_auth(
            "client",
            &auth_message(
                serde_json::json!({ "user_name": "Bob", "protocol_version": PROTOCOL_VERSION }),
            ),
            &state,
            &insecure_jwt_config(),
        )
        .await;

        assert_eq!(state.read().await.clients["client"].user_name, "Bob");
        assert!(test_helpers::recv_msg(&mut rx).is_none());
    }

    #[tokio::test]
    async fn unsupported_protocol_versions_are_rejected_and_closed() {
        for version in [0, PROTOCOL_VERSION + 1, u64::MAX] {
            let state = test_helpers::create_state();
            let (client, mut rx) = test_helpers::create_client_with_rx("user", "Alice", true);
            state
                .write()
                .await
                .clients
                .insert("client".to_string(), client);

            handle_auth(
                "client",
                &auth_message(serde_json::json!({ "protocol_version": version })),
                &state,
                &insecure_jwt_config(),
            )
            .await;

            let error = test_helpers::recv_msg(&mut rx).unwrap();
            assert_eq!(error.msg_type, "error");
            let payload = error.payload.unwrap();
            assert_eq!(payload["code"], "PROTOCOL_VERSION_UNSUPPORTED");
            assert!(
                payload["message"]
                    .as_str()
                    .unwrap()
                    .contains(&version.to_string()),
                "message must name the requested version: {payload:?}"
            );

            let close = rx.recv().await.unwrap().unwrap();
            assert_eq!(
                close.close_frame(),
                Some((
                    super::super::super::constants::POLICY_VIOLATION_CLOSE_CODE,
                    "Unsupported protocol version"
                ))
            );
        }
    }

    #[tokio::test]
    async fn malformed_protocol_version_is_rejected() {
        let state = test_helpers::create_state();
        let (client, mut rx) = test_helpers::create_client_with_rx("user", "Alice", true);
        state
            .write()
            .await
            .clients
            .insert("client".to_string(), client);

        handle_auth(
            "client",
            &auth_message(serde_json::json!({ "protocol_version": "1" })),
            &state,
            &insecure_jwt_config(),
        )
        .await;

        let payload = test_helpers::recv_msg(&mut rx).unwrap().payload.unwrap();
        assert_eq!(payload["code"], "PROTOCOL_VERSION_UNSUPPORTED");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("Invalid protocol_version"));
    }

    #[tokio::test]
    async fn auth_success_echoes_only_a_declared_protocol_version() {
        for declared in [None, Some(PROTOCOL_VERSION)] {
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
            let mut payload = serde_json::json!({ "token": token });
            if let Some(version) = declared {
                payload["protocol_version"] = serde_json::json!(version);
            }

            handle_auth("client", &auth_message(payload), &state, &jwt_config).await;

            let success = test_helpers::recv_msg(&mut rx).unwrap();
            assert_eq!(success.msg_type, "auth_success");
            assert_eq!(
                success.payload.unwrap()["protocol_version"].as_u64(),
                declared
            );
        }
    }

    #[tokio::test]
    async fn participant_status_is_echoed_when_declared() {
        for (declared, expected) in [
            (
                serde_json::json!(["participant_status"]),
                serde_json::json!(["participant_status"]),
            ),
            (
                serde_json::json!(["host_transfer", "participant_status"]),
                serde_json::json!(["host_transfer", "participant_status"]),
            ),
            (
                serde_json::json!(["host_transfer"]),
                serde_json::json!(["host_transfer"]),
            ),
        ] {
            let state = test_helpers::create_state();
            let (client, mut rx) = test_helpers::create_client_with_rx("user", "Anonymous", true);
            state
                .write()
                .await
                .clients
                .insert("client".to_string(), client);

            handle_auth(
                "client",
                &auth_message(serde_json::json!({
                    "user_name": "Bob",
                    "features": declared,
                })),
                &state,
                &insecure_jwt_config(),
            )
            .await;

            let success = test_helpers::recv_msg(&mut rx).unwrap();
            assert_eq!(success.payload.unwrap()["features"], expected);
        }
    }

    #[tokio::test]
    async fn insecure_auth_stores_and_echoes_supported_features_when_declared() {
        for (declared, expected) in [
            (serde_json::json!(["host_transfer", "future"]), true),
            (serde_json::json!(["future", 7, null]), false),
            (serde_json::json!("host_transfer"), false),
        ] {
            let state = test_helpers::create_state();
            let (client, mut rx) = test_helpers::create_client_with_rx("user", "Anonymous", true);
            state
                .write()
                .await
                .clients
                .insert("client".to_string(), client);

            handle_auth(
                "client",
                &auth_message(serde_json::json!({
                    "user_name": "Bob",
                    "features": declared,
                })),
                &state,
                &insecure_jwt_config(),
            )
            .await;

            assert_eq!(
                state.read().await.clients["client"].supports_host_transfer,
                expected
            );
            let success = test_helpers::recv_msg(&mut rx).unwrap();
            assert_eq!(success.msg_type, "auth_success");
            assert_eq!(
                success.payload.unwrap()["features"],
                if expected {
                    serde_json::json!(["host_transfer"])
                } else {
                    serde_json::json!([])
                }
            );
        }
    }

    #[tokio::test]
    async fn insecure_auth_without_valid_features_does_not_enable_host_transfer() {
        for payload in [
            serde_json::json!({ "user_name": "Bob" }),
            serde_json::json!({
                "user_name": "Bob",
                "features": "host_transfer"
            }),
        ] {
            let state = test_helpers::create_state();
            let (client, _rx) = test_helpers::create_client_with_rx("user", "Anonymous", true);
            state
                .write()
                .await
                .clients
                .insert("client".to_string(), client);

            handle_auth(
                "client",
                &auth_message(payload),
                &state,
                &insecure_jwt_config(),
            )
            .await;

            assert!(!state.read().await.clients["client"].supports_host_transfer);
        }
    }

    #[tokio::test]
    async fn omitted_features_are_not_echoed_on_jwt_auth() {
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

        handle_auth(
            "client",
            &auth_message(serde_json::json!({ "token": token })),
            &state,
            &jwt_config,
        )
        .await;

        let success = test_helpers::recv_msg(&mut rx).unwrap();
        assert!(success.payload.unwrap().get("features").is_none());
        assert!(!state.read().await.clients["client"].supports_host_transfer);
    }

    #[tokio::test]
    async fn jwt_auth_stores_and_echoes_host_transfer() {
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

        handle_auth(
            "client",
            &auth_message(serde_json::json!({
                "token": token,
                "features": ["host_transfer", "future"]
            })),
            &state,
            &jwt_config,
        )
        .await;

        assert!(state.read().await.clients["client"].supports_host_transfer);
        assert_eq!(
            test_helpers::recv_msg(&mut rx).unwrap().payload.unwrap()["features"],
            serde_json::json!(["host_transfer"])
        );
    }
}
