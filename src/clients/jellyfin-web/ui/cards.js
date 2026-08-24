(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  const updateRoomListUI = () => {
    const roomList = document.getElementById('owp-room-list');
    if (!roomList) return;
    if (state.rooms.length === 0) {
      const empty = createElement('div', '', 'No active rooms.');
      empty.style.cssText = 'font-size:12px; color:#555; padding: 10px; text-align:center;';
      roomList.replaceChildren(empty);
      return;
    }
    roomList.replaceChildren();
    state.rooms.forEach(room => {
      const item = createElement('div', 'owp-room-item');
      const details = createElement('div');
      const name = createElement('div', '', room.name);
      name.style.fontWeight = 'bold';
      const count = createElement('div', '', `${String(room.count)} users`);
      count.style.cssText = 'font-size:10px; color:#888';
      details.append(name, count);
      const join = createElement('button', 'owp-btn secondary', 'Join');
      item.append(details, join);
      item.onclick = () => {
        if (OWP.actions && OWP.actions.joinRoom) OWP.actions.joinRoom(room.id);
      };
      roomList.appendChild(item);
    });
  };

  const buildCardContent = (room) => {
    const box = createElement('div', 'cardBox cardBox-bottompadded');
    const scalable = createElement('div', 'cardScalable');
    const padder = createElement('div', 'cardPadder cardPadder-overflowPortrait');
    const cardIcon = createElement('span', 'cardImageIcon material-icons groups owp-card-icon');
    cardIcon.setAttribute('aria-hidden', 'true');
    padder.appendChild(cardIcon);

    const image = createElement('div', 'cardImageContainer coveredImage cardContent owp-card-image-container');
    image.style.backgroundColor = '#1a1a1a';
    const footer = createElement('div', 'innerCardFooter');
    const count = createElement('div', 'cardText');
    count.style.cssText = 'color:#69f0ae;font-weight:600;';
    const countIcon = createElement('span', 'material-icons', 'groups');
    countIcon.style.cssText = 'font-size:14px;vertical-align:middle;';
    count.append(countIcon, document.createTextNode(` ${String(room.count)} watching`));
    footer.appendChild(count);
    image.appendChild(footer);

    const overlay = createElement('div', 'cardOverlayContainer itemAction');
    const join = createElement('button', 'cardOverlayButton cardOverlayButton-hover cardOverlayFab-primary owp-join-btn paper-icon-button-light');
    const playIcon = createElement('span', 'material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover play_arrow');
    playIcon.setAttribute('aria-hidden', 'true');
    join.appendChild(playIcon);
    overlay.appendChild(join);
    scalable.append(padder, image, overlay);

    const name = createElement('div', 'cardText cardTextCentered cardText-first owp-card-name');
    name.appendChild(createElement('bdi', '', room.name));
    const media = createElement('div', 'cardText cardTextCentered cardText-secondary owp-card-media');
    media.appendChild(createElement('bdi', 'owp-media-title', room.media_id ? 'Loading...' : 'No media'));
    box.append(scalable, name, media);
    return box;
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
      if (containerEl && item?.ImageTags?.Primary) {
        const serverUrl = window.ApiClient._serverAddress || window.ApiClient.serverAddress?.() || '';
        const imageUrl = `${serverUrl}/Items/${mediaId}/Images/Primary?fillHeight=237&fillWidth=158&quality=96&tag=${item.ImageTags.Primary}`;
        containerEl.style.backgroundImage = `url("${imageUrl}")`;
        if (iconEl) iconEl.style.display = 'none';
      }
    }).catch(() => {
      const titleEl = card.querySelector('.owp-media-title');
      if (titleEl) titleEl.textContent = 'Unknown';
    });
  };

  const attachCardHandlers = (card, room) => {
    const joinBtn = card.querySelector('.owp-join-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[OpenWatchParty] Play button clicked for room:', room.id, 'media:', room.media_id);
        if (!room.media_id) {
          ui.showToast('No media in this room');
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
          const itemName = document.querySelector('.itemName bdi');
          const playBtn = document.querySelector('.mainDetailButtons .btnPlay, .mainDetailButtons button[data-action="resume"], .mainDetailButtons button[data-action="play"]');
          if (playBtn && itemName && itemName.textContent.trim()) {
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
    card.className = 'card overflowPortraitCard card-hoverable card-withuserdata owp-room-card';
    card.dataset.index = String(index);
    card.dataset.roomId = String(room.id);
    card.dataset.mediaId = String(room.media_id || '');
    card.dataset.count = String(room.count);
    card.replaceChildren(buildCardContent(room));
    attachMediaInfo(card, room.media_id);
    attachCardHandlers(card, room);
    return card;
  };

  Object.assign(ui, { updateRoomListUI, createRoomCard });
})();
