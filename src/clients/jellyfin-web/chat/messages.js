(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const chat = OWP.chat = OWP.chat || { messages: [], unreadCount: 0 };
  const MAX_MESSAGES = 100;

  const formatTime = (ts) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderMessage = (message) => {
    const container = document.getElementById('owp-chat-messages');
    if (!container) return;
    const msgEl = document.createElement('div');
    msgEl.className = 'owp-chat-message' + (message.isOwn ? ' owp-chat-own' : '');
    const meta = document.createElement('div');
    meta.className = 'owp-chat-meta';
    const username = document.createElement('span');
    username.className = 'owp-chat-username';
    username.textContent = String(message.username);
    const time = document.createElement('span');
    time.className = 'owp-chat-time';
    time.textContent = formatTime(message.timestamp);
    meta.append(username, time);
    const text = document.createElement('div');
    text.className = 'owp-chat-text';
    text.textContent = String(message.text);
    msgEl.append(meta, text);
    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
  };

  const renderAllMessages = () => {
    const container = document.getElementById('owp-chat-messages');
    if (!container) return;
    container.replaceChildren();
    chat.messages.forEach(msg => renderMessage(msg));
  };

  const receive = (msg) => {
    console.log('[OpenWatchParty] Chat.receive called with:', msg);
    const message = {
      clientId: msg.client,
      username: msg.payload?.username || 'Anonymous',
      text: msg.payload?.text || '',
      timestamp: msg.server_ts || Date.now(),
      isOwn: msg.client === OWP.state.clientId
    };
    chat.messages.push(message);
    if (chat.messages.length > MAX_MESSAGES) {
      chat.messages.shift();
    }
    if (!chat.isChatVisible()) {
      chat.unreadCount++;
      chat.updateBadge();
      if (!message.isOwn && OWP.ui && OWP.ui.showChatToast) {
        OWP.ui.showChatToast(message.username, message.text);
      }
    }
    renderMessage(message);
  };

  const clear = () => {
    chat.messages = [];
    chat.unreadCount = 0;
    chat.updateBadge();
    const container = document.getElementById('owp-chat-messages');
    if (container) container.replaceChildren();
  };

  Object.assign(chat, { renderMessage, renderAllMessages, receive, clear });
})();
