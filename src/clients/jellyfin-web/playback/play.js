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

  const ITEM_ID_RE = /^[a-f0-9]{32}$/i;

  // The play button of this item's details page. Jellyfin keeps the pages it
  // showed before in the DOM, hidden as `.page.hide`, so the first play button
  // in the document can belong to a details page of another item.
  const findDetailsPlayButton = (itemId) => {
    if (!ITEM_ID_RE.test(itemId) || typeof document.querySelectorAll !== 'function') return null;
    for (const page of document.querySelectorAll('.page:not(.hide)')) {
      if (!page.querySelector(`.mainDetailButtons [data-id="${itemId}"]`)) continue;
      const button = page.querySelector('.mainDetailButtons .btnPlay:not(.hide)');
      if (button) return button;
    }
    return null;
  };

  const launchViaDetailsPage = (item, isCurrent = () => true) => {
    const itemId = item?.Id || item?.id;
    if (!itemId || !OWP.state.inRoom || !isCurrent() || !window.location || !document.querySelector) {
      return false;
    }
    const encodedId = encodeURIComponent(itemId);
    if (!(window.location.hash || '').includes(`/details?id=${encodedId}`)) {
      // Leaving the player removes its video: the lifecycle check must not
      // take that for the user closing the player and leave the room.
      OWP.state.mediaSwitchUntil = Date.now() + OWP.constants.MEDIA_SWITCH_GRACE_MS;
      window.location.hash = `#/details?id=${encodedId}`;
    }
    let attempts = 0;
    const clickOfficialPlay = () => {
      if (!OWP.state.inRoom || !isCurrent()) return;
      if (OWP.utils.getPlayingItemId?.() === itemId) return;
      const button = findDetailsPlayButton(itemId);
      if (button) {
        button.click();
        return;
      }
      if (++attempts < 50) OWP.timers.setTimeout(clickOfficialPlay, 100, 'media');
    };
    clickOfficialPlay();
    return true;
  };

  const playItem = async (item, { isCurrent = () => true, silent = false } = {}) => {
    const pm = utils.getPlaybackManager();
    if (!pm) {
      return launchViaDetailsPage(item, isCurrent);
    }
    const result = await tryPlayMethods(pm, item, isCurrent);
    if (!result.success && !result.cancelled && launchViaDetailsPage(item, isCurrent)) {
      return true;
    }
    if (!result.success && !result.cancelled && !silent) {
      console.error('[OpenWatchParty] All playback methods failed:', result.errors);
      if (OWP.ui && OWP.ui.showToast) {
        OWP.ui.showToast('Failed to start playback. Try refreshing the page.');
      }
    }
    return result.success;
  };

  const safePlay = async (video, context = 'synchronization') => {
    if (!video || typeof video.play !== 'function') return false;
    const actionAttempt = OWP.state.playbackActionAttempt;
    const roomId = OWP.state.roomId;
    const isCurrent = () => OWP.state.inRoom
      && OWP.state.roomId === roomId
      && OWP.state.playbackActionAttempt === actionAttempt;
    try {
      await video.play();
      if (!isCurrent()) return false;
      const state = OWP.state;
      state.playbackBlocked = false;
      state.playbackFailureNotified = false;
      if (state.syncStatus === 'blocked') state.syncStatus = 'syncing';
      if (OWP.ui?.updateSyncIndicator) OWP.ui.updateSyncIndicator();
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      const state = OWP.state;
      console.error(`[OpenWatchParty] Playback failed during ${context}:`, err);
      state.playbackBlocked = true;
      state.syncStatus = 'blocked';
      state.pendingPlayUntil = 0;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (OWP.ui?.updateSyncIndicator) OWP.ui.updateSyncIndicator();
      if (!state.playbackFailureNotified && OWP.ui?.showToast) {
        state.playbackFailureNotified = true;
        OWP.ui.showToast('Playback was blocked. Press Play in Jellyfin to continue.');
      }
      return false;
    }
  };

  const markPlaybackResumed = () => {
    const state = OWP.state;
    if (!state.playbackBlocked) return;
    state.playbackBlocked = false;
    state.playbackFailureNotified = false;
    state.syncStatus = state.inRoom && !state.isHost ? 'syncing' : 'synced';
    if (OWP.ui?.updateSyncIndicator) OWP.ui.updateSyncIndicator();
  };

  const ensurePlayback = async (itemId, attempt = 0, expectedRequestAttempt = null, force = false) => {
    const state = OWP.state;
    if (!state.inRoom || !itemId || !window.ApiClient) return false;
    // Only media that is actually playing counts as started, not the item of
    // the page being browsed (a details page names it while nothing plays).
    if (!force && utils.getPlayingItemId?.() === itemId) return true;
    if (!force && state.joiningItemId === itemId && expectedRequestAttempt === null) return false;
    const requestAttempt = expectedRequestAttempt ?? ++state.playbackRequestAttempt;
    if (requestAttempt !== state.playbackRequestAttempt) return false;
    const userId = ApiClient.getCurrentUserId?.() || ApiClient._currentUserId;
    if (!userId) {
      if (attempt < 5) {
        OWP.timers.setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500, 'media');
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
        OWP.timers.setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500, 'media');
      }
      return success;
    } catch (err) {
      if (requestAttempt === state.playbackRequestAttempt && state.inRoom && attempt < 5) {
        OWP.timers.setTimeout(() => ensurePlayback(itemId, attempt + 1, requestAttempt, force), 500, 'media');
      }
      return false;
    } finally {
      if (requestAttempt === state.playbackRequestAttempt) state.joiningItemId = '';
    }
  };

  Object.assign(playback, {
    tryPlayMethods,
    findDetailsPlayButton,
    launchViaDetailsPage,
    playItem,
    safePlay,
    markPlaybackResumed,
    ensurePlayback
  });
})();
