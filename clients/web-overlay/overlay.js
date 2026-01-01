(() => {
  const DEFAULT_WS_URL = "ws://localhost:8999/ws";
  const SUPPRESS_MS = 400;

  const state = {
    ws: null,
    roomId: "",
    name: "",
    clientId: "",
    isHost: false,
    followHost: true,
    suppressUntil: 0,
    pingTimer: null,
    lastPingAt: 0,
    latency: null,
    video: null,
  };

  const randomId = () => {
    if (crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `client-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  };

  const byId = (id) => document.getElementById(id);

  const setStatus = (text, kind = "info") => {
    const el = byId("osp-status");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  };

  const setLatency = (ms) => {
    const el = byId("osp-latency");
    if (!el) return;
    el.textContent = ms === null ? "-" : `${ms} ms`;
    state.latency = ms;
  };

  const findVideo = () => {
    if (state.video && document.contains(state.video)) {
      return state.video;
    }
    state.video = document.querySelector("video");
    return state.video;
  };

  const shouldSend = () => Date.now() > state.suppressUntil;

  const suppressEvents = () => {
    state.suppressUntil = Date.now() + SUPPRESS_MS;
  };

  const sendMessage = (type, payload = {}) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const message = {
      type,
      room: state.roomId,
      client: state.clientId,
      payload,
      ts: Date.now(),
    };
    state.ws.send(JSON.stringify(message));
  };

  const connect = () => {
    const url = byId("osp-ws").value.trim() || DEFAULT_WS_URL;
    state.roomId = byId("osp-room").value.trim();
    state.name = byId("osp-name").value.trim() || "Guest";
    if (!state.roomId) {
      setStatus("Room ID required", "error");
      return;
    }
    if (!state.clientId) {
      state.clientId = randomId();
    }

    state.ws = new WebSocket(url);
    state.ws.addEventListener("open", () => {
      setStatus("Connected", "ok");
      startPing();
    });
    state.ws.addEventListener("close", () => {
      setStatus("Disconnected", "error");
      stopPing();
      setLatency(null);
    });
    state.ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!msg || msg.room !== state.roomId) return;
      handleMessage(msg);
    });
  };

  const handleMessage = (msg) => {
    const payload = msg.payload || {};
    const video = findVideo();
    if (!video) return;

    if (msg.type === "pong") {
      if (payload.client_ts) {
        const rtt = Date.now() - payload.client_ts;
        setLatency(Math.max(0, Math.round(rtt)));
        if (state.isHost) {
          sendMessage("state_update", { reported_latency: state.latency });
        }
      }
      return;
    }

    if (msg.type === "invite_created") {
      const inviteEl = byId("osp-invite");
      if (inviteEl) {
        inviteEl.value = payload.invite_token || "";
      }
      return;
    }

    if (msg.type === "room_state") {
      byId("osp-host").textContent = payload.host_id || "unknown";
      if (payload.state && payload.state.play_state) {
        byId("osp-playstate").textContent = payload.state.play_state;
      }
      if (payload.state && typeof payload.state.position === "number" && state.followHost) {
        suppressEvents();
        video.currentTime = payload.state.position;
      }
      if (payload.participants) {
        updateParticipants(payload.participants, payload.participant_count);
      }
      return;
    }

    if (msg.type === "player_event" && state.followHost) {
      const action = payload.action;
      if (!action) return;
      suppressEvents();
      if (action === "play") {
        video.play().catch(() => {});
      } else if (action === "pause") {
        video.pause();
      } else if (action === "seek" && typeof payload.position === "number") {
        video.currentTime = payload.position;
      }
      return;
    }

    if (msg.type === "state_update" && state.followHost) {
      if (typeof payload.position === "number") {
        suppressEvents();
        video.currentTime = payload.position;
      }
      if (payload.play_state === "playing") {
        suppressEvents();
        video.play().catch(() => {});
      }
      if (payload.play_state === "paused") {
        suppressEvents();
        video.pause();
      }
    }

    if (msg.type === "participants_update") {
      updateParticipants(payload.participants, payload.participant_count);
    }
  };

  const updateParticipants = (participants, count) => {
    const countEl = byId("osp-count");
    const listEl = byId("osp-participants");
    if (countEl) {
      countEl.textContent = Number.isFinite(count) ? String(count) : "-";
    }
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!Array.isArray(participants)) return;
    participants.forEach((participant) => {
      const item = document.createElement("div");
      const label = participant.name || participant.client_id || "participant";
      item.textContent = participant.is_host ? `${label} (host)` : label;
      listEl.appendChild(item);
    });
  };

  const hookVideo = () => {
    const video = findVideo();
    if (!video) {
      setStatus("No video element found", "error");
      return;
    }
    video.addEventListener("play", () => {
      if (!state.isHost || !shouldSend()) return;
      sendMessage("player_event", { action: "play", position: video.currentTime });
    });
    video.addEventListener("pause", () => {
      if (!state.isHost || !shouldSend()) return;
      sendMessage("player_event", { action: "pause", position: video.currentTime });
    });
    video.addEventListener("seeking", () => {
      if (!state.isHost || !shouldSend()) return;
      sendMessage("player_event", { action: "seek", position: video.currentTime });
    });
  };

  const startPing = () => {
    stopPing();
    state.pingTimer = window.setInterval(() => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      const clientTs = Date.now();
      state.lastPingAt = clientTs;
      sendMessage("ping", { client_ts: clientTs });
    }, 3000);
  };

  const stopPing = () => {
    if (state.pingTimer) {
      window.clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  };

  const createRoom = () => {
    state.isHost = true;
    state.followHost = false;
    byId("osp-follow").checked = false;
    const video = findVideo();
    const mediaUrl = byId("osp-media").value.trim() || (video ? video.currentSrc : "");
    sendMessage("create_room", {
      media_url: mediaUrl,
      start_pos: video ? video.currentTime : 0,
      name: state.name,
      auth_token: byId("osp-auth").value.trim() || undefined,
      options: {
        free_play: false,
      },
    });
  };

  const joinRoom = () => {
    state.isHost = false;
    state.followHost = true;
    byId("osp-follow").checked = true;
    sendMessage("join_room", {
      name: state.name,
      auth_token: byId("osp-auth").value.trim() || undefined,
      invite_token: byId("osp-invite").value.trim() || undefined,
    });
  };

  const createInvite = () => {
    sendMessage("create_invite", {
      expires_in: 3600,
      auth_token: byId("osp-auth").value.trim() || undefined,
    });
  };

  const createUI = () => {
    const container = document.createElement("div");
    container.id = "osp-overlay";
    container.innerHTML = `
      <style>
        #osp-overlay {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 9999;
          background: rgba(20, 20, 20, 0.85);
          color: #fff;
          font: 13px/1.4 "Helvetica Neue", Arial, sans-serif;
          padding: 12px;
          border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          width: 260px;
        }
        #osp-overlay input[type="text"] {
          width: 100%;
          margin: 4px 0;
          padding: 6px 8px;
          border-radius: 6px;
          border: 1px solid #444;
          background: #111;
          color: #fff;
        }
        #osp-overlay button {
          width: 100%;
          margin-top: 6px;
          padding: 6px 8px;
          border-radius: 6px;
          border: none;
          background: #2e7d32;
          color: #fff;
          cursor: pointer;
        }
        #osp-overlay button.secondary {
          background: #1565c0;
        }
        #osp-overlay button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        #osp-status[data-kind="error"] { color: #ff7676; }
        #osp-status[data-kind="ok"] { color: #7dff98; }
      </style>
      <div style="font-weight: bold; margin-bottom: 6px;">OpenSyncParty</div>
      <div id="osp-status" data-kind="info">Disconnected</div>
      <input id="osp-ws" type="text" placeholder="WS URL" value="${DEFAULT_WS_URL}" />
      <input id="osp-room" type="text" placeholder="Room ID" />
      <input id="osp-name" type="text" placeholder="Display name" />
      <input id="osp-media" type="text" placeholder="Media URL (host)" />
      <input id="osp-auth" type="text" placeholder="Auth token (JWT)" />
      <input id="osp-invite" type="text" placeholder="Invite token (JWT)" />
      <button id="osp-connect">Connect</button>
      <button id="osp-create" class="secondary">Create room (host)</button>
      <button id="osp-join">Join room</button>
      <button id="osp-invite-btn" class="secondary">Create invite</button>
      <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
        <input id="osp-follow" type="checkbox" checked /> Follow host
      </label>
      <div style="margin-top:6px; font-size:12px; color:#ccc;">
        Host: <span id="osp-host">-</span> | State: <span id="osp-playstate">-</span>
      </div>
      <div style="margin-top:4px; font-size:12px; color:#aaa;">
        RTT: <span id="osp-latency">-</span>
      </div>
      <div style="margin-top:6px; font-size:12px; color:#bbb;">
        Participants: <span id="osp-count">-</span>
      </div>
      <div id="osp-participants" style="margin-top:4px; font-size:12px; color:#ddd; max-height:120px; overflow:auto;"></div>
    `;
    document.body.appendChild(container);

    byId("osp-connect").addEventListener("click", () => {
      connect();
      hookVideo();
    });
    byId("osp-create").addEventListener("click", () => createRoom());
    byId("osp-join").addEventListener("click", () => joinRoom());
    byId("osp-invite-btn").addEventListener("click", () => createInvite());
    byId("osp-follow").addEventListener("change", (e) => {
      state.followHost = e.target.checked;
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUI);
  } else {
    createUI();
  }
})();
