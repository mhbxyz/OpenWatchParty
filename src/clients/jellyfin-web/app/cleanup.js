(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const state = OWP.state;

  const cleanupPanel = () => {
    const lc = OWP._lifecycle;
    if (lc && lc.panelStopPropagation) {
      const panel = document.getElementById(OWP.constants.PANEL_ID);
      if (panel) {
        panel.removeEventListener('click', lc.panelStopPropagation);
        panel.removeEventListener('mousedown', lc.panelStopPropagation);
        panel.removeEventListener('keydown', lc.panelStopPropagation);
        panel.removeEventListener('keyup', lc.panelStopPropagation);
        panel.removeEventListener('keypress', lc.panelStopPropagation);
      }
      lc.panelStopPropagation = null;
    }
  };

  const cleanupVideo = () => {
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
  };

  const cleanup = () => {
    const lc = OWP._lifecycle;
    if (lc) lc.clearAllIntervals();
    if (state.pendingActionTimer) {
      clearTimeout(state.pendingActionTimer);
      state.pendingActionTimer = null;
    }
    if (lc) lc.hadVideoElement = false;
    if (OWP.actions?.disconnect) {
      OWP.actions.disconnect();
    } else if (state.ws) {
      state.autoReconnect = false;
      state.ws.close();
      state.ws = null;
    }
    cleanupPanel();
    cleanupVideo();
    state.bound = false;
    state.initialized = false;
  };

  OWP.app = OWP.app || {};
  Object.assign(OWP.app, { cleanup });
})();
