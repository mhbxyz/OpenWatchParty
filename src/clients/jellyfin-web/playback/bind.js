(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const { STATE_UPDATE_MS, SEEK_THRESHOLD, STREAM_RELOAD_MAX_MS, OWN_COMMAND_HOLD_MS } = OWP.constants;
  const hasPendingRoomWork = () => Boolean(
    (state.pendingPlayUntil && utils.getServerNow() < state.pendingPlayUntil)
    || (state.pendingMediaId && state.pendingMediaUntil && utils.nowMs() < state.pendingMediaUntil)
  );

  // Jellyfin switches an audio or subtitle track by reloading the stream in
  // place: the video empties (position 0), plays again and seeks back to where
  // it was. Until it plays again, the host's events describe the reload, not
  // the room.
  const isReloadingStream = () => Boolean(state.streamReloadUntil && utils.nowMs() < state.streamReloadUntil);

  let promotedPlay = null;

  // A private guest pause must not become the room's state on promotion.
  // Keep that pause as a send gate until the room position and play state
  // have been applied, including an asynchronous or blocked play request.
  const syncPromotedGuest = (video) => {
    if (!state.isHost || !state.guestPaused || !video || !state.lastSyncServerTs) return;
    if (hasPendingRoomWork() || state.isBuffering || !utils.isVideoReady() || utils.isSeeking()) return;
    if (promotedPlay?.video === video && promotedPlay.roomId === state.roomId) return;
    if (state.playbackBlocked && video.paused && state.lastSyncPlayState === 'playing') return;
    state.hostAppliedPlayState = state.lastSyncPlayState;
    utils.startSyncing();
    const playing = state.lastSyncPlayState === 'playing';
    const position = playing
      ? utils.adjustedPosition(state.lastSyncPosition, state.lastSyncServerTs)
      : state.lastSyncPosition;
    video.currentTime = position;
    if (!playing) {
      video.pause();
      state.guestPaused = false;
      return;
    }
    if (!video.paused) {
      state.guestPaused = false;
      return;
    }
    const attempt = { video, roomId: state.roomId, actionAttempt: state.playbackActionAttempt };
    promotedPlay = attempt;
    Promise.resolve(playback.safePlay(video, 'host promotion')).then(success => {
      if (success && !video.paused && state.inRoom && state.isHost
          && state.roomId === attempt.roomId && state.currentVideoElement === video
          && state.playbackActionAttempt === attempt.actionAttempt) state.guestPaused = false;
    }).finally(() => {
      if (promotedPlay === attempt) promotedPlay = null;
    });
  };

  const endStreamReload = (video) => {
    state.streamReloadUntil = 0;
    state.lastSentPosition = video.currentTime;
    // A guest's play or pause that came during the reload goes first: it
    // holds the sync, so the reload's own play is not sent to the room.
    if (state.reloadGuestCommand) OWP._wsHandlers?.applyReloadGuestCommand?.(video);
  };

  const sendStateUpdate = (video) => {
    const actions = OWP.actions;
    if (!state.isHost || !actions || !actions.send) return;
    syncPromotedGuest(video);
    if (state.guestPaused) return;
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
    if (state.guestPaused) return;
    const controlState = action === 'play' ? 'playing' : action === 'pause' ? 'paused' : '';
    const expectedState = state.pendingPlayUntil ? state.hostPendingPlayState : state.hostAppliedPlayState;
    const supersedesCommand = controlState && expectedState && controlState !== expectedState;
    if (isReloadingStream()) return;
    if (state.pendingMediaId && state.pendingMediaUntil && utils.nowMs() < state.pendingMediaUntil) return;
    if ((state.isSyncing || hasPendingRoomWork()) && !supersedesCommand) return;
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
    if (action === 'play' || action === 'pause') {
      state.playbackActionAttempt++;
      if (state.pendingActionTimer) OWP.timers.clear(state.pendingActionTimer);
      state.pendingActionTimer = null;
      state.pendingPlayUntil = 0;
      state.hostPendingPlayState = '';
      state.hostAppliedPlayState = controlState;
      state.isSyncing = false;
      state.hostControlAcks.push(action);
      if (state.hostControlAcks.length > 32) state.hostControlAcks.shift();
    }
    utils.log('HOST', { action, pos: video.currentTime, paused: video.paused });
    actions.send('player_event', { action, position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
    if (action === 'play' || action === 'pause' || action === 'seek') {
      actions.send('state_update', { position: video.currentTime, play_state: video.paused ? 'paused' : 'playing' });
      state.lastStateSentAt = utils.nowMs();
    }
  };

  // A guest's own play or pause is the room's: the server passes it to everyone,
  // the host included. OWP's own plays and pauses set the room state first, so
  // they never match here.
  const onGuestEvent = (action, video) => {
    const actions = OWP.actions;
    if (!state.inRoom || state.isHost || !actions || !actions.send || !utils.shouldSend()) return;
    if (!state.sharedPlaybackControl) return;
    const playing = action === 'play';
    if (state.lastSyncPlayState !== (playing ? 'paused' : 'playing')) return;
    // Not while the room waits for the host, nor for the pause that ends an
    // episode or comes with leaving the player (the stream is gone by then).
    if (playing && state.roomWaiting) return;
    // Without a stream (HAVE_NOTHING) it is the player closing; a video that
    // is still loading or buffering is the user's.
    if (video.ended || video.readyState === 0 || video.isConnected === false) return;
    const now = utils.nowMs();
    const playState = playing ? 'playing' : 'paused';
    state.lastSyncPlayState = playState;
    state.lastSyncPosition = video.currentTime;
    state.lastSyncServerTs = utils.getServerNow();
    state.ownCommandUntil = now + OWN_COMMAND_HOLD_MS;
    state.ownCommandPlayState = playState;
    state.isInitialSync = false;
    state.initialSyncUntil = 0;
    state.initialSyncTargetPos = null;
    state.syncCooldownUntil = playing ? now + 2000 : 0;
    state.playbackActionAttempt++;
    utils.log('GUEST', { action, pos: video.currentTime });
    actions.send('player_event', { action, position: video.currentTime, play_state: playState });
  };

  const createVideoListeners = (video) => {
    return {
      waiting: () => {
        state.isBuffering = true;
        utils.log('VIDEO', { event: 'buffering', pos: video.currentTime, readyState: video.readyState });
        if (state.isHost && !state.guestPaused && !state.isSyncing && !hasPendingRoomWork() && !isReloadingStream()
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
          if (state.isHost && !state.guestPaused && !state.isSyncing && !hasPendingRoomWork() && utils.shouldSend()
              && OWP.actions && OWP.actions.send) {
            OWP.actions.send('player_event', { action: 'play', position: video.currentTime });
          }
        }
      },
      play: () => {
        if (playback.markPlaybackResumed) playback.markPlaybackResumed();
        onGuestEvent('play', video);
        if (!state.isHost && state.guestPaused) {
          state.guestPaused = false;
          state.isInitialSync = false;
          state.initialSyncUntil = 0;
          state.initialSyncTargetPos = null;
          state.syncCooldownUntil = 0;
        }
        if (state.isHost && state.guestPaused) {
          syncPromotedGuest(video);
          return;
        }
        onHostEvent('play', video);
      },
      pause: () => {
        if (state.inRoom && !state.isHost && !state.sharedPlaybackControl && state.lastSyncPlayState === 'playing') state.guestPaused = true;
        onGuestEvent('pause', video);
        onHostEvent('pause', video);
        if (OWP.queue?.onVideoTime) OWP.queue.onVideoTime(video);
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
        // OWP opening the room's next item empties the video too: that is no
        // reload, and the room's play must not wait for one.
        if (!state.isHost || !state.inRoom || state.guestPaused || isReloadingStream() || state.pendingMediaId) return;
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
        if (OWP.queue?.onVideoTime) OWP.queue.onVideoTime(video);
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

  const cleanupVideoListeners = () => OWP.stateLifecycle.releaseVideoBinding();

  Object.assign(playback, { bindVideo, cleanupVideoListeners, syncPromotedGuest });
})();
