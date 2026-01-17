(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.chat) return;

  const MAX_MESSAGES = 100;
  const MAX_MESSAGE_LENGTH = 500;

  const state = OWP.state;
  const utils = OWP.utils;

  /**
   * Escape HTML to prevent XSS attacks
   */
  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  /**
   * Format timestamp for display
   */
  const formatTime = (ts) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const chat = {
    messages: [],
    unreadCount: 0,

    /**
     * Send a chat message to the room
     */
    send(text) {
      console.log('[OpenWatchParty] Chat.send called with:', text);
      if (!text || !text.trim()) return false;
      const trimmed = text.trim();
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        OWP.ui.showToast(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
        return false;
      }
      if (!OWP.state.ws || OWP.state.ws.readyState !== 1) {
        console.log('[OpenWatchParty] Chat: Not connected');
        OWP.ui.showToast('Not connected to server');
        return false;
      }
      if (!OWP.state.roomId) {
        console.log('[OpenWatchParty] Chat: Not in a room');
        OWP.ui.showToast('Not in a room');
        return false;
      }
      console.log('[OpenWatchParty] Chat: Sending message to room', OWP.state.roomId);
      OWP.actions.send('chat_message', { text: trimmed });
      return true;
    },

    /**
     * Handle incoming chat message from server
     */
    receive(msg) {
      console.log('[OpenWatchParty] Chat.receive called with:', msg);
      const message = {
        clientId: msg.client,
        username: msg.payload?.username || 'Anonymous',
        text: msg.payload?.text || '',
        timestamp: msg.server_ts || Date.now(),
        isOwn: msg.client === OWP.state.clientId
      };

      this.messages.push(message);

      // Trim to max messages
      if (this.messages.length > MAX_MESSAGES) {
        this.messages.shift();
      }

      // Update unread count and show toast if chat is not visible
      if (!this.isChatVisible()) {
        this.unreadCount++;
        this.updateBadge();
        // Show toast for messages from others
        if (!message.isOwn && OWP.ui && OWP.ui.showChatToast) {
          OWP.ui.showChatToast(message.username, message.text);
        }
      }

      // Render the new message
      this.renderMessage(message);
    },

    /**
     * Check if chat panel is visible
     */
    isChatVisible() {
      const chatSection = document.getElementById('owp-chat-section');
      const panel = document.getElementById(OWP.constants.PANEL_ID);
      return chatSection && panel && !panel.classList.contains('hide');
    },

    /**
     * Mark all messages as read
     */
    markRead() {
      this.unreadCount = 0;
      this.updateBadge();
    },

    /**
     * Update the unread badge on the chat tab/button
     */
    updateBadge() {
      const badge = document.getElementById('owp-chat-badge');
      if (badge) {
        if (this.unreadCount > 0) {
          badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    },

    /**
     * Render a single chat message to the DOM
     */
    renderMessage(message) {
      const container = document.getElementById('owp-chat-messages');
      if (!container) return;

      const msgEl = document.createElement('div');
      msgEl.className = 'owp-chat-message' + (message.isOwn ? ' owp-chat-own' : '');
      msgEl.innerHTML = `
        <div class="owp-chat-meta">
          <span class="owp-chat-username">${escapeHtml(message.username)}</span>
          <span class="owp-chat-time">${formatTime(message.timestamp)}</span>
        </div>
        <div class="owp-chat-text">${escapeHtml(message.text)}</div>
      `;
      container.appendChild(msgEl);

      // Auto-scroll to bottom
      container.scrollTop = container.scrollHeight;
    },

    /**
     * Render all messages (used when chat UI is first shown)
     */
    renderAllMessages() {
      const container = document.getElementById('owp-chat-messages');
      if (!container) return;
      container.innerHTML = '';
      this.messages.forEach(msg => this.renderMessage(msg));
    },

    /**
     * Clear chat when leaving room
     */
    clear() {
      this.messages = [];
      this.unreadCount = 0;
      this.updateBadge();
      const container = document.getElementById('owp-chat-messages');
      if (container) container.innerHTML = '';
    }
  };

  OWP.chat = chat;
})();
