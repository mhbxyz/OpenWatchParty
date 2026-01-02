(() => {
  console.log("%c OpenSyncParty Plugin Loaded (OSD Mode) ", "background: #2e7d32; color: #fff; font-size: 12px; padding: 2px; border-radius: 2px;");
  
  const PANEL_ID = 'osp-panel';
  const BTN_ID = 'osp-osd-btn';
  const STYLE_ID = 'osp-style';
  
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const DEFAULT_WS_URL = `${protocol}//${host}:3001/ws`;
  const SUPPRESS_MS = 1000;

  // --- STATE ---
  const state = {
    ws: null,
    roomId: '',
    clientId: '',
    name: '',
    isHost: false,
    followHost: true,
    suppressUntil: 0,
    rooms: [], 
    inRoom: false,
    bound: false,
    autoReconnect: true
  };

  const nowMs = () => Date.now();
  const shouldSend = () => nowMs() > state.suppressUntil;
  const suppress = (ms = SUPPRESS_MS) => { state.suppressUntil = nowMs() + ms; };
  const getVideo = () => document.querySelector('video');

  // --- UI ---

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; bottom: 100px; right: 20px; width: 300px; max-height: 450px;
        padding: 16px; border-radius: 12px; background: rgba(10, 10, 10, 0.98);
        backdrop-filter: blur(20px); color: #fff; font-family: sans-serif; z-index: 20000;
        border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 12px 40px rgba(0,0,0,0.8);
        display: flex; flex-direction: column;
      }
      #${PANEL_ID}.hide { display: none; }
      .osp-header { font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 8px; }
      .osp-section { margin-bottom: 15px; overflow-y: auto; }
      .osp-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
      .osp-room-item { 
        background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 8px;
        display: flex; justify-content: space-between; align-items: center; cursor: pointer;
        border: 1px solid transparent; transition: all 0.2s;
      }
      .osp-room-item:hover { background: rgba(255,255,255,0.1); border-color: #1565c0; }
      .osp-btn { 
        border: none; border-radius: 6px; padding: 10px 15px; 
        background: #388e3c; color: #fff; cursor: pointer; font-weight: bold; font-size: 13px;
      }
      .osp-btn.secondary { background: #1565c0; }
      .osp-btn.danger { background: #d32f2f; }
      .osp-input { 
        width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444; 
        background: #000; color: #fff; box-sizing: border-box; margin-bottom: 10px; font-size: 14px;
      }
      .osp-footer { font-size: 10px; color: #555; text-align: center; margin-top: auto; padding-top: 10px; }
    `;
    document.head.appendChild(style);
  };

  const render = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    if (!state.inRoom) {
      panel.innerHTML = `
        <div class="osp-header"><span>OpenSyncParty</span> <span id="osp-ws-indicator"></span></div>
        <div class="osp-lobby-container">
            <div class="osp-section">
              <div class="osp-label">Available Rooms</div>
              <div id="osp-room-list"></div>
            </div>
            <div class="osp-section" style="border-top: 1px solid #333; padding-top: 15px;">
              <div class="osp-label">Create a Room</div>
              <input class="osp-input" id="osp-new-room-name" type="text" placeholder="e.g. Movie Night" />
              <button class="osp-btn" style="width:100%" id="osp-btn-create">Create & Host</button>
            </div>
        </div>
        <div class="osp-footer">Connected to: ${host}:3001</div>
      `;
      panel.querySelector('#osp-btn-create').onclick = createRoom;
      updateRoomListUI();
    } else {
      panel.innerHTML = `
        <div class="osp-header">
          <span style="color:#69f0ae">●</span>
          <span style="flex-grow:1; margin-left:8px;">${state.roomName}</span>
          <button class="osp-btn danger" id="osp-btn-leave">${state.isHost ? 'Close' : 'Leave'}</button>
        </div>
        <div class="osp-section">
          <div class="osp-label">Participants</div>
          <div id="osp-participants-list" style="font-size:13px;">Online: ${state.participantCount || 1}</div>
        </div>
        <div class="osp-meta" style="font-size:10px; color:#666; display:flex; justify-content:space-between;">
            <span>RTT: <span class="osp-latency">-</span></span>
            <span>ID: ${state.clientId.split('-')[1] || '...'}</span>
        </div>
      `;
      panel.querySelector('#osp-btn-leave').onclick = leaveRoom;
    }
    updateStatusIndicator();
  };

  const updateRoomListUI = () => {
    const roomList = document.getElementById('osp-room-list');
    if (!roomList) return;
    if (state.rooms.length === 0) {
        roomList.innerHTML = '<div style="font-size:12px; color:#555; padding: 10px; text-align:center;">No active rooms.</div>';
        return;
    }
    roomList.innerHTML = '';
    state.rooms.forEach(room => {
      const item = document.createElement('div');
      item.className = 'osp-room-item';
      item.innerHTML = `<div><div style="font-weight:bold">${room.name}</div><div style="font-size:10px; color:#888">${room.count} users</div></div><button class="osp-btn secondary">Join</button>`;
      item.onclick = () => joinRoom(room.id);
      roomList.appendChild(item);
    });
  };

  const updateStatusIndicator = () => {
      const el = document.getElementById('osp-ws-indicator');
      if (!el) return;
      const connected = state.ws && state.ws.readyState === 1;
      el.style.color = connected ? "#69f0ae" : "#ff5252";
      el.textContent = connected ? "Online" : "Offline";
  };

  // --- ACTIONS ---

  const createRoom = () => {
    const nameInput = document.getElementById('osp-new-room-name');
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) return;
    const v = getVideo();
    send('create_room', { name: name, start_pos: v ? v.currentTime : 0 });
  };

  const joinRoom = (id) => {
    state.roomId = id;
    send('join_room', {}, id);
  };

  const leaveRoom = () => {
    send('leave_room');
    state.inRoom = false;
    state.roomId = '';
    render();
  };

  const connect = () => {
    if (state.ws) state.ws.close();
    state.ws = new WebSocket(DEFAULT_WS_URL);
    state.ws.onopen = () => { render(); };
    state.ws.onclose = () => { render(); if(state.autoReconnect) setTimeout(connect, 3000); };
    state.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // CRITICAL FIX: Accept messages if we are in the room, OR if it's a room list, OR if it's the room state we just requested
        if (!state.inRoom || msg.room === state.roomId || !msg.room || msg.type === 'room_state') {
            handleMessage(msg);
        }
      } catch (err) {}
    };
  };

  const handleMessage = (msg) => {
    const video = getVideo();
    console.log('[OpenSyncParty] Received:', msg.type, msg);

    switch (msg.type) {
      case "room_list":
        state.rooms = msg.payload || [];
        if (!state.inRoom) updateRoomListUI();
        break;

      case "client_hello":
        if (msg.payload && msg.payload.client_id) {
          state.clientId = msg.payload.client_id;
          render();
        }
        break;

      case "room_state":
        state.inRoom = true;
        state.roomId = msg.room; // Store the new room ID
        state.roomName = msg.payload.name;
        state.participantCount = msg.payload.participant_count;
        if (!state.clientId && msg.client) {
          state.clientId = msg.client;
        }
        state.isHost = (msg.payload.host_id === state.clientId);
        render();
        if (video && !state.isHost && msg.payload.state) {
          suppress(); video.currentTime = msg.payload.state.position;
        }
        break;

      case "participants_update":
        state.participantCount = msg.payload.participant_count;
        if (state.inRoom) {
            const el = document.getElementById('osp-participants-list');
            if(el) el.textContent = `Online: ${state.participantCount}`;
        }
        break;

      case "room_closed":
        state.inRoom = false; state.roomId = ''; render();
        break;

      case "player_event":
        if (state.isHost || !video) return;
        suppress();
        if (msg.payload.action === 'play') video.play().catch(()=>{});
        else if (msg.payload.action === 'pause') video.pause();
        else if (msg.payload.action === 'seek') video.currentTime = msg.payload.position;
        break;
        
      case "state_update":
        if (state.isHost || !video) return;
        if (Math.abs(video.currentTime - msg.payload.position) > 3.0) {
          suppress(); video.currentTime = msg.payload.position;
        }
        break;

      case "pong":
        if (msg.payload && msg.payload.client_ts) {
          const rtt = nowMs() - msg.payload.client_ts;
          const latEl = document.querySelector('.osp-latency');
          if(latEl) latEl.textContent = `${rtt} ms`;
        }
        break;
    }
  };

  const send = (type, payload = {}, roomOverride = null) => {
    if (!state.ws || state.ws.readyState !== 1) return;
    const message = {
      type,
      room: roomOverride || state.roomId,
      payload,
      ts: nowMs()
    };
    if (state.clientId) message.client = state.clientId;
    state.ws.send(JSON.stringify(message));
  };

  // --- BOOTSTRAP ---

  const injectOsdButton = () => {
    if (document.getElementById(BTN_ID)) return;
    const buttonsContainer = document.querySelector('.videoOsdBottom .buttons');
    if (!buttonsContainer) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.style.cssText = 'color: #fff !important; opacity: 1 !important; z-index: 9999;';
    btn.innerHTML = '<span class="material-icons groups" aria-hidden="true"></span>';
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) render();
    };
    buttonsContainer.insertBefore(btn, buttonsContainer.firstChild);
  };

  const bindVideo = () => {
    const video = getVideo();
    if (!video || state.bound) return;
    state.bound = true;
    const onEvent = (action) => {
      if (!state.isHost || !shouldSend()) return;
      send('player_event', { action, position: video.currentTime });
    };
    video.addEventListener('play', () => onEvent('play'));
    video.addEventListener('pause', () => onEvent('pause'));
    video.addEventListener('seeked', () => onEvent('seek'));
    setInterval(() => {
      if (state.isHost && state.ws && state.ws.readyState === 1 && !video.paused) {
        send('state_update', { position: video.currentTime, play_state: 'playing' });
      }
    }, 5000);
  };

  const init = () => {
    injectStyles();
    if (!document.getElementById(PANEL_ID)) {
        const panel = document.createElement('div');
        panel.id = PANEL_ID; panel.className = 'hide';
        document.body.appendChild(panel);
    }
    connect();
    setInterval(() => { injectOsdButton(); if (getVideo()) bindVideo(); }, 1000);
    setInterval(() => { if(state.ws && state.ws.readyState === 1) send('ping', {client_ts: nowMs()}); }, 3000);
  };

  init();
})();
