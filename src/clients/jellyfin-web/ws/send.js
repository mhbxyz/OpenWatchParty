(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;

  const send = (type, payload = {}, roomOverride = null) => {
    if (!state.ws || state.ws.readyState !== 1) return;
    const message = {
      type,
      room: roomOverride || state.roomId,
      payload,
      ts: utils.nowMs()
    };
    if (state.clientId) message.client = state.clientId;
    state.ws.send(JSON.stringify(message));
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
    state.inRoom = false;
    state.roomId = '';
    state.readyRoomId = '';
    state.isInitialSync = false;
    state.initialSyncUntil = 0;
    state.initialSyncTargetPos = 0;
    state.syncCooldownUntil = 0;
    state.syncStatus = 'synced';
    state.pendingPlayUntil = 0;
    state.currentDrift = 0;
    if (state.pendingActionTimer) {
      clearTimeout(state.pendingActionTimer);
      state.pendingActionTimer = null;
    }
    if (OWP.chat) OWP.chat.clear();
    const panel = document.getElementById(OWP.constants.PANEL_ID);
    if (panel) panel.classList.add('hide');
  };

  Object.assign(actions, { send, createRoom, joinRoom, leaveRoom });
})();
