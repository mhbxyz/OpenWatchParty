(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const { PANEL_ID, BTN_ID, DEFAULT_WS_URL } = OWP.constants;
  const GLOBAL_BTN_ID = 'owp-global-btn';

  const togglePanel = (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle('hide');
    if (!panel.classList.contains('hide')) render(true);
  };

  const renderLobby = (panel) => {
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
    ui.updateRoomListUI();
  };

  const renderRoom = (panel) => {
    const syncIndicator = ui.buildSyncStatusIndicator();
    panel.innerHTML = `
      <div class="owp-header">
        <span style="color:#69f0ae">\u25CF</span>
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
  };

  const setupChatInput = (panel) => {
    const chatInput = panel.querySelector('#owp-chat-input');
    const chatSend = panel.querySelector('#owp-chat-send');
    if (!chatInput || !chatSend) return;
    ui.stopPlayerCapture(chatInput);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (OWP.chat && OWP.chat.send(chatInput.value)) {
          chatInput.value = '';
        }
      }
    });
    chatSend.addEventListener('click', () => {
      if (OWP.chat && OWP.chat.send(chatInput.value)) {
        chatInput.value = '';
      }
    });
    if (OWP.chat) {
      OWP.chat.markRead();
      OWP.chat.renderAllMessages();
    }
  };

  const render = (forceFullRender = false) => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!forceFullRender && panel.dataset.inRoom === String(state.inRoom) && panel.children.length > 0) {
      ui.updateStatusIndicator();
      ui.updateSyncIndicator();
      ui.updateRoomListUI();
      ui.renderHomeWatchParties();
      return;
    }
    panel.dataset.inRoom = String(state.inRoom);
    if (!state.inRoom) {
      renderLobby(panel);
    } else {
      renderRoom(panel);
      setupChatInput(panel);
    }
    ui.updateStatusIndicator();
    ui.renderHomeWatchParties();
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
    btn.onclick = togglePanel;
    const favBtn = videoOsd.querySelector('[title="Add to favorites"], [title="Remove from favorites"]');
    if (favBtn) {
      favBtn.insertAdjacentElement('beforebegin', btn);
    } else {
      videoOsd.appendChild(btn);
    }
  };

  const injectGlobalButton = () => {
    if (document.getElementById(GLOBAL_BTN_ID)) return;
    const headerRight = document.querySelector('.headerRight') || document.querySelector('.skinHeader .headerRight');
    if (!headerRight) return;

    const btn = document.createElement('button');
    btn.id = GLOBAL_BTN_ID;
    btn.className = 'paper-icon-button-light owp-global-btn';
    btn.type = 'button';
    btn.title = 'OpenWatchParty';
    btn.setAttribute('aria-label', 'OpenWatchParty');
    btn.innerHTML = '<span class="material-icons groups" aria-hidden="true"></span>';
    btn.onclick = togglePanel;

    headerRight.prepend(btn);
  };

  Object.assign(ui, { render, injectOsdButton, injectGlobalButton });
})();
