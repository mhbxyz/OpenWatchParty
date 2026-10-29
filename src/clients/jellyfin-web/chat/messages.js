(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const chat = OWP.chat = OWP.chat || { messages: [], unreadCount: 0 };
  const MAX_MESSAGES = 100;

  const formatTime = (ts) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const TIMESTAMP_REGEX = /(?<![\w:])(?:(\d{1,2}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))(?![\w:])/g;

  const parseTimestampSeconds = (str) => {
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  };

  const onTimestampClick = (seconds) => {
    const video = OWP.utils?.getVideo?.();
    if (!video) return;
    const isHost = !OWP.state?.inRoom || Boolean(OWP.state?.isHost);
    if (!isHost) {
      if (OWP.ui?.showToast && OWP.i18n?.t) {
        OWP.ui.showToast(OWP.i18n.t('hostOnlySeek'));
      }
      return;
    }
    const maxDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    video.currentTime = Math.min(seconds, maxDuration);
  };

  const appendTextWithTimestamps = (targetEl, content) => {
    const str = String(content ?? '');
    TIMESTAMP_REGEX.lastIndex = 0;
    if (!TIMESTAMP_REGEX.test(str)) {
      targetEl.textContent = str;
      return;
    }
    TIMESTAMP_REGEX.lastIndex = 0;
    const appendNode = (node) => {
      if (typeof targetEl.append === 'function') {
        targetEl.append(node);
      } else if (typeof targetEl.appendChild === 'function') {
        targetEl.appendChild(node);
      }
    };
    const createText = (text) => {
      return typeof document.createTextNode === 'function' ? document.createTextNode(text) : text;
    };
    let lastIndex = 0;
    let match;
    while ((match = TIMESTAMP_REGEX.exec(str)) !== null) {
      if (match.index > lastIndex) {
        appendNode(createText(str.slice(lastIndex, match.index)));
      }
      const matchText = match[0];
      const seconds = parseTimestampSeconds(matchText);
      if (seconds !== null) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'owp-chat-timestamp';
        btn.textContent = matchText;
        btn.onclick = (e) => {
          e.stopPropagation();
          onTimestampClick(seconds);
        };
        appendNode(btn);
      } else {
        appendNode(createText(matchText));
      }
      lastIndex = TIMESTAMP_REGEX.lastIndex;
    }
    if (lastIndex < str.length) {
      appendNode(createText(str.slice(lastIndex)));
    }
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
    appendTextWithTimestamps(text, message.text);
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
    const isVisible = typeof chat.isChatVisible === 'function' ? chat.isChatVisible() : true;
    if (!isVisible && !message.isOwn) {
      chat.unreadCount++;
      if (typeof chat.updateBadge === 'function') chat.updateBadge();
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
    const isVisible = typeof chat.isChatVisible === 'function' ? chat.isChatVisible() : true;
    if (isError && !isVisible) {
      chat.unreadCount++;
      if (typeof chat.updateBadge === 'function') chat.updateBadge();
      if (OWP.ui && OWP.ui.showChatToast) OWP.ui.showChatToast(message.username, message.text);
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

  Object.assign(chat, {
    renderMessage, renderAllMessages, receive, system, clear,
    parseTimestampSeconds, appendTextWithTimestamps, onTimestampClick
  });
})();
