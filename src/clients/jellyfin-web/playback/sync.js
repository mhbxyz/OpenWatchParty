(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const {
    DRIFT_DEADZONE_SEC,
    DRIFT_SOFT_MAX_SEC,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    DRIFT_GAIN,
    INITIAL_SYNC_DRIFT_THRESHOLD,
    INITIAL_SYNC_MAX_DRIFT,
    MEDIA_READY_POLL_MS,
    MEDIA_READY_TIMEOUT_MS
  } = OWP.constants;

  const notifyReady = (roomId, mediaId) => {
    if (!state.inRoom || state.roomId !== roomId || state.readyRoomId === roomId) return;
    if (mediaId && utils.getCurrentItemId() !== mediaId) return;
    const actions = OWP.actions;
    if (!actions || !actions.send) return;
    state.readyRoomId = roomId;
    actions.send('ready', { room: roomId, media_id: mediaId || utils.getCurrentItemId() });
  };

  const watchReady = ({ roomId = state.roomId, mediaId = '', onReady = null } = {}) => {
    if (state.mediaReadyCleanup) state.mediaReadyCleanup();
    const attempt = ++state.mediaSyncAttempt;
    let deadline = Date.now() + MEDIA_READY_TIMEOUT_MS;
    const initialMediaId = utils.getCurrentItemId();
    const initialVideo = utils.getVideo();
    const initialSource = initialVideo?.currentSrc || initialVideo?.src || '';
    const requiresVideoTransition = Boolean(mediaId && initialMediaId !== mediaId);
    let timeoutReported = false;
    let watchedVideo = null;
    let timer = null;

    const cleanup = () => {
      if (timer) OWP.timers.clear(timer);
      timer = null;
      if (watchedVideo) {
        watchedVideo.removeEventListener('canplay', check);
        watchedVideo.removeEventListener('loadeddata', check);
      }
      watchedVideo = null;
      if (state.mediaReadyCleanup === cleanup) state.mediaReadyCleanup = null;
    };

    const scheduleCheck = () => {
      if (Date.now() >= deadline) {
        deadline = Date.now() + MEDIA_READY_TIMEOUT_MS;
        if (mediaId && playback.ensurePlayback) playback.ensurePlayback(mediaId, 0, null, true);
        if (!timeoutReported && OWP.ui?.showToast) {
          OWP.ui.showToast('Still waiting for the watch party media');
          timeoutReported = true;
        }
      }
      timer = OWP.timers.setTimeout(check, MEDIA_READY_POLL_MS, 'media');
    };

    function check() {
      if (timer) OWP.timers.clear(timer);
      timer = null;
      if (attempt !== state.mediaSyncAttempt || !state.inRoom || state.roomId !== roomId) {
        cleanup();
        return;
      }
      if (mediaId && utils.getCurrentItemId() !== mediaId) {
        scheduleCheck();
        return;
      }
      const video = utils.getVideo();
      if (!video) {
        scheduleCheck();
        return;
      }
      if (requiresVideoTransition && video === initialVideo) {
        const currentSource = video.currentSrc || video.src || '';
        if (currentSource === initialSource) {
          scheduleCheck();
          return;
        }
      }
      if (watchedVideo !== video) {
        if (watchedVideo) {
          watchedVideo.removeEventListener('canplay', check);
          watchedVideo.removeEventListener('loadeddata', check);
        }
        watchedVideo = video;
        watchedVideo.addEventListener('canplay', check);
        watchedVideo.addEventListener('loadeddata', check);
      }
      if (video.readyState < 2) {
        scheduleCheck();
        return;
      }
      state.pendingMediaId = '';
      if (typeof onReady === 'function') onReady(video);
      notifyReady(roomId, mediaId);
      cleanup();
    }

    state.mediaReadyCleanup = cleanup;
    check();
  };

  const checkInitialSync = (abs, drift, expected, video, serverNow) => {
    if (!state.isInitialSync) return false;
    const now = utils.nowMs();
    const inCooldown = state.syncCooldownUntil && now < state.syncCooldownUntil;
    if (abs > INITIAL_SYNC_MAX_DRIFT) {
      utils.log('SYNC', { type: 'initial_sync_critical_drift', drift, videoPos: video.currentTime, expected });
      video.currentTime = expected;
      state.lastSyncServerTs = serverNow;
      state.lastSyncPosition = expected;
      state.initialSyncTargetPos = null;
      return true;
    }
    if (state.initialSyncTargetPos !== null
        && abs > INITIAL_SYNC_DRIFT_THRESHOLD
        && !inCooldown) {
      utils.log('SYNC', { type: 'post_buffer_seek', drift, videoPos: video.currentTime, expected });
      video.currentTime = expected;
      state.lastSyncServerTs = serverNow;
      state.lastSyncPosition = expected;
      state.initialSyncTargetPos = null;
      return true;
    }
    if (abs < INITIAL_SYNC_DRIFT_THRESHOLD) {
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = null;
      utils.log('SYNC', { type: 'initial_sync_complete', drift, reason: 'drift_threshold' });
    } else if (state.initialSyncUntil && now >= state.initialSyncUntil) {
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = null;
      utils.log('SYNC', { type: 'initial_sync_timeout', drift });
    }
    return false;
  };

  const applySyncCorrection = (drift, abs, video, expected, serverNow) => {
    if (abs < DRIFT_DEADZONE_SEC) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (state.syncStatus !== 'synced') {
        state.syncStatus = 'synced';
        state.currentDrift = 0;
        if (OWP.ui && OWP.ui.updateSyncIndicator) OWP.ui.updateSyncIndicator();
      }
      return;
    }
    if (state.syncStatus !== 'syncing') {
      state.syncStatus = 'syncing';
      if (OWP.ui && OWP.ui.updateSyncIndicator) OWP.ui.updateSyncIndicator();
    }
    state.currentDrift = drift;
    if (abs >= DRIFT_SOFT_MAX_SEC) {
      const now = utils.nowMs();
      const inCooldown = state.syncCooldownUntil && now < state.syncCooldownUntil;
      if (state.isInitialSync || inCooldown) {
        if (abs > 5) {
          utils.log('SYNC', { type: 'skip_hard_seek', drift, reason: state.isInitialSync ? 'initial_sync' : 'cooldown' });
        }
      } else {
        utils.log('SYNC', { type: 'HARD_SEEK', expected, actual: video.currentTime, drift });
        utils.suppress();
        video.currentTime = expected;
        state.lastSyncServerTs = serverNow;
        state.lastSyncPosition = expected;
        if (video.playbackRate !== 1) video.playbackRate = 1;
        return;
      }
    }
    const sign = drift > 0 ? 1 : -1;
    const correction = sign * Math.sqrt(abs) * DRIFT_GAIN;
    const rate = Math.min(Math.max(1 + correction, PLAYBACK_RATE_MIN), PLAYBACK_RATE_MAX);
    if (abs > 0.5) {
      utils.log('SYNC', { expected, actual: video.currentTime, drift, rate });
    }
    video.playbackRate = rate;
  };

  const syncLoop = () => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!video) return;
    if (!state.inRoom || state.isHost) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (state.pendingMediaId) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (!state.lastSyncServerTs || state.lastSyncPlayState !== 'playing') {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (state.isBuffering || !utils.isVideoReady()) return;
    if (video.paused) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    const serverNow = utils.getServerNow();
    const elapsed = Math.max(0, serverNow - state.lastSyncServerTs) / 1000;
    const expected = state.lastSyncPosition + elapsed;
    const drift = expected - video.currentTime;
    const abs = Math.abs(drift);
    if (checkInitialSync(abs, drift, expected, video, serverNow)) return;
    applySyncCorrection(drift, abs, video, expected, serverNow);
  };

  Object.assign(playback, { watchReady, syncLoop });
})();
