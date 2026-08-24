(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;

  const updateStatusIndicator = () => {
    const el = document.getElementById('owp-ws-indicator');
    if (!el) return;
    const connected = state.ws && state.ws.readyState === 1;
    el.style.color = connected ? '#69f0ae' : '#ff5252';
    el.textContent = connected ? 'Online' : 'Offline';
  };

  const updateSyncIndicator = () => {
    const el = document.getElementById('owp-sync-indicator');
    if (!el || state.isHost) return;
    const status = state.syncStatus || 'synced';
    let dotClass, label, showSpinner = false;
    if (status === 'blocked') {
      dotClass = 'syncing';
      label = 'Playback blocked - press Play';
    } else if (status === 'pending_play') {
      dotClass = 'pending';
      const remaining = Math.max(0, (state.pendingPlayUntil - (Date.now() + (state.serverOffsetMs || 0))) / 1000);
      label = `Waiting for sync... ${remaining.toFixed(1)}s`;
      showSpinner = true;
    } else if (status === 'syncing') {
      dotClass = 'syncing';
      label = 'Out of sync';
    } else {
      dotClass = 'synced';
      label = 'In sync';
    }
    const marker = document.createElement('div');
    marker.className = showSpinner ? 'owp-sync-spinner' : `owp-sync-dot ${dotClass}`;
    const text = document.createElement('span');
    text.textContent = label;
    el.replaceChildren(marker, text);
  };

  const buildSyncStatusIndicator = () => {
    if (state.isHost) return null;
    const status = state.syncStatus || 'synced';
    let dotClass, label, showSpinner = false;
    if (status === 'blocked') {
      dotClass = 'syncing';
      label = 'Playback blocked - press Play';
    } else if (status === 'pending_play') {
      dotClass = 'pending';
      const remaining = Math.max(0, (state.pendingPlayUntil - (Date.now() + (state.serverOffsetMs || 0))) / 1000);
      label = `Waiting for sync... ${remaining.toFixed(1)}s`;
      showSpinner = true;
    } else if (status === 'syncing') {
      dotClass = 'syncing';
      label = 'Out of sync';
    } else {
      dotClass = 'synced';
      label = 'In sync';
    }
    const indicator = document.createElement('div');
    indicator.className = 'owp-sync-status';
    indicator.id = 'owp-sync-indicator';
    const marker = document.createElement('div');
    marker.className = showSpinner ? 'owp-sync-spinner' : `owp-sync-dot ${dotClass}`;
    const text = document.createElement('span');
    text.textContent = label;
    indicator.append(marker, text);
    return indicator;
  };

  const stopPlayerCapture = (input) => {
    const stopPropagation = (e) => e.stopPropagation();
    input.addEventListener('keydown', stopPropagation);
    input.addEventListener('keyup', stopPropagation);
    input.addEventListener('keypress', stopPropagation);
    input.addEventListener('click', stopPropagation);
    input.addEventListener('mousedown', stopPropagation);
  };

  Object.assign(ui, { updateStatusIndicator, updateSyncIndicator, buildSyncStatusIndicator, stopPlayerCapture });
})();
