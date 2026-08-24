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
    OWP.timers.clearScope('lifecycle');
    Object.keys(state.intervals).forEach(key => {
      if (state.intervals[key]) OWP.timers.clear(state.intervals[key]);
      state.intervals[key] = null;
    });
  };

  const onVideoPlayerExit = () => {
    console.log('[OpenWatchParty] Video player closed, cleaning up...');
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    if (panel) panel.classList.add('hide');
    if ((state.inRoom || state.rejoinPending) && OWP.actions && OWP.actions.leaveRoom) {
      OWP.actions.leaveRoom();
    }
    if (OWP.playback && OWP.playback.cleanupVideoListeners) {
      OWP.playback.cleanupVideoListeners();
    }
    state.autoJoinAttempt++;
    OWP.timers.clearScope('media');
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

  const retryConnectionAfterLogin = () => {
    const socketOpen = typeof WebSocket !== 'undefined' && state.ws?.readyState === WebSocket.OPEN;
    if (!state.authBlocked || state.isConnecting || socketOpen) return false;
    const accessToken = window.ApiClient?.accessToken?.()
      || window.ApiClient?._accessToken
      || window.ApiClient?._serverInfo?.AccessToken;
    if (!accessToken || !OWP.actions?.connect) return false;
    state.authBlocked = false;
    state.authError = '';
    OWP.actions.connect();
    return true;
  };

  const startIntervals = () => {
    state.intervals.ui = OWP.timers.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      retryConnectionAfterLogin();
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
            const autoJoinAttempt = ++state.autoJoinAttempt;
            OWP.timers.setTimeout(() => {
              if (autoJoinAttempt !== state.autoJoinAttempt || !utils.getVideo()) return;
              console.log('[OpenWatchParty] Auto-joining room:', roomId);
              OWP.actions.joinRoom(roomId);
            }, 500, 'media');
          }
        }
      }
    }, UI_CHECK_MS, 'lifecycle');
    state.intervals.home = OWP.timers.setInterval(() => {
      if (document.visibilityState === 'visible' && utils.isHomeView()) {
        ui.renderHomeWatchParties();
      }
    }, HOME_REFRESH_MS, 'lifecycle');
    state.intervals.sync = OWP.timers.setInterval(() => {
      if (state.inRoom && !state.isHost) {
        playback.syncLoop();
      }
    }, SYNC_LOOP_MS, 'lifecycle');
  };

  const init = () => {
    if (state.initialized) {
      console.log('[OpenWatchParty] Already initialized, skipping');
      return;
    }
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
    state.initialized = true;
  };

  // Expose lifecycle internals for cleanup module
  OWP._lifecycle = {
    get panelStopPropagation() { return panelStopPropagation; },
    set panelStopPropagation(v) { panelStopPropagation = v; },
    get hadVideoElement() { return hadVideoElement; },
    set hadVideoElement(v) { hadVideoElement = v; },
    clearAllIntervals,
    retryConnectionAfterLogin
  };

  OWP.app = OWP.app || {};
  Object.assign(OWP.app, { init });
})();
