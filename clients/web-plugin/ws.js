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
    const v = utils.getVideo();
    const mediaId = utils.getCurrentItemId();
    send('create_room', { start_pos: v ? v.currentTime : 0, media_id: mediaId });
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

      // Store quality settings from server config
      if (data.quality) {
        state.quality.maxBitrate = data.quality.default_max_bitrate || 0;
        state.quality.preferDirectPlay = data.quality.prefer_direct_play !== false;
        state.quality.allowHostControl = data.quality.allow_host_quality_control !== false;
        console.log('[OpenWatchParty] Quality settings:', state.quality);
      }

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
    // Guard against multiple simultaneous connection attempts
    if (state.isConnecting) {
      console.log('[OpenWatchParty] Connection already in progress, skipping');
      return;
    }

    // Guard against reconnecting if already connected
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      console.log('[OpenWatchParty] Already connected, skipping');
      return;
    }

    state.isConnecting = true;

    // Close existing connection cleanly (disable auto-reconnect during intentional close)
    if (state.ws) {
      const wasAutoReconnect = state.autoReconnect;
      state.autoReconnect = false;
      state.ws.close();
      state.ws = null;
      state.autoReconnect = wasAutoReconnect;
    }

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
      state.isConnecting = false;
      return;
    }

    state.ws.onopen = () => {
      console.log('[OpenWatchParty] WebSocket connected');
      state.isConnecting = false;
      // Flush any buffered logs now that we're connected
      if (utils.flushLogBuffer) utils.flushLogBuffer();
      // Send auth/identity message after connection
      // Include username even without JWT token so server knows who we are
      const authPayload = {};
      if (token) authPayload.token = token;
      if (state.userName) authPayload.user_name = state.userName;
      if (state.userId) authPayload.user_id = state.userId;
      if (Object.keys(authPayload).length > 0) {
        state.ws.send(JSON.stringify({ type: 'auth', payload: authPayload, ts: utils.nowMs() }));
      }
      ui.render();
    };
    state.ws.onerror = (err) => {
      console.error('[OpenWatchParty] WebSocket error:', err);
      state.isConnecting = false;
    };
    state.ws.onclose = (e) => {
      console.log('[OpenWatchParty] WebSocket closed:', e.code, e.reason);
      state.isConnecting = false;
      ui.render();
      // Only auto-reconnect if flag is set and not already connecting
      if (state.autoReconnect && !state.isConnecting) {
        setTimeout(connect, 3000);
      }
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
          utils.log('CLIENT', {
            type: 'room_state',
            msg_pos: basePos,
            target_pos: targetPos,
            video_pos: video.currentTime,
            gap: targetPos - video.currentTime,
            play_state: msg.payload.state.play_state
          });
          utils.startSyncing();
          if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
            video.currentTime = targetPos;
            // Update sync state to match our seek target - prevents drift chase
            // after buffering (otherwise syncLoop sees drift from old server_ts)
            state.lastSyncServerTs = utils.getServerNow();
            state.lastSyncPosition = targetPos;
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
          const action = msg.payload.action;
          // For seek/buffering: use exact HOST position (both should start at same point)
          // For play: use adjusted position to compensate for network latency
          const targetPos = (action === 'seek' || action === 'buffering')
            ? msg.payload.position
            : utils.adjustedPosition(msg.payload.position, msg.server_ts);
          const serverNow = utils.getServerNow();
          const gap = targetPos - video.currentTime;

          utils.log('CLIENT', {
            action,
            msg_pos: msg.payload.position,
            target_pos: targetPos,
            video_pos: video.currentTime,
            gap
          });

          // Big seek: pause first to prevent playing stale content, then seek
          if (Math.abs(gap) > SEEK_THRESHOLD) {
            video.pause();
            video.currentTime = targetPos;
            state.lastSyncServerTs = serverNow;
            state.lastSyncPosition = targetPos;
          } else {
            // Small gap: just update sync state with client position
            state.lastSyncServerTs = serverNow;
            state.lastSyncPosition = video.currentTime;
          }
        }

        if (msg.payload) {
          if (msg.payload.action === 'play') {
            state.lastSyncPlayState = 'playing';
            // Use HOST's position/timestamp as sync baseline
            // syncLoop will handle catch-up via playback rate adjustment
            state.lastSyncServerTs = msg.server_ts;
            state.lastSyncPosition = msg.payload.position;
            // Set cooldown: let syncLoop catch up via playback rate
            state.syncCooldownUntil = utils.nowMs() + 5000;
            video.play().catch(() => {});

          } else if (msg.payload.action === 'pause') {
            state.lastSyncPlayState = 'paused';
            state.syncCooldownUntil = 0;  // Clear cooldown on pause
            // Pause immediately, no scheduling delay
            video.pause();

          } else if (msg.payload.action === 'seek') {
            // Use play_state from message if available, otherwise assume paused
            const hostPlayState = msg.payload.play_state || 'paused';
            state.lastSyncPlayState = hostPlayState;
            if (hostPlayState === 'playing') {
              // HOST is playing after seek - resume playback
              state.syncCooldownUntil = utils.nowMs() + 5000;
              video.play().catch(() => {});
            }

          } else if (msg.payload.action === 'buffering') {
            // Host is buffering - pause and wait for seek/play event
            state.lastSyncPlayState = 'paused';
            // Don't clear cooldown - we'll get a play event soon and need protection
            video.pause();
          }
        }
        break;
        
      case 'state_update':
        if (state.isHost || !video) return;
        // Always update play state
        if (msg.payload) {
          state.lastSyncPlayState = msg.payload.play_state || state.lastSyncPlayState;
        }
        // Handle play/pause BEFORE buffering check - browser queues play() during buffering
        if (msg.payload.play_state === 'playing' && video.paused) {
          utils.startSyncing();
          video.play().catch(() => {});
          // Establish sync baseline at CLIENT's current position when resuming
          // This prevents immediate HARD_SEEK after buffering - syncLoop will use
          // playback rate to catch up gradually.
          state.lastSyncServerTs = utils.getServerNow();
          state.lastSyncPosition = video.currentTime;
          // Set cooldown: ignore position updates for 3s to let syncLoop catch up
          // via playback rate instead of triggering HARD_SEEK from stale HOST position
          state.syncCooldownUntil = utils.nowMs() + 5000;
          return;  // Don't update position in this message - let video start playing first
        } else if (msg.payload.play_state === 'paused' && !video.paused) {
          utils.startSyncing();
          state.syncCooldownUntil = 0;  // Clear cooldown on pause
          video.pause();
        }
        // Don't update position sync state while buffering - this prevents the seek loop
        // where syncLoop sees huge drift after buffering because state_update kept
        // advancing lastSyncPosition while video was stuck loading
        if (state.isBuffering || !utils.isVideoReady()) return;
        // Skip position updates during cooldown after resume - let syncLoop handle drift
        // via playback rate instead of jumping to HOST position immediately
        if (state.syncCooldownUntil && utils.nowMs() < state.syncCooldownUntil) {
          return;
        }
        // Update position sync state only when video is ready and playing
        if (msg.payload) {
          state.lastSyncServerTs = msg.server_ts || utils.getServerNow();
          state.lastSyncPosition = msg.payload.position || state.lastSyncPosition;
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
            const prevOffset = state.serverOffsetMs;
            state.serverOffsetMs = state.hasTimeSync
              ? (state.serverOffsetMs * 0.6 + sampleOffset * 0.4)
              : sampleOffset;
            state.hasTimeSync = true;
            // Log clock sync periodically (every ~10 pings to reduce noise)
            if (Math.random() < 0.1) {
              utils.log('CLOCK', { rtt, server_offset: state.serverOffsetMs, delta: state.serverOffsetMs - prevOffset });
            }
          }
        }
        break;

      case 'quality_update':
        // Host broadcasts quality settings to guests
        if (!state.isHost && msg.payload) {
          state.roomQuality = {
            maxBitrate: msg.payload.maxBitrate || 0,
            preferDirectPlay: msg.payload.preferDirectPlay !== false,
            preset: msg.payload.preset || 'auto'
          };
          console.log('[OpenWatchParty] Quality updated by host:', state.roomQuality);
          ui.render(true);  // Force re-render to update quality display
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
