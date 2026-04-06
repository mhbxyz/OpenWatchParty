(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const state = OWP.state;
  const ui = OWP.ui;
  const utils = OWP.utils;
  const playback = OWP.playback;
  const { UI_CHECK_MS, HOME_REFRESH_MS, SYNC_LOOP_MS } = OWP.constants;

  let panelStopPropagation = null;
  let hadVideoElement = false;

  const clearAllIntervals = () => {
    if (state.intervals.ui) { clearInterval(state.intervals.ui); state.intervals.ui = null; }
    if (state.intervals.ping) { clearInterval(state.intervals.ping); state.intervals.ping = null; }
    if (state.intervals.home) { clearInterval(state.intervals.home); state.intervals.home = null; }
    if (state.intervals.sync) { clearInterval(state.intervals.sync); state.intervals.sync = null; }
    if (state.intervals.stateUpdate) { clearInterval(state.intervals.stateUpdate); state.intervals.stateUpdate = null; }
  };

  const onVideoPlayerExit = () => {
    console.log('[OpenWatchParty] Video player closed, cleaning up...');
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    if (panel) panel.classList.add('hide');
    if (state.inRoom && OWP.actions && OWP.actions.leaveRoom) {
      OWP.actions.leaveRoom();
    }
    if (OWP.playback && OWP.playback.cleanupVideoListeners) {
      OWP.playback.cleanupVideoListeners();
    }
    state.bound = false;
  };

  const createPanel = () => {
    if (document.getElementById(OWP.constants.PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = OWP.constants.PANEL_ID;
    panel.className = 'hide';
    document.body.appendChild(panel);
    panelStopPropagation = (e) => e.stopPropagation();
    panel.addEventListener('click', panelStopPropagation);
    panel.addEventListener('mousedown', panelStopPropagation);
    panel.addEventListener('keydown', panelStopPropagation);
    panel.addEventListener('keyup', panelStopPropagation);
    panel.addEventListener('keypress', panelStopPropagation);
  };

  const startIntervals = () => {
    state.intervals.ui = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const video = utils.getVideo();
      if (hadVideoElement && !video) {
        hadVideoElement = false;
        onVideoPlayerExit();
        return;
      }
      if (video) {
        hadVideoElement = true;
        ui.injectOsdButton();
        playback.bindVideo();
        if (state.pendingJoinRoomId) {
          console.log('[OpenWatchParty] Video detected, pendingJoinRoomId:', state.pendingJoinRoomId);
          if (OWP.actions && OWP.actions.joinRoom) {
            const roomId = state.pendingJoinRoomId;
            state.pendingJoinRoomId = '';
            setTimeout(() => {
              console.log('[OpenWatchParty] Auto-joining room:', roomId);
              OWP.actions.joinRoom(roomId);
            }, 500);
          }
        }
      }

      // Jellyfin is an SPA; header DOM is frequently replaced during navigation.
      // Keep a global launcher button present even when no video OSD exists.
      ui.injectGlobalButton();
    }, UI_CHECK_MS);
    state.intervals.home = setInterval(() => {
      if (document.visibilityState === 'visible' && utils.isHomeView()) {
        ui.renderHomeWatchParties();
      }
    }, HOME_REFRESH_MS);
    state.intervals.sync = setInterval(() => {
      if (state.inRoom && !state.isHost) {
        playback.syncLoop();
      }
    }, SYNC_LOOP_MS);
  };

  const init = () => {
    if (state.initialized) {
      console.log('[OpenWatchParty] Already initialized, skipping');
      return;
    }
    state.initialized = true;
    console.log('%c OpenWatchParty Plugin Loaded (OSD Mode) ', 'background: #2e7d32; color: #fff; font-size: 12px; padding: 2px; border-radius: 2px;');
    clearAllIntervals();
    ui.injectStyles();
    createPanel();
    if (OWP.actions && OWP.actions.connect) {
      console.log('[OpenWatchParty] Initiating WebSocket connection...');
      OWP.actions.connect();
    } else {
      console.error('[OpenWatchParty] OWP.actions.connect not available!');
    }
    startIntervals();
  };

  // Expose lifecycle internals for cleanup module
  OWP._lifecycle = {
    get panelStopPropagation() { return panelStopPropagation; },
    set panelStopPropagation(v) { panelStopPropagation = v; },
    get hadVideoElement() { return hadVideoElement; },
    set hadVideoElement(v) { hadVideoElement = v; },
    clearAllIntervals
  };

  OWP.app = OWP.app || {};
  Object.assign(OWP.app, { init });
})();
