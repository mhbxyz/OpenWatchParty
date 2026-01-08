(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.actions) return;

  const { DEFAULT_WS_URL, SEEK_THRESHOLD } = OWP.constants;
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;

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
    const nameInput = document.getElementById('owp-new-room-name');
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
      if (!apiClient || typeof apiClient.accessToken !== 'function') {
        console.warn('[OpenWatchParty] ApiClient not available, auth disabled');
        return null;
      }

      const accessToken = apiClient.accessToken();
      if (!accessToken) {
        console.warn('[OpenWatchParty] No access token available, user may not be logged in');
        return null;
      }

      // Build the token URL
      const serverAddress = typeof apiClient.serverAddress === 'function' ? apiClient.serverAddress() : '';
      const tokenUrl = `${serverAddress}/OpenWatchParty/Token`;

      // Fetch with Jellyfin auth headers
      const response = await fetch(tokenUrl, {
        headers: {
          'X-Emby-Token': accessToken
        }
      });

      if (!response.ok) {
        console.warn('[OpenWatchParty] Failed to fetch auth token:', response.status);
        return null;
      }

      const data = await response.json();
      state.authEnabled = data.auth_enabled || false;
      state.userId = data.user_id || '';
      state.userName = data.user_name || '';

      if (data.auth_enabled && data.token) {
        state.authToken = data.token;
        console.log('[OpenWatchParty] Auth token obtained for user:', state.userName);
        return data.token;
      }

      console.log('[OpenWatchParty] Server auth disabled, connecting without token');
      return null;
    } catch (err) {
      console.warn('[OpenWatchParty] Error fetching auth token:', err);
      return null;
    }
  };

  const connect = async () => {
    if (state.ws) state.ws.close();

    // Reuse existing token if we have one (avoid rate limiting on reconnects)
    let token = state.authToken;
    if (!token) {
      token = await fetchAuthToken();
    }

    // Connect without token in URL (security: avoid token in logs/history)
    const wsUrl = DEFAULT_WS_URL;
    console.log('[OpenWatchParty] Connecting to WebSocket:', wsUrl);

    // Security warning for non-secure WebSocket
    if (wsUrl.startsWith('ws://') && window.location.protocol === 'https:') {
      console.warn('[OpenWatchParty] WARNING: Using insecure WebSocket (ws://) on HTTPS page. Data may be intercepted.');
    }

    try {
      state.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[OpenWatchParty] Failed to create WebSocket:', err);
      return;
    }

    state.ws.onopen = () => {
      console.log('[OpenWatchParty] WebSocket connected');
      // Send auth message after connection (secure: token not in URL)
      if (token) {
        state.ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
      }
      ui.render();
    };
    state.ws.onerror = (err) => {
      console.error('[OpenWatchParty] WebSocket error:', err);
    };
    state.ws.onclose = (e) => {
      console.log('[OpenWatchParty] WebSocket closed:', e.code, e.reason);
      ui.render();
      if (state.autoReconnect) setTimeout(connect, 3000);
    };
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
    console.log('[OpenWatchParty] Received:', msg.type, msg);

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
          if (OWP.playback && OWP.playback.ensurePlayback) {
            OWP.playback.ensurePlayback(msg.payload.media_id);
            if (OWP.playback.watchReady) OWP.playback.watchReady();
          }
        }
        break;

      case 'participants_update':
        state.participantCount = msg.payload.participant_count;
        if (state.inRoom) {
          const el = document.getElementById('owp-participants-list');
          if (el) el.textContent = `Online: ${state.participantCount}`;
        }
        if (state.lastParticipantCount && state.participantCount > state.lastParticipantCount) {
          ui.showToast('A participant joined the room');
        }
        state.lastParticipantCount = state.participantCount;
        break;

      case 'room_closed':
        state.inRoom = false; state.roomId = '';
        const reason = msg.payload?.reason || 'The room was closed';
        ui.showToast(reason);  // Show notification when room closes (fixes M-UX08)
        ui.render();
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
          const latEl = document.querySelector('.owp-latency');
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

  OWP.actions = {
    send,
    createRoom,
    joinRoom,
    leaveRoom,
    connect
  };
})();
