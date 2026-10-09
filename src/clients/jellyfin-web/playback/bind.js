(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const { STATE_UPDATE_MS, SEEK_THRESHOLD, STREAM_RELOAD_MAX_MS } = OWP.constants;
  const hasPendingRoomWork = () => Boolean(
    (state.pendingPlayUntil && utils.getServerNow() < state.pendingPlayUntil)
    || (state.pendingMediaId && state.pendingMediaUntil && utils.nowMs() < state.pendingMediaUntil)
  );

  // Jellyfin switches an audio or subtitle track by reloading the stream in
  // place: the video empties (position 0), plays again and seeks back to where
  // it was. Until it plays again, the host's events describe the reload, not
  // the room.
  const isReloadingStream = () => Boolean(state.streamReloadUntil && utils.nowMs() < state.streamReloadUntil);

  const endStreamReload = (video) => {
    state.streamReloadUntil = 0;
    state.lastSentPosition = video.currentTime;
  };

  const sendStateUpdate = (video) => {
    const actions = OWP.actions;
    if (!state.isHost || !actions || !actions.send) return;
    if (state.isSyncing || hasPendingRoomWork() || isReloadingStream()) return;
    if (utils.isSeeking()) return;
    if (state.isBuffering || !utils.isVideoReady()) return;
    const now = utils.nowMs();
    if (now - state.lastStateSentAt < STATE_UPDATE_MS) return;
    state.lastStateSentAt = now;
    actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
  };

  const onHostEvent = (action, video) => {
    const actions = OWP.actions;
    if (!state.isHost || !actions || !actions.send || !utils.shouldSend()) return;
    if (state.isSyncing || hasPendingRoomWork() || isReloadingStream()) return;
    if (action === 'seek' && !utils.isVideoReady()) return;
    if (action === 'pause') {
      if (state.isBuffering) return;
      if (utils.isSeeking()) return;
      state.wantsToPlay = false;
    }
    if (action === 'play') {
      if (utils.isSeeking()) return;
      state.wantsToPlay = true;
      // A reload past its time limit ends with this play, not with another
      // one on `playing`.
      if (state.streamReloadUntil) endStreamReload(video);
    }
    if (action === 'seek') {
      const now = utils.nowMs();
      if (now - state.lastSeekSentAt < 250) return;
      if (Math.abs(video.currentTime - state.lastSentPosition) < SEEK_THRESHOLD) return;
      state.lastSeekSentAt = now;
      state.lastSentPosition = video.currentTime;
    }
    utils.log('HOST', { action, pos: video.currentTime, paused: video.paused });
    actions.send('player_event', { action, position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
    if (action === 'play' || action === 'pause' || action === 'seek') {
      actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
      state.lastStateSentAt = utils.nowMs();
    }
  };

  const trackGuestPause = () => {
    if (state.inRoom && !state.isHost && state.lastSyncPlayState === 'playing') {
      state.guestPaused = true;
    }
  };

  const trackGuestPlay = () => {
    if (!state.inRoom || state.isHost || !state.guestPaused) return;
    state.guestPaused = false;
    // Rejoining playback should catch up on the next sync tick, even if a
    // host command set an initial-sync or command cooldown while paused.
    state.isInitialSync = false;
    state.initialSyncUntil = 0;
    state.initialSyncTargetPos = null;
    state.syncCooldownUntil = 0;
  };

  const createVideoListeners = (video) => {
    return {
      waiting: () => {
        state.isBuffering = true;
        utils.log('VIDEO', { event: 'buffering', pos: video.currentTime, readyState: video.readyState });
        if (state.isHost && !state.isSyncing && !hasPendingRoomWork() && !isReloadingStream()
            && utils.shouldSend() && OWP.actions && OWP.actions.send) {
          OWP.actions.send('player_event', { action: 'buffering', position: video.currentTime });
        }
      },
      canplay: () => {
        const wasBuffering = state.isBuffering;
        state.isBuffering = false;
        if (wasBuffering) utils.log('VIDEO', { event: 'ready', pos: video.currentTime, readyState: video.readyState });
        // A reload that started paused ends here; the room stays paused. One
        // that started playing waits for `playing`: the element is paused
        // until Jellyfin plays it again.
        if (state.streamReloadUntil && !state.streamReloadResume && video.paused) endStreamReload(video);
      },
      playing: () => {
        if (playback.markPlaybackResumed) playback.markPlaybackResumed();
        const wasBuffering = state.isBuffering;
        // Also past the time limit: the room still waits for this play.
        const wasReloading = Boolean(state.streamReloadUntil);
        state.isBuffering = false;
        if (wasReloading) endStreamReload(video);
        if (wasBuffering || wasReloading) {
          utils.log('VIDEO', { event: 'playing', pos: video.currentTime });
          if (state.isHost && !state.isSyncing && !hasPendingRoomWork() && utils.shouldSend()
              && OWP.actions && OWP.actions.send) {
            OWP.actions.send('player_event', { action: 'play', position: video.currentTime });
          }
        }
      },
      play: () => {
        if (playback.markPlaybackResumed) playback.markPlaybackResumed();
        trackGuestPlay();
        onHostEvent('play', video);
      },
      pause: () => {
        trackGuestPause();
        onHostEvent('pause', video);
      },
      seeked: () => {
        utils.log('VIDEO', { event: 'seeked', pos: video.currentTime });
        onHostEvent('seek', video);
      },
      // The room waits for the host's reload as it does while the host buffers,
      // from where the host was playing, instead of being told to play from
      // 0:00 and then to seek back.
      emptied: () => {
        // A reload already under way (a retry empties again) keeps its limit.
        if (!state.isHost || !state.inRoom || isReloadingStream()) return;
        state.streamReloadUntil = utils.nowMs() + STREAM_RELOAD_MAX_MS;
        state.streamReloadResume = state.lastPlayedPlaying;
        if (!state.streamReloadResume || hasPendingRoomWork()
            || !OWP.actions || !OWP.actions.send) return;
        utils.log('HOST', { action: 'stream_reload', pos: state.lastPlayedPosition });
        OWP.actions.send('player_event', { action: 'buffering', position: state.lastPlayedPosition });
      },
      timeupdate: () => {
        if (video.readyState < 2 || video.seeking) return;
        state.lastPlayedPosition = video.currentTime;
        state.lastPlayedPlaying = !video.paused;
      }
    };
  };

  const bindVideo = () => {
    const video = utils.getVideo();
    if (!video) return;
    if (state.bound && state.currentVideoElement !== video) {
      cleanupVideoListeners();
      state.bound = false;
    }
    if (state.bound) return;
    state.bound = true;
    state.currentVideoElement = video;
    // A pause belongs to the video it was made on.
    state.guestPaused = false;
    const listeners = createVideoListeners(video);
    state.videoListeners = listeners;
    video.addEventListener('waiting', listeners.waiting);
    video.addEventListener('canplay', listeners.canplay);
    video.addEventListener('playing', listeners.playing);
    video.addEventListener('play', listeners.play);
    video.addEventListener('pause', listeners.pause);
    video.addEventListener('seeked', listeners.seeked);
    video.addEventListener('emptied', listeners.emptied);
    video.addEventListener('timeupdate', listeners.timeupdate);
    if (state.intervals.stateUpdate) {
      OWP.timers.clear(state.intervals.stateUpdate);
    }
    state.intervals.stateUpdate = OWP.timers.setInterval(() => {
      if (state.isHost) sendStateUpdate(video);
    }, STATE_UPDATE_MS, 'video');
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
      video.removeEventListener('emptied', listeners.emptied);
      video.removeEventListener('timeupdate', listeners.timeupdate);
    }
    if (state.intervals.stateUpdate) {
      OWP.timers.clear(state.intervals.stateUpdate);
      state.intervals.stateUpdate = null;
    }
    state.videoListeners = null;
    state.currentVideoElement = null;
  };

  Object.assign(playback, { bindVideo, cleanupVideoListeners });
})();
