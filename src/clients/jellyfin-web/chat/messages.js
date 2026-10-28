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
    msgEl.className = 'owp-chat-message' + (message.isOwn ? ' owp-chat-own' : '')
      + (message.system ? ' owp-chat-system' : '') + (message.isError ? ' owp-chat-error' : '');
    // One line per message in the room bar: the time is in the tooltip.
    msgEl.title = formatTime(message.timestamp);
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
    // The rendered chat keeps the same messages as chat.messages, which gains
    // one at a time.
    if (container.children.length > MAX_MESSAGES) container.children[0].remove();
    container.scrollTop = container.scrollHeight;
  };

  const renderAllMessages = () => {
    const container = document.getElementById('owp-chat-messages');
    if (!container) return;
    container.replaceChildren();
    chat.messages.forEach(msg => renderMessage(msg));
  };

  const receive = (msg) => {
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
    // Your own messages are never unread, even if the chat closed before the
    // server echoed them back.
    if (!chat.isChatVisible() && !message.isOwn) {
      chat.unreadCount++;
      chat.updateBadge();
      if (OWP.ui && OWP.ui.showChatToast) {
        OWP.ui.showChatToast(message.username, message.text);
      }
    }
    renderMessage(message);
  };

  // A line from OWP itself, as SERVER: who the room waits for and why, say.
  // Only an error counts as unread (and shows a toast) while the chat is closed.
  const system = (text, isError = false) => {
    const message = { system: true, isError, username: 'SERVER', text, timestamp: Date.now(), isOwn: false };
    chat.messages.push(message);
    if (chat.messages.length > MAX_MESSAGES) chat.messages.shift();
    if (isError && !chat.isChatVisible()) {
      chat.unreadCount++;
      chat.updateBadge();
      if (OWP.ui && OWP.ui.showChatToast) OWP.ui.showChatToast(message.username, message.text);
    }
    renderMessage(message);
  };

  // The room's last messages, which a server with chat_history sends once on
  // joining. They replace what the chat shows (a rejoin after a lost
  // connection gets them again), and none counts as unread. The server marks
  // this member's own ones (its client id changes with each connection).
  const loadHistory = (entries) => {
    chat.messages = entries.slice(-MAX_MESSAGES).map(entry => ({
      clientId: entry.client,
      username: entry.username || 'Anonymous',
      text: entry.text,
      timestamp: entry.server_ts,
      isOwn: entry.own || entry.client === OWP.state.clientId
    }));
    chat.unreadCount = 0;
    chat.updateBadge();
    renderAllMessages();
  };

  const clear = () => {
    chat.messages = [];
    chat.unreadCount = 0;
    chat.updateBadge();
    const container = document.getElementById('owp-chat-messages');
    if (container) container.replaceChildren();
  };

  Object.assign(chat, { renderMessage, renderAllMessages, receive, system, loadHistory, clear });
})();
