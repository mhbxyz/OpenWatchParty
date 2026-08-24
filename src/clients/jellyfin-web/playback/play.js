(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const utils = OWP.utils;

  const tryPlayMethods = (pm, item) => {
    const playOptions = { startPositionTicks: 0 };
    const errors = [];
    if (typeof pm.play === 'function') {
      try {
        pm.play({ items: [item], ...playOptions });
        console.log('[OpenWatchParty] Playback started via pm.play({ items })');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'play({ items })', error: err.message });
      }
      try {
        pm.play({ item: item, ...playOptions });
        console.log('[OpenWatchParty] Playback started via pm.play({ item })');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'play({ item })', error: err.message });
      }
      const itemId = item?.Id || item?.id;
      if (itemId) {
        try {
          pm.play({ ids: [itemId], ...playOptions });
          console.log('[OpenWatchParty] Playback started via pm.play({ ids })');
          return { success: true, errors };
        } catch (err) {
          errors.push({ method: 'play({ ids })', error: err.message });
        }
      }
    }
    if (typeof pm.playItems === 'function') {
      try {
        pm.playItems([item], 0);
        console.log('[OpenWatchParty] Playback started via pm.playItems()');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'playItems()', error: err.message });
      }
    }
    return { success: false, errors };
  };

  const playItem = (item) => {
    const pm = utils.getPlaybackManager();
    if (!pm) {
      console.warn('[OpenWatchParty] Playback failed: PlaybackManager not available');
      return false;
    }
    const result = tryPlayMethods(pm, item);
    if (!result.success) {
      console.error('[OpenWatchParty] All playback methods failed:', result.errors);
      if (OWP.ui && OWP.ui.showToast) {
        OWP.ui.showToast('Failed to start playback. Try refreshing the page.');
      }
    }
    return result.success;
  };

  const ensurePlayback = (itemId, attempt = 0, expectedRequestAttempt = null) => {
    const state = OWP.state;
    if (!state.inRoom || !itemId || !window.ApiClient) return;
    if (utils.getCurrentItemId() === itemId) return;
    if (state.joiningItemId === itemId && expectedRequestAttempt === null) return;
    const requestAttempt = expectedRequestAttempt ?? ++state.playbackRequestAttempt;
    if (requestAttempt !== state.playbackRequestAttempt) return;
    const userId = ApiClient.getCurrentUserId?.() || ApiClient._currentUserId;
    if (!userId) {
      if (attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt), 500);
      }
      return;
    }
    state.joiningItemId = itemId;
    ApiClient.getItem(userId, itemId).then((item) => {
      if (requestAttempt !== state.playbackRequestAttempt || !state.inRoom) return;
      if (!playItem(item) && attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt), 500);
      }
    }).catch(() => {
      if (requestAttempt === state.playbackRequestAttempt && state.inRoom && attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt), 500);
      }
    }).finally(() => {
      if (requestAttempt === state.playbackRequestAttempt) state.joiningItemId = '';
    });
  };

  Object.assign(playback, { playItem, ensurePlayback });
})();
