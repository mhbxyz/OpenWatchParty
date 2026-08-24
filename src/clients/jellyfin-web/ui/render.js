(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const { PANEL_ID, BTN_ID, DEFAULT_WS_URL } = OWP.constants;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  const renderLobby = (panel) => {
    const header = createElement('div', 'owp-header');
    header.append(createElement('span', '', 'OpenWatchParty'), document.createTextNode(' '));
    const status = createElement('span');
    status.id = 'owp-ws-indicator';
    header.appendChild(status);

    const lobby = createElement('div', 'owp-lobby-container');
    const roomSection = createElement('div', 'owp-section');
    roomSection.appendChild(createElement('div', 'owp-label', 'Available Rooms'));
    const roomList = createElement('div');
    roomList.id = 'owp-room-list';
    roomSection.appendChild(roomList);
    const createSection = createElement('div', 'owp-section');
    createSection.style.cssText = 'border-top: 1px solid #333; padding-top: 15px;';
    const btn = createElement('button', 'owp-btn', 'Create Room');
    btn.id = 'owp-btn-create';
    btn.style.width = '100%';
    btn.onclick = () => OWP.actions && OWP.actions.createRoom && OWP.actions.createRoom();
    createSection.appendChild(btn);
    lobby.append(roomSection, createSection);

    const footer = createElement('div', 'owp-footer');
    footer.append(document.createTextNode('Server: '), document.createTextNode(String(DEFAULT_WS_URL.replace(/^wss?:\/\//, '').replace('/ws', ''))));
    panel.replaceChildren(header, lobby, footer);
    ui.updateRoomListUI();
  };

  const renderRoom = (panel) => {
    const syncIndicator = ui.buildSyncStatusIndicator();
    const header = createElement('div', 'owp-header');
    const online = createElement('span', '', '\u25CF');
    online.style.color = '#69f0ae';
    const roomName = createElement('span', '', state.roomName);
    roomName.style.cssText = 'flex-grow:1; margin-left:8px;';
    const leaveBtn = createElement('button', 'owp-btn danger', state.isHost ? 'Close' : 'Leave');
    leaveBtn.id = 'owp-btn-leave';
    leaveBtn.onclick = () => OWP.actions && OWP.actions.leaveRoom && OWP.actions.leaveRoom();
    header.append(online, roomName, leaveBtn);

    const participantSection = createElement('div', 'owp-section');
    participantSection.style.flexShrink = '0';
    participantSection.appendChild(createElement('div', 'owp-label', 'Participants'));
    const participantList = createElement('div', '', `Online: ${String(state.participantCount || 1)}`);
    participantList.id = 'owp-participants-list';
    participantList.style.fontSize = '13px';
    participantSection.appendChild(participantList);
    if (syncIndicator) participantSection.appendChild(syncIndicator);

    const chatSection = createElement('div');
    chatSection.id = 'owp-chat-section';
    const chatLabel = createElement('div', 'owp-label');
    chatLabel.appendChild(document.createTextNode('Chat '));
    const badge = createElement('span', 'owp-chat-badge');
    badge.id = 'owp-chat-badge';
    chatLabel.appendChild(badge);
    const messages = createElement('div');
    messages.id = 'owp-chat-messages';
    const inputContainer = createElement('div');
    inputContainer.id = 'owp-chat-input-container';
    const input = createElement('input');
    input.id = 'owp-chat-input';
    input.type = 'text';
    input.placeholder = 'Type a message...';
    input.maxLength = 500;
    const send = createElement('button', '', 'Send');
    send.id = 'owp-chat-send';
    inputContainer.append(input, send);
    chatSection.append(chatLabel, messages, inputContainer);

    const meta = createElement('div', 'owp-meta');
    meta.style.cssText = 'font-size:10px; color:#666; display:flex; justify-content:space-between; flex-shrink:0; padding-top:8px;';
    const latencyContainer = createElement('span');
    latencyContainer.appendChild(document.createTextNode('RTT: '));
    latencyContainer.appendChild(createElement('span', 'owp-latency', '-'));
    const clientId = String(state.clientId).split('-')[1] || '...';
    meta.append(latencyContainer, createElement('span', '', `ID: ${clientId}`));
    panel.replaceChildren(header, participantSection, chatSection, meta);
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
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) render(true);
    };
    const favBtn = videoOsd.querySelector('[title="Add to favorites"], [title="Remove from favorites"]');
    if (favBtn) {
      favBtn.insertAdjacentElement('beforebegin', btn);
    } else {
      videoOsd.appendChild(btn);
    }
  };

  Object.assign(ui, { render, injectOsdButton });
})();
