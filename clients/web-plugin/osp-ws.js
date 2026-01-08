(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.actions) return;

  const { DEFAULT_WS_URL, SEEK_THRESHOLD } = OSP.constants;
  const state = OSP.state;
  const utils = OSP.utils;
  const ui = OSP.ui;

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
    const nameInput = document.getElementById('osp-new-room-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) return;
    const v = utils.getVideo();
    const mediaId = utils.getCurrentItemId();
    send('create_room', { name: name, start_pos: v ? v.currentTime : 0, media_id: mediaId });
  };

  const joinRoom = (id) => {
    state.roomId = id;
    send('join_room', {}, id);
  };

  const leaveRoom = () => {
    send('leave_room');
    state.inRoom = false;
    state.roomId = '';
    state.readyRoomId = '';
    ui.render();
  };

  const fetchAuthToken = async () => {
    try {
      // Get the Jellyfin API client
      const apiClient = window.ApiClient;
      if (!apiClient) {
        console.warn('[OpenSyncParty] ApiClient not available, auth disabled');
        return null;
      }

      // Build the token URL
      const serverAddress = apiClient.serverAddress ? apiClient.serverAddress() : '';
      const tokenUrl = `${serverAddress}/OpenSyncParty/Token`;

      // Fetch with Jellyfin auth headers
      const response = await fetch(tokenUrl, {
        headers: {
          'X-Emby-Token': apiClient.accessToken(),
          'X-Emby-Authorization': apiClient._authorizationHeader || ''
        }
      });

      if (!response.ok) {
        console.warn('[OpenSyncParty] Failed to fetch auth token:', response.status);
        return null;
      }

      const data = await response.json();
      state.authEnabled = data.auth_enabled || false;
      state.userId = data.user_id || '';
      state.userName = data.user_name || '';

      if (data.auth_enabled && data.token) {
        state.authToken = data.token;
        console.log('[OpenSyncParty] Auth token obtained for user:', state.userName);
        return data.token;
      }

      console.log('[OpenSyncParty] Server auth disabled, connecting without token');
      return null;
    } catch (err) {
      console.warn('[OpenSyncParty] Error fetching auth token:', err);
      return null;
    }
  };

  const connect = async () => {
    if (state.ws) state.ws.close();

    // Fetch auth token before connecting
    const token = await fetchAuthToken();

    // Build WebSocket URL with token if available
    let wsUrl = DEFAULT_WS_URL;
    if (token) {
      wsUrl = `${DEFAULT_WS_URL}?token=${encodeURIComponent(token)}`;
    }

    // Security warning for non-secure WebSocket
    if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      console.warn('[OpenSyncParty] WARNING: Using insecure WebSocket (ws://) on HTTPS page. Data may be intercepted.');
    } else if (wsUrl.startsWith('ws://')) {
      console.warn('[OpenSyncParty] Using insecure WebSocket (ws://). Consider using wss:// in production.');
    }

    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { ui.render(); };
    state.ws.onclose = () => { ui.render(); if (state.autoReconnect) setTimeout(connect, 3000); };
    state.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!state.inRoom || msg.room === state.roomId || !msg.room || msg.type === 'room_state') {
          handleMessage(msg);
        }
      } catch (err) {}
    };
  };

  const handleMessage = (msg) => {
    const video = utils.getVideo();
    console.log('[OpenSyncParty] Received:', msg.type, msg);

    switch (msg.type) {
      case 'room_list':
        state.rooms = msg.payload || [];
        if (!state.inRoom) ui.updateRoomListUI();
        ui.renderHomeWatchParties();
        break;

      case 'client_hello':
        if (msg.payload && msg.payload.client_id) {
          state.clientId = msg.payload.client_id;
          ui.render();
        }
        break;

      case 'room_state':
        state.inRoom = true;
        state.roomId = msg.room;
        state.roomName = msg.payload.name;
        state.participantCount = msg.payload.participant_count;
        if (!state.clientId && msg.client) {
          state.clientId = msg.client;
        }
        state.isHost = (msg.payload.host_id === state.clientId);
        if (!state.hasTimeSync && typeof msg.server_ts === 'number') {
          state.serverOffsetMs = msg.server_ts - utils.nowMs();
          state.hasTimeSync = true;
        }
        if (msg.payload && msg.payload.state) {
          state.lastSyncServerTs = msg.server_ts || utils.getServerNow();
          state.lastSyncPosition = msg.payload.state.position || 0;
          state.lastSyncPlayState = msg.payload.state.play_state || 'paused';
        }
        ui.render();
        if (video && !state.isHost && msg.payload && msg.payload.state) {
          const basePos = msg.payload.state.position || 0;
          const targetPos = utils.adjustedPosition(basePos, msg.server_ts);
          utils.startSyncing();
          if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
            video.currentTime = targetPos;
          }
          if (msg.payload.state.play_state === 'playing') {
            video.play().catch(() => {});
          } else if (msg.payload.state.play_state === 'paused') {
            video.pause();
          }
        }
        if (!state.isHost && msg.payload && msg.payload.media_id) {
          if (OSP.playback && OSP.playback.ensurePlayback) {
            OSP.playback.ensurePlayback(msg.payload.media_id);
            if (OSP.playback.watchReady) OSP.playback.watchReady();
          }
        }
        break;

      case 'participants_update':
        state.participantCount = msg.payload.participant_count;
        if (state.inRoom) {
          const el = document.getElementById('osp-participants-list');
          if (el) el.textContent = `Online: ${state.participantCount}`;
        }
        if (state.lastParticipantCount && state.participantCount > state.lastParticipantCount) {
          ui.showToast('A participant joined the room');
        }
        state.lastParticipantCount = state.participantCount;
        break;

      case 'room_closed':
        state.inRoom = false; state.roomId = ''; ui.render();
        break;

      case 'player_event':
        if (state.isHost || !video) return;
        utils.startSyncing();
        if (msg.payload && typeof msg.payload.position === 'number') {
          const targetPos = utils.adjustedPosition(msg.payload.position, msg.server_ts);
          if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
            video.currentTime = targetPos;
          }
        }
        if (msg.payload) {
          const targetServerTs = msg.payload.target_server_ts || msg.server_ts;
          if (typeof msg.payload.position === 'number' && typeof targetServerTs === 'number') {
            state.lastSyncServerTs = targetServerTs;
            state.lastSyncPosition = msg.payload.position;
          }
          if (msg.payload.action === 'play') {
            state.lastSyncPlayState = 'playing';
            const serverNow = utils.getServerNow();
            const delay = typeof targetServerTs === 'number' ? targetServerTs - serverNow : 0;
            if (delay > 0) {
              utils.scheduleAt(targetServerTs, () => video.play().catch(() => {}));
            } else {
              const timeLost = Math.abs(delay) / 1000;
              if (typeof msg.payload.position === 'number') {
                video.currentTime = msg.payload.position + timeLost;
              }
              video.play().catch(() => {});
            }
          } else if (msg.payload.action === 'pause') {
            state.lastSyncPlayState = 'paused';
            utils.scheduleAt(targetServerTs, () => video.pause());
          } else if (msg.payload.action === 'seek' && typeof msg.payload.position === 'number') {
            const targetPos = utils.adjustedPosition(msg.payload.position, targetServerTs);
            utils.scheduleAt(targetServerTs, () => {
              if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
                video.currentTime = targetPos;
              }
            });
          }
        }
        break;
        
      case 'state_update':
        if (state.isHost || !video) return;
        if (msg.payload && typeof msg.payload.position === 'number') {
          const targetPos = utils.adjustedPosition(msg.payload.position, msg.server_ts);
          if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
            utils.startSyncing();
            video.currentTime = targetPos;
          }
        }
        if (msg.payload.play_state === 'playing' && video.paused) {
          utils.startSyncing();
          video.play().catch(() => {});
        } else if (msg.payload.play_state === 'paused' && !video.paused) {
          utils.startSyncing();
          video.pause();
        }
        if (msg.payload) {
          state.lastSyncServerTs = msg.server_ts || utils.getServerNow();
          state.lastSyncPosition = msg.payload.position || state.lastSyncPosition;
          state.lastSyncPlayState = msg.payload.play_state || state.lastSyncPlayState;
        }
        break;

      case 'pong':
        if (msg.payload && msg.payload.client_ts) {
          const now = utils.nowMs();
          const rtt = now - msg.payload.client_ts;
          const latEl = document.querySelector('.osp-latency');
          if (latEl) latEl.textContent = `${rtt} ms`;
          if (typeof msg.server_ts === 'number' && rtt > 0) {
            const sampleOffset = msg.server_ts + (rtt / 2) - now;
            state.serverOffsetMs = state.hasTimeSync
              ? (state.serverOffsetMs * 0.6 + sampleOffset * 0.4)
              : sampleOffset;
            state.hasTimeSync = true;
          }
        }
        break;
    }
  };

  OSP.actions = {
    send,
    createRoom,
    joinRoom,
    leaveRoom,
    connect
  };
})();
