//! The room's media queue (#69): list operations only, no I/O.
//!
//! The current item is the room's `media_id`, so it isn't stored twice. Ids
//! and titles are validated by the handler before they reach the queue.

use crate::types::{Client, QueueDetails, QueueSuggestionDetails, QueueUnavailableDetails};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Items kept per room, watched ones included.
pub(crate) const MAX_QUEUE_ITEMS: usize = 20;
pub(crate) const MAX_SUGGESTIONS: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Suggestion {
    pub id: String,
    pub title: String,
    pub series: Option<String>,
    pub by: String,
    pub by_user: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct QueueItem {
    pub id: String,
    pub title: String,
    /// Kept for the countdown (see `advance`), never sent: older clients
    /// reject unknown fields in `queue_state`.
    #[serde(skip)]
    pub series: Option<String>,
}

/// When the room moves to the next item, and the timer generation allowed to
/// do it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Countdown {
    pub until: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MediaQueue {
    pub items: Vec<QueueItem>,
    pub suggestions: Vec<Suggestion>,
    pub availability: HashMap<String, HashSet<String>>,
    /// The last item `add` appended. It stays after that item is removed, so
    /// the host's client fills the queue on from it and an item the host
    /// removed doesn't come back, after a reload or a host change too.
    pub last_added: Option<String>,
    pub countdown: Option<Countdown>,
    /// The generation of the pending play the last advance armed. While that
    /// play is pending, the host may still report its previous item, which
    /// mustn't move the new item's start.
    pub advance_generation: Option<u64>,
}

impl MediaQueue {
    fn position(&self, id: &str) -> Option<usize> {
        self.items.iter().position(|item| item.id == id)
    }

    /// Index of the room's current item, if it is queued.
    pub(crate) fn current(&self, media_id: Option<&str>) -> Option<usize> {
        self.position(media_id?)
    }

    pub(crate) fn next(&self, media_id: Option<&str>) -> Option<&QueueItem> {
        self.items.get(self.current(media_id)? + 1)
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.position(id).is_some()
    }

    /// Appends the items that aren't queued yet. A full queue drops its oldest
    /// watched item for each new one; items that still don't fit are ignored.
    /// Returns whether the queue changed.
    pub(crate) fn add(&mut self, items: Vec<QueueItem>, media_id: Option<&str>) -> bool {
        let mut changed = false;
        for item in items {
            if self.contains(&item.id) {
                continue;
            }
            if self.items.len() >= MAX_QUEUE_ITEMS {
                if self.current(media_id).unwrap_or(0) == 0 {
                    break;
                }
                self.items.remove(0);
            }
            self.last_added = Some(item.id.clone());
            self.suggestions
                .retain(|suggestion| suggestion.id != item.id);
            self.items.push(item);
            changed = true;
        }
        changed
    }

    /// Removes any item but the current one.
    pub(crate) fn remove(&mut self, id: &str, media_id: Option<&str>) -> bool {
        if media_id == Some(id) {
            return false;
        }
        let Some(index) = self.position(id) else {
            return false;
        };
        self.items.remove(index);
        true
    }

    /// Moves an upcoming item to another upcoming index, so the current item
    /// and the watched ones keep their place.
    pub(crate) fn move_to(&mut self, id: &str, to: usize, media_id: Option<&str>) -> bool {
        let first_upcoming = self.current(media_id).map_or(0, |index| index + 1);
        let Some(from) = self.position(id) else {
            return false;
        };
        if from < first_upcoming || to < first_upcoming || to >= self.items.len() || to == from {
            return false;
        }
        let item = self.items.remove(from);
        self.items.insert(to, item);
        true
    }

    pub(crate) fn suggest(&mut self, suggestion: Suggestion) -> bool {
        if self.contains(&suggestion.id)
            || self
                .suggestions
                .iter()
                .any(|existing| existing.id == suggestion.id)
            || self.suggestions.len() >= MAX_SUGGESTIONS
        {
            return false;
        }
        self.suggestions.push(suggestion);
        true
    }

    pub(crate) fn dismiss(&mut self, id: &str, by_user: &str, is_host: bool) -> bool {
        let Some(index) = self
            .suggestions
            .iter()
            .position(|suggestion| suggestion.id == id)
        else {
            return false;
        };
        if !is_host && self.suggestions[index].by_user != by_user {
            return false;
        }
        self.suggestions.remove(index);
        true
    }

    fn active_ids(&self) -> HashSet<String> {
        self.items
            .iter()
            .map(|item| item.id.clone())
            .chain(
                self.suggestions
                    .iter()
                    .map(|suggestion| suggestion.id.clone()),
            )
            .collect()
    }

    /// Replaces one member's report and returns whether any visible detail
    /// changed.
    pub(crate) fn report_availability(
        &mut self,
        client_id: &str,
        missing: HashSet<String>,
    ) -> bool {
        let active = self.active_ids();
        let changed = active.iter().any(|id| {
            self.availability
                .get(client_id)
                .is_some_and(|previous| previous.contains(id.as_str()))
                != missing.contains(id.as_str())
        });
        self.availability.insert(client_id.to_string(), missing);
        changed
    }

    pub(crate) fn forget_availability(&mut self, client_id: &str) -> bool {
        let active = self.active_ids();
        self.availability
            .remove(client_id)
            .is_some_and(|missing| missing.iter().any(|id| active.contains(id)))
    }

    pub(crate) fn details(
        &self,
        recipient_id: &str,
        clients: &HashMap<String, Client>,
        members: &[String],
    ) -> QueueDetails {
        let recipient_user = clients
            .get(recipient_id)
            .filter(|client| !client.user_id.is_empty())
            .map_or(recipient_id, |client| client.user_id.as_str());
        let suggestions = self
            .suggestions
            .iter()
            .map(|suggestion| QueueSuggestionDetails {
                id: suggestion.id.clone(),
                title: suggestion.title.clone(),
                series: suggestion.series.clone(),
                by: suggestion.by.clone(),
                mine: suggestion.by_user == recipient_user,
            })
            .collect();
        let ids = self.items.iter().map(|item| item.id.as_str()).chain(
            self.suggestions
                .iter()
                .map(|suggestion| suggestion.id.as_str()),
        );
        let unavailable = ids
            .filter_map(|id| {
                let mut you = false;
                let mut seen_users = HashSet::new();
                let names: Vec<_> = members
                    .iter()
                    .filter(|member| {
                        self.availability
                            .get(member.as_str())
                            .is_some_and(|missing| missing.contains(id))
                    })
                    .filter_map(|member| {
                        let client = clients.get(member)?;
                        let user = if client.user_id.is_empty() {
                            member.as_str()
                        } else {
                            client.user_id.as_str()
                        };
                        if user == recipient_user {
                            you = true;
                            None
                        } else if seen_users.insert(user) {
                            Some(client.user_name.clone())
                        } else {
                            None
                        }
                    })
                    .collect();
                (you || !names.is_empty()).then(|| QueueUnavailableDetails {
                    id: id.to_string(),
                    names,
                    you,
                })
            })
            .collect();
        QueueDetails {
            suggestions,
            unavailable,
        }
    }

    /// The `queue_state` payload.
    pub(crate) fn payload(&self, media_id: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "items": self.items,
            "current": self.current(media_id),
            "last_added": self.last_added,
            "countdown_until": self.countdown.map(|countdown| countdown.until),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> QueueItem {
        QueueItem {
            id: id.to_string(),
            title: format!("Episode {id}"),
            series: None,
        }
    }

    fn queue(ids: &[&str]) -> MediaQueue {
        MediaQueue {
            items: ids.iter().map(|id| item(id)).collect(),
            ..Default::default()
        }
    }

    fn ids(queue: &MediaQueue) -> Vec<&str> {
        queue.items.iter().map(|item| item.id.as_str()).collect()
    }

    #[test]
    fn current_and_next_follow_the_room_media() {
        let queue = queue(&["a", "b", "c"]);
        assert_eq!(queue.current(Some("b")), Some(1));
        assert_eq!(queue.next(Some("b")), Some(&item("c")));
        assert_eq!(queue.next(Some("c")), None);
        assert_eq!(queue.current(Some("x")), None);
        assert_eq!(queue.next(Some("x")), None);
        assert_eq!(queue.current(None), None);
    }

    #[test]
    fn add_appends_new_items_once() {
        let mut queue = queue(&["a"]);
        assert!(queue.add(vec![item("b"), item("a"), item("b"), item("c")], Some("a")));
        assert_eq!(ids(&queue), ["a", "b", "c"]);
        assert_eq!(queue.last_added.as_deref(), Some("c"));
        assert!(!queue.add(vec![item("c")], Some("a")));
    }

    #[test]
    fn the_last_added_item_outlives_its_removal() {
        let names: Vec<String> = (0..MAX_QUEUE_ITEMS).map(|i| i.to_string()).collect();
        let mut full = queue(&names.iter().map(String::as_str).collect::<Vec<_>>());
        let mut queue = queue(&["a"]);
        assert!(queue.add(vec![item("b"), item("c")], Some("a")));
        assert!(queue.remove("c", Some("a")));
        assert_eq!(queue.last_added.as_deref(), Some("c"));

        // Items already queued, or that don't fit, don't move it.
        assert!(!queue.add(vec![item("b")], Some("a")));
        assert_eq!(queue.last_added.as_deref(), Some("c"));
        full.last_added = Some("19".to_string());
        assert!(!full.add(vec![item("new")], Some("0")));
        assert_eq!(full.last_added.as_deref(), Some("19"));
    }

    #[test]
    fn a_full_queue_drops_watched_items_first() {
        let names: Vec<String> = (0..MAX_QUEUE_ITEMS).map(|i| i.to_string()).collect();
        let mut queue = queue(&names.iter().map(String::as_str).collect::<Vec<_>>());

        assert!(queue.add(vec![item("new1"), item("new2"), item("new3")], Some("2")));
        assert_eq!(queue.items.len(), MAX_QUEUE_ITEMS);
        assert_eq!(&ids(&queue)[..1], ["2"]);
        assert_eq!(&ids(&queue)[MAX_QUEUE_ITEMS - 2..], ["new1", "new2"]);
        assert_eq!(queue.current(Some("2")), Some(0));
    }

    #[test]
    fn a_full_queue_without_watched_items_ignores_new_ones() {
        let names: Vec<String> = (0..MAX_QUEUE_ITEMS).map(|i| i.to_string()).collect();
        let mut queue = queue(&names.iter().map(String::as_str).collect::<Vec<_>>());

        assert!(!queue.add(vec![item("new")], Some("0")));
        assert!(!queue.add(vec![item("new")], None));
        assert_eq!(queue.items.len(), MAX_QUEUE_ITEMS);
        assert!(!queue.contains("new"));
    }

    #[test]
    fn remove_keeps_the_current_item() {
        let mut queue = queue(&["a", "b", "c"]);
        assert!(!queue.remove("b", Some("b")));
        assert!(!queue.remove("x", Some("b")));
        assert!(queue.remove("a", Some("b")));
        assert!(queue.remove("c", Some("b")));
        assert_eq!(ids(&queue), ["b"]);
    }

    #[test]
    fn move_to_reorders_upcoming_items_only() {
        let mut queue = queue(&["a", "b", "c", "d", "e"]);
        assert!(queue.move_to("e", 2, Some("b")));
        assert_eq!(ids(&queue), ["a", "b", "e", "c", "d"]);
        assert!(queue.move_to("e", 4, Some("b")));
        assert_eq!(ids(&queue), ["a", "b", "c", "d", "e"]);

        assert!(!queue.move_to("b", 3, Some("b")), "current item");
        assert!(!queue.move_to("a", 3, Some("b")), "watched item");
        assert!(!queue.move_to("d", 1, Some("b")), "into the watched items");
        assert!(!queue.move_to("d", 5, Some("b")), "out of range");
        assert!(!queue.move_to("d", 3, Some("b")), "same place");
        assert!(!queue.move_to("x", 3, Some("b")), "unknown item");
        assert_eq!(ids(&queue), ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn move_to_reorders_everything_when_the_room_media_isnt_queued() {
        let mut queue = queue(&["a", "b", "c"]);
        assert!(queue.move_to("c", 0, Some("x")));
        assert_eq!(ids(&queue), ["c", "a", "b"]);
    }

    #[test]
    fn payload_reports_items_current_last_added_and_countdown() {
        let mut queue = queue(&["a", "b"]);
        assert_eq!(
            queue.payload(Some("a")),
            serde_json::json!({
                "items": [
                    { "id": "a", "title": "Episode a" },
                    { "id": "b", "title": "Episode b" },
                ],
                "current": 0,
                "last_added": null,
                "countdown_until": null,
            })
        );

        queue.countdown = Some(Countdown {
            until: 1234,
            generation: 7,
        });
        queue.last_added = Some("c".to_string());
        let payload = queue.payload(None);
        assert_eq!(payload["current"], serde_json::Value::Null);
        assert_eq!(payload["last_added"], "c");
        assert_eq!(payload["countdown_until"], 1234);
    }

    fn suggestion(id: &str, by_user: &str) -> Suggestion {
        Suggestion {
            id: id.to_string(),
            title: format!("Suggestion {id}"),
            series: None,
            by: "Ana".to_string(),
            by_user: by_user.to_string(),
        }
    }

    #[test]
    fn suggestions_ignore_queued_duplicate_and_over_the_cap_items() {
        let mut queue = queue(&["queued"]);
        assert!(!queue.suggest(suggestion("queued", "ana")));
        assert!(queue.suggest(suggestion("first", "ana")));
        assert!(!queue.suggest(suggestion("first", "bob")));
        for index in 1..MAX_SUGGESTIONS {
            assert!(queue.suggest(suggestion(&format!("s{index}"), "ana")));
        }
        assert!(!queue.suggest(suggestion("one-too-many", "ana")));
        assert_eq!(queue.suggestions.len(), MAX_SUGGESTIONS);
    }

    #[test]
    fn dismiss_allows_the_host_or_the_same_user_only() {
        let mut queue = MediaQueue::default();
        assert!(queue.suggest(suggestion("a", "user-ana")));
        assert!(!queue.dismiss("a", "user-bob", false));
        assert!(queue.dismiss("a", "user-ana", false));
        assert!(queue.suggest(suggestion("b", "user-ana")));
        assert!(queue.dismiss("b", "user-bob", true));
        assert!(!queue.dismiss("unknown", "user-bob", true));
    }

    #[test]
    fn add_drops_only_suggestions_that_really_fit() {
        let names: Vec<String> = (0..MAX_QUEUE_ITEMS).map(|i| i.to_string()).collect();
        let mut queue = queue(&names.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(queue.suggest(suggestion("new", "ana")));
        assert!(!queue.add(vec![item("new")], Some("0")));
        assert_eq!(queue.suggestions[0].id, "new");

        assert!(queue.remove("0", None));
        assert!(queue.add(vec![item("new")], None));
        assert!(queue.suggestions.is_empty());
    }

    #[test]
    fn details_are_per_recipient_and_keep_room_and_item_order() {
        let mut queue = queue(&["a"]);
        let mut own = suggestion("b", "user-ana");
        own.series = Some("series".to_string());
        assert!(queue.suggest(own));
        assert!(queue.suggest(suggestion("c", "other-client")));
        queue.report_availability(
            "ana-client",
            HashSet::from(["a".to_string(), "b".to_string(), "gone".to_string()]),
        );
        queue.report_availability(
            "other-client",
            HashSet::from(["a".to_string(), "c".to_string()]),
        );

        let mut clients = HashMap::new();
        for (id, user_id, name) in [
            ("host", "user-host", "Host"),
            ("ana-client", "user-ana", "Ana"),
            ("other-client", "", "Bob"),
        ] {
            let (mut client, _rx) = crate::test_helpers::create_client_with_rx(user_id, name, true);
            client.room_id = Some("room".to_string());
            clients.insert(id.to_string(), client);
        }
        let members = vec!["host".into(), "ana-client".into(), "other-client".into()];
        let details = queue.details("ana-client", &clients, &members);
        assert_eq!(details.suggestions[0].series.as_deref(), Some("series"));
        assert!(details.suggestions[0].mine);
        assert!(!details.suggestions[1].mine);
        let serialized = serde_json::to_value(&details).unwrap();
        assert_eq!(serialized["suggestions"][0]["series"], "series");
        assert!(serialized["suggestions"][1].get("series").is_none());
        assert_eq!(
            details
                .unavailable
                .iter()
                .map(|item| (item.id.as_str(), item.names.clone(), item.you))
                .collect::<Vec<_>>(),
            [
                ("a", vec!["Bob".to_string()], true),
                ("b", vec![], true),
                ("c", vec!["Bob".to_string()], false),
            ]
        );
        assert!(queue.forget_availability("ana-client"));
        assert!(!queue.forget_availability("ana-client"));
        assert!(queue
            .details("host", &clients, &members)
            .unavailable
            .iter()
            .all(|item| item.id != "gone"));
    }

    #[test]
    fn unavailable_names_are_deduplicated_by_account_not_display_name() {
        let mut queue = queue(&["a"]);
        assert!(queue.suggest(suggestion("b", "user-ana")));
        let mut clients = HashMap::new();
        for (id, user_id, name) in [
            ("host", "user-host", "Host"),
            ("ana-first", "user-ana", "Ana"),
            ("another-user", "user-other", "Ana"),
            ("ana-second", "user-ana", "Ana"),
        ] {
            let (client, _rx) = crate::test_helpers::create_client_with_rx(user_id, name, true);
            clients.insert(id.to_string(), client);
        }
        let members = vec![
            "host".to_string(),
            "ana-first".to_string(),
            "another-user".to_string(),
            "ana-second".to_string(),
        ];
        for id in ["ana-first", "another-user", "ana-second"] {
            queue.report_availability(id, HashSet::from(["a".to_string(), "b".to_string()]));
        }

        let details = queue.details("host", &clients, &members);
        assert_eq!(details.unavailable.len(), 2);
        for item in details.unavailable {
            assert_eq!(item.names, ["Ana", "Ana"]);
            assert!(!item.you);
        }
    }

    #[test]
    fn any_missing_tab_of_the_recipient_sets_you_without_naming_the_account() {
        let mut queue = queue(&["a"]);
        let mut clients = HashMap::new();
        for (id, user_id, name) in [
            ("ana-first", "user-ana", "Ana"),
            ("ana-second", "user-ana", "Ana"),
            ("bob", "user-bob", "Bob"),
        ] {
            let (client, _rx) = crate::test_helpers::create_client_with_rx(user_id, name, true);
            clients.insert(id.to_string(), client);
        }
        let members = vec![
            "ana-first".to_string(),
            "ana-second".to_string(),
            "bob".to_string(),
        ];
        queue.report_availability("ana-first", HashSet::new());
        queue.report_availability("ana-second", HashSet::from(["a".to_string()]));
        queue.report_availability("bob", HashSet::from(["a".to_string()]));

        for recipient in ["ana-first", "ana-second"] {
            let details = queue.details(recipient, &clients, &members);
            assert_eq!(details.unavailable.len(), 1);
            assert!(details.unavailable[0].you);
            assert_eq!(details.unavailable[0].names, ["Bob"]);
        }

        assert!(queue.forget_availability("ana-second"));
        let details = queue.details("ana-first", &clients, &members);
        assert!(!details.unavailable[0].you);
        assert_eq!(details.unavailable[0].names, ["Bob"]);
    }

    #[test]
    fn details_use_client_ids_for_insecure_members() {
        let mut queue = MediaQueue::default();
        assert!(queue.suggest(suggestion("a", "ana-client")));
        let mut clients = HashMap::new();
        for (id, name) in [("ana-client", "Ana"), ("bob-client", "Bob")] {
            let (client, _rx) = crate::test_helpers::create_client_with_rx("", name, true);
            clients.insert(id.to_string(), client);
        }
        let members = vec!["ana-client".to_string(), "bob-client".to_string()];

        assert!(queue.details("ana-client", &clients, &members).suggestions[0].mine);
        assert!(!queue.details("bob-client", &clients, &members).suggestions[0].mine);
        for id in ["ana-client", "bob-client"] {
            queue.report_availability(id, HashSet::from(["a".to_string()]));
        }
        let details = queue.details("ana-client", &clients, &members);
        assert!(details.unavailable[0].you);
        assert_eq!(details.unavailable[0].names, ["Bob"]);
    }
}
