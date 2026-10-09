(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;

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

  const resetRoomState = () => {
    normalizePlaybackRate();
    if (state.mediaReadyCleanup) state.mediaReadyCleanup();
    OWP.timers.clearScope('room');
    OWP.timers.clearScope('media');
    state.pendingActionTimer = null;
    Object.assign(state, {
      inRoom: false,
      roomId: '',
      roomName: '',
      participantCount: 0,
      participants: [],
      statusesRoomId: '',
      statusCandidate: '',
      statusCandidateSince: 0,
      statusSentKey: '',
      roomBarSection: '',
      lastParticipantCount: 0,
      isHost: false,
      readyRoomId: '',
      isBuffering: false,
      wantsToPlay: false,
      streamReloadUntil: 0,
      lastPlayedPosition: 0,
      lastPlayedPlaying: false,
      streamReloadResume: false,
      reloadGuestCommand: null,
      isSyncing: false,
      syncCooldownUntil: 0,
      isInitialSync: false,
      initialSyncUntil: 0,
      initialSyncTargetPos: null,
      syncStatus: 'synced',
      currentDrift: 0,
      outOfSyncSince: 0,
      driftCheckedAt: 0,
      pendingPlayUntil: 0,
      lastSyncServerTs: 0,
      lastSyncPosition: 0,
      lastSyncPlayState: '',
      roomWaiting: false,
      roomHostId: '',
      ownCommandUntil: 0,
      ownCommandPlayState: '',
      joiningItemId: '',
      pendingJoinRoomId: '',
      pendingMediaId: '',
      pendingMediaUntil: 0,
      suppressUntil: 0,
      playbackBlocked: false,
      playbackFailureNotified: false,
      inviteJoinPending: false,
      pendingInviteTicket: ''
    });
    state.playbackRequestAttempt++;
    state.autoJoinAttempt++;
    state.cardPollAttempt++;
    state.mediaSyncAttempt++;
    state.playbackActionAttempt++;
    if (OWP.ui?.updateGuestControls) OWP.ui.updateGuestControls();
    if (OWP.chat) OWP.chat.clear();
  };

  const createRoom = () => {
    const v = utils.getVideo();
    const mediaId = utils.getPlayingItemId?.();
    // Rooms start from what is playing: never create an empty room.
    if (!v || !mediaId) {
      if (OWP.ui?.showToast) OWP.ui.showToast('Start playing something to create a room.');
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
    if (!isReconnect && actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    state.desiredRoomId = id;
    state.rejectedRejoinRoomIds = state.rejectedRejoinRoomIds.filter(roomId => roomId !== id);
    state.rejoinPending = isReconnect;
    state.roomId = id;
    const userName = state.userName
      || window.ApiClient?._currentUser?.Name
      || 'Anonymous';
    const payload = { user_name: userName };
    if (inviteTicket) payload.invite_ticket = inviteTicket;
    send('join_room', payload, id);
  };

  const leaveRoom = () => {
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
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
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
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
    createRoom,
    joinRoom,
    leaveRoom,
    closeRoom
  });
})();
