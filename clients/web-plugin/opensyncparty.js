(() => {
  const PANEL_ID = 'osp-watchparty-panel';
  const TOGGLE_ID = 'osp-watchparty-toggle';
  const STYLE_ID = 'osp-watchparty-style';
  const DEFAULT_WS_URL = 'ws://localhost:8999/ws';

  const state = {
    ws: null,
    roomId: '',
    clientId: '',
    isHost: false,
    followHost: true,
    suppressUntil: 0,
    pingTimer: null,
    bound: false
  };

  const nowMs = () => Date.now();
  const shouldSend = () => nowMs() > state.suppressUntil;
  const suppress = (ms) => {
    state.suppressUntil = nowMs() + ms;
  };

  const getVideo = () => document.querySelector('video');

  const setStatus = (text) => {
    const el = document.querySelector('.osp-status');
    if (el) el.textContent = text;
  };

  const setLatency = (text) => {
    const el = document.querySelector('.osp-latency');
    if (el) el.textContent = text;
  };

  const setHost = (text) => {
    const el = document.querySelector('.osp-host');
    if (el) el.textContent = text;
  };

  const send = (type, payload = {}) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type,
      room: state.roomId,
      client: state.clientId,
      payload,
      ts: nowMs()
    }));
  };

  const handleMessage = (msg) => {
    const payload = msg.payload || {};
    const video = getVideo();
    if (!video) return;

    if (msg.type === 'pong') {
      if (payload.client_ts) {
        const rtt = nowMs() - payload.client_ts;
        setLatency(`${Math.max(0, Math.round(rtt))} ms`);
      }
      return;
    }

    if (msg.type === 'invite_created') {
      const inviteInput = document.querySelector('.osp-invite');
      if (inviteInput) inviteInput.value = payload.invite_token || '';
      return;
    }

    if (msg.type === 'room_state') {
      setHost(payload.host_id || '-');
      if (payload.state && typeof payload.state.position === 'number' && state.followHost) {
        suppress(400);
        video.currentTime = payload.state.position;
      }
      return;
    }

    if (msg.type === 'player_event' && state.followHost) {
      const action = payload.action;
      suppress(400);
      if (action === 'play') {
        video.play().catch(() => {});
      } else if (action === 'pause') {
        video.pause();
      } else if (action === 'seek' && typeof payload.position === 'number') {
        video.currentTime = payload.position;
      }
      return;
    }

    if (msg.type === 'state_update' && state.followHost) {
      if (typeof payload.position === 'number') {
        suppress(400);
        video.currentTime = payload.position;
      }
      if (payload.play_state === 'playing') {
        suppress(400);
        video.play().catch(() => {});
      }
      if (payload.play_state === 'paused') {
        suppress(400);
        video.pause();
      }
    }
  };

  const startPing = () => {
    stopPing();
    state.pingTimer = setInterval(() => {
      send('ping', { client_ts: nowMs() });
    }, 3000);
  };

  const stopPing = () => {
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  };

  const connect = () => {
    const wsInput = document.querySelector('.osp-ws');
    const roomInput = document.querySelector('.osp-room');
    const nameInput = document.querySelector('.osp-name');
    const authInput = document.querySelector('.osp-auth');

    if (!wsInput || !roomInput || !nameInput) return;
    state.roomId = roomInput.value.trim();
    if (!state.roomId) {
      setStatus('Room ID required');
      return;
    }
    if (!state.clientId) {
      state.clientId = `client-${nowMs()}`;
    }

    state.ws = new WebSocket(wsInput.value.trim() || DEFAULT_WS_URL);
    state.ws.addEventListener('open', () => {
      setStatus('Connected');
      startPing();
    });
    state.ws.addEventListener('close', () => {
      setStatus('Disconnected');
      stopPing();
      setLatency('-');
    });
    state.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || msg.room !== state.roomId) return;
      handleMessage(msg);
    });

    if (authInput) {
      authInput.dataset.token = authInput.value.trim();
    }
  };

  const createRoom = () => {
    const video = getVideo();
    const nameInput = document.querySelector('.osp-name');
    const authInput = document.querySelector('.osp-auth');
    state.isHost = true;
    state.followHost = false;
    const followToggle = document.querySelector('.osp-follow');
    if (followToggle) followToggle.checked = false;
    send('create_room', {
      media_url: video ? video.currentSrc : '',
      start_pos: video ? video.currentTime : 0,
      name: nameInput ? nameInput.value.trim() : 'Host',
      auth_token: authInput ? authInput.value.trim() : undefined,
      options: { free_play: false }
    });
  };

  const joinRoom = () => {
    const nameInput = document.querySelector('.osp-name');
    const authInput = document.querySelector('.osp-auth');
    const inviteInput = document.querySelector('.osp-invite');
    state.isHost = false;
    state.followHost = true;
    const followToggle = document.querySelector('.osp-follow');
    if (followToggle) followToggle.checked = true;
    send('join_room', {
      name: nameInput ? nameInput.value.trim() : 'Guest',
      auth_token: authInput ? authInput.value.trim() : undefined,
      invite_token: inviteInput ? inviteInput.value.trim() : undefined
    });
  };

  const createInvite = () => {
    const authInput = document.querySelector('.osp-auth');
    send('create_invite', { expires_in: 3600, auth_token: authInput ? authInput.value.trim() : undefined });
  };

  const bindVideo = () => {
    if (state.bound) return;
    const video = getVideo();
    if (!video) return;
    state.bound = true;

    video.addEventListener('play', () => {
      if (!state.isHost || !shouldSend()) return;
      send('player_event', { action: 'play', position: video.currentTime });
    });
    video.addEventListener('pause', () => {
      if (!state.isHost || !shouldSend()) return;
      send('player_event', { action: 'pause', position: video.currentTime });
    });
    video.addEventListener('seeking', () => {
      if (!state.isHost || !shouldSend()) return;
      send('player_event', { action: 'seek', position: video.currentTime });
    });
  };

  const createPanel = () => {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'hide';
    panel.innerHTML = `
      <div class="osp-title">Watch Party</div>
      <input class="osp-input osp-ws" type="text" placeholder="WS URL" value="${DEFAULT_WS_URL}" />
      <input class="osp-input osp-room" type="text" placeholder="Room ID" />
      <input class="osp-input osp-name" type="text" placeholder="Display name" />
      <input class="osp-input osp-auth" type="text" placeholder="Auth token (JWT)" />
      <input class="osp-input osp-invite" type="text" placeholder="Invite token (JWT)" />
      <div class="osp-row">
        <button class="osp-btn osp-connect">Connect</button>
        <button class="osp-btn osp-invite-btn">Create invite</button>
      </div>
      <div class="osp-row">
        <button class="osp-btn osp-create">Create room</button>
        <button class="osp-btn osp-join">Join room</button>
      </div>
      <label class="osp-toggle">
        <input class="osp-follow" type="checkbox" checked /> Follow host
      </label>
      <div class="osp-status">Disconnected</div>
      <div class="osp-meta">Host: <span class="osp-host">-</span> | RTT: <span class="osp-latency">-</span></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.osp-connect').addEventListener('click', connect);
    panel.querySelector('.osp-create').addEventListener('click', createRoom);
    panel.querySelector('.osp-join').addEventListener('click', joinRoom);
    panel.querySelector('.osp-invite-btn').addEventListener('click', createInvite);
    panel.querySelector('.osp-follow').addEventListener('change', (e) => {
      state.followHost = e.target.checked;
    });
  };

  const createToggle = () => {
    if (document.getElementById(TOGGLE_ID)) return;
    const target = document.querySelector('.btnVideoOsdSettings') || document.querySelector('.videoOsdBottom .buttons');
    if (!target) return;
    const btn = document.createElement('button');
    btn.id = TOGGLE_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.setAttribute('title', 'Watch Party');
    btn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">group</span>';
    btn.addEventListener('click', () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.classList.toggle('hide');
    });
    target.parentNode.insertBefore(btn, target.nextSibling);
  };

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 20px;
        bottom: 140px;
        width: 280px;
        padding: 12px;
        border-radius: 10px;
        background: rgba(20, 20, 20, 0.9);
        color: #fff;
        font-size: 13px;
        z-index: 9999;
      }
      #${PANEL_ID}.hide { display: none; }
      #${PANEL_ID} .osp-title { font-weight: 600; margin-bottom: 8px; }
      #${PANEL_ID} .osp-input {
        width: 100%; margin: 4px 0; padding: 6px 8px; border-radius: 6px;
        border: 1px solid #3a3a3a; background: #101010; color: #fff;
      }
      #${PANEL_ID} .osp-row { display: flex; gap: 6px; margin-top: 6px; }
      #${PANEL_ID} .osp-btn {
        flex: 1; border: none; border-radius: 6px; padding: 6px 8px;
        background: #2e7d32; color: #fff; cursor: pointer;
      }
      #${PANEL_ID} .osp-invite-btn { background: #1565c0; }
      #${PANEL_ID} .osp-toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
      #${PANEL_ID} .osp-status { margin-top: 6px; font-size: 12px; color: #ccc; }
      #${PANEL_ID} .osp-meta { margin-top: 4px; font-size: 12px; color: #aaa; }
    `;
    document.head.appendChild(style);
  };

  const init = () => {
    createPanel();
    createToggle();
    injectStyles();
    bindVideo();
  };

  const observer = new MutationObserver(() => {
    init();
  });

  const start = () => {
    init();
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
