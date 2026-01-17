(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.utils) return;

  const { SUPPRESS_MS, SYNC_LEAD_MS } = OWP.constants;
  const state = OWP.state;

  const nowMs = () => Date.now();
  const shouldSend = () => nowMs() > state.suppressUntil;
  const suppress = (ms = SUPPRESS_MS) => { state.suppressUntil = nowMs() + ms; };
  const getVideo = () => document.querySelector('video');
  const isVideoReady = () => {
    const video = getVideo();
    return video && video.readyState >= 3;
  };
  const isBuffering = () => {
    const video = getVideo();
    if (!video) return false;
    return video.readyState < 3 || (video.networkState === 2 && video.readyState < 4);
  };
  const isSeeking = () => {
    const video = getVideo();
    return video && video.seeking;
  };
  let syncingTimer = null;
  const startSyncing = () => {
    state.isSyncing = true;
    if (syncingTimer) clearTimeout(syncingTimer);
    syncingTimer = setTimeout(() => {
      state.isSyncing = false;
      syncingTimer = null;
    }, SUPPRESS_MS);
  };
  const getPlaybackManager = () => window.playbackManager || window.PlaybackManager || window.app?.playbackManager;
  const getCurrentItem = () => {
    const pm = getPlaybackManager();
    if (!pm) return null;
    if (typeof pm.getCurrentItem === 'function') return pm.getCurrentItem();
    if (typeof pm.currentItem === 'function') return pm.currentItem();
    return pm.currentItem || pm._currentItem || null;
  };
  /**
   * Gets the current item ID from playback manager, DOM, or URL.
   * Jellyfin item IDs are 32 hex characters.
   */
  const getCurrentItemId = () => {
    // Method 1: Try Jellyfin's internal playback tracking
    // Check various Jellyfin globals for current playing item
    try {
      // Try window.NowPlayingItem (set by some Jellyfin versions)
      if (window.NowPlayingItem?.Id) return window.NowPlayingItem.Id;

      // Try Emby.Page for current item context
      if (window.Emby?.Page?.currentItem?.Id) return window.Emby.Page.currentItem.Id;

      // Try getting from appRouter's current view
      if (window.appRouter?.currentRouteInfo?.options?.item?.Id) {
        return window.appRouter.currentRouteInfo.options.item.Id;
      }

      // Try sessionStorage for playback info
      const playbackInfo = sessionStorage.getItem('playbackInfo');
      if (playbackInfo) {
        const info = JSON.parse(playbackInfo);
        if (info?.ItemId && /^[a-f0-9]{32}$/i.test(info.ItemId)) return info.ItemId;
      }
    } catch (e) { /* ignore */ }

    // Method 2: Try playback manager
    const pm = getPlaybackManager();
    if (pm) {
      const item = getCurrentItem();
      if (item?.Id) return item.Id;
    }

    // Method 3: Check video OSD for title element with data attributes
    const titleEl = document.querySelector('.osdTitle[data-id], .videoOsdTitle[data-id], [class*="osd"] [data-id]');
    if (titleEl?.dataset?.id && /^[a-f0-9]{32}$/i.test(titleEl.dataset.id)) {
      return titleEl.dataset.id;
    }

    // Method 4: Check the page for any visible item ID in data attributes
    const itemIdEl = document.querySelector('.videoOsd [data-itemid], .videoOsdBottom [data-itemid]');
    if (itemIdEl?.dataset?.itemid && /^[a-f0-9]{32}$/i.test(itemIdEl.dataset.itemid)) {
      return itemIdEl.dataset.itemid;
    }

    // Method 5: Parse from current URL hash
    const hash = window.location.hash || '';
    const patterns = [
      /[?&]id=([a-f0-9]{32})/i,
      /\/items\/([a-f0-9]{32})/i,
      /\/videos\/([a-f0-9]{32})/i,
      /id=([a-f0-9]{32})/i
    ];
    for (const pattern of patterns) {
      const match = hash.match(pattern);
      if (match) return match[1];
    }

    return null;
  };
  const getItemImageUrl = (itemId, imageTag) => {
    if (!itemId || !window.ApiClient) return '';
    const serverUrl = window.ApiClient._serverAddress || window.ApiClient.serverAddress?.() || '';
    if (!serverUrl) return '';
    let url = `${serverUrl}/Items/${itemId}/Images/Primary?quality=90`;
    if (imageTag) url += `&tag=${imageTag}`;
    return url;
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

  // P-JS03 fix: Use static entity map instead of DOM creation for HTML escaping
  const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  const escapeHtml = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
  };

  /**
   * Send a single log entry to the server.
   */
  const sendLog = (entry) => {
    if (!state.ws || state.ws.readyState !== 1) return false;
    try {
      state.ws.send(JSON.stringify({
        type: 'client_log',
        payload: { category: entry.category, message: entry.message },
        ts: entry.ts
      }));
      return true;
    } catch (e) {
      console.warn('[OWP] Failed to send log:', e.message);
      return false;
    }
  };

  /**
   * Flush all buffered logs to the server.
   * Called when WebSocket connects.
   */
  const flushLogBuffer = () => {
    if (!state.ws || state.ws.readyState !== 1) return;
    while (state.logBuffer.length > 0) {
      const entry = state.logBuffer.shift();
      if (!sendLog(entry)) {
        // Put it back if send failed
        state.logBuffer.unshift(entry);
        break;
      }
    }
  };

  /**
   * Structured debug logging for sync analysis.
   * Format: [OWP:{CATEGORY}] key=value key=value ...
   * Categories: CLOCK, HOST, CLIENT, SYNC, VIDEO
   * Logs are buffered if WebSocket not connected, then flushed when connected.
   */
  const log = (category, data) => {
    const parts = Object.entries(data).map(([k, v]) => {
      if (typeof v === 'number') {
        // Format numbers: positions as Xs, timestamps as ms, rates as Xx
        if (k.includes('pos') || k === 'actual' || k === 'expected' || k === 'drift') {
          return `${k}=${v.toFixed(2)}s`;
        }
        if (k === 'rate') {
          return `${k}=${v.toFixed(2)}x`;
        }
        if (k.includes('offset') || k.includes('delay') || k.includes('rtt')) {
          return `${k}=${v >= 0 ? '+' : ''}${Math.round(v)}ms`;
        }
        return `${k}=${v}`;
      }
      return `${k}=${v}`;
    });
    const message = parts.join(' ');
    console.log(`[OWP:${category}] ${message}`);

    const logEntry = { category, message, ts: nowMs() };

    // If connected, flush buffer first then send this log
    if (state.ws && state.ws.readyState === 1) {
      flushLogBuffer();
      sendLog(logEntry);
    } else {
      // Buffer the log (with size limit to prevent memory issues)
      if (state.logBuffer.length < state.logBufferMax) {
        state.logBuffer.push(logEntry);
      }
    }
  };

  OWP.utils = {
    nowMs,
    shouldSend,
    suppress,
    getVideo,
    isVideoReady,
    isBuffering,
    isSeeking,
    startSyncing,
    getPlaybackManager,
    getCurrentItem,
    getCurrentItemId,
    getItemImageUrl,
    isHomeView,
    getServerNow,
    adjustedPosition,
    scheduleAt,
    escapeHtml,
    log,
    flushLogBuffer
  };
})();
