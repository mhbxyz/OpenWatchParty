(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.ui) return;

  const { PANEL_ID, BTN_ID, STYLE_ID, HOME_SECTION_ID, host } = OSP.constants;
  const state = OSP.state;
  const utils = OSP.utils;

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
      .osp-header { font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 8px; }
      .osp-section { margin-bottom: 15px; overflow-y: auto; }
      .osp-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
      .osp-room-item { 
        background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 8px;
        display: flex; justify-content: space-between; align-items: center; cursor: pointer;
        border: 1px solid transparent; transition: all 0.2s;
      }
      .osp-room-item:hover { background: rgba(255,255,255,0.1); border-color: #1565c0; }
      .osp-btn { 
        border: none; border-radius: 6px; padding: 10px 15px; 
        background: #388e3c; color: #fff; cursor: pointer; font-weight: bold; font-size: 13px;
      }
      .osp-btn.secondary { background: #1565c0; }
      .osp-btn.danger { background: #d32f2f; }
      .osp-input { 
        width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444; 
        background: #000; color: #fff; box-sizing: border-box; margin-bottom: 10px; font-size: 14px;
      }
      .osp-footer { font-size: 10px; color: #555; text-align: center; margin-top: auto; padding-top: 10px; }
    `;
    document.head.appendChild(style);
  };

  const updateStatusIndicator = () => {
    const el = document.getElementById('osp-ws-indicator');
    if (!el) return;
    const connected = state.ws && state.ws.readyState === 1;
    el.style.color = connected ? '#69f0ae' : '#ff5252';
    el.textContent = connected ? 'Online' : 'Offline';
  };

  const updateRoomListUI = () => {
    const roomList = document.getElementById('osp-room-list');
    if (!roomList) return;
    if (state.rooms.length === 0) {
      roomList.innerHTML = '<div style="font-size:12px; color:#555; padding: 10px; text-align:center;">No active rooms.</div>';
      return;
    }
    roomList.innerHTML = '';
    state.rooms.forEach(room => {
      const item = document.createElement('div');
      item.className = 'osp-room-item';
      item.innerHTML = `<div><div style="font-weight:bold">${room.name}</div><div style="font-size:10px; color:#888">${room.count} users</div></div><button class="osp-btn secondary">Join</button>`;
      item.onclick = () => {
        if (OSP.actions && OSP.actions.joinRoom) OSP.actions.joinRoom(room.id);
      };
      roomList.appendChild(item);
    });
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

    if (!state.rooms || state.rooms.length === 0) {
      section.innerHTML = '';
      return;
    }

    const cards = state.rooms.map((room) => {
      let imageUrl = '';
      if (room.media_id) {
        imageUrl = state.homeRoomCache.get(room.media_id) || utils.getItemImageUrl(room.media_id);
        if (imageUrl) state.homeRoomCache.set(room.media_id, imageUrl);
      }
      const cover = imageUrl
        ? `<div style="width:120px;height:180px;border-radius:8px;background:#111 url('${imageUrl}') center/cover no-repeat;"></div>`
        : `<div style="width:120px;height:180px;border-radius:8px;background:#111;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">No Cover</div>`;
      return `
        <div class="osp-room-card" data-room-id="${room.id}" data-media-id="${room.media_id || ''}" style="display:flex;gap:12px;cursor:pointer;align-items:center;padding:10px;border-radius:10px;background:rgba(255,255,255,0.05);">
          ${cover}
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="font-weight:600;font-size:16px;">${room.name}</div>
            <div style="font-size:12px;color:#aaa;">${room.count} participant${room.count > 1 ? 's' : ''}</div>
            <div style="font-size:12px;color:#69f0ae;">Join</div>
          </div>
        </div>
      `;
    }).join('');

    section.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-weight:700;font-size:18px;">Watch Parties</div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">${cards}</div>
    `;

    section.querySelectorAll('.osp-room-card').forEach((card) => {
      card.addEventListener('click', () => {
        const roomId = card.getAttribute('data-room-id');
        const mediaId = card.getAttribute('data-media-id');
        if (roomId && OSP.actions && OSP.actions.joinRoom) {
          OSP.actions.joinRoom(roomId);
          if (OSP.playback && OSP.playback.ensurePlayback) {
            OSP.playback.ensurePlayback(mediaId);
          }
        }
      });
    });
  };

  const render = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    if (!state.inRoom) {
      panel.innerHTML = `
        <div class="osp-header"><span>OpenSyncParty</span> <span id="osp-ws-indicator"></span></div>
        <div class="osp-lobby-container">
            <div class="osp-section">
              <div class="osp-label">Available Rooms</div>
              <div id="osp-room-list"></div>
            </div>
            <div class="osp-section" style="border-top: 1px solid #333; padding-top: 15px;">
              <div class="osp-label">Create a Room</div>
              <input class="osp-input" id="osp-new-room-name" type="text" placeholder="e.g. Movie Night" />
              <button class="osp-btn" style="width:100%" id="osp-btn-create">Create & Host</button>
            </div>
        </div>
        <div class="osp-footer">Connected to: ${host}:3000</div>
      `;
      const btn = panel.querySelector('#osp-btn-create');
      if (btn) btn.onclick = () => OSP.actions && OSP.actions.createRoom && OSP.actions.createRoom();
      updateRoomListUI();
    } else {
      panel.innerHTML = `
        <div class="osp-header">
          <span style="color:#69f0ae">●</span>
          <span style="flex-grow:1; margin-left:8px;">${state.roomName}</span>
          <button class="osp-btn danger" id="osp-btn-leave">${state.isHost ? 'Close' : 'Leave'}</button>
        </div>
        <div class="osp-section">
          <div class="osp-label">Participants</div>
          <div id="osp-participants-list" style="font-size:13px;">Online: ${state.participantCount || 1}</div>
        </div>
        <div class="osp-meta" style="font-size:10px; color:#666; display:flex; justify-content:space-between;">
            <span>RTT: <span class="osp-latency">-</span></span>
            <span>ID: ${state.clientId.split('-')[1] || '...'}</span>
        </div>
      `;
      const leaveBtn = panel.querySelector('#osp-btn-leave');
      if (leaveBtn) leaveBtn.onclick = () => OSP.actions && OSP.actions.leaveRoom && OSP.actions.leaveRoom();
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

  OSP.ui = {
    injectStyles,
    updateStatusIndicator,
    updateRoomListUI,
    renderHomeWatchParties,
    render,
    injectOsdButton,
    showToast
  };
})();
