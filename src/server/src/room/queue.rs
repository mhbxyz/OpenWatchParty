//! The room's media queue (#69): list operations only, no I/O.
//!
//! The current item is the room's `media_id`, so it isn't stored twice. Ids
//! and titles are validated by the handler before they reach the queue.

use serde::Serialize;

/// Items kept per room, watched ones included.
pub(crate) const MAX_QUEUE_ITEMS: usize = 20;

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
}
