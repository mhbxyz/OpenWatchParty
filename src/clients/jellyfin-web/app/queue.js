(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const queue = OWP.queue = OWP.queue || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const t = OWP.i18n.t;

  const UPCOMING = 5;                // Episodes the host keeps queued after the room's item
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
    advance: id => send('queue_advance', { id }),
    remove: id => send('queue_remove', { id }),
    move: (id, to) => send('queue_move', { id, to }),
    cancelCountdown: () => {
      cancelledFor = cancelKey();
      requestCountdown(false);
    }
  });
})();
