(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { PANEL_ID, BTN_ID, ROOM_MODE_CLASS } = OWP.constants;
  const { renderLobby, renderRoom, setupChatInput, updateServerLabel } = views;
  const { createWatchPartyIcon, updateCreateRoomButton, focusPanelStart, isKeyboardClick, setLobbyHelpOpen } = ui;


  const render = (forceFullRender = false) => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!forceFullRender && panel.dataset.inRoom === String(state.inRoom) && panel.children.length > 0) {
      ui.updateStatusIndicator();
      ui.updateSyncIndicator();
      ui.updateRoomListUI();
      updateCreateRoomButton();
      updateServerLabel();
      ui.renderHomeWatchParties();
      return;
    }
    const redrawingRoom = state.inRoom
      && panel.dataset.inRoom === 'true'
      && panel.children.length > 0;
    const oldMessages = redrawingRoom ? panel.querySelector('#owp-chat-messages') : null;
    const messageNodes = oldMessages ? Array.from(oldMessages.childNodes) : null;
    const oldScrollTop = oldMessages ? Number(oldMessages.scrollTop) || 0 : 0;
    const wasChatAtBottom = oldMessages
      ? oldScrollTop + (Number(oldMessages.clientHeight) || 0) >= (Number(oldMessages.scrollHeight) || 0) - 1
      : true;
    const oldInput = redrawingRoom ? panel.querySelector('#owp-chat-input') : null;
    const chatDraft = oldInput ? oldInput.value : '';
    // A full draw replaces every control. Keyboard focus inside the panel
    // (on Create Room or Join, say) goes to the same control if it is drawn
    // again, or to the first one, instead of falling out of the dialog.
    const active = document.activeElement;
    const focusInside = !!active && active !== panel && typeof panel.contains === 'function' && panel.contains(active);
    const focusedId = focusInside ? active.id : '';
    panel.dataset.inRoom = String(state.inRoom);
    if (state.inRoom) panel.classList.add(ROOM_MODE_CLASS);
    else panel.classList.remove(ROOM_MODE_CLASS);
    if (!state.inRoom) {
      renderLobby(panel);
    } else {
      renderRoom(panel);
      setupChatInput(panel);
      if (redrawingRoom) {
        const messages = panel.querySelector('#owp-chat-messages');
        if (messages && messageNodes) {
          messages.replaceChildren(...messageNodes);
          messages.scrollTop = wasChatAtBottom ? messages.scrollHeight : oldScrollTop;
        }
        const input = panel.querySelector('#owp-chat-input');
        if (input) input.value = chatDraft;
      }
    }
    // The lobby and the room bar sit differently below the header.
    if (ui.updatePanelPlacement) ui.updatePanelPlacement();
    ui.updateStatusIndicator();
    ui.renderHomeWatchParties();
    if (focusInside && !panel.classList.contains('hide')) {
      const same = focusedId && document.getElementById(focusedId);
      if (same && panel.contains(same)) same.focus({ preventScroll: true });
      else focusPanelStart(panel);
    }
  };


  const injectOsdButton = () => {
    // Jellyfin keeps the previous player page in the DOM, hidden as
    // `.page.hide`: use the buttons of the shown player, and move the button
    // there when it is still in another player page.
    const videoOsd = Array.from(document.querySelectorAll('.videoOsdBottom .buttons'))
      .find(buttons => !buttons.closest('.page.hide'));
    if (!videoOsd) return;
    const existing = document.getElementById(BTN_ID);
    if (existing) {
      if (existing.closest('.videoOsdBottom .buttons') === videoOsd) return;
      existing.remove();
    }
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.title = t('watchParty');
    btn.appendChild(createWatchPartyIcon());
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) {
        panel.dataset.opener = BTN_ID;
        if (ui.resetPanelPlacement) ui.resetPanelPlacement(panel);
        setLobbyHelpOpen(false);
        render(true);
        if (isKeyboardClick(e)) focusPanelStart(panel);
      }
      btn.setAttribute('aria-expanded', String(!panel.classList.contains('hide')));
    };
    btn.setAttribute('aria-label', t('watchParty'));
    btn.setAttribute('aria-controls', PANEL_ID);
    const currentPanel = document.getElementById(PANEL_ID);
    btn.setAttribute('aria-expanded', String(!!currentPanel && !currentPanel.classList.contains('hide')));
    // By class: its title follows the Jellyfin language.
    const favBtn = videoOsd.querySelector('.btnUserRating');
    if (favBtn) {
      favBtn.insertAdjacentElement('beforebegin', btn);
    } else {
      videoOsd.appendChild(btn);
    }
  };
  Object.assign(ui, { render, injectOsdButton });
})();
