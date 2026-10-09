(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const t = OWP.i18n.t;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  const drawRoomList = (roomList) => {
    if (state.rooms.length === 0) {
      const empty = createElement('div', 'owp-room-empty', t('noActiveRooms'));
      roomList.replaceChildren(empty);
      return;
    }
    roomList.replaceChildren();
    state.rooms.forEach(room => {
      const item = createElement('div', 'owp-room-item');
      const details = createElement('div');
      const name = createElement('div', 'owp-room-title', OWP.i18n.localizeRoomName(room.name));
      const count = createElement('div', 'owp-room-count', t('user', { count: room.count }));
      details.append(name, count);
      if (!room.media_id) {
        const noMedia = createElement('div', 'owp-room-note', t('noMedia'));
        details.appendChild(noMedia);
      }
      const join = createElement('button', 'owp-btn secondary', t('join'));
      join.dataset.roomId = String(room.id);
      item.append(details, join);
      item.onclick = () => {
        // A room without media has nothing to start here. From the player,
        // joining still syncs whatever is playing.
        if (!room.media_id && !OWP.utils?.getPlayingItemId?.()) {
          ui.showToast(t('noMediaJoinHint'));
          return;
        }
        if (OWP.actions && OWP.actions.joinRoom) OWP.actions.joinRoom(room.id);
      };
      roomList.appendChild(item);
    });
  };

  // The list is drawn again on every room list update. Keyboard focus on a
  // Join button goes back to the same room's button, or to the panel's first
  // control once that room is gone, instead of falling out of the panel.
  const restoreRoomListFocus = (roomList, roomId) => {
    const same = roomId && Array.from(roomList.querySelectorAll('button')).find(button => button.dataset.roomId === roomId);
    if (same) {
      same.focus({ preventScroll: true });
      return;
    }
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    if (panel && panel.contains(roomList) && ui.focusPanelStart) ui.focusPanelStart(panel);
  };

  const updateRoomListUI = () => {
    const roomList = document.getElementById('owp-room-list');
    if (!roomList) return;
    const active = document.activeElement;
    const focusInside = !!active && active !== roomList && typeof roomList.contains === 'function' && roomList.contains(active);
    const focusedRoomId = focusInside && active.dataset ? active.dataset.roomId || '' : '';
    drawRoomList(roomList);
    if (focusInside) restoreRoomListFocus(roomList, focusedRoomId);
  };

  // The head count is a badge of its own in the image's corner, not Jellyfin's
  // innerCardFooter: themes restyle that one for progress bars (ElegantFin
  // stretches it over the whole image and lifts the text into the middle).
  const fillCountBadge = (badge, count) => {
    const icon = createElement('span', 'material-icons', 'groups');
    icon.setAttribute('aria-hidden', 'true');
    badge.replaceChildren(icon, createElement('span', 'owp-card-count-text', ` ${t('watching', { count })}`));
  };

  const updateRoomCardCount = (card, count) => {
    card.dataset.count = String(count);
    const badge = card.querySelector('.owp-card-count');
    if (badge) fillCountBadge(badge, count);
  };

  // Same markup and classes as Jellyfin's landscape home cards ("Continue
  // Watching"), with no colours of its own, so the row matches its neighbours
  // and follows the active theme.
  const buildCardContent = (room, index) => {
    const box = createElement('div', 'cardBox cardBox-bottompadded');
    const scalable = createElement('div', 'cardScalable');
    const padder = createElement('div', 'cardPadder cardPadder-overflowBackdrop');
    const cardIcon = createElement('span', 'cardImageIcon material-icons groups owp-card-icon');
    cardIcon.setAttribute('aria-hidden', 'true');
    padder.appendChild(cardIcon);

    const image = createElement('div', `cardImageContainer coveredImage cardContent defaultCardBackground defaultCardBackground${(index % 5) + 1} owp-card-image-container`);
    const count = createElement('div', 'owp-card-count');
    fillCountBadge(count, room.count);
    image.appendChild(count);

    const overlay = createElement('div', 'cardOverlayContainer itemAction');
    const join = createElement('button', 'cardOverlayButton cardOverlayButton-hover cardOverlayFab-primary owp-join-btn paper-icon-button-light');
    join.title = t('join');
    join.setAttribute('aria-label', t('join'));
    const playIcon = createElement('span', 'material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover play_arrow');
    playIcon.setAttribute('aria-hidden', 'true');
    join.appendChild(playIcon);
    overlay.appendChild(join);
    scalable.append(padder, image, overlay);

    const name = createElement('div', 'cardText cardTextCentered cardText-first owp-card-name');
    name.appendChild(createElement('bdi', '', OWP.i18n.localizeRoomName(room.name)));
    const media = createElement('div', 'cardText cardTextCentered cardText-secondary owp-card-media');
    media.appendChild(createElement('bdi', 'owp-media-title', room.media_id ? t('loading') : t('noMedia')));
    box.append(scalable, name, media);
    return box;
  };

  // Landscape art, in the order Jellyfin's "Continue Watching" picks it by
  // default: the item's thumb, then the series' thumb, then a backdrop (its own,
  // then the series' one), and the item's own image last, cropped to fit. An
  // episode's own image is a frame of it, often dark and hard to place.
  const landscapeImage = (item, mediaId) => {
    const tags = item.ImageTags || {};
    if (tags.Thumb) return { id: mediaId, type: 'Thumb', tag: tags.Thumb };
    if (item.ParentThumbItemId && item.ParentThumbImageTag) {
      return { id: item.ParentThumbItemId, type: 'Thumb', tag: item.ParentThumbImageTag };
    }
    if (item.BackdropImageTags?.length) return { id: mediaId, type: 'Backdrop', tag: item.BackdropImageTags[0] };
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
      return { id: item.ParentBackdropItemId, type: 'Backdrop', tag: item.ParentBackdropImageTags[0] };
    }
    if (tags.Primary) return { id: mediaId, type: 'Primary', tag: tags.Primary };
    return null;
  };

  const attachMediaInfo = (card, mediaId) => {
    if (!mediaId || !window.ApiClient) return;
    const userId = window.ApiClient.getCurrentUserId?.() || window.ApiClient._currentUserId;
    if (!userId) return;
    window.ApiClient.getItem(userId, mediaId).then(item => {
      const titleEl = card.querySelector('.owp-media-title');
      if (titleEl && item?.Name) {
        titleEl.textContent = item.Name;
      }
      const containerEl = card.querySelector('.owp-card-image-container');
      const iconEl = card.querySelector('.owp-card-icon');
      const image = item ? landscapeImage(item, mediaId) : null;
      if (containerEl && image) {
        const serverUrl = window.ApiClient._serverAddress || window.ApiClient.serverAddress?.() || '';
        const imageUrl = `${serverUrl}/Items/${encodeURIComponent(image.id)}/Images/${image.type}`
          + `?fillWidth=480&fillHeight=270&quality=96&tag=${encodeURIComponent(image.tag)}`;
        // Only once the art has loaded: until then, or if it never does, the
        // card keeps its placeholder background and icon.
        const art = new Image();
        art.onload = () => {
          containerEl.style.backgroundImage = `url("${imageUrl}")`;
          // Jellyfin's cards with art carry no placeholder background. Keeping
          // it lets a theme's `background` shorthand (ElegantFin) reset its
          // size, and the art shows at full size from its top left corner.
          containerEl.className = containerEl.className.split(/\s+/)
            .filter(name => !/^defaultCardBackground\d*$/.test(name)).join(' ');
          if (iconEl) iconEl.style.display = 'none';
        };
        art.src = imageUrl;
      }
    }).catch(() => {
      const titleEl = card.querySelector('.owp-media-title');
      if (titleEl) titleEl.textContent = t('unknown');
    });
  };

  const attachCardHandlers = (card, room) => {
    const joinBtn = card.querySelector('.owp-join-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[OpenWatchParty] Play button clicked for room:', room.id, 'media:', room.media_id);
        if (!room.media_id) {
          ui.showToast(t('noMediaInRoom'));
          return;
        }
        state.pendingJoinRoomId = room.id;
        console.log('[OpenWatchParty] Set pendingJoinRoomId:', room.id);
        const serverId = window.ApiClient?.serverId?.() || window.ApiClient?._serverInfo?.Id || '';
        console.log('[OpenWatchParty] Navigating to details page');
        const detailsUrl = `#/details?id=${room.media_id}&serverId=${serverId}`;
        window.location.hash = detailsUrl;
        let attempts = 0;
        const maxAttempts = 50;
        const roomId = room.id;
        const cardPollAttempt = ++state.cardPollAttempt;
        const checkInterval = OWP.timers.setInterval(() => {
          if (cardPollAttempt !== state.cardPollAttempt || state.pendingJoinRoomId !== roomId) {
            OWP.timers.clear(checkInterval);
            return;
          }
          attempts++;
          // The play button of this item's own details page: a hidden page of
          // an earlier item can come first in the document.
          const playBtn = OWP.playback?.findDetailsPlayButton?.(room.media_id);
          if (playBtn) {
            console.log('[OpenWatchParty] Play button found and page ready, clicking it');
            OWP.timers.clear(checkInterval);
            playBtn.click();
          } else if (attempts >= maxAttempts) {
            console.log('[OpenWatchParty] Play button not found or page not ready after 5s, giving up');
            OWP.timers.clear(checkInterval);
          }
        }, 100, 'ui');
      });
    }
    card.addEventListener('click', (e) => {
      if (e.target.closest('.owp-join-btn')) return;
      if (room.media_id && window.Emby && window.Emby.Page) {
        window.Emby.Page.show('/details?id=' + room.media_id);
      }
    });
  };

  const createRoomCard = (room, index) => {
    const card = document.createElement('div');
    card.className = 'card overflowBackdropCard card-hoverable card-withuserdata owp-room-card';
    card.dataset.index = String(index);
    card.dataset.roomId = String(room.id);
    card.dataset.mediaId = String(room.media_id || '');
    card.dataset.count = String(room.count);
    card.replaceChildren(buildCardContent(room, index));
    attachMediaInfo(card, room.media_id);
    attachCardHandlers(card, room);
    return card;
  };

  Object.assign(ui, { updateRoomListUI, createRoomCard, updateRoomCardCount });
})();
