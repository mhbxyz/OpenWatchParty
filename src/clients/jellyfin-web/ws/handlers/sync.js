(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const h = OWP._wsHandlers = OWP._wsHandlers || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const { SEEK_THRESHOLD, VIDEO_ACTION_RETRY_MS, VIDEO_ACTION_MAX_WAIT_MS } = OWP.constants;

  const applyRoomState = (msg) => {
    // Names from another room must not show until this room's list arrives.
    if (msg.room !== state.roomId) state.participants = [];
    state.inRoom = true;
    state.roomId = msg.room;
    state.roomName = msg.payload.name;
    state.participantCount = msg.payload.participant_count;
    if (!state.clientId && msg.client) {
      state.clientId = msg.client;
    }
    state.isHost = (msg.payload.host_id === state.clientId);
    if (state.isHost) state.guestPaused = false;
    if (!state.hasTimeSync && typeof msg.server_ts === 'number') {
      state.serverOffsetMs = msg.server_ts - utils.nowMs();
      state.hasTimeSync = true;
    }
  };

  const syncToRoom = (msg, video, acceptedAsGuest = false) => {
    if (state.isHost && !acceptedAsGuest) {
      state.pendingPlayUntil = 0;
      return;
    }
    if (!video || !msg.payload?.state) return;
    const basePos = msg.payload.state.position || 0;
    const hostPlaying = msg.payload.state.play_state === 'playing';
    const stateServerTs = msg.payload.state_server_ts || msg.server_ts || utils.getServerNow();
    const targetPos = hostPlaying ? utils.adjustedPosition(basePos, stateServerTs) : basePos;
    state.lastSyncServerTs = stateServerTs;
    state.lastSyncPosition = basePos;
    state.lastSyncPlayState = msg.payload.state.play_state || 'paused';
    if (hostPlaying) state.roomWaiting = false;
    state.pendingPlayUntil = 0;
    state.syncStatus = hostPlaying ? 'syncing' : 'synced';
    if (ui.updateSyncIndicator) ui.updateSyncIndicator();
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
      OWP.playback.safePlay(video, 'room synchronization');
    } else if (msg.payload.state.play_state === 'paused') {
      video.pause();
    }
  };

  const scheduleRoomSync = (msg, fallbackVideo, acceptedAsGuest = false) => {
    if (state.isHost && !acceptedAsGuest) {
      state.pendingPlayUntil = 0;
      return;
    }
    const targetServerTs = msg.payload?.target_server_ts;
    const roomId = msg.room;
    const actionAttempt = ++state.playbackActionAttempt;
    const retryDeadline = utils.nowMs()
      + Math.max(0, (targetServerTs || utils.getServerNow()) - utils.getServerNow())
      + VIDEO_ACTION_MAX_WAIT_MS;
    const apply = () => {
      if (actionAttempt !== state.playbackActionAttempt || !state.inRoom || state.roomId !== roomId) return;
      if (state.isHost && !acceptedAsGuest) {
        syncToRoom(msg, null, acceptedAsGuest);
        return;
      }
      const activeVideo = utils.getVideo();
      const fallbackIsUsable = fallbackVideo
        && fallbackVideo.isConnected !== false
        && (!state.currentVideoElement || state.currentVideoElement === fallbackVideo);
      const video = activeVideo || (fallbackIsUsable ? fallbackVideo : null);
      if (!video) {
        if (utils.nowMs() < retryDeadline) {
          state.pendingActionTimer = OWP.timers.setTimeout(apply, VIDEO_ACTION_RETRY_MS, 'room');
        } else {
          state.pendingActionTimer = null;
          state.pendingPlayUntil = 0;
          if (state.syncStatus === 'pending_play') state.syncStatus = 'synced';
          if (ui.updateSyncIndicator) ui.updateSyncIndicator();
        }
        return;
      }
      syncToRoom(msg, video, acceptedAsGuest);
    };
    if (typeof targetServerTs === 'number' && targetServerTs > utils.getServerNow()) {
      state.syncStatus = msg.payload?.state?.play_state === 'playing' ? 'pending_play' : 'syncing';
      state.pendingPlayUntil = targetServerTs;
      if (ui.updateSyncIndicator) ui.updateSyncIndicator();
      utils.scheduleAt(targetServerTs, apply);
    } else {
      apply();
    }
  };

  h.handleRoomState = (msg, video) => {
    if (state.rejoinPending && state.desiredRoomId && msg.room !== state.desiredRoomId) return;
    if (!state.rejoinPending && state.rejectedRejoinRoomIds.includes(msg.room)) return;
    applyRoomState(msg);
    const acceptedAsGuest = !state.isHost;
    state.inviteJoinPending = false;
    if (OWP.actions?.completeRoomRejoin) OWP.actions.completeRoomRejoin(msg.room);
    ui.render();
    if (acceptedAsGuest && msg.payload?.media_id) {
      state.pendingMediaId = msg.payload.media_id;
      state.pendingMediaUntil = 0;
      if (OWP.playback && OWP.playback.ensurePlayback) {
        OWP.playback.ensurePlayback(msg.payload.media_id);
      }
      if (OWP.playback?.watchReady) {
        OWP.playback.watchReady({
          roomId: msg.room,
          mediaId: msg.payload.media_id,
          onReady: readyVideo => scheduleRoomSync(msg, readyVideo, acceptedAsGuest)
        });
      }
      return;
    }
    state.pendingMediaId = '';
    state.pendingMediaUntil = 0;
    scheduleRoomSync(msg, video, acceptedAsGuest);
  };

  h.handleStateUpdate = (msg, video) => {
    if (state.isHost || !video) return;
    state.playbackActionAttempt++;
    if (msg.payload) {
      state.lastSyncPlayState = msg.payload.play_state || state.lastSyncPlayState;
      if (msg.payload.play_state === 'playing') state.roomWaiting = false;
    }
    if (state.guestPaused) {
      state.lastSyncServerTs = msg.server_ts || utils.getServerNow();
      state.lastSyncPosition = typeof msg.payload.position === 'number'
        ? msg.payload.position
        : state.lastSyncPosition;
      return;
    }
    if (msg.payload.play_state === 'playing' && video.paused) {
      utils.startSyncing();
      OWP.playback.safePlay(video, 'state update');
      state.lastSyncServerTs = utils.getServerNow();
      state.lastSyncPosition = video.currentTime;
      state.syncCooldownUntil = utils.nowMs() + 2000;
      return;
    } else if (msg.payload.play_state === 'paused' && !video.paused) {
      utils.startSyncing();
      state.syncCooldownUntil = 0;
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = null;
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
