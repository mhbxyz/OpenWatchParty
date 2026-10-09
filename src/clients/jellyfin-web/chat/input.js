(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const chat = OWP.chat = OWP.chat || { messages: [], unreadCount: 0 };
  const t = OWP.i18n.t;

  const MAX_MESSAGE_LENGTH = 500;

  const send = (text) => {
    console.log('[OpenWatchParty] Chat.send called with:', text);
    if (!text || !text.trim()) return false;
    const trimmed = text.trim();
    // Count code points, like the message validator and the server, so a
    // 500-character emoji or CJK message is not refused here.
    if (Array.from(trimmed).length > MAX_MESSAGE_LENGTH) {
      OWP.ui.showToast(t('messageTooLong', { count: MAX_MESSAGE_LENGTH }));
      return false;
    }
    if (!OWP.state.ws || OWP.state.ws.readyState !== 1) {
      console.log('[OpenWatchParty] Chat: Not connected');
      OWP.ui.showToast(t('notConnected'));
      return false;
    }
    if (!OWP.state.roomId) {
      console.log('[OpenWatchParty] Chat: Not in a room');
      OWP.ui.showToast(t('notInRoom'));
      return false;
    }
    console.log('[OpenWatchParty] Chat: Sending message to room', OWP.state.roomId);
    OWP.actions.send('chat_message', { text: trimmed });
    return true;
  };

  // The chat is a drop-down of the room bar: it is read only while it is open.
  const isChatVisible = () => {
    const chatSection = document.getElementById('owp-chat-section');
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    return Boolean(chatSection && !chatSection.hidden && panel && !panel.classList.contains('hide'));
  };

  const markRead = () => {
    chat.unreadCount = 0;
    updateBadge();
  };

  const updateBadge = () => {
    const badge = document.getElementById('owp-chat-badge');
    const count = chat.unreadCount > 99 ? '99+' : chat.unreadCount;
    if (badge) {
      if (chat.unreadCount > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
    // The chat button shows only an icon and the badge: name the unread count.
    const button = document.getElementById('owp-btn-chat');
    if (button) button.setAttribute('aria-label', chat.unreadCount > 0 ? t('chatUnread', { count }) : t('chat'));
  };

  Object.assign(chat, { send, isChatVisible, markRead, updateBadge });
})();
