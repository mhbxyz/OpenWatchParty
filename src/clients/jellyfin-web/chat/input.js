(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const chat = OWP.chat = OWP.chat || { messages: [], unreadCount: 0 };
  const t = OWP.i18n.t;

  const MAX_MESSAGE_LENGTH = 500;

  const send = (text) => {
    if (!text || !text.trim()) return false;
    const trimmed = text.trim();
    // Expand :shortcodes: to emoji characters before validation and sending.
    const message = OWP.emoji?.expand ? OWP.emoji.expand(trimmed) : trimmed;
    // Count code points, like the message validator and the server, so a
    // 500-character emoji or CJK message is not refused here.
    if (Array.from(message).length > MAX_MESSAGE_LENGTH) {
      OWP.ui.showToast(t('messageTooLong', { count: MAX_MESSAGE_LENGTH }));
      return false;
    }
    if (!OWP.state.ws || OWP.state.ws.readyState !== 1) {
      OWP.ui.showToast(t('notConnected'));
      return false;
    }
    if (!OWP.state.roomId) {
      OWP.ui.showToast(t('notInRoom'));
      return false;
    }
    OWP.actions.send('chat_message', { text: message });
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
