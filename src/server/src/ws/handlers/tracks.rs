use super::super::dispatch::is_authenticated;
use crate::messaging::{collect_room_senders, send_to_senders};
use crate::room::participant_tracks_message;
use crate::types::{IncomingMessage, ServerState, SharedState};
use log::debug;

/// The longest track title kept, in characters.
pub(crate) const MAX_TRACK_TITLE_CHARS: usize = 100;
/// The longest language code kept: ISO 639 codes and BCP 47 tags fit.
const MAX_TRACK_LANGUAGE_CHARS: usize = 16;

/// One track, as `{ title?, language?, forced? }`: the stream's title, its
/// language code and, for subtitles, whether it is forced. Unknown fields,
/// an empty or too long title, a malformed language and a non-boolean
/// `forced` make it invalid. Returns the track with only the given fields.
fn valid_track(value: &serde_json::Value) -> Option<serde_json::Value> {
    let object = value.as_object()?;
    let mut track = serde_json::Map::new();
    for (key, field) in object {
        match key.as_str() {
            "title" => {
                let title = field.as_str()?.trim();
                if title.is_empty()
                    || title.chars().count() > MAX_TRACK_TITLE_CHARS
                    || title.chars().any(char::is_control)
                {
                    return None;
                }
                track.insert(key.clone(), serde_json::json!(title));
            }
            "language" => {
                let language = field.as_str()?;
                if language.is_empty()
                    || language.len() > MAX_TRACK_LANGUAGE_CHARS
                    || !language
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
                {
                    return None;
                }
                track.insert(key.clone(), serde_json::json!(language));
            }
            "forced" => {
                track.insert(key.clone(), serde_json::json!(field.as_bool()?));
            }
            _ => return None,
        }
    }
    Some(serde_json::Value::Object(track))
}

/// The payload must be exactly `{ media_id, audio, subtitle }`: the Jellyfin
/// item the member plays (32 hex digits) and each track, or null for none.
fn valid_tracks(payload: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let object = payload?.as_object()?;
    if object.len() != 3 {
        return None;
    }
    let media_id = object.get("media_id")?.as_str()?;
    if media_id.len() != 32 || !media_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let track = |key: &str| match object.get(key)? {
        serde_json::Value::Null => Some(serde_json::Value::Null),
        value => valid_track(value),
    };
    Some(serde_json::json!({
        "media_id": media_id.to_ascii_lowercase(),
        "audio": track("audio")?,
        "subtitle": track("subtitle")?,
    }))
}

/// Stores a member's tracks and sends the room the new `participant_tracks`,
/// unless they did not change. Runs under the state's write lock, as every
/// sender of participant messages does.
fn record_tracks(state: &mut ServerState, client_id: &str, tracks: serde_json::Value) {
    let ServerState { clients, rooms } = state;
    let Some(room) = clients
        .get(client_id)
        .and_then(|client| client.room_id.as_ref())
        .and_then(|room_id| rooms.get_mut(room_id))
    else {
        return;
    };
    if !room.clients.iter().any(|id| id == client_id) || room.tracks.get(client_id) == Some(&tracks)
    {
        return;
    }
    room.tracks.insert(client_id.to_string(), tracks);
    send_to_senders(
        &collect_room_senders(room, clients, None),
        &participant_tracks_message(room),
        "participant tracks",
    );
}

/// `participant_tracks`: a member reports the audio and subtitle tracks it
/// plays, for the others to see. Informational only: an invalid payload is
/// ignored without an error, as for `participant_status`.
pub(in crate::ws) async fn handle_participant_tracks(
    client_id: &str,
    parsed: &IncomingMessage,
    state: &SharedState,
) {
    if !is_authenticated(client_id, state).await {
        return;
    }
    let Some(tracks) = valid_tracks(parsed.payload.as_ref()) else {
        debug!("Ignoring invalid participant tracks client_id={client_id}");
        return;
    };
    record_tracks(&mut *state.write().await, client_id, tracks);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers;
    use crate::types::{ClientMessageType, ServerMessageType, WsMessage};

    const MEDIA: &str = "09a5f21d9ff1211e52063842163eb2e0";

    fn tracks_message(payload: serde_json::Value) -> IncomingMessage {
        IncomingMessage {
            msg_type: ClientMessageType::ParticipantTracks,
            room: None,
            client: None,
            payload: Some(payload),
            ts: 0,
            server_ts: None,
        }
    }

    fn tracks(message: &WsMessage) -> serde_json::Value {
        assert_eq!(message.msg_type, ServerMessageType::ParticipantTracks);
        message.payload.as_ref().unwrap()["tracks"].clone()
    }

    fn report(audio: serde_json::Value, subtitle: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "media_id": MEDIA, "audio": audio, "subtitle": subtitle })
    }

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
    fn keeps_a_report_with_known_fields_and_trims_the_title() {
        let english = serde_json::json!({ "title": "  English ", "language": "eng" });
        let forced = serde_json::json!({ "language": "spa", "forced": true });
        assert_eq!(
            valid_tracks(Some(&report(english, forced))),
            Some(serde_json::json!({
                "media_id": MEDIA,
                "audio": { "title": "English", "language": "eng" },
                "subtitle": { "language": "spa", "forced": true }
            }))
        );
        let upper =
            serde_json::json!({ "media_id": MEDIA.to_uppercase(), "audio": {}, "subtitle": null });
        assert_eq!(
            valid_tracks(Some(&upper)),
            Some(serde_json::json!({ "media_id": MEDIA, "audio": {}, "subtitle": null }))
        );
        let long = "é".repeat(MAX_TRACK_TITLE_CHARS);
        assert!(valid_track(&serde_json::json!({ "title": long })).is_some());
        assert!(valid_track(&serde_json::json!({ "language": "zh-Hant-TW" })).is_some());
    }

    #[test]
    fn ignores_a_malformed_report() {
        let ok = serde_json::json!({ "language": "eng" });
        for payload in [
            serde_json::json!({ "media_id": MEDIA, "audio": ok }),
            serde_json::json!({ "media_id": MEDIA, "audio": ok, "subtitle": null, "extra": 1 }),
            serde_json::json!({ "media_id": "abc", "audio": ok, "subtitle": null }),
            serde_json::json!({ "media_id": "g".repeat(32), "audio": ok, "subtitle": null }),
            serde_json::json!({ "media_id": 1, "audio": ok, "subtitle": null }),
            report(serde_json::json!("eng"), serde_json::Value::Null),
            report(
                serde_json::json!({ "codec": "aac" }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "title": "   " }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "title": "a".repeat(MAX_TRACK_TITLE_CHARS + 1) }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "title": "two\nlines" }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "language": "" }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "language": "e n" }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::json!({ "language": "a".repeat(17) }),
                serde_json::Value::Null,
            ),
            report(
                serde_json::Value::Null,
                serde_json::json!({ "forced": "yes" }),
            ),
            serde_json::json!([MEDIA]),
        ] {
            assert_eq!(valid_tracks(Some(&payload)), None, "{payload}");
        }
        assert_eq!(valid_tracks(None), None);
    }

    #[tokio::test]
    async fn a_report_reaches_the_whole_room_in_list_order_once() {
        let state = test_helpers::create_state();
        let (mut host_rx, mut guest_rx) = room_with_guest(&state).await;
        let english = report(
            serde_json::json!({ "title": "English" }),
            serde_json::Value::Null,
        );

        handle_participant_tracks("guest", &tracks_message(english.clone()), &state).await;

        let to_host = test_helpers::recv_msg(&mut host_rx).unwrap();
        let to_guest = test_helpers::recv_msg(&mut guest_rx).unwrap();
        assert_eq!(tracks(&to_host), serde_json::json!([null, english]));
        assert_eq!(tracks(&to_guest), tracks(&to_host));
        assert_eq!(to_host.room.as_deref(), Some("room-1"));

        // The same report again changes nothing and sends nothing.
        handle_participant_tracks("guest", &tracks_message(english), &state).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
    }

    #[tokio::test]
    async fn ignores_a_report_from_outside_the_room_list_or_unauthenticated_or_invalid() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        let english = report(
            serde_json::json!({ "title": "English" }),
            serde_json::Value::Null,
        );
        {
            let mut locked = state.write().await;
            let (outsider, _rx) = test_helpers::create_client_with_rx("outsider", "Out", true);
            locked.clients.insert("outsider".to_string(), outsider);
            // Points at the room without being in its list.
            let (mut unlisted, _rx) = test_helpers::create_client_with_rx("unlisted", "Unl", true);
            unlisted.room_id = Some("room-1".to_string());
            locked.clients.insert("unlisted".to_string(), unlisted);
            // In the room's list, but not authenticated.
            let (mut stranger, _rx) = test_helpers::create_client_with_rx("stranger", "Str", false);
            stranger.room_id = Some("room-1".to_string());
            locked.clients.insert("stranger".to_string(), stranger);
            let room = locked.rooms.get_mut("room-1").unwrap();
            room.clients.push("stranger".to_string());
        }
        handle_participant_tracks("outsider", &tracks_message(english.clone()), &state).await;
        handle_participant_tracks("unlisted", &tracks_message(english.clone()), &state).await;
        handle_participant_tracks("stranger", &tracks_message(english), &state).await;
        handle_participant_tracks("guest", &tracks_message(serde_json::json!({})), &state).await;
        assert!(test_helpers::recv_msg(&mut host_rx).is_none());
        assert!(state.read().await.rooms["room-1"].tracks.is_empty());
    }

    #[tokio::test]
    async fn a_member_who_leaves_takes_their_tracks_away() {
        let state = test_helpers::create_state();
        let (mut host_rx, _guest_rx) = room_with_guest(&state).await;
        let english = report(
            serde_json::json!({ "title": "English" }),
            serde_json::Value::Null,
        );
        handle_participant_tracks("host", &tracks_message(english.clone()), &state).await;
        handle_participant_tracks("guest", &tracks_message(english.clone()), &state).await;
        while test_helpers::recv_msg(&mut host_rx).is_some() {}

        let notification = {
            let mut locked = state.write().await;
            let ServerState { clients, rooms } = &mut *locked;
            crate::room::handle_leave("guest", clients, rooms).unwrap()
        };
        crate::room::send_leave_notification(&notification, "test");

        let messages =
            std::iter::from_fn(|| test_helpers::recv_msg(&mut host_rx)).collect::<Vec<_>>();
        let last = messages.last().unwrap();
        assert_eq!(tracks(last), serde_json::json!([english]));
        assert!(!state.read().await.rooms["room-1"]
            .tracks
            .contains_key("guest"));
    }
}
