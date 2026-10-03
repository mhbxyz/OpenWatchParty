(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const utils = OWP.utils = OWP.utils || {};

  const getCurrentItem = () => {
    const pm = utils.getPlaybackManager();
    if (!pm) return null;
    if (typeof pm.getCurrentItem === 'function') return pm.getCurrentItem();
    if (typeof pm.currentItem === 'function') return pm.currentItem();
    return pm.currentItem || pm._currentItem || null;
  };

  const getItemIdFromGlobals = () => {
    try {
      if (window.NowPlayingItem?.Id) return window.NowPlayingItem.Id;
      if (window.Emby?.Page?.currentItem?.Id) return window.Emby.Page.currentItem.Id;
      if (window.appRouter?.currentRouteInfo?.options?.item?.Id) {
        return window.appRouter.currentRouteInfo.options.item.Id;
      }
      const playbackInfo = sessionStorage.getItem('playbackInfo');
      if (playbackInfo) {
        const info = JSON.parse(playbackInfo);
        if (info?.ItemId && /^[a-f0-9]{32}$/i.test(info.ItemId)) return info.ItemId;
      }
    } catch (e) { /* ignore */ }
    const pm = utils.getPlaybackManager();
    if (pm) {
      const item = getCurrentItem();
      if (item?.Id) return item.Id;
    }
    return null;
  };

  const getItemIdFromDom = () => {
    const titleEl = document.querySelector('.osdTitle[data-id], .videoOsdTitle[data-id], [class*="osd"] [data-id]');
    if (titleEl?.dataset?.id && /^[a-f0-9]{32}$/i.test(titleEl.dataset.id)) {
      return titleEl.dataset.id;
    }
    const itemIdEl = document.querySelector('.videoOsd [data-itemid], .videoOsdBottom [data-itemid]');
    if (itemIdEl?.dataset?.itemid && /^[a-f0-9]{32}$/i.test(itemIdEl.dataset.itemid)) {
      return itemIdEl.dataset.itemid;
    }
    return null;
  };

  const getItemIdFromUrl = () => {
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

  const getCurrentItemId = () => {
    return getItemIdFromGlobals() || getItemIdFromDom() || getItemIdFromUrl() || null;
  };

  const ITEM_ID_RE = /^[a-f0-9]{32}$/i;

  // Jellyfin keeps the last player page in the DOM, hidden as `.page.hide`,
  // and its OSD still carries the previous item's id.
  const firstOnVisiblePage = (selector) => [...document.querySelectorAll(selector)]
    .find(element => typeof element.closest !== 'function' || !element.closest('.page.hide')) || null;

  // The item the player is actually playing, or null. Unlike getCurrentItemId,
  // it never falls back to the page being browsed (route item, URL) or to a
  // hidden player page, which name something that is not playing.
  const getPlayingItemId = () => {
    if (!utils.getVideo()) return null;
    try {
      if (window.NowPlayingItem?.Id) return window.NowPlayingItem.Id;
    } catch (e) { /* ignore */ }
    const item = getCurrentItem();
    if (item?.Id) return item.Id;
    const titleEl = firstOnVisiblePage('.osdTitle[data-id], .videoOsdTitle[data-id], [class*="osd"] [data-id]');
    if (ITEM_ID_RE.test(titleEl?.dataset?.id || '')) return titleEl.dataset.id;
    const itemIdEl = firstOnVisiblePage('.videoOsd [data-itemid], .videoOsdBottom [data-itemid]');
    if (ITEM_ID_RE.test(itemIdEl?.dataset?.itemid || '')) return itemIdEl.dataset.itemid;
    return null;
  };

  Object.assign(utils, { getCurrentItem, getCurrentItemId, getPlayingItemId });
})();
