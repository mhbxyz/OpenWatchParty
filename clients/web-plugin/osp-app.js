(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.app) return;

  const state = OSP.state;
  const ui = OSP.ui;
  const utils = OSP.utils;
  const playback = OSP.playback;

  const init = () => {
    console.log('%c OpenSyncParty Plugin Loaded (OSD Mode) ', 'background: #2e7d32; color: #fff; font-size: 12px; padding: 2px; border-radius: 2px;');
    ui.injectStyles();
    if (!document.getElementById(OSP.constants.PANEL_ID)) {
      const panel = document.createElement('div');
      panel.id = OSP.constants.PANEL_ID;
      panel.className = 'hide';
      document.body.appendChild(panel);
    }
    if (OSP.actions && OSP.actions.connect) OSP.actions.connect();
    setInterval(() => { ui.injectOsdButton(); if (utils.getVideo()) playback.bindVideo(); }, 1000);
    setInterval(() => { if (state.ws && state.ws.readyState === 1) OSP.actions.send('ping', { client_ts: utils.nowMs() }); }, 3000);
    setInterval(() => { ui.renderHomeWatchParties(); }, 2000);
    setInterval(() => { playback.syncLoop(); }, 1000);
  };

  OSP.app = { init };
})();
