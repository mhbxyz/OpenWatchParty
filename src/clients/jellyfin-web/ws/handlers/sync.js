(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const h = OWP._wsHandlers = OWP._wsHandlers || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const { SEEK_THRESHOLD } = OWP.constants;

  const applyRoomState = (msg) => {
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
      state.lastSyncPosition = typeof msg.payload.state.position === 'number'
        ? msg.payload.state.position
        : 0;
      state.lastSyncPlayState = msg.payload.state.play_state || 'paused';
    }
  };

  const syncToRoom = (msg, video) => {
    if (!video || state.isHost || !msg.payload?.state) return;
    const basePos = msg.payload.state.position || 0;
    const targetPos = utils.adjustedPosition(basePos, msg.server_ts);
    const hostPlaying = msg.payload.state.play_state === 'playing';
    utils.log('CLIENT', {
      type: 'room_state',
      msg_pos: basePos,
      target_pos: targetPos,
      video_pos: video.currentTime,
      gap: targetPos - video.currentTime,
      play_state: msg.payload.state.play_state
    });
    utils.startSyncing();
    if (hostPlaying) {
      const { INITIAL_SYNC_COOLDOWN_MS, INITIAL_SYNC_MAX_MS } = OWP.constants;
      const now = utils.nowMs();
      state.isInitialSync = true;
      state.initialSyncUntil = now + INITIAL_SYNC_MAX_MS;
      state.syncCooldownUntil = now + INITIAL_SYNC_COOLDOWN_MS;
      state.initialSyncTargetPos = targetPos;
      utils.log('CLIENT', { type: 'initial_sync_started', cooldown: INITIAL_SYNC_COOLDOWN_MS, max: INITIAL_SYNC_MAX_MS, targetPos });
    }
    if (Math.abs(video.currentTime - targetPos) > SEEK_THRESHOLD) {
      video.currentTime = targetPos;
    }
    if (hostPlaying) {
      video.play().catch(() => {});
    } else if (msg.payload.state.play_state === 'paused') {
      video.pause();
    }
  };

  h.handleRoomState = (msg, video) => {
    if (state.rejoinPending && state.desiredRoomId && msg.room !== state.desiredRoomId) return;
    if (!state.rejoinPending && state.rejectedRejoinRoomIds.includes(msg.room)) return;
    applyRoomState(msg);
    if (OWP.actions?.completeRoomRejoin) OWP.actions.completeRoomRejoin(msg.room);
    ui.render();
    syncToRoom(msg, video);
    if (!state.isHost && msg.payload?.media_id) {
      if (OWP.playback && OWP.playback.ensurePlayback) {
        OWP.playback.ensurePlayback(msg.payload.media_id);
        if (OWP.playback.watchReady) OWP.playback.watchReady();
      }
    }
  };

  h.handleStateUpdate = (msg, video) => {
    if (state.isHost || !video) return;
    if (msg.payload) {
      state.lastSyncPlayState = msg.payload.play_state || state.lastSyncPlayState;
    }
    if (msg.payload.play_state === 'playing' && video.paused) {
      utils.startSyncing();
      video.play().catch(() => {});
      state.lastSyncServerTs = utils.getServerNow();
      state.lastSyncPosition = video.currentTime;
      state.syncCooldownUntil = utils.nowMs() + 2000;
      return;
    } else if (msg.payload.play_state === 'paused' && !video.paused) {
      utils.startSyncing();
      state.syncCooldownUntil = 0;
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = 0;
      video.pause();
    }
    if (state.isBuffering || !utils.isVideoReady()) return;
    if (state.syncCooldownUntil && utils.nowMs() < state.syncCooldownUntil) {
      return;
    }
    if (msg.payload) {
      state.lastSyncServerTs = msg.server_ts || utils.getServerNow();
      state.lastSyncPosition = typeof msg.payload.position === 'number'
        ? msg.payload.position
        : state.lastSyncPosition;
    }
  };
})();
