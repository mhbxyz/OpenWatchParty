(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const utils = OWP.utils = OWP.utils || {};
  const state = OWP.state;
  const { SUPPRESS_MS, SYNC_LEAD_MS } = OWP.constants;

  let syncingTimer = null;

  const nowMs = () => Date.now();

  const getServerNow = () => nowMs() + (state.serverOffsetMs || 0);

  const adjustedPosition = (position, serverTs) => {
    const serverNow = getServerNow();
    const ts = typeof serverTs === 'number' ? serverTs : serverNow;
    const elapsed = Math.max(0, serverNow - ts) + SYNC_LEAD_MS;
    return position + (elapsed / 1000);
  };

  const scheduleAt = (serverTs, fn) => {
    if (state.pendingActionTimer) {
      OWP.timers.clear(state.pendingActionTimer);
      state.pendingActionTimer = null;
    }
    const serverNow = getServerNow();
    const target = typeof serverTs === 'number' ? serverTs : serverNow;
    const delay = Math.max(0, target - serverNow);
    if (delay === 0) {
      fn();
      return;
    }
    state.pendingActionTimer = OWP.timers.setTimeout(() => {
      state.pendingActionTimer = null;
      fn();
    }, delay, 'room');
  };

  const startSyncing = () => {
    state.isSyncing = true;
    if (syncingTimer) OWP.timers.clear(syncingTimer);
    syncingTimer = OWP.timers.setTimeout(() => {
      state.isSyncing = false;
      syncingTimer = null;
    }, SUPPRESS_MS, 'room');
  };

  Object.assign(utils, { nowMs, getServerNow, adjustedPosition, scheduleAt, startSyncing });
})();
