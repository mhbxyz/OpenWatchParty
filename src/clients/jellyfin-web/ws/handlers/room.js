(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const h = OWP._wsHandlers = OWP._wsHandlers || {};
  const state = OWP.state;
  const ui = OWP.ui;

  h.handleRoomList = (msg) => {
    state.rooms = msg.payload || [];
    if (!state.inRoom) ui.updateRoomListUI();
    ui.renderHomeWatchParties();
  };

  h.handleClientHello = (msg) => {
    if (msg.payload && msg.payload.client_id) {
      state.clientId = msg.payload.client_id;
      ui.render();
    }
  };

  h.handleAuthSuccess = () => {
    if (OWP.actions?.handleAuthenticatedConnection) {
      OWP.actions.handleAuthenticatedConnection();
    }
  };

  h.handleParticipantsUpdate = (msg) => {
    state.participantCount = msg.payload.participant_count;
    if (state.inRoom) {
      const el = document.getElementById('owp-participants-list');
      if (el) el.textContent = `Online: ${state.participantCount}`;
    }
    if (state.lastParticipantCount && state.participantCount > state.lastParticipantCount) {
      ui.showToast('A participant joined the room');
    }
    state.lastParticipantCount = state.participantCount;
  };

  h.handleClientLeft = (msg) => {
    if (msg.payload?.participant_count !== undefined) {
      state.participantCount = msg.payload.participant_count;
      if (state.inRoom) {
        const el = document.getElementById('owp-participants-list');
        if (el) el.textContent = `Online: ${state.participantCount}`;
        ui.showToast('A participant left the room');
      }
      state.lastParticipantCount = state.participantCount;
    }
  };

  h.handleRoomClosed = (msg) => {
    if (OWP.actions?.cancelRoomRejoin) OWP.actions.cancelRoomRejoin();
    if (OWP.actions?.resetRoomState) OWP.actions.resetRoomState();
    else {
      state.inRoom = false;
      state.roomId = '';
    }
    const reason = msg.payload?.reason || 'The room was closed';
    ui.showToast(reason);
    ui.render();
  };

  h.handleError = (msg) => {
    const message = msg.payload?.message || 'Unknown error';
    console.error('[OpenWatchParty] Server error:', message);
    if (state.rejoinPending && OWP.actions?.failRoomRejoin) {
      OWP.actions.failRoomRejoin(message);
      return;
    }
    ui.showToast(message);
  };
})();
