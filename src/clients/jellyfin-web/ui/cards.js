(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const utils = OWP.utils;

  const updateRoomListUI = () => {
    const roomList = document.getElementById('owp-room-list');
    if (!roomList) return;
    if (state.rooms.length === 0) {
      roomList.innerHTML = '<div style="font-size:12px; color:#555; padding: 10px; text-align:center;">No active rooms.</div>';
      return;
    }
    roomList.innerHTML = '';
    state.rooms.forEach(room => {
      const item = document.createElement('div');
      item.className = 'owp-room-item';
      item.innerHTML = `<div><div style="font-weight:bold">${utils.escapeHtml(room.name)}</div><div style="font-size:10px; color:#888">${room.count} users</div></div><button class="owp-btn secondary">Join</button>`;
      item.onclick = () => {
        if (OWP.actions && OWP.actions.joinRoom) OWP.actions.joinRoom(room.id);
      };
      roomList.appendChild(item);
    });
  };

  const buildCardHtml = (room) => {
    return `
      <div class="cardBox cardBox-bottompadded">
        <div class="cardScalable">
          <div class="cardPadder cardPadder-overflowPortrait">
            <span class="cardImageIcon material-icons groups owp-card-icon" aria-hidden="true"></span>
          </div>
          <div class="cardImageContainer coveredImage cardContent owp-card-image-container" style="background-color:#1a1a1a;">
            <div class="innerCardFooter">
              <div class="cardText" style="color:#69f0ae;font-weight:600;">
                <span class="material-icons" style="font-size:14px;vertical-align:middle;">groups</span>
                ${room.count} watching
              </div>
            </div>
          </div>
          <div class="cardOverlayContainer itemAction">
            <button class="cardOverlayButton cardOverlayButton-hover cardOverlayFab-primary owp-join-btn paper-icon-button-light">
              <span class="material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover play_arrow" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <div class="cardText cardTextCentered cardText-first owp-card-name">
          <bdi>${utils.escapeHtml(room.name)}</bdi>
        </div>
        <div class="cardText cardTextCentered cardText-secondary owp-card-media">
          <bdi class="owp-media-title">${room.media_id ? 'Loading...' : 'No media'}</bdi>
        </div>
      </div>
    `;
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
    card.dataset.index = index;
    card.dataset.roomId = room.id;
    card.dataset.mediaId = room.media_id || '';
    card.dataset.count = room.count;
    card.innerHTML = buildCardHtml(room);
    attachMediaInfo(card, room.media_id);
    attachCardHandlers(card, room);
    return card;
  };

  Object.assign(ui, { updateRoomListUI, createRoomCard });
})();
