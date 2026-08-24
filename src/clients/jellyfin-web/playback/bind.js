(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const { STATE_UPDATE_MS, SEEK_THRESHOLD } = OWP.constants;

  const sendStateUpdate = (video) => {
    const actions = OWP.actions;
    if (!state.isHost || !actions || !actions.send) return;
    if (state.isSyncing) return;
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
    if (state.isSyncing) return;
    if (action === 'seek' && !utils.isVideoReady()) return;
    if (action === 'pause') {
      if (state.isBuffering) return;
      if (utils.isSeeking()) return;
      state.wantsToPlay = false;
    }
    if (action === 'play') {
      if (utils.isSeeking()) return;
      state.wantsToPlay = true;
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

  const createVideoListeners = (video) => {
    return {
      waiting: () => {
        state.isBuffering = true;
        utils.log('VIDEO', { event: 'buffering', pos: video.currentTime, readyState: video.readyState });
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
          if (state.isHost && OWP.actions && OWP.actions.send) {
            OWP.actions.send('player_event', { action: 'play', position: video.currentTime });
          }
        }
      },
      play: () => onHostEvent('play', video),
      pause: () => onHostEvent('pause', video),
      seeked: () => {
        utils.log('VIDEO', { event: 'seeked', pos: video.currentTime });
        onHostEvent('seek', video);
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
    const listeners = createVideoListeners(video);
    state.videoListeners = listeners;
    video.addEventListener('waiting', listeners.waiting);
    video.addEventListener('canplay', listeners.canplay);
    video.addEventListener('playing', listeners.playing);
    video.addEventListener('play', listeners.play);
    video.addEventListener('pause', listeners.pause);
    video.addEventListener('seeked', listeners.seeked);
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
