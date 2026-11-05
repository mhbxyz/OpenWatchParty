(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const segments = OWP.segments = OWP.segments || {};
  const state = OWP.state;
  const utils = OWP.utils;

  const TICKS_PER_SECOND = 10000000; // Jellyfin times are in ticks of 100 ns
  // The parts of an item Jellyfin offers to skip that the room tells apart
  // (Intro Skipper marks them as media segments).
  const TYPES = ['Intro', 'Recap', 'Outro'];
  // Jellyfin's Skip button seeks to the segment's end, and skips by itself as
  // soon as the video enters it. A skip goes from inside the segment, or this
  // close to its start, to its end: at most this far past it...
  const MARGIN_S = 1.5;
  // ...or this far short of it, where a stream may land.
  const SHORT_OF_END_S = 0.5;

  // The room and item the segments are for: a room left, or another item,
  // starts again.
  const roomItem = () => (state.inRoom && state.roomMediaId ? `${state.roomId}|${state.roomMediaId}` : '');

  // The room item's segments, in seconds, once Jellyfin answers, and the
  // checks waiting for that answer.
  let loaded = { key: '', items: [], answered: true, waiting: [] };

  // After room_state, for every member: each room's item is asked for once.
  segments.refresh = () => {
    const key = roomItem();
    if (loaded.key === key) return;
    const mediaId = state.roomMediaId;
    const current = { key, items: [], answered: !key || !window.ApiClient, waiting: [] };
    loaded = current;
    if (current.answered) return;
    window.ApiClient.getJSON(window.ApiClient.getUrl(`MediaSegments/${mediaId}`))
      .then((result) => {
        current.items = (result?.Items || [])
          .filter(segment => TYPES.includes(segment.Type))
          .map(segment => ({
            type: segment.Type,
            start: segment.StartTicks / TICKS_PER_SECOND,
            end: segment.EndTicks / TICKS_PER_SECOND
          }));
      })
      .catch(err => utils.log('SEGMENTS', { error: err?.name || 'Error' }))
      .finally(() => {
        current.answered = true;
        // The checks for a room or item left meanwhile are dropped.
        if (loaded === current) current.waiting.splice(0).forEach(check => check());
      });
  };

  // Runs a check of a seek once the room item's segments are known: at once,
  // or when Jellyfin answers, so a skip that comes first is not missed.
  segments.whenKnown = (check) => {
    segments.refresh();
    if (!loaded.key) return;
    if (loaded.answered) check();
    else loaded.waiting.push(check);
  };

  // The type of the room item's segment that a seek from `from` to `to`
  // skipped, or '' for any other seek.
  segments.skipped = (from, to) => {
    if (loaded.key !== roomItem()) return '';
    const skipped = loaded.items.find(segment => from >= segment.start - MARGIN_S
      && from < segment.end - MARGIN_S
      && to >= segment.end - SHORT_OF_END_S
      && to <= segment.end + MARGIN_S);
    return skipped ? skipped.type : '';
  };
})();
