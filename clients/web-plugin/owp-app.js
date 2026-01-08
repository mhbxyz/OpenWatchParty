(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.app) return;

  const state = OWP.state;
  const ui = OWP.ui;
  const utils = OWP.utils;
  const playback = OWP.playback;
  const { UI_CHECK_MS, PING_MS, HOME_REFRESH_MS, SYNC_LOOP_MS } = OWP.constants;

  const clearAllIntervals = () => {
    if (state.intervals.ui) { clearInterval(state.intervals.ui); state.intervals.ui = null; }
    if (state.intervals.ping) { clearInterval(state.intervals.ping); state.intervals.ping = null; }
    if (state.intervals.home) { clearInterval(state.intervals.home); state.intervals.home = null; }
    if (state.intervals.sync) { clearInterval(state.intervals.sync); state.intervals.sync = null; }
    if (state.intervals.stateUpdate) { clearInterval(state.intervals.stateUpdate); state.intervals.stateUpdate = null; }
  };

  const init = () => {
    console.log('%c OpenWatchParty Plugin Loaded (OSD Mode) ', 'background: #2e7d32; color: #fff; font-size: 12px; padding: 2px; border-radius: 2px;');

    // Clear any existing intervals (in case of re-init)
    clearAllIntervals();

    ui.injectStyles();
    if (!document.getElementById(OWP.constants.PANEL_ID)) {
      const panel = document.createElement('div');
      panel.id = OWP.constants.PANEL_ID;
      panel.className = 'hide';
      document.body.appendChild(panel);
    }
    if (OWP.actions && OWP.actions.connect) OWP.actions.connect();

    // UI check interval - inject OSD button and bind video (only when tab is visible, fixes M-P04)
    state.intervals.ui = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ui.injectOsdButton();
      if (utils.getVideo()) playback.bindVideo();
    }, UI_CHECK_MS);

    // Ping interval - only when connected
    state.intervals.ping = setInterval(() => {
      if (state.ws && state.ws.readyState === 1) {
        OWP.actions.send('ping', { client_ts: utils.nowMs() });
      }
    }, PING_MS);

    // Home watch parties refresh - only when on home view AND tab is visible (fixes M-P05)
    state.intervals.home = setInterval(() => {
      if (document.visibilityState === 'visible' && utils.isHomeView()) {
        ui.renderHomeWatchParties();
      }
    }, HOME_REFRESH_MS);

    // Sync loop - only when in room and not host
    state.intervals.sync = setInterval(() => {
      if (state.inRoom && !state.isHost) {
        playback.syncLoop();
      }
    }, SYNC_LOOP_MS);
  };

  const cleanup = () => {
    clearAllIntervals();
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    // Clean up video listeners if any
    if (state.currentVideoElement && state.videoListeners) {
      const video = state.currentVideoElement;
      const listeners = state.videoListeners;
      if (listeners.waiting) video.removeEventListener('waiting', listeners.waiting);
      if (listeners.canplay) video.removeEventListener('canplay', listeners.canplay);
      if (listeners.playing) video.removeEventListener('playing', listeners.playing);
      if (listeners.play) video.removeEventListener('play', listeners.play);
      if (listeners.pause) video.removeEventListener('pause', listeners.pause);
      if (listeners.seeked) video.removeEventListener('seeked', listeners.seeked);
      state.videoListeners = null;
      state.currentVideoElement = null;
    }
    state.bound = false;
  };

  OWP.app = { init, cleanup };
})();
