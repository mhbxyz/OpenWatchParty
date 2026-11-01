(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const queue = OWP.queue = OWP.queue || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const t = OWP.i18n.t;

  const UPCOMING = 5;                // Episodes the host keeps queued after the room's item
  const SEARCH_RESULTS = 8;          // Library search results shown in the queue section
  const TICKS_PER_SECOND = 10000000; // Jellyfin times are in ticks of 100 ns

  // The server keeps the queue and runs the countdown; the host's client fills
  // the queue and says when the credits start. Nothing here runs for a guest,
  // outside a room or with a server without media_queue.
  const isQueueHost = () => state.inRoom && state.isHost && state.serverFeatures.includes('media_queue');
  const send = (type, payload) => {
    if (OWP.actions?.send) OWP.actions.send(type, payload);
  };

  // The room's item is the room_state media: queue_state can still describe
  // the previous one for a moment after an advance.
  const roomIndex = () => state.queueItems.findIndex(item => item.id === state.roomMediaId);
  const nextItem = () => {
    const index = roomIndex();
    return index < 0 ? null : state.queueItems[index + 1] || null;
  };
  const previousItem = () => {
    const index = roomIndex();
    return index > 0 ? state.queueItems[index - 1] : null;
  };

  const episodeTitle = episode => (Number.isInteger(episode.ParentIndexNumber) && Number.isInteger(episode.IndexNumber)
    ? t('queueEpisodeTitle', { season: episode.ParentIndexNumber, episode: episode.IndexNumber, name: episode.Name || '' })
    : episode.Name || episode.Id);
  // An episode's season and number alone, as a series result says which one it adds.
  const episodeCode = episode => (Number.isInteger(episode.ParentIndexNumber) && Number.isInteger(episode.IndexNumber)
    ? t('queueEpisodeCode', { season: episode.ParentIndexNumber, episode: episode.IndexNumber })
    : episode.Name || episode.Id);
  const cutTitle = value => Array.from(String(value || '')).slice(0, 100).join('');
  const itemTitle = item => cutTitle(item.Type === 'Episode'
    ? t('queueSeriesEpisodeTitle', { series: item.SeriesName || '', episode: episodeTitle(item) })
    : item.Name || item.Id);
  const withSeries = item => state.serverFeatures.includes('start_when_ready')
    && item.Type === 'Episode' && /^[0-9a-f]{32}$/i.test(item.SeriesId || '');
  const queueItem = item => ({
    id: item.Id,
    title: itemTitle(item),
    ...(withSeries(item) ? { series: item.SeriesId } : {})
  });

  let searchTimer = null;
  let searchRequest = 0;
  let roomGeneration = 0;

  const resolveSeries = async (series, userId) => {
    let result = await window.ApiClient.getJSON(window.ApiClient.getUrl('Shows/NextUp', {
      seriesId: series.Id, userId, limit: 1, disableFirstEpisode: false
    }));
    let episode = (result?.Items || []).find(item => item.LocationType !== 'Virtual');
    if (!episode) {
      result = await window.ApiClient.getJSON(window.ApiClient.getUrl(`Shows/${series.Id}/Episodes`, {
        userId, limit: 1
      }));
      episode = (result?.Items || []).find(item => item.LocationType !== 'Virtual');
    }
    return episode || null;
  };

  const searchResult = async (item, userId) => {
    let source = item;
    let kind;
    let detail = '';
    if (item.Type === 'Series') {
      source = await resolveSeries(item, userId);
      if (!source) return null;
      kind = t('queueKindSeries');
      detail = t('queueContinuesWith', { episode: episodeCode(source) });
    } else if (item.Type === 'Episode') {
      kind = t('queueKindEpisode');
      detail = item.SeriesName || '';
    } else if (item.Type === 'Movie') {
      kind = t('queueKindMovie');
      detail = Number.isInteger(item.ProductionYear) ? String(item.ProductionYear) : '';
    } else {
      kind = t('queueKindVideo');
      detail = Number.isInteger(item.ProductionYear) ? String(item.ProductionYear) : '';
    }
    const entry = queueItem(source);
    // A series is shown by its name; the queue gets the episode's title.
    return { item: entry, label: item.Type === 'Series' && item.Name ? item.Name : entry.title, kind, detail };
  };

  // null means that the debounced request is in flight; [] with searched
  // false clears results for a query shorter than two characters.
  const search = (term, receive) => {
    const request = ++searchRequest;
    if (searchTimer) OWP.timers.clear(searchTimer);
    searchTimer = null;
    const query = String(term || '').trim();
    if (query.length < 2) {
      receive([], false);
      return;
    }
    receive(null, true);
    searchTimer = OWP.timers.setTimeout(async () => {
      searchTimer = null;
      try {
        const userId = window.ApiClient.getCurrentUserId();
        // Episodes are asked for apart and listed last: a show's name matches
        // all its episodes too, which would push the show itself out.
        const find = types => window.ApiClient.getJSON(window.ApiClient.getUrl(`Users/${userId}/Items`, {
          searchTerm: query,
          IncludeItemTypes: types,
          Recursive: true,
          Limit: SEARCH_RESULTS,
          Fields: 'ProductionYear'
        }));
        const [titles, episodes] = await Promise.all([find('Movie,Series,Video,MusicVideo'), find('Episode')]);
        const items = [...(titles?.Items || []), ...(episodes?.Items || [])].slice(0, SEARCH_RESULTS);
        // A series whose next episode can't be looked up is left out, not
        // the whole search.
        const resolved = await Promise.all(items.map(item => searchResult(item, userId).catch((err) => {
          report('search-series', err);
          return null;
        })));
        if (request === searchRequest) receive(resolved.filter(Boolean), true);
      } catch (err) {
        if (request === searchRequest) receive([], true);
        report('search', err);
      }
    }, 300, 'room');
  };

  const add = async (item) => {
    if (!isQueueHost()) return;
    const roomId = state.roomId;
    const clientId = state.clientId;
    const mediaId = state.roomMediaId;
    const userId = window.ApiClient.getCurrentUserId();
    const generation = roomGeneration;
    const isCurrentContext = () => generation === roomGeneration && isQueueHost()
      && state.roomId === roomId && state.clientId === clientId
      && state.roomMediaId === mediaId && window.ApiClient.getCurrentUserId() === userId;
    let selected;
    try {
      selected = queueItem(await window.ApiClient.getItem(userId, item.id));
    } catch (err) {
      report('add-selected', err);
      return;
    }
    if (!isCurrentContext()) return;
    const items = [];
    if (state.roomMediaId && state.roomMediaId !== selected.id
        && !state.queueItems.some(entry => entry.id === state.roomMediaId)) {
      try {
        const current = await window.ApiClient.getItem(userId, mediaId);
        items.push(queueItem(current));
      } catch (err) {
        report('add-current', err);
      }
    }
    items.push(selected);
    // A library response must not add an earlier room's items to a new queue.
    if (!isCurrentContext()) return;
    send('queue_add', { items });
  };

  const suggest = item => send('queue_suggest', item);
  const dismiss = id => send('queue_dismiss', { id });

  let availabilityRoom = '';
  let availabilityClient = '';
  let availabilityUser = '';
  let availability = new Map();
  let availabilityPending = new Set();
  let availabilitySent = null;

  const availabilityIds = () => [...new Set([
    ...state.queueItems.map(item => item.id),
    ...state.queueSuggestions.map(item => item.id)
  ])];
  const sendAvailability = () => {
    if (!state.inRoom || !state.serverFeatures.includes('queue_suggestions')) return;
    const active = new Set(availabilityIds());
    const missing = [...availability]
      .filter(([id, available]) => active.has(id) && available === false)
      .map(([id]) => id)
      .sort();
    const key = JSON.stringify(missing);
    if (availabilitySent === null && missing.length === 0) return;
    if (availabilitySent === key) return;
    availabilitySent = key;
    send('queue_availability', { missing });
  };
  const checkAvailability = () => {
    if (!state.inRoom || !state.serverFeatures.includes('queue_suggestions') || !window.ApiClient) return;
    const userId = window.ApiClient.getCurrentUserId();
    if (availabilityRoom !== state.roomId || availabilityClient !== state.clientId || availabilityUser !== userId) {
      availabilityRoom = state.roomId;
      availabilityClient = state.clientId;
      availabilityUser = userId;
      availability = new Map();
      availabilityPending = new Set();
      availabilitySent = null;
    }
    const roomId = state.roomId;
    const clientId = state.clientId;
    const cache = availability;
    const isCurrent = () => cache === availability && state.inRoom && state.roomId === roomId
      && state.clientId === clientId && window.ApiClient.getCurrentUserId() === userId;
    availabilityIds().forEach((id) => {
      if (availability.has(id) || availabilityPending.has(id)) return;
      availabilityPending.add(id);
      window.ApiClient.getItem(userId, id).then(() => {
        if (!isCurrent()) return;
        availabilityPending.delete(id);
        availability.set(id, true);
        sendAvailability();
      }).catch((err) => {
        if (!isCurrent()) return;
        availabilityPending.delete(id);
        if (err?.status === 404 || err?.statusCode === 404) availability.set(id, false);
        sendAvailability();
      });
    });
    sendAvailability();
  };

  // The host hears about suggestions that arrive while it is host. Those the
  // first queue_details in a room brings, and those seen as a guest, are only
  // recorded, so becoming host or joining doesn't replay them.
  let noticeRoom = '';
  let noticedSuggestions = new Set();
  const onQueueDetails = () => {
    if (noticeRoom === state.roomId && state.isHost) {
      state.queueSuggestions.forEach((suggestion) => {
        if (!noticedSuggestions.has(suggestion.id) && !suggestion.mine) {
          OWP.ui.showToast?.(t('queueSuggested', { name: suggestion.by, title: suggestion.title }));
        }
      });
    }
    noticeRoom = state.roomId;
    noticedSuggestions = new Set(state.queueSuggestions.map(item => item.id));
    checkAvailability();
  };

  const resetRoom = () => {
    roomGeneration++;
    if (searchTimer) OWP.timers.clear(searchTimer);
    searchTimer = null;
    searchRequest++;
    availabilityRoom = '';
    availabilityClient = '';
    availabilityUser = '';
    availability = new Map();
    availabilityPending = new Set();
    availabilitySent = null;
    noticeRoom = '';
    noticedSuggestions = new Set();
  };

  // The host fills an empty queue, then tops it up only when the room moves on
  // from an item this client saw as host. It waits for the room's queue_state,
  // which comes after room_state on joining. Filling goes on from the episode
  // the room's queue_add appended last, which the server keeps, so one the
  // host removed doesn't come back after a reload or a host change either.
  // Each room item is looked at once. A failed library request is retried up
  // to three times, five seconds apart, without waiting for a room message.
  let seenItem = '';
  // The fill waiting for the library, dropped when the room moves to another
  // item or this client loses the role or the room's queue (another room, a
  // lost connection).
  let filling = null;
  const FILL_RETRY_MS = 5000;
  const MAX_FILL_RETRIES = 3;
  let retry = null;

  const fill = async () => {
    if (!state.queueReceived) return;
    const roomId = state.roomId;
    const item = `${roomId}|${state.roomMediaId}`;
    const key = `${item}|${state.queueLastAdded || ''}`;
    if (retry && retry.key !== key) retry = null;
    if (retry && Date.now() < retry.at) return;
    if (filling?.item !== item) filling = null;
    if (seenItem === item || filling) return;
    const index = roomIndex();
    const upcoming = state.queueItems.length ? state.queueItems.length - 1 - index : 0;
    // A queue this client didn't see as host is inherited, and a room item
    // that isn't queued leaves the host's list as it is.
    if (state.queueItems.length && (!seenItem.startsWith(`${roomId}|`) || index < 0 || upcoming >= UPCOMING)) {
      seenItem = item;
      return;
    }
    const lastAdded = state.queueLastAdded;
    const startId = lastAdded || state.roomMediaId;
    const attempt = { item };
    filling = attempt;
    const userId = window.ApiClient.getCurrentUserId();
    let start;
    let result;
    try {
      start = await window.ApiClient.getItem(userId, startId);
      if (start?.Type === 'Episode' && start.SeriesId) {
        result = await window.ApiClient.getJSON(window.ApiClient.getUrl(`Shows/${start.SeriesId}/Episodes`, {
          userId, startItemId: startId, limit: UPCOMING + 10
        }));
      }
    } catch (err) {
      if (filling === attempt) {
        filling = null;
        if (isQueueHost() && state.queueReceived && `${state.roomId}|${state.roomMediaId}` === item
            && state.queueLastAdded === lastAdded) {
          const failures = (retry?.failures || 0) + 1;
          retry = { key, failures, at: failures > MAX_FILL_RETRIES ? Infinity : Date.now() + FILL_RETRY_MS };
        }
      }
      throw err;
    }
    const current = filling === attempt;
    if (current) filling = null;
    // The answer is for the queue this started from, not one with another item
    // added meanwhile.
    if (!current || !isQueueHost() || state.queueLastAdded !== lastAdded) return;
    retry = null;
    seenItem = item;
    if (!result) return;
    const episodes = (result.Items || [])
      .filter(episode => episode.Id !== startId && episode.LocationType !== 'Virtual')
      .slice(0, UPCOMING - upcoming);
    const items = (state.queueItems.length ? [] : [start]).concat(episodes);
    if (!items.length) return;
    // The series lets the server go on to the next episode without a countdown.
    const withSeries = state.serverFeatures.includes('start_when_ready');
    send('queue_add', {
      items: items.map(episode => ({
        id: episode.Id,
        title: episodeTitle(episode),
        ...(withSeries && /^[0-9a-f]{32}$/i.test(episode.SeriesId || '') ? { series: episode.SeriesId } : {})
      }))
    });
  };

  // Where the room's item's credits start (Jellyfin's Outro media segment, as
  // Intro Skipper marks it), in seconds, or null to wait for the end.
  let credits = { mediaId: '', start: null };

  const loadCredits = async (mediaId) => {
    credits = { mediaId, start: null };
    const result = await window.ApiClient.getJSON(window.ApiClient.getUrl(`MediaSegments/${mediaId}`, {
      includeSegmentTypes: 'Outro'
    }));
    const outro = (result?.Items || []).find(segment => segment.Type === 'Outro');
    if (outro && credits.mediaId === mediaId) credits.start = outro.StartTicks / TICKS_PER_SECOND;
  };

  const report = (what, err) => utils.log('QUEUE', { what, error: err?.name || 'Error' });

  // The room and item whose countdown the host cancelled: it doesn't start
  // again on that item in that room.
  let cancelledFor = '';
  const cancelKey = () => `${state.roomId}|${state.roomMediaId}`;
  // The last countdown request, until a queue_state answers it.
  let countdownRequest = '';

  // After room_state, queue_state and host changes. A guest forgets the items
  // it saw as host: the queue it finds on becoming the host again is
  // inherited.
  queue.refresh = () => {
    if (!isQueueHost() || !state.queueReceived) retry = null;
    if (!state.isHost) seenItem = '';
    if (!state.isHost || !state.queueReceived) filling = null;
    if (!isQueueHost() || !state.roomMediaId || !window.ApiClient) return;
    if (credits.mediaId !== state.roomMediaId) loadCredits(state.roomMediaId).catch(err => report('credits', err));
    fill().catch(err => report('fill', err));
  };

  // Reuse the lifecycle tick: no new timer survives a leave or a cleanup.
  queue.retryFill = () => {
    if (retry && Date.now() >= retry.at) queue.refresh();
  };

  // A queue_state answers the last countdown request. The host's video is
  // looked at again: it may have paused or gone back meanwhile, with no other
  // event to tell while it stays paused.
  queue.onQueueState = () => {
    countdownRequest = '';
    queue.refresh();
    checkAvailability();
    const video = utils.getVideo?.();
    if (video) queue.onVideoTime(video);
  };

  const requestCountdown = (start) => {
    const key = `${state.roomMediaId}|${start}`;
    if (countdownRequest === key) return;
    countdownRequest = key;
    send('queue_countdown', { start });
  };

  // Jellyfin closes the player when a video ends, which takes everyone out of
  // the room, so the countdown starts this long before the end at the latest
  // and the room moves on while the video still plays.
  const END_MARGIN_S = OWP.constants.QUEUE_COUNTDOWN_MS / 1000 + 5;

  const countdownStart = (video) => {
    const outro = credits.mediaId === state.roomMediaId ? credits.start : null;
    const latest = Number.isFinite(video.duration) ? video.duration - END_MARGIN_S : null;
    if (outro === null || latest === null) return outro ?? latest;
    return Math.min(outro, latest);
  };

  // A room play or pause on its way to the host's player, such as a guest's
  // pause: the server already ended the countdown, and the video plays on
  // until the pause applies.
  const roomCommandPending = () => Boolean(state.pendingPlayUntil) && utils.getServerNow() < state.pendingPlayUntil;

  // From the host's video events: the countdown starts at the credits, and
  // stops when the room pauses, at the end too, or the host goes back before
  // them. The server also ends it when it accepts a pause.
  queue.onVideoTime = (video) => {
    if (!isQueueHost() || !state.roomMediaId || utils.getPlayingItemId?.() !== state.roomMediaId) return;
    const start = countdownStart(video);
    const inCredits = start !== null && video.currentTime >= start;
    if (state.queueCountdownUntil) {
      if (!inCredits || video.paused) requestCountdown(false);
    } else if (inCredits && !video.paused && !roomCommandPending() && nextItem() && cancelledFor !== cancelKey()) {
      requestCountdown(true);
    }
  };

  Object.assign(queue, {
    nextItem,
    previousItem,
    search,
    add,
    suggest,
    dismiss,
    accept: add,
    withdraw: dismiss,
    onQueueDetails,
    resetRoom,
    advance: id => send('queue_advance', { id }),
    remove: id => send('queue_remove', { id }),
    move: (id, to) => send('queue_move', { id, to }),
    cancelCountdown: () => {
      cancelledFor = cancelKey();
      requestCountdown(false);
    }
  });
})();
