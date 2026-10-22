(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const utils = OWP.utils;

  const connected = () => state.ws?.readyState === 1 && state.connectionPhase === 'authenticated';

  const send = (type, payload = {}, roomOverride = null) => {
    if (!state.ws || state.ws.readyState !== 1) return;
    const message = {
      type,
      payload,
      ts: utils.nowMs()
    };
    const room = roomOverride || state.roomId;
    if (room) message.room = room;
    if (state.clientId) message.client = state.clientId;
    state.ws.send(JSON.stringify(message));
  };

  const normalizePlaybackRate = () => {
    const video = state.currentVideoElement || utils.getVideo?.();
    if (video && video.playbackRate !== 1) video.playbackRate = 1;
  };

  const resetDriftCorrection = () => {
    normalizePlaybackRate();
    if (state.syncStatus === 'syncing') state.syncStatus = 'synced';
    state.currentDrift = 0;
    state.syncCooldownUntil = 0;
    state.outOfSyncSince = 0;
    state.driftCheckedAt = 0;
    if (OWP.ui?.updateSyncIndicator) OWP.ui.updateSyncIndicator();
  };

  const resetRoomPlayback = () => {
    normalizePlaybackRate();
    if (state.mediaReadyCleanup) state.mediaReadyCleanup();
    OWP.timers.clearScope('room');
    OWP.timers.clearScope('media');
    Object.assign(state, OWP.stateFactories.createRoomPlaybackState());
    // Generation fences must advance, not return to their initial value.
    state.playbackRequestAttempt++;
    state.autoJoinAttempt++;
    state.cardPollAttempt++;
    state.mediaSyncAttempt++;
    state.playbackActionAttempt++;
  };

  const resetRoomMembership = () => {
    Object.assign(state, OWP.stateFactories.createRoomState());
  };

  const resetRoomUI = () => {
    Object.assign(state, OWP.stateFactories.createRoomUIState());
  };

  const resetRoomState = () => {
    resetRoomPlayback();
    resetRoomMembership();
    resetRoomUI();
    Object.assign(state, OWP.stateFactories.createInviteWorkState());
    if (OWP.ui?.updateGuestControls) OWP.ui.updateGuestControls();
    if (OWP.chat) OWP.chat.clear();
  };

  const createRoom = () => {
    const v = utils.getVideo();
    const mediaId = utils.getPlayingItemId?.();
    // Rooms start from what is playing: never create an empty room.
    if (!v || !mediaId) {
      if (OWP.ui?.showToast) OWP.ui.showToast(t('createRoomHint'));
      return;
    }
    if (!connected()) {
      if (OWP.ui?.showToast) OWP.ui.showToast(t('notConnected'));
      return;
    }
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    state.desiredRoomId = '';
    const userName = state.userName
      || window.ApiClient?._currentUser?.Name
      || 'Anonymous';
    send('create_room', {
      start_pos: v ? v.currentTime : 0,
      media_id: mediaId,
      user_name: userName
    });
  };

  const joinRoom = (id, isReconnect = false, inviteTicket = '') => {
    // An invite join without a connection keeps its ticket: the next
    // authentication consumes it again.
    if (inviteTicket && !connected()) {
      state.pendingInviteTicket = inviteTicket;
      return;
    }
    state.guestPaused = false;
    state.sharedPlaybackControl = false;
    if (!isReconnect && actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    state.desiredRoomId = id;
    state.rejectedRejoinRoomIds = state.rejectedRejoinRoomIds.filter(roomId => roomId !== id);
    // Without a connection (a drop, the reconnect still under way) the join
    // waits for the next authentication, as a rejoin does, instead of being lost.
    const deferred = !connected();
    state.rejoinPending = isReconnect || deferred;
    state.roomId = id;
    if (deferred) return;
    const userName = state.userName
      || window.ApiClient?._currentUser?.Name
      || 'Anonymous';
    const payload = { user_name: userName };
    if (inviteTicket) payload.invite_ticket = inviteTicket;
    send('join_room', payload, id);
  };

  // A room_state already on its way (the queue moving on as someone leaves)
  // must not take this client back into the room it left.
  const forgetRoom = () => {
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    if (state.roomId && actions.rejectRoomState) actions.rejectRoomState(state.roomId);
  };

  const leaveRoom = () => {
    forgetRoom();
    send('leave_room');
    resetRoomState();
    if (OWP.ui && OWP.ui.hidePanel) {
      OWP.ui.hidePanel();
    } else {
      const panel = document.getElementById(OWP.constants.PANEL_ID);
      if (panel) panel.classList.add('hide');
    }
  };

  const closeRoom = () => {
    forgetRoom();
    const supportsHostTransfer = state.serverFeatures.includes('host_transfer');
    send(supportsHostTransfer ? 'close_room' : 'leave_room');
    resetRoomState();
    if (OWP.ui && OWP.ui.hidePanel) {
      OWP.ui.hidePanel();
    } else {
      const panel = document.getElementById(OWP.constants.PANEL_ID);
      if (panel) panel.classList.add('hide');
    }
  };

  Object.assign(actions, {
    send,
    normalizePlaybackRate,
    resetDriftCorrection,
    resetRoomState,
    resetRoomPlayback,
    resetRoomMembership,
    resetRoomUI,
    createRoom,
    joinRoom,
    leaveRoom,
    closeRoom
  });
})();
