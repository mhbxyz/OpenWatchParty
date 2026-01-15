(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.playback) return;

  const state = OWP.state;
  const utils = OWP.utils;
  const {
    STATE_UPDATE_MS,
    SEEK_THRESHOLD,
    DRIFT_DEADZONE_SEC,
    DRIFT_SOFT_MAX_SEC,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    DRIFT_GAIN,
    INITIAL_SYNC_DRIFT_THRESHOLD,
    INITIAL_SYNC_MAX_DRIFT
  } = OWP.constants;

  /**
   * Get effective quality settings (room quality if in room, otherwise local settings)
   */
  const getEffectiveQuality = () => {
    if (state.inRoom && state.roomQuality) {
      return state.roomQuality;
    }
    return {
      maxBitrate: state.quality.maxBitrate,
      preferDirectPlay: state.quality.preferDirectPlay,
      preset: state.quality.currentPreset
    };
  };

  /**
   * Build playback options with quality settings applied
   */
  const buildPlaybackOptions = (baseOptions = {}) => {
    const quality = getEffectiveQuality();
    const options = { ...baseOptions };

    // Apply max bitrate if set (0 = auto/no limit)
    if (quality.maxBitrate > 0) {
      options.maxStreamingBitrate = quality.maxBitrate;
      options.maxBitrate = quality.maxBitrate;
    }

    // Apply direct play preference
    if (quality.preferDirectPlay) {
      options.enableDirectPlay = true;
      options.enableDirectStream = true;
      // Lower transcoding priority
      options.enableTranscoding = true;
      options.allowVideoStreamCopy = true;
      options.allowAudioStreamCopy = true;
    }

    return options;
  };

  /**
   * Set quality preset by key (auto, 1080p, 720p, 480p, 360p)
   */
  const setQualityPreset = (presetKey) => {
    const presets = OWP.constants.QUALITY_PRESETS;
    const preset = presets[presetKey];
    if (!preset) {
      console.warn('[OpenWatchParty] Unknown quality preset:', presetKey);
      return false;
    }

    state.quality.currentPreset = presetKey;
    state.quality.maxBitrate = preset.bitrate;
    console.log('[OpenWatchParty] Quality preset set:', presetKey, preset);

    // If host, broadcast quality change to room
    if (state.isHost && state.inRoom && OWP.actions && OWP.actions.send) {
      OWP.actions.send('quality_update', {
        maxBitrate: preset.bitrate,
        preferDirectPlay: state.quality.preferDirectPlay,
        preset: presetKey
      });
    }

    return true;
  };

  /**
   * Toggle direct play preference
   */
  const toggleDirectPlay = (enable) => {
    state.quality.preferDirectPlay = enable;
    console.log('[OpenWatchParty] Direct play:', enable ? 'enabled' : 'disabled');

    // If host, broadcast quality change to room
    if (state.isHost && state.inRoom && OWP.actions && OWP.actions.send) {
      OWP.actions.send('quality_update', {
        maxBitrate: state.quality.maxBitrate,
        preferDirectPlay: enable,
        preset: state.quality.currentPreset
      });
    }
  };

  const playItem = (item) => {
    const pm = utils.getPlaybackManager();
    if (!pm) return false;

    // Build options with quality settings
    const qualityOptions = buildPlaybackOptions({ startPositionTicks: 0 });

    if (typeof pm.play === 'function') {
      try {
        pm.play({ items: [item], ...qualityOptions });
        return true;
      } catch (err) { }
      try {
        pm.play({ item: item, ...qualityOptions });
        return true;
      } catch (err) { }
      const itemId = item?.Id || item?.id;
      if (itemId) {
        try {
          pm.play({ ids: [itemId], ...qualityOptions });
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
    const actions = OWP.actions;
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
      const actions = OWP.actions;
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
      const actions = OWP.actions;
      if (!state.isHost || !actions || !actions.send || !utils.shouldSend()) return;
      // Don't send while syncing to server command (prevents feedback loop)
      if (state.isSyncing) return;
      // Don't block play/pause on video ready - these are critical user actions
      // Only block seek events when video not ready (HLS still loading)
      if (action === 'seek' && !utils.isVideoReady()) return;

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
        if (now - state.lastSeekSentAt < 250) return;  // Reduced from 500ms (UX-P2)
        if (Math.abs(video.currentTime - state.lastSentPosition) < SEEK_THRESHOLD) return;
        state.lastSeekSentAt = now;
        state.lastSentPosition = video.currentTime;
      }
      utils.log('HOST', { action, pos: video.currentTime, paused: video.paused });
      // Include play_state in all events so CLIENT knows if HOST is playing
      actions.send('player_event', { action, position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
      // For play/pause/seek, send immediate state_update (bypass normal throttle/ready checks)
      // This ensures CLIENT gets the play_state change ASAP
      // For seek: CLIENT needs to know if HOST is playing so it can resume after seeking
      if (action === 'play' || action === 'pause' || action === 'seek') {
        actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
        state.lastStateSentAt = utils.nowMs();
      }
    };

    // Create named listeners for cleanup
    const listeners = {
      waiting: () => {
        state.isBuffering = true;
        utils.log('VIDEO', { event: 'buffering', pos: video.currentTime, readyState: video.readyState });
        // Host: notify clients to pause while we buffer
        if (state.isHost && OWP.actions && OWP.actions.send) {
          OWP.actions.send('player_event', { action: 'buffering', position: video.currentTime });
        }
      },
      canplay: () => {
        const wasBuffering = state.isBuffering;
        state.isBuffering = false;
        if (wasBuffering) utils.log('VIDEO', { event: 'ready', pos: video.currentTime, readyState: video.readyState });
      },
      playing: () => {
        const wasBuffering = state.isBuffering;
        state.isBuffering = false;
        if (wasBuffering) {
          utils.log('VIDEO', { event: 'playing', pos: video.currentTime });
          // Host: notify clients to resume after buffering
          if (state.isHost && OWP.actions && OWP.actions.send) {
            OWP.actions.send('player_event', { action: 'play', position: video.currentTime });
          }
        }
      },
      play: () => onEvent('play'),
      pause: () => onEvent('pause'),
      seeked: () => {
        utils.log('VIDEO', { event: 'seeked', pos: video.currentTime });
        onEvent('seek');
      }
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
    // P-JS02 fix: Use cached video element when available to avoid repeated DOM queries
    const video = state.currentVideoElement || utils.getVideo();
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
    // Check for initial sync phase exit conditions
    if (state.isInitialSync) {
      const now = utils.nowMs();

      // If drift is too large (>10s in either direction), do immediate HARD_SEEK
      // This catches both Jellyfin resume jumps (ahead) and HLS segment issues (behind)
      // Trying to catch up 10+ seconds at 2x would take too long
      if (abs > INITIAL_SYNC_MAX_DRIFT) {
        utils.log('SYNC', { type: 'initial_sync_large_drift', drift, videoPos: video.currentTime, expected });
        // Seek to expected position
        video.currentTime = expected;
        state.lastSyncServerTs = serverNow;
        state.lastSyncPosition = expected;
        state.initialSyncTargetPos = 0;
        return;
      }

      // Exit initial sync if drift is small enough (caught up!)
      if (abs < INITIAL_SYNC_DRIFT_THRESHOLD) {
        state.isInitialSync = false;
        state.initialSyncUntil = 0;
        state.initialSyncTargetPos = 0;
        utils.log('SYNC', { type: 'initial_sync_complete', drift, reason: 'drift_threshold' });
      }
      // Exit initial sync if max time exceeded
      else if (state.initialSyncUntil && now >= state.initialSyncUntil) {
        state.isInitialSync = false;
        state.initialSyncUntil = 0;
        state.initialSyncTargetPos = 0;
        utils.log('SYNC', { type: 'initial_sync_timeout', drift });
      }
    }

    if (abs < DRIFT_DEADZONE_SEC) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      // UX-P3: Mark as synced when drift is within acceptable range
      if (state.syncStatus === 'syncing') {
        state.syncStatus = 'synced';
        if (OWP.ui && OWP.ui.updateSyncIndicator) OWP.ui.updateSyncIndicator();
      }
      return;
    }
    if (abs >= DRIFT_SOFT_MAX_SEC) {
      // During initial sync or cooldown, skip HARD_SEEK - let rate adjustment catch up gradually
      // This prevents seek loops when CLIENT is catching up after joining or resuming
      const now = utils.nowMs();
      const inCooldown = state.syncCooldownUntil && now < state.syncCooldownUntil;
      if (state.isInitialSync || inCooldown) {
        // Fall through to rate adjustment below
        if (abs > 5) {
          utils.log('SYNC', { type: 'skip_hard_seek', drift, reason: state.isInitialSync ? 'initial_sync' : 'cooldown' });
        }
      } else {
        utils.log('SYNC', { type: 'HARD_SEEK', expected, actual: video.currentTime, drift });
        utils.suppress();
        video.currentTime = expected;
        // Update sync state to our new position - prevents drift chase loop
        // (otherwise next iteration sees even more drift from old sync state)
        state.lastSyncServerTs = serverNow;
        state.lastSyncPosition = expected;
        if (video.playbackRate !== 1) video.playbackRate = 1;
        return;
      }
    }
    // Progressive catch-up: sqrt curve gives stronger correction for larger drifts
    // while staying smooth. Example: 2s drift → 1.21x, 4s drift → 1.30x (clamped to 1.20x)
    const sign = drift > 0 ? 1 : -1;
    const correction = sign * Math.sqrt(abs) * DRIFT_GAIN;
    const rate = Math.min(Math.max(1 + correction, PLAYBACK_RATE_MIN), PLAYBACK_RATE_MAX);
    // Log only when drift is significant (> 0.5s) to reduce noise
    if (abs > 0.5) {
      utils.log('SYNC', { expected, actual: video.currentTime, drift, rate });
    }
    video.playbackRate = rate;
  };

  OWP.playback = {
    playItem,
    ensurePlayback,
    bindVideo,
    syncLoop,
    watchReady,
    cleanupVideoListeners,
    // Quality control
    getEffectiveQuality,
    setQualityPreset,
    toggleDirectPlay
  };
})();
