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
        panel.removeEventListener('wheel', lc.panelStopPropagation);
      }
      lc.panelStopPropagation = null;
    }
  };

  // Last step of cleanup: the application/UI part of the reset described in
  // client-state.md. Clearing `initialized` lets a later init() build the panel
  // and header buttons again, and stops a header module that finishes loading
  // after cleanup from injecting its buttons.
  const resetApplicationUI = () => {
    state.initialized = false;
  };

  const cleanup = () => {
    const lc = OWP._lifecycle;
    OWP.timers.clearAll();
    state.pendingActionTimer = null;
    state.tokenRefreshTimer = null;
    state.reconnectTimer = null;
    state.roomRejoinTimer = null;
    Object.keys(state.intervals).forEach(key => { state.intervals[key] = null; });
    if (lc) lc.hadVideoElement = false;
    if (OWP.actions?.disconnect) {
      OWP.actions.disconnect();
    } else if (state.ws) {
      state.autoReconnect = false;
      state.ws.close();
      state.ws = null;
    }
    if (OWP.ui?.removeHeaderButtons) OWP.ui.removeHeaderButtons();
    cleanupPanel();
    OWP.stateLifecycle.releaseVideoBinding();
    if (OWP.ui?.updateGuestControls) OWP.ui.updateGuestControls();
    resetApplicationUI();
  };

  OWP.app = OWP.app || {};
  Object.assign(OWP.app, { cleanup });
})();
