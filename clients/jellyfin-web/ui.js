(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.ui) return;

  const { PANEL_ID, BTN_ID, STYLE_ID, HOME_SECTION_ID, DEFAULT_WS_URL } = OWP.constants;
  const state = OWP.state;
  const utils = OWP.utils;

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; bottom: 100px; right: 20px; width: 300px; max-height: 450px;
        padding: 16px; border-radius: 12px; background: rgba(10, 10, 10, 0.98);
        backdrop-filter: blur(20px); color: #fff; font-family: sans-serif; z-index: 20000;
        border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 12px 40px rgba(0,0,0,0.8);
        display: flex; flex-direction: column;
      }
      #${PANEL_ID}.hide { display: none; }
      .owp-header { font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 8px; }
      .owp-section { margin-bottom: 15px; overflow-y: auto; }
      .owp-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
      .owp-room-item {
        background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 8px;
        display: flex; justify-content: space-between; align-items: center; cursor: pointer;
        border: 1px solid transparent; transition: all 0.2s;
      }
      .owp-room-item:hover { background: rgba(255,255,255,0.1); border-color: #1565c0; }
      .owp-btn {
        border: none; border-radius: 6px; padding: 10px 15px;
        background: #388e3c; color: #fff; cursor: pointer; font-weight: bold; font-size: 13px;
      }
      .owp-btn.secondary { background: #1565c0; }
      .owp-btn.danger { background: #d32f2f; }
      .owp-input {
        width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444;
        background: #000; color: #fff; box-sizing: border-box; margin-bottom: 10px; font-size: 14px;
      }
      .owp-footer { font-size: 10px; color: #555; text-align: center; margin-top: auto; padding-top: 10px; }
      .owp-select {
        width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #444;
        background: #000; color: #fff; box-sizing: border-box; font-size: 13px;
        cursor: pointer; appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M6 8L2 4h8z'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 10px center;
      }
      .owp-select:focus { border-color: #1565c0; outline: none; }
      .owp-checkbox-row {
        display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: #aaa;
      }
      .owp-checkbox-row input { accent-color: #388e3c; }
      /* UX-P3: Sync status indicator styles */
      .owp-sync-status { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-top: 8px; padding: 6px 8px; border-radius: 4px; background: rgba(255,255,255,0.05); }
      .owp-sync-dot { width: 8px; height: 8px; border-radius: 50%; }
      .owp-sync-dot.synced { background: #69f0ae; }
      .owp-sync-dot.syncing { background: #ffd740; animation: owp-pulse 1s infinite; }
      .owp-sync-dot.pending { background: #ff9800; animation: owp-pulse 0.5s infinite; }
      @keyframes owp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      .owp-sync-spinner { width: 12px; height: 12px; border: 2px solid #444; border-top-color: #ff9800; border-radius: 50%; animation: owp-spin 0.8s linear infinite; }
      @keyframes owp-spin { to { transform: rotate(360deg); } }
      /* Chat styles */
      #owp-chat-section { display: flex; flex-direction: column; height: 180px; border-top: 1px solid #333; margin-top: 10px; padding-top: 10px; }
      #owp-chat-messages { flex: 1; overflow-y: auto; padding: 4px 0; font-size: 12px; }
      .owp-chat-message { margin-bottom: 8px; padding: 4px 0; }
      .owp-chat-message.owp-chat-own .owp-chat-username { color: #69f0ae; }
      .owp-chat-meta { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
      .owp-chat-username { font-weight: bold; color: #64b5f6; font-size: 11px; }
      .owp-chat-time { font-size: 10px; color: #666; }
      .owp-chat-text { color: #ddd; word-wrap: break-word; line-height: 1.4; }
      #owp-chat-input-container { display: flex; gap: 8px; padding-top: 8px; border-top: 1px solid #333; }
      #owp-chat-input { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #444; background: #111; color: #fff; font-size: 12px; }
      #owp-chat-input:focus { border-color: #1565c0; outline: none; }
      #owp-chat-send { padding: 8px 12px; border-radius: 6px; border: none; background: #1565c0; color: #fff; cursor: pointer; font-size: 12px; }
      #owp-chat-send:hover { background: #1976d2; }
      .owp-chat-badge { display: none; background: #d32f2f; color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 10px; margin-left: 4px; }
    `;
    document.head.appendChild(style);
  };

  const updateStatusIndicator = () => {
    const el = document.getElementById('owp-ws-indicator');
    if (!el) return;
    const connected = state.ws && state.ws.readyState === 1;
    el.style.color = connected ? '#69f0ae' : '#ff5252';
    el.textContent = connected ? 'Online' : 'Offline';
  };

  /**
   * Update sync status indicator dynamically (UX-P3)
   */
  const updateSyncIndicator = () => {
    const el = document.getElementById('owp-sync-indicator');
    if (!el || state.isHost) return;

    const status = state.syncStatus || 'synced';
    let dotClass, label, showSpinner = false;

    if (status === 'pending_play') {
      dotClass = 'pending';
      const remaining = Math.max(0, (state.pendingPlayUntil - (Date.now() + (state.serverOffsetMs || 0))) / 1000);
      label = `Syncing playback... ${remaining.toFixed(1)}s`;
      showSpinner = true;
    } else if (status === 'syncing') {
      dotClass = 'syncing';
      label = 'Catching up...';
    } else {
      dotClass = 'synced';
      label = 'Synced';
    }

    el.innerHTML = showSpinner
      ? `<div class="owp-sync-spinner"></div><span>${label}</span>`
      : `<div class="owp-sync-dot ${dotClass}"></div><span>${label}</span>`;
  };

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

  /**
   * Create a Jellyfin-style card for a watch party room
   */
  const createRoomCard = (room, index) => {
    const card = document.createElement('div');
    card.className = 'card overflowPortraitCard card-hoverable card-withuserdata owp-room-card';
    card.dataset.index = index;
    card.dataset.roomId = room.id;
    card.dataset.mediaId = room.media_id || '';
    card.dataset.count = room.count;

    // Build card HTML structure matching Jellyfin's native card format exactly
    card.innerHTML = `
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

    // Fetch media info if we have media_id
    if (room.media_id && window.ApiClient) {
      const userId = window.ApiClient.getCurrentUserId?.() || window.ApiClient._currentUserId;
      if (userId) {
        window.ApiClient.getItem(userId, room.media_id).then(item => {
          // Set media title
          const titleEl = card.querySelector('.owp-media-title');
          if (titleEl && item?.Name) {
            titleEl.textContent = item.Name;
          }
          // Set background-image on cardImageContainer (Jellyfin style)
          const containerEl = card.querySelector('.owp-card-image-container');
          const iconEl = card.querySelector('.owp-card-icon');
          if (containerEl && item?.ImageTags?.Primary) {
            const serverUrl = window.ApiClient._serverAddress || window.ApiClient.serverAddress?.() || '';
            const imageUrl = `${serverUrl}/Items/${room.media_id}/Images/Primary?fillHeight=237&fillWidth=158&quality=96&tag=${item.ImageTags.Primary}`;
            containerEl.style.backgroundImage = `url("${imageUrl}")`;
            if (iconEl) iconEl.style.display = 'none';
          }
        }).catch(() => {
          const titleEl = card.querySelector('.owp-media-title');
          if (titleEl) titleEl.textContent = 'Unknown';
        });
      }
    }

    // Click handler for play button - start media and join room
    const joinBtn = card.querySelector('.owp-join-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[OpenWatchParty] Play button clicked for room:', room.id, 'media:', room.media_id);

        if (!room.media_id) {
          showToast('No media in this room');
          return;
        }

        // Store room to join after video loads
        state.pendingJoinRoomId = room.id;
        console.log('[OpenWatchParty] Set pendingJoinRoomId:', room.id);

        // Get server ID for the playback
        const serverId = window.ApiClient?.serverId?.() || window.ApiClient?._serverInfo?.Id || '';

        // Navigate to item details page (use #/ format, not #!/)
        console.log('[OpenWatchParty] Navigating to details page');
        const detailsUrl = `#/details?id=${room.media_id}&serverId=${serverId}`;
        window.location.hash = detailsUrl;

        // Poll for play button AND wait for page data to be loaded
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds max (50 * 100ms)
        const checkInterval = setInterval(() => {
          attempts++;
          // Check if the item name is loaded (indicates page controller is ready)
          const itemName = document.querySelector('.itemName bdi');
          const playBtn = document.querySelector('.mainDetailButtons .btnPlay, .mainDetailButtons button[data-action="resume"], .mainDetailButtons button[data-action="play"]');

          if (playBtn && itemName && itemName.textContent.trim()) {
            console.log('[OpenWatchParty] Play button found and page ready, clicking it');
            clearInterval(checkInterval);
            playBtn.click();
          } else if (attempts >= maxAttempts) {
            console.log('[OpenWatchParty] Play button not found or page not ready after 5s, giving up');
            clearInterval(checkInterval);
          }
        }, 100);
      });
    }

    // Click on card (not button) - just navigate to media details
    card.addEventListener('click', (e) => {
      // Don't trigger if clicking the play button
      if (e.target.closest('.owp-join-btn')) return;
      // Navigate to media details if available
      if (room.media_id && window.Emby && window.Emby.Page) {
        window.Emby.Page.show('/details?id=' + room.media_id);
      }
    });

    return card;
  };

  const renderHomeWatchParties = () => {
    if (!utils.isHomeView()) return;
    const container = document.querySelector('.homeSectionsContainer') || document.querySelector('#indexPage');
    if (!container) return;

    let section = document.getElementById(HOME_SECTION_ID);
    if (!section) {
      section = document.createElement('div');
      section.id = HOME_SECTION_ID;
      section.className = 'verticalSection verticalSection-extrabottompadding';
      container.prepend(section);
    }

    // No rooms - remove section entirely
    if (!state.rooms || state.rooms.length === 0) {
      if (section.parentNode) section.remove();
      return;
    }

    // Ensure container structure exists with Jellyfin-native classes
    let itemsContainer = section.querySelector('.itemsContainer');
    if (!itemsContainer) {
      section.innerHTML = `
        <div class="sectionTitleContainer sectionTitleContainer-cards padded-left padded-right">
          <h2 class="sectionTitle sectionTitle-cards">
            <span class="material-icons sectionTitleIcon" style="margin-right:8px;">groups</span>
            Watch Parties
          </h2>
        </div>
        <div class="emby-scroller" data-horizontal="true" data-centerfocus="true">
          <div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x padded-left padded-right"></div>
        </div>
      `;
      itemsContainer = section.querySelector('.itemsContainer');
    }

    // Build map of existing cards
    const existingCards = new Map();
    itemsContainer.querySelectorAll('.owp-room-card').forEach(card => {
      existingCards.set(card.dataset.roomId, card);
    });

    // Track which rooms still exist
    const currentRoomIds = new Set(state.rooms.map(r => r.id));

    // Remove cards for rooms that no longer exist
    existingCards.forEach((card, roomId) => {
      if (!currentRoomIds.has(roomId)) {
        card.remove();
      }
    });

    // Update or create cards
    state.rooms.forEach((room, index) => {
      const existing = existingCards.get(room.id);
      if (existing) {
        // Update count if changed
        if (existing.dataset.count !== String(room.count)) {
          existing.dataset.count = room.count;
          const countEl = existing.querySelector('.innerCardFooter .cardText');
          if (countEl) {
            countEl.innerHTML = `<span class="material-icons" style="font-size:14px;vertical-align:middle;">groups</span> ${room.count} watching`;
          }
        }
      } else {
        // Create new card
        itemsContainer.appendChild(createRoomCard(room, index));
      }
    });
  };

  /**
   * Build sync status indicator HTML (UX-P3)
   */
  const buildSyncStatusIndicator = () => {
    if (state.isHost) return '';  // Host doesn't need sync indicator

    const status = state.syncStatus || 'synced';
    let dotClass, label, extra = '';

    if (status === 'pending_play') {
      dotClass = 'pending';
      const remaining = Math.max(0, (state.pendingPlayUntil - (Date.now() + (state.serverOffsetMs || 0))) / 1000);
      label = `Syncing playback... ${remaining.toFixed(1)}s`;
      extra = '<div class="owp-sync-spinner"></div>';
    } else if (status === 'syncing') {
      dotClass = 'syncing';
      label = 'Catching up...';
    } else {
      dotClass = 'synced';
      label = 'Synced';
    }

    return `
      <div class="owp-sync-status" id="owp-sync-indicator">
        ${extra || `<div class="owp-sync-dot ${dotClass}"></div>`}
        <span>${label}</span>
      </div>
    `;
  };

  // Prevent video player from capturing keyboard events in our inputs
  const stopPlayerCapture = (input) => {
    const stopPropagation = (e) => e.stopPropagation();
    input.addEventListener('keydown', stopPropagation);
    input.addEventListener('keyup', stopPropagation);
    input.addEventListener('keypress', stopPropagation);
    // Prevent click from triggering video play/pause
    input.addEventListener('click', stopPropagation);
    input.addEventListener('mousedown', stopPropagation);
  };

  const render = (forceFullRender = false) => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    // Skip full re-render if panel structure exists and state hasn't changed
    if (!forceFullRender && panel.dataset.inRoom === String(state.inRoom) && panel.children.length > 0) {
      updateStatusIndicator();
      updateSyncIndicator();  // UX-P3: Update sync status dynamically
      updateRoomListUI();
      renderHomeWatchParties();
      return;
    }
    panel.dataset.inRoom = String(state.inRoom);

    if (!state.inRoom) {
      panel.innerHTML = `
        <div class="owp-header"><span>OpenWatchParty</span> <span id="owp-ws-indicator"></span></div>
        <div class="owp-lobby-container">
            <div class="owp-section">
              <div class="owp-label">Available Rooms</div>
              <div id="owp-room-list"></div>
            </div>
            <div class="owp-section" style="border-top: 1px solid #333; padding-top: 15px;">
              <button class="owp-btn" style="width:100%" id="owp-btn-create">Create Room</button>
            </div>
        </div>
        <div class="owp-footer">Server: ${DEFAULT_WS_URL.replace(/^wss?:\/\//, '').replace('/ws', '')}</div>
      `;
      const btn = panel.querySelector('#owp-btn-create');
      if (btn) btn.onclick = () => OWP.actions && OWP.actions.createRoom && OWP.actions.createRoom();
      updateRoomListUI();
    } else {
      const syncIndicator = buildSyncStatusIndicator();  // UX-P3
      panel.innerHTML = `
        <div class="owp-header">
          <span style="color:#69f0ae">●</span>
          <span style="flex-grow:1; margin-left:8px;">${utils.escapeHtml(state.roomName)}</span>
          <button class="owp-btn danger" id="owp-btn-leave">${state.isHost ? 'Close' : 'Leave'}</button>
        </div>
        <div class="owp-section" style="flex-shrink:0;">
          <div class="owp-label">Participants</div>
          <div id="owp-participants-list" style="font-size:13px;">Online: ${state.participantCount || 1}</div>
          ${syncIndicator}
        </div>
        <div id="owp-chat-section">
          <div class="owp-label">Chat <span id="owp-chat-badge" class="owp-chat-badge"></span></div>
          <div id="owp-chat-messages"></div>
          <div id="owp-chat-input-container">
            <input type="text" id="owp-chat-input" placeholder="Type a message..." maxlength="500">
            <button id="owp-chat-send">Send</button>
          </div>
        </div>
        <div class="owp-meta" style="font-size:10px; color:#666; display:flex; justify-content:space-between; flex-shrink:0; padding-top:8px;">
            <span>RTT: <span class="owp-latency">-</span></span>
            <span>ID: ${state.clientId.split('-')[1] || '...'}</span>
        </div>
      `;
      const leaveBtn = panel.querySelector('#owp-btn-leave');
      if (leaveBtn) leaveBtn.onclick = () => OWP.actions && OWP.actions.leaveRoom && OWP.actions.leaveRoom();

      // Setup chat input handlers
      const chatInput = panel.querySelector('#owp-chat-input');
      const chatSend = panel.querySelector('#owp-chat-send');
      if (chatInput && chatSend) {
        // Prevent video player from capturing keyboard events
        stopPlayerCapture(chatInput);

        // Send on Enter key
        chatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (OWP.chat && OWP.chat.send(chatInput.value)) {
              chatInput.value = '';
            }
          }
        });

        // Send on button click
        chatSend.addEventListener('click', () => {
          if (OWP.chat && OWP.chat.send(chatInput.value)) {
            chatInput.value = '';
          }
        });

        // Mark messages as read when chat is visible
        if (OWP.chat) {
          OWP.chat.markRead();
          OWP.chat.renderAllMessages();
        }
      }
    }
    updateStatusIndicator();
    renderHomeWatchParties();
  };

  const injectOsdButton = () => {
    if (document.getElementById(BTN_ID)) return;

    const videoOsd = document.querySelector('.videoOsdBottom .buttons');
    if (!videoOsd) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.title = 'Watch Party';
    btn.innerHTML = '<span class="material-icons groups" aria-hidden="true"></span>';
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) render(true);
    };

    // Insert before "Add to favorites" button
    const favBtn = videoOsd.querySelector('[title="Add to favorites"], [title="Remove from favorites"]');
    if (favBtn) {
      favBtn.insertAdjacentElement('beforebegin', btn);
    } else {
      videoOsd.appendChild(btn);
    }
  };

  const showToast = (message) => {
    if (window.Dashboard && typeof Dashboard.showToast === 'function') {
      Dashboard.showToast(message, 'info');
      return;
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202020;color:#fff;padding:10px 14px;border-radius:6px;z-index:30000;font-size:12px;cursor:pointer;';
    toast.onclick = () => toast.remove();  // Allow manual dismiss (fixes M-UX02)
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);  // Increased from 2s to 4s (fixes M-UX02)
  };

  OWP.ui = {
    injectStyles,
    updateStatusIndicator,
    updateSyncIndicator,  // UX-P3: Sync status update
    updateRoomListUI,
    renderHomeWatchParties,
    render,
    injectOsdButton,
    showToast
  };
})();
