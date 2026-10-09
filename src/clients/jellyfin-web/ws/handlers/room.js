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

  h.handleAuthSuccess = (msg) => {
    state.serverFeatures = msg.payload?.features || [];
    if (state.connectionPhase !== 'authenticated' && OWP.actions?.handleAuthenticatedConnection) {
      OWP.actions.handleAuthenticatedConnection();
    }
  };

  h.handleParticipantsUpdate = (msg) => {
    state.participantCount = msg.payload.participant_count;
    if (state.inRoom) ui.updateParticipantList();
    if (state.lastParticipantCount && state.participantCount > state.lastParticipantCount) {
      ui.showToast('A participant joined the room');
    }
    state.lastParticipantCount = state.participantCount;
  };

  h.handleClientLeft = (msg) => {
    if (msg.payload?.participant_count !== undefined) {
      state.participantCount = msg.payload.participant_count;
      if (state.inRoom) {
        ui.updateParticipantList();
        ui.showToast('A participant left the room');
      }
      state.lastParticipantCount = state.participantCount;
    }
  };

  h.handleParticipantList = (msg) => {
    if (!state.inRoom || msg.room !== state.roomId) return;
    // The statuses for this list follow in participant_statuses.
    state.participants = msg.payload.participants.map(participant => ({
      name: participant.name,
      isHost: participant.is_host,
      status: null
    }));
    ui.updateParticipantList();
  };

  // Statuses in participant_list order; a list of another length belongs to
  // another version of the list and is ignored. Receiving it also tells that
  // this server accepts participant_status (an older one would answer with an
  // error).
  h.handleParticipantStatuses = (msg) => {
    if (!state.inRoom || msg.room !== state.roomId) return;
    state.statusesRoomId = msg.room;
    const { statuses } = msg.payload;
    if (statuses.length !== state.participants.length) return;
    state.participants = state.participants.map((participant, index) => ({ ...participant, status: statuses[index] }));
    ui.updateParticipantList();
  };

  h.handleHostChanged = (msg) => {
    if (!state.inRoom || msg.room !== state.roomId) return;
    const becameHost = msg.payload.host_id === state.clientId;
    state.isHost = becameHost;
    state.roomHostId = msg.payload.host_id;
    if (becameHost && OWP.actions?.resetDriftCorrection) {
      OWP.actions.resetDriftCorrection();
    }
    ui.render();
    if (ui.updateRoomRoleControls) ui.updateRoomRoleControls();
    ui.showToast(becameHost ? 'You are now the host' : `${msg.payload.host_name} is now the host`);
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
    if (state.inviteJoinPending) {
      // A bad or expired invite must fall back to the normal room list.
      state.inviteJoinPending = false;
      if (OWP.actions?.resetRoomState) OWP.actions.resetRoomState();
      ui.showToast(message);
      ui.render();
      return;
    }
    if (state.rejoinPending && OWP.actions?.failRoomRejoin) {
      OWP.actions.failRoomRejoin(message);
      return;
    }
    ui.showToast(message);
  };
})();
