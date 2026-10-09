(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const h = OWP._wsHandlers = OWP._wsHandlers || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const { SEEK_THRESHOLD, VIDEO_ACTION_RETRY_MS, VIDEO_ACTION_MAX_WAIT_MS } = OWP.constants;

  const applyPosition = (video, position, projectPlaying = false, eventServerTs = null) => {
    if (typeof position !== 'number' || !Number.isFinite(position)) return;
    const elapsed = projectPlaying && typeof eventServerTs === 'number'
      ? Math.max(0, utils.getServerNow() - eventServerTs) / 1000
      : 0;
    const target = position + elapsed;
    if (Math.abs(target - video.currentTime) > SEEK_THRESHOLD) video.currentTime = target;
    state.lastSyncPosition = target;
    state.lastSyncServerTs = utils.getServerNow();
  };

  const resolveVideo = (fallbackVideo) => {
    const activeVideo = utils.getVideo();
    const fallbackIsUsable = fallbackVideo
      && fallbackVideo.isConnected !== false
      && (!state.currentVideoElement || state.currentVideoElement === fallbackVideo);
    return activeVideo || (fallbackIsUsable ? fallbackVideo : null);
  };

  // Play and pause are the room's: any member can send them. The pending play
  // the server starts once everyone is ready comes under the host's id.
  const fromGuest = msg => Boolean(msg.client) && msg.client !== state.roomHostId;

  const applyPlayerEvent = (msg, fallbackVideo) => {
    const video = resolveVideo(fallbackVideo);
    if (!video || !msg.payload) return false;
    const action = msg.payload.action;
    const position = msg.payload.position;
    const hostPlayState = msg.payload.play_state || (action === 'play' ? 'playing' : 'paused');
    state.pendingPlayUntil = 0;
    state.isInitialSync = false;
    state.initialSyncUntil = 0;
    state.initialSyncTargetPos = null;

    switch (action) {
      case 'play':
        state.roomWaiting = false;
        applyPosition(video, position, true, msg.server_ts);
        state.lastSyncPlayState = 'playing';
        state.syncCooldownUntil = utils.nowMs() + 2000;
        state.syncStatus = 'syncing';
        OWP.playback.safePlay(video, 'host play command');
        if (ui.showToast) ui.showToast(fromGuest(msg) ? 'A guest resumed playback' : 'Host resumed playback');
        break;
      case 'pause':
        state.roomWaiting = false;
        applyPosition(video, position, false, null);
        state.lastSyncPlayState = 'paused';
        state.syncCooldownUntil = 0;
        state.syncStatus = 'synced';
        video.pause();
        if (ui.showToast) ui.showToast(fromGuest(msg) ? 'A guest paused playback' : 'Host paused playback');
        break;
      case 'seek':
        state.roomWaiting = false;
        applyPosition(video, position, hostPlayState === 'playing', msg.server_ts);
        state.lastSyncPlayState = hostPlayState;
        state.syncCooldownUntil = utils.nowMs() + 2000;
        if (hostPlayState === 'playing') {
          state.syncStatus = 'syncing';
          OWP.playback.safePlay(video, 'host seek command');
        } else {
          state.syncStatus = 'synced';
          video.pause();
        }
        break;
      case 'buffering':
        state.roomWaiting = true;
        applyPosition(video, position, false, null);
        state.lastSyncPlayState = 'paused';
        state.syncStatus = 'syncing';
        video.pause();
        break;
    }
    if (ui.updateSyncIndicator) ui.updateSyncIndicator();
    return true;
  };

  // A guest's play or pause, on the host's player. Its own play and pause
  // events are held back (startSyncing) so they are not sent again.
  const applyGuestCommand = (msg, fallbackVideo) => {
    const video = resolveVideo(fallbackVideo);
    if (!video || !msg.payload) return false;
    const playing = msg.payload.action === 'play';
    // While the host's stream reloads, the latest guest command waits for the
    // reload to end; otherwise the reload's own play would undo a pause.
    if (state.streamReloadUntil) {
      state.reloadGuestCommand = { msg, roomId: state.roomId, attempt: state.playbackActionAttempt };
      return true;
    }
    // Already there, as with the host's own pending play once everyone is ready.
    if (playing !== video.paused) return true;
    utils.startSyncing();
    applyPosition(video, msg.payload.position, playing, msg.server_ts);
    state.wantsToPlay = playing;
    if (playing) OWP.playback.safePlay(video, 'guest play command');
    else video.pause();
    // The pending play the server starts comes under the host's id.
    if (ui.showToast && fromGuest(msg)) ui.showToast(playing ? 'A guest resumed playback' : 'A guest paused playback');
    return true;
  };

  // Called when the host's stream reload ends: applies the guest command that
  // came during it, unless the room, the role or a newer command changed.
  h.applyReloadGuestCommand = (video) => {
    const pending = state.reloadGuestCommand;
    state.reloadGuestCommand = null;
    if (!pending || !state.isHost || !state.inRoom || state.roomId !== pending.roomId) return;
    if (state.playbackActionAttempt !== pending.attempt) return;
    applyGuestCommand(pending.msg, video);
  };

  const handleHostPlayerEvent = (msg, video) => {
    if (msg.payload.action !== 'play' && msg.payload.action !== 'pause') return;
    const targetTs = msg.payload.target_server_ts || msg.server_ts || utils.getServerNow();
    const roomId = msg.room || state.roomId;
    const actionAttempt = ++state.playbackActionAttempt;
    utils.scheduleAt(targetTs, () => {
      if (actionAttempt !== state.playbackActionAttempt || !state.inRoom || state.roomId !== roomId || !state.isHost) return;
      applyGuestCommand(msg, video);
    });
  };

  h.handlePlayerEvent = (msg, video) => {
    if (state.isHost) {
      if (msg.payload) handleHostPlayerEvent(msg, video);
      return;
    }
    utils.startSyncing();
    if (!msg.payload) return;
    const targetTs = msg.payload.target_server_ts || msg.server_ts || utils.getServerNow();
    const roomId = msg.room || state.roomId;
    const actionAttempt = ++state.playbackActionAttempt;
    const retryDeadline = utils.nowMs()
      + Math.max(0, targetTs - utils.getServerNow())
      + VIDEO_ACTION_MAX_WAIT_MS;
    state.syncStatus = msg.payload.action === 'play' ? 'pending_play' : 'syncing';
    state.pendingPlayUntil = targetTs;
    if (ui.updateSyncIndicator) ui.updateSyncIndicator();
    const applyScheduledEvent = () => {
      if (actionAttempt !== state.playbackActionAttempt || !state.inRoom || state.roomId !== roomId) return;
      utils.startSyncing();
      if (!applyPlayerEvent(msg, video)) {
        if (utils.nowMs() < retryDeadline) {
          state.pendingActionTimer = OWP.timers.setTimeout(applyScheduledEvent, VIDEO_ACTION_RETRY_MS, 'room');
        } else {
          state.pendingActionTimer = null;
          state.pendingPlayUntil = 0;
          if (state.syncStatus === 'pending_play') state.syncStatus = 'synced';
          if (ui.updateSyncIndicator) ui.updateSyncIndicator();
        }
      }
    };
    utils.scheduleAt(targetTs, applyScheduledEvent);
  };
})();
