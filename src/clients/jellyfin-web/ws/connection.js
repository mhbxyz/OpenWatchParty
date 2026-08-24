(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const { DEFAULT_WS_URL, RECONNECT_BASE_MS, RECONNECT_MAX_MS, ROOM_REJOIN_TIMEOUT_MS, PING_INIT_MS, PING_STABLE_MS, PING_STABLE_AFTER } = OWP.constants;

  const clearRoomRejoinTimer = () => {
    if (state.roomRejoinTimer) {
      OWP.timers.clear(state.roomRejoinTimer);
      state.roomRejoinTimer = null;
    }
  };

  const clearReconnectTimer = () => {
    if (state.reconnectTimer) {
      OWP.timers.clear(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  const rejectRoomState = (roomId) => {
    if (!roomId || state.rejectedRejoinRoomIds.includes(roomId)) return;
    state.rejectedRejoinRoomIds.push(roomId);
    if (state.rejectedRejoinRoomIds.length > 8) state.rejectedRejoinRoomIds.shift();
  };

  const allowRoomState = (roomId) => {
    state.rejectedRejoinRoomIds = state.rejectedRejoinRoomIds.filter(id => id !== roomId);
  };

  const cancelRoomRejoin = (rejectInFlight = true) => {
    if (rejectInFlight && state.rejoinPending) rejectRoomState(state.desiredRoomId);
    clearRoomRejoinTimer();
    state.rejoinPending = false;
    state.desiredRoomId = '';
  };

  const completeRoomRejoin = (roomId) => {
    clearRoomRejoinTimer();
    state.rejoinPending = false;
    state.desiredRoomId = roomId;
    allowRoomState(roomId);
  };

  const failRoomRejoin = (message) => {
    if (!state.rejoinPending) return;
    const failedRoomId = state.desiredRoomId;
    clearRoomRejoinTimer();
    state.rejoinPending = false;
    state.desiredRoomId = '';
    rejectRoomState(failedRoomId);
    if (actions.resetRoomState) actions.resetRoomState();
    if (message && ui.showToast) ui.showToast(message);
    ui.render();
  };

  const scheduleRoomRejoinTimeout = (roomId, message) => {
    clearRoomRejoinTimer();
    state.roomRejoinTimer = OWP.timers.setTimeout(() => {
      state.roomRejoinTimer = null;
      if (state.rejoinPending && state.desiredRoomId === roomId) {
        failRoomRejoin(message);
      }
    }, ROOM_REJOIN_TIMEOUT_MS, 'connection');
  };

  const handleAuthenticatedConnection = () => {
    state.connectionPhase = 'authenticated';
    if (!state.rejoinPending || !state.desiredRoomId) return;
    const roomId = state.desiredRoomId;
    allowRoomState(roomId);
    actions.joinRoom(roomId, true);
    scheduleRoomRejoinTimeout(roomId, 'Could not rejoin the watch party');
  };

  const onWsOpen = (token, socket) => {
    if (socket !== state.ws) return;
    console.log('[OpenWatchParty] WebSocket connected');
    clearReconnectTimer();
    state.isConnecting = false;
    state.connectionPhase = token ? 'authenticating' : 'authenticated';
    state.reconnectAttempts = 0;
    if (utils.flushLogBuffer) utils.flushLogBuffer();
    const authPayload = {};
    if (token) authPayload.token = token;
    if (state.userName) authPayload.user_name = state.userName;
    if (state.userId) authPayload.user_id = state.userId;
    if (Object.keys(authPayload).length > 0) {
      socket.send(JSON.stringify({ type: 'auth', payload: authPayload, ts: utils.nowMs() }));
    }
    actions.send('ping', { client_ts: utils.nowMs() });
    schedulePing();
    if (!token) handleAuthenticatedConnection();
    else if (state.rejoinPending && state.desiredRoomId) {
      scheduleRoomRejoinTimeout(state.desiredRoomId, 'Could not reauthenticate the watch party connection');
    }
    ui.render();
  };

  const onWsClose = (e, socket) => {
    if (socket !== state.ws) return;
    console.log('[OpenWatchParty] WebSocket closed:', e.code, e.reason);
    state.ws = null;
    state.isConnecting = false;
    state.connectionPhase = 'disconnected';
    state.successfulPings = 0;
    state.timeSyncSamples = [];
    state.clientId = '';
    clearRoomRejoinTimer();
    if (state.inRoom) {
      if (state.isHost) {
        cancelRoomRejoin();
        if (actions.resetRoomState) actions.resetRoomState();
        if (ui.showToast) ui.showToast('The watch party closed when the host disconnected');
      } else {
        if (actions.normalizePlaybackRate) actions.normalizePlaybackRate();
        state.desiredRoomId = state.roomId;
        allowRoomState(state.desiredRoomId);
        state.rejoinPending = Boolean(state.desiredRoomId);
        state.inRoom = false;
        state.roomId = '';
        state.readyRoomId = '';
      }
    }
    ui.render();
    if (state.autoReconnect && !state.isConnecting) {
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempts),
        RECONNECT_MAX_MS
      );
      state.reconnectAttempts++;
      console.log(`[OpenWatchParty] Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})`);
      clearReconnectTimer();
      const expectedConnectionAttempt = state.connectionAttempt;
      state.reconnectTimer = OWP.timers.setTimeout(() => {
        state.reconnectTimer = null;
        if (expectedConnectionAttempt !== state.connectionAttempt || !state.autoReconnect) return;
        connect();
      }, delay, 'connection');
    }
  };

  const handleMessage = (msg) => {
    const video = utils.getVideo();
    console.log('[OpenWatchParty] Received:', msg.type, msg);
    const h = OWP._wsHandlers;
    switch (msg.type) {
      case 'room_list': h.handleRoomList(msg); break;
      case 'client_hello': h.handleClientHello(msg); break;
      case 'auth_success': h.handleAuthSuccess(msg); break;
      case 'room_state': h.handleRoomState(msg, video); break;
      case 'participants_update': h.handleParticipantsUpdate(msg); break;
      case 'client_left': h.handleClientLeft(msg); break;
      case 'room_closed': h.handleRoomClosed(msg); break;
      case 'player_event': h.handlePlayerEvent(msg, video); break;
      case 'state_update': h.handleStateUpdate(msg, video); break;
      case 'pong': h.handlePong(msg); break;
      case 'chat_message': if (OWP.chat && msg.payload) OWP.chat.receive(msg); break;
      case 'error': h.handleError(msg); break;
    }
  };

  const connect = async () => {
    if (state.isConnecting) {
      console.log('[OpenWatchParty] Connection already in progress, skipping');
      return;
    }
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      console.log('[OpenWatchParty] Already connected, skipping');
      return;
    }
    state.autoReconnect = true;
    clearReconnectTimer();
    const connectionAttempt = ++state.connectionAttempt;
    state.isConnecting = true;
    state.connectionPhase = 'connecting';
    if (state.ws) {
      const previousSocket = state.ws;
      state.ws = null;
      previousSocket.onopen = null;
      previousSocket.onclose = null;
      previousSocket.onerror = null;
      previousSocket.onmessage = null;
      previousSocket.close();
    }
    let token = state.authToken;
    if (!token) {
      token = await actions.fetchAuthToken();
    }
    if (connectionAttempt !== state.connectionAttempt || !state.autoReconnect) {
      return;
    }
    if (state.authBlocked) {
      state.isConnecting = false;
      if (ui.showToast) ui.showToast(state.authError || 'OpenWatchParty authentication is not configured');
      ui.render();
      return;
    }
    const wsUrl = state.wsUrl || DEFAULT_WS_URL;
    console.log('[OpenWatchParty] Connecting to WebSocket:', wsUrl);
    if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      console.warn('[OpenWatchParty] WARNING: Using insecure WebSocket (ws://) on HTTPS page. Data may be intercepted.');
    }
    try {
      state.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[OpenWatchParty] Failed to create WebSocket:', err);
      state.isConnecting = false;
      return;
    }
    const socket = state.ws;
    socket.onopen = () => onWsOpen(token, socket);
    socket.onerror = (err) => {
      if (socket !== state.ws) return;
      console.error('[OpenWatchParty] WebSocket error:', err);
      state.isConnecting = false;
    };
    socket.onclose = (event) => onWsClose(event, socket);
    socket.onmessage = (e) => {
      if (socket !== state.ws) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'room_state') {
          if (state.rejoinPending && state.desiredRoomId && msg.room !== state.desiredRoomId) {
            console.warn('[OpenWatchParty] Ignoring room_state for unexpected room:', msg.room);
            return;
          }
          if (!state.rejoinPending && state.rejectedRejoinRoomIds.includes(msg.room)) {
            console.warn('[OpenWatchParty] Ignoring late room_state after failed rejoin:', msg.room);
            return;
          }
        }
        if (!state.inRoom || msg.room === state.roomId || !msg.room || msg.type === 'room_state') {
          handleMessage(msg);
        }
      } catch (err) {
        console.error('[OpenWatchParty] Failed to parse message:', err.message, 'Data:', e.data?.substring?.(0, 100));
      }
    };
  };

  const disconnect = () => {
    state.autoReconnect = false;
    state.connectionAttempt++;
    state.authRequestAttempt++;
    clearReconnectTimer();
    cancelRoomRejoin();
    state.isConnecting = false;
    state.connectionPhase = 'disconnected';
    state.clientId = '';
    state.successfulPings = 0;
    state.timeSyncSamples = [];
    if (actions.resetRoomState) actions.resetRoomState();
    if (state.intervals.ping) {
      OWP.timers.clear(state.intervals.ping);
      state.intervals.ping = null;
    }
    const socket = state.ws;
    state.ws = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, 'OpenWatchParty client cleanup');
    }
  };

  const schedulePing = () => {
    if (state.intervals.ping) OWP.timers.clear(state.intervals.ping);
    const interval = state.successfulPings >= PING_STABLE_AFTER
      ? PING_STABLE_MS
      : PING_INIT_MS;
    state.intervals.ping = OWP.timers.setInterval(() => {
      if (state.ws && state.ws.readyState === 1) {
        actions.send('ping', { client_ts: utils.nowMs() });
      }
    }, interval, 'connection');
  };

  Object.assign(actions, {
    connect,
    schedulePing,
    handleAuthenticatedConnection,
    completeRoomRejoin,
    failRoomRejoin,
    cancelRoomRejoin,
    disconnect
  });
})();
