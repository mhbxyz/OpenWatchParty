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
      lastParticipantCount: 0,
      isHost: false,
      readyRoomId: '',
      isBuffering: false,
      wantsToPlay: false,
      isSyncing: false,
      syncCooldownUntil: 0,
      isInitialSync: false,
      initialSyncUntil: 0,
      initialSyncTargetPos: null,
      syncStatus: 'synced',
      currentDrift: 0,
      pendingPlayUntil: 0,
      lastSyncServerTs: 0,
      lastSyncPosition: 0,
      lastSyncPlayState: '',
      joiningItemId: '',
      pendingJoinRoomId: '',
      pendingMediaId: '',
      suppressUntil: 0,
      playbackBlocked: false,
      playbackFailureNotified: false
    });
    state.playbackRequestAttempt++;
    state.autoJoinAttempt++;
    state.cardPollAttempt++;
    state.mediaSyncAttempt++;
    state.playbackActionAttempt++;
    if (OWP.chat) OWP.chat.clear();
  };

  const createRoom = () => {
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    state.desiredRoomId = '';
    const v = utils.getVideo();
    const mediaId = utils.getCurrentItemId();
    const userName = state.userName
      || window.ApiClient?._currentUser?.Name
      || 'Anonymous';
    send('create_room', {
      start_pos: v ? v.currentTime : 0,
      media_id: mediaId,
      user_name: userName
    });
  };

  const joinRoom = (id, isReconnect = false) => {
    if (!isReconnect && actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    state.desiredRoomId = id;
    state.rejectedRejoinRoomIds = state.rejectedRejoinRoomIds.filter(roomId => roomId !== id);
    state.rejoinPending = isReconnect;
    state.roomId = id;
    const userName = state.userName
      || window.ApiClient?._currentUser?.Name
      || 'Anonymous';
    send('join_room', { user_name: userName }, id);
  };

  const leaveRoom = () => {
    if (actions.cancelRoomRejoin) actions.cancelRoomRejoin();
    send('leave_room');
    resetRoomState();
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    if (panel) panel.classList.add('hide');
  };

  Object.assign(actions, {
    send,
    normalizePlaybackRate,
    resetRoomState,
    createRoom,
    joinRoom,
    leaveRoom
  });
})();
