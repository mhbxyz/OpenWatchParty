(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.ui) return;

  const { PANEL_ID, BTN_ID, STYLE_ID, HOME_SECTION_ID, host } = OWP.constants;
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

  const createRoomCard = (room) => {
    let imageUrl = '';
    if (room.media_id) {
      imageUrl = state.homeRoomCache.get(room.media_id) || utils.getItemImageUrl(room.media_id);
      if (imageUrl) state.homeRoomCache.set(room.media_id, imageUrl);
    }

    const card = document.createElement('div');
    card.className = 'owp-room-card';
    card.dataset.roomId = room.id;
    card.dataset.mediaId = room.media_id || '';
    card.dataset.count = room.count;
    card.style.cssText = 'display:flex;gap:12px;cursor:pointer;align-items:center;padding:10px;border-radius:10px;background:rgba(255,255,255,0.05);';

    const cover = document.createElement('div');
    cover.style.cssText = 'width:120px;height:180px;border-radius:8px;background:#111;display:flex;align-items:center;justify-content:center;';
    // Security: only allow http(s) URLs to prevent XSS via javascript: or data: URLs
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      cover.style.backgroundImage = `url('${imageUrl.replace(/'/g, "\\'")}')`;
      cover.style.backgroundPosition = 'center';
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundRepeat = 'no-repeat';
    } else {
      cover.innerHTML = '<span style="color:#666;font-size:12px;">No Cover</span>';
    }

    const info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    info.innerHTML = `
      <div class="owp-card-name" style="font-weight:600;font-size:16px;">${utils.escapeHtml(room.name)}</div>
      <div class="owp-card-count" style="font-size:12px;color:#aaa;">${room.count} participant${room.count > 1 ? 's' : ''}</div>
      <div style="font-size:12px;color:#69f0ae;">Join</div>
    `;

    card.appendChild(cover);
    card.appendChild(info);

    card.addEventListener('click', () => {
      if (OWP.actions && OWP.actions.joinRoom) {
        OWP.actions.joinRoom(room.id);
        if (room.media_id && OWP.playback && OWP.playback.ensurePlayback) {
          OWP.playback.ensurePlayback(room.media_id);
        }
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
      section.style.cssText = 'margin: 12px 16px 24px;';
      container.prepend(section);
    }

    // No rooms - clear section
    if (!state.rooms || state.rooms.length === 0) {
      if (section.innerHTML !== '') section.innerHTML = '';
      return;
    }

    // Ensure container structure exists
    let cardsContainer = section.querySelector('.owp-cards-container');
    if (!cardsContainer) {
      section.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-weight:700;font-size:18px;">Watch Parties</div>
        </div>
        <div class="owp-cards-container" style="display:flex;gap:16px;flex-wrap:wrap;"></div>
      `;
      cardsContainer = section.querySelector('.owp-cards-container');
    }

    // Build map of existing cards
    const existingCards = new Map();
    cardsContainer.querySelectorAll('.owp-room-card').forEach(card => {
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
    state.rooms.forEach(room => {
      const existing = existingCards.get(room.id);
      if (existing) {
        // Update count if changed
        if (existing.dataset.count !== String(room.count)) {
          existing.dataset.count = room.count;
          const countEl = existing.querySelector('.owp-card-count');
          if (countEl) {
            countEl.textContent = `${room.count} participant${room.count > 1 ? 's' : ''}`;
          }
        }
      } else {
        // Create new card
        cardsContainer.appendChild(createRoomCard(room));
      }
    });
  };

  const render = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    if (!state.inRoom) {
      panel.innerHTML = `
        <div class="owp-header"><span>OpenWatchParty</span> <span id="owp-ws-indicator"></span></div>
        <div class="owp-lobby-container">
            <div class="owp-section">
              <div class="owp-label">Available Rooms</div>
              <div id="owp-room-list"></div>
            </div>
            <div class="owp-section" style="border-top: 1px solid #333; padding-top: 15px;">
              <div class="owp-label">Create a Room</div>
              <input class="owp-input" id="owp-new-room-name" type="text" placeholder="e.g. Movie Night" />
              <button class="owp-btn" style="width:100%" id="owp-btn-create">Create & Host</button>
            </div>
        </div>
        <div class="owp-footer">Connected to: ${host}:3000</div>
      `;
      const btn = panel.querySelector('#owp-btn-create');
      if (btn) btn.onclick = () => OWP.actions && OWP.actions.createRoom && OWP.actions.createRoom();
      updateRoomListUI();
    } else {
      panel.innerHTML = `
        <div class="owp-header">
          <span style="color:#69f0ae">●</span>
          <span style="flex-grow:1; margin-left:8px;">${utils.escapeHtml(state.roomName)}</span>
          <button class="owp-btn danger" id="owp-btn-leave">${state.isHost ? 'Close' : 'Leave'}</button>
        </div>
        <div class="owp-section">
          <div class="owp-label">Participants</div>
          <div id="owp-participants-list" style="font-size:13px;">Online: ${state.participantCount || 1}</div>
        </div>
        <div class="owp-meta" style="font-size:10px; color:#666; display:flex; justify-content:space-between;">
            <span>RTT: <span class="owp-latency">-</span></span>
            <span>ID: ${state.clientId.split('-')[1] || '...'}</span>
        </div>
      `;
      const leaveBtn = panel.querySelector('#owp-btn-leave');
      if (leaveBtn) leaveBtn.onclick = () => OWP.actions && OWP.actions.leaveRoom && OWP.actions.leaveRoom();
    }
    updateStatusIndicator();
    renderHomeWatchParties();
  };

  const injectOsdButton = () => {
    if (document.getElementById(BTN_ID)) return;
    const buttonsContainer = document.querySelector('.videoOsdBottom .buttons');
    if (!buttonsContainer) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.style.cssText = 'color: #fff !important; opacity: 1 !important; z-index: 9999;';
    btn.innerHTML = '<span class="material-icons groups" aria-hidden="true"></span>';
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) render();
    };
    buttonsContainer.insertBefore(btn, buttonsContainer.firstChild);
  };

  const showToast = (message) => {
    if (window.Dashboard && typeof Dashboard.showToast === 'function') {
      Dashboard.showToast(message, 'info');
      return;
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202020;color:#fff;padding:10px 14px;border-radius:6px;z-index:30000;font-size:12px;';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  };

  OWP.ui = {
    injectStyles,
    updateStatusIndicator,
    updateRoomListUI,
    renderHomeWatchParties,
    render,
    injectOsdButton,
    showToast
  };
})();
