(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const { PANEL_ID, ROOM_MODE_CLASS } = OWP.constants;
  const { renderLobby, renderRoom, setupChatInput, updateServerLabel } = views;
  const { updateCreateRoomButton, focusPanelStart } = ui;


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
    // Leaving the room also takes its "up next" strip off the page.
    if (!state.inRoom && ui.updateQueue) ui.updateQueue();
    if (!state.inRoom && ui.updateStartLabel) ui.updateStartLabel();
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

  Object.assign(ui, { render });
})();
