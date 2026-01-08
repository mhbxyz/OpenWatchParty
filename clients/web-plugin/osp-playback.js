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
      } catch (err) { }
      try {
        pm.play({ item: item, startPositionTicks: 0 });
        return true;
      } catch (err) { }
      const itemId = item?.Id || item?.id;
      if (itemId) {
        try {
          pm.play({ ids: [itemId], startPositionTicks: 0 });
          return true;
        } catch (err) { }
      }
    }
    if (typeof pm.playItems === 'function') {
      try {
        pm.playItems([item], 0);
        return true;
      } catch (err) { }
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
    if (!video) return;

    // If we're already bound to a different video, clean up first
    if (state.bound && state.currentVideoElement !== video) {
      cleanupVideoListeners();
      state.bound = false;
    }

    if (state.bound) return;
    state.bound = true;
    state.currentVideoElement = video;

    const sendStateUpdate = () => {
      const actions = OSP.actions;
      if (!state.isHost || !actions || !actions.send) return;
      // Don't send while syncing to server command (prevents feedback loop)
      if (state.isSyncing) return;
      // Don't send while seeking (HLS lies about state during seek)
      if (utils.isSeeking()) return;
      // Don't send while buffering or if video not ready
      if (state.isBuffering || !utils.isVideoReady()) return;
      const now = utils.nowMs();
      if (now - state.lastStateSentAt < STATE_UPDATE_MS) return;
      state.lastStateSentAt = now;
      actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
    };

    const onEvent = (action) => {
      const actions = OSP.actions;
      if (!state.isHost || !actions || !actions.send || !utils.shouldSend()) return;
      // Don't send while syncing to server command (prevents feedback loop)
      if (state.isSyncing) return;
      // Don't send events if video not ready (HLS still loading)
      if (!utils.isVideoReady()) return;

      if (action === 'pause') {
        // Ignore pause events caused by buffering or seeking (not user-initiated)
        if (state.isBuffering) return;
        if (utils.isSeeking()) return;
        state.wantsToPlay = false;
      }
      if (action === 'play') {
        // Ignore play events during seeking (HLS internal state)
        if (utils.isSeeking()) return;
        state.wantsToPlay = true;
      }
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

    // Create named listeners for cleanup
    const listeners = {
      waiting: () => { state.isBuffering = true; },
      canplay: () => { state.isBuffering = false; },
      playing: () => { state.isBuffering = false; },
      play: () => onEvent('play'),
      pause: () => onEvent('pause'),
      seeked: () => onEvent('seek')
    };
    state.videoListeners = listeners;

    video.addEventListener('waiting', listeners.waiting);
    video.addEventListener('canplay', listeners.canplay);
    video.addEventListener('playing', listeners.playing);
    video.addEventListener('play', listeners.play);
    video.addEventListener('pause', listeners.pause);
    video.addEventListener('seeked', listeners.seeked);

    // State update interval (tracked for cleanup)
    if (state.intervals.stateUpdate) {
      clearInterval(state.intervals.stateUpdate);
    }
    state.intervals.stateUpdate = setInterval(() => {
      if (state.isHost) sendStateUpdate();
    }, STATE_UPDATE_MS);
  };

  const cleanupVideoListeners = () => {
    if (state.currentVideoElement && state.videoListeners) {
      const video = state.currentVideoElement;
      const listeners = state.videoListeners;
      video.removeEventListener('waiting', listeners.waiting);
      video.removeEventListener('canplay', listeners.canplay);
      video.removeEventListener('playing', listeners.playing);
      video.removeEventListener('play', listeners.play);
      video.removeEventListener('pause', listeners.pause);
      video.removeEventListener('seeked', listeners.seeked);
    }
    if (state.intervals.stateUpdate) {
      clearInterval(state.intervals.stateUpdate);
      state.intervals.stateUpdate = null;
    }
    state.videoListeners = null;
    state.currentVideoElement = null;
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
    // Don't adjust during buffering - let the video load
    if (state.isBuffering || !utils.isVideoReady()) {
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
    // Progressive catch-up: sqrt curve gives stronger correction for larger drifts
    // while staying smooth. Example: 2s drift → 1.21x, 4s drift → 1.30x (clamped to 1.20x)
    const sign = drift > 0 ? 1 : -1;
    const correction = sign * Math.sqrt(abs) * DRIFT_GAIN;
    const rate = Math.min(Math.max(1 + correction, PLAYBACK_RATE_MIN), PLAYBACK_RATE_MAX);
    video.playbackRate = rate;
  };

  OSP.playback = {
    playItem,
    ensurePlayback,
    bindVideo,
    syncLoop,
    watchReady,
    cleanupVideoListeners
  };
})();
