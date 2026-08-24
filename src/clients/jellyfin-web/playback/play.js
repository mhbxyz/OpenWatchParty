(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const utils = OWP.utils;

  const tryPlayMethods = async (pm, item, isCurrent = () => true) => {
    const playOptions = { startPositionTicks: 0 };
    const errors = [];
    if (typeof pm.play === 'function') {
      if (!isCurrent()) return { success: false, cancelled: true, errors };
      try {
        await Promise.resolve(pm.play({ items: [item], ...playOptions }));
        console.log('[OpenWatchParty] Playback started via pm.play({ items })');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'play({ items })', error: err.message });
      }
      if (!isCurrent()) return { success: false, cancelled: true, errors };
      try {
        await Promise.resolve(pm.play({ item: item, ...playOptions }));
        console.log('[OpenWatchParty] Playback started via pm.play({ item })');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'play({ item })', error: err.message });
      }
      if (!isCurrent()) return { success: false, cancelled: true, errors };
      const itemId = item?.Id || item?.id;
      if (itemId) {
        try {
          await Promise.resolve(pm.play({ ids: [itemId], ...playOptions }));
          console.log('[OpenWatchParty] Playback started via pm.play({ ids })');
          return { success: true, errors };
        } catch (err) {
          errors.push({ method: 'play({ ids })', error: err.message });
        }
      }
    }
    if (!isCurrent()) return { success: false, cancelled: true, errors };
    if (typeof pm.playItems === 'function') {
      try {
        await Promise.resolve(pm.playItems([item], 0));
        console.log('[OpenWatchParty] Playback started via pm.playItems()');
        return { success: true, errors };
      } catch (err) {
        errors.push({ method: 'playItems()', error: err.message });
      }
    }
    return { success: false, errors };
  };

  const playItem = async (item, { isCurrent = () => true, silent = false } = {}) => {
    const pm = utils.getPlaybackManager();
    if (!pm) {
      console.warn('[OpenWatchParty] Playback failed: PlaybackManager not available');
      return false;
    }
    const result = await tryPlayMethods(pm, item, isCurrent);
    if (!result.success && !result.cancelled && !silent) {
      console.error('[OpenWatchParty] All playback methods failed:', result.errors);
      if (OWP.ui && OWP.ui.showToast) {
        OWP.ui.showToast('Failed to start playback. Try refreshing the page.');
      }
    }
    return result.success;
  };

  const ensurePlayback = async (itemId, attempt = 0, expectedRequestAttempt = null, force = false) => {
    const state = OWP.state;
    if (!state.inRoom || !itemId || !window.ApiClient) return false;
    if (!force && utils.getCurrentItemId() === itemId) return true;
    if (!force && state.joiningItemId === itemId && expectedRequestAttempt === null) return false;
    const requestAttempt = expectedRequestAttempt ?? ++state.playbackRequestAttempt;
    if (requestAttempt !== state.playbackRequestAttempt) return false;
    const userId = ApiClient.getCurrentUserId?.() || ApiClient._currentUserId;
    if (!userId) {
      if (attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500);
      }
      return false;
    }
    state.joiningItemId = itemId;
    try {
      const item = await ApiClient.getItem(userId, itemId);
      if (requestAttempt !== state.playbackRequestAttempt || !state.inRoom) return false;
      const isCurrent = () => requestAttempt === state.playbackRequestAttempt && state.inRoom;
      const success = await playItem(item, { isCurrent, silent: attempt < 5 });
      if (!isCurrent()) return false;
      if (!success && attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500);
      }
      return success;
    } catch (err) {
      if (requestAttempt === state.playbackRequestAttempt && state.inRoom && attempt < 5) {
        setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500);
      }
      return false;
    } finally {
      if (requestAttempt === state.playbackRequestAttempt) state.joiningItemId = '';
    }
  };

  Object.assign(playback, { tryPlayMethods, playItem, ensurePlayback });
})();
