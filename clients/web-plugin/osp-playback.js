(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.playback) return;

  const state = OSP.state;
  const utils = OSP.utils;
  const {
    STATE_UPDATE_MS,
    SEEK_THRESHOLD,
    DRIFT_DEADZONE_SEC,
    DRIFT_SOFT_MAX_SEC,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    DRIFT_GAIN
  } = OSP.constants;

  const playItem = (item) => {
    const pm = utils.getPlaybackManager();
    if (!pm) return false;
    if (typeof pm.play === 'function') {
      try {
        pm.play({ items: [item], startPositionTicks: 0 });
        return true;
      } catch (err) {}
      try {
        pm.play({ item: item, startPositionTicks: 0 });
        return true;
      } catch (err) {}
      const itemId = item?.Id || item?.id;
      if (itemId) {
        try {
          pm.play({ ids: [itemId], startPositionTicks: 0 });
          return true;
        } catch (err) {}
      }
    }
    if (typeof pm.playItems === 'function') {
      try {
        pm.playItems([item], 0);
        return true;
      } catch (err) {}
    }
    return false;
  };

  const ensurePlayback = (itemId, attempt = 0) => {
    if (!itemId || !window.ApiClient) return;
    if (utils.getCurrentItemId() === itemId) return;
    if (state.joiningItemId === itemId) return;
    const userId = ApiClient.getCurrentUserId?.() || ApiClient._currentUserId;
    if (!userId) {
      if (attempt < 5) setTimeout(() => ensurePlayback(itemId, attempt + 1), 500);
      return;
    }
    state.joiningItemId = itemId;
    ApiClient.getItem(userId, itemId).then((item) => {
      if (!playItem(item) && attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1), 500);
      }
    }).catch(() => {
      if (attempt < 5) setTimeout(() => ensurePlayback(itemId, attempt + 1), 500);
    }).finally(() => {
      state.joiningItemId = '';
    });
  };

  const notifyReady = () => {
    if (!state.inRoom || !state.roomId || state.readyRoomId === state.roomId) return;
    const actions = OSP.actions;
    if (!actions || !actions.send) return;
    state.readyRoomId = state.roomId;
    actions.send('ready', { room: state.roomId, media_id: utils.getCurrentItemId() });
  };

  const watchReady = () => {
    const video = utils.getVideo();
    if (!video) return;
    if (video.readyState >= 2) {
      notifyReady();
      return;
    }
    const onReady = () => {
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadeddata', onReady);
      notifyReady();
    };
    video.addEventListener('canplay', onReady);
    video.addEventListener('loadeddata', onReady);
  };

  const bindVideo = () => {
    const video = utils.getVideo();
    if (!video || state.bound) return;
    state.bound = true;
    const sendStateUpdate = () => {
      const actions = OSP.actions;
      if (!state.isHost || !actions || !actions.send) return;
      const now = utils.nowMs();
      if (now - state.lastStateSentAt < STATE_UPDATE_MS) return;
      state.lastStateSentAt = now;
      actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
    };
    const onEvent = (action) => {
      const actions = OSP.actions;
      if (!state.isHost || !actions || !actions.send || !utils.shouldSend()) return;
      if (action === 'seek') {
        const now = utils.nowMs();
        if (now - state.lastSeekSentAt < 500) return;
        if (Math.abs(video.currentTime - state.lastSentPosition) < SEEK_THRESHOLD) return;
        state.lastSeekSentAt = now;
        state.lastSentPosition = video.currentTime;
      }
      actions.send('player_event', { action, position: video.currentTime });
      if (action === 'play' || action === 'pause') {
        sendStateUpdate();
      }
    };
    video.addEventListener('play', () => onEvent('play'));
    video.addEventListener('pause', () => onEvent('pause'));
    video.addEventListener('seeked', () => onEvent('seek'));
    setInterval(() => {
      sendStateUpdate();
    }, STATE_UPDATE_MS);
  };

  const syncLoop = () => {
    const video = utils.getVideo();
    if (!video) return;
    if (!state.inRoom || state.isHost) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (!state.lastSyncServerTs || state.lastSyncPlayState !== 'playing') {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (video.paused) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    const serverNow = utils.getServerNow();
    const elapsed = Math.max(0, serverNow - state.lastSyncServerTs) / 1000;
    const expected = state.lastSyncPosition + elapsed;
    const drift = expected - video.currentTime;
    const abs = Math.abs(drift);
    if (abs < DRIFT_DEADZONE_SEC) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (abs >= DRIFT_SOFT_MAX_SEC) {
      utils.suppress();
      video.currentTime = expected;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    const rate = Math.min(Math.max(1 + drift * DRIFT_GAIN, PLAYBACK_RATE_MIN), PLAYBACK_RATE_MAX);
    video.playbackRate = rate;
  };

  OSP.playback = {
    playItem,
    ensurePlayback,
    bindVideo,
    syncLoop,
    watchReady
  };
})();
