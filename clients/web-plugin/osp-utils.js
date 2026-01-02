(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.utils) return;

  const { SUPPRESS_MS, SYNC_LEAD_MS } = OSP.constants;
  const state = OSP.state;

  const nowMs = () => Date.now();
  const shouldSend = () => nowMs() > state.suppressUntil;
  const suppress = (ms = SUPPRESS_MS) => { state.suppressUntil = nowMs() + ms; };
  const getVideo = () => document.querySelector('video');
  const getPlaybackManager = () => window.playbackManager || window.PlaybackManager || window.app?.playbackManager;
  const getCurrentItem = () => {
    const pm = getPlaybackManager();
    if (!pm) return null;
    if (typeof pm.getCurrentItem === 'function') return pm.getCurrentItem();
    if (typeof pm.currentItem === 'function') return pm.currentItem();
    return pm.currentItem || pm._currentItem || null;
  };
  const getCurrentItemId = () => {
    const item = getCurrentItem();
    if (item) return item.Id || item.id || item.ItemId || null;
    const hash = window.location.hash || '';
    const match = hash.match(/id=([a-f0-9]{16,})/i);
    return match ? match[1] : null;
  };
  const getItemImageUrl = (itemId) => {
    if (!itemId || !window.ApiClient || typeof ApiClient.getItemImageUrl !== 'function') return '';
    return ApiClient.getItemImageUrl(itemId, { type: 'Primary', quality: 90 });
  };
  const isHomeView = () => {
    if (document.querySelector('.homePage')) return true;
    const hash = window.location.hash || '';
    return hash.includes('home');
  };
  const getServerNow = () => nowMs() + (state.serverOffsetMs || 0);
  const adjustedPosition = (position, serverTs) => {
    const serverNow = getServerNow();
    const ts = typeof serverTs === 'number' ? serverTs : serverNow;
    const elapsed = Math.max(0, serverNow - ts) + SYNC_LEAD_MS;
    return position + (elapsed / 1000);
  };
  const scheduleAt = (serverTs, fn) => {
    if (state.pendingActionTimer) {
      clearTimeout(state.pendingActionTimer);
      state.pendingActionTimer = null;
    }
    const serverNow = getServerNow();
    const target = typeof serverTs === 'number' ? serverTs : serverNow;
    const delay = Math.max(0, target - serverNow);
    if (delay === 0) {
      fn();
      return;
    }
    state.pendingActionTimer = setTimeout(() => {
      state.pendingActionTimer = null;
      fn();
    }, delay);
  };

  OSP.utils = {
    nowMs,
    shouldSend,
    suppress,
    getVideo,
    getPlaybackManager,
    getCurrentItem,
    getCurrentItemId,
    getItemImageUrl,
    isHomeView,
    getServerNow,
    adjustedPosition,
    scheduleAt
  };
})();
