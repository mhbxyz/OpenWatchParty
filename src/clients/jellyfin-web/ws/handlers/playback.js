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

  const applyPlayerEvent = (msg, fallbackVideo) => {
    const activeVideo = utils.getVideo();
    const fallbackIsUsable = fallbackVideo
      && fallbackVideo.isConnected !== false
      && (!state.currentVideoElement || state.currentVideoElement === fallbackVideo);
    const video = activeVideo || (fallbackIsUsable ? fallbackVideo : null);
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
        applyPosition(video, position, true, msg.server_ts);
        state.lastSyncPlayState = 'playing';
        state.syncCooldownUntil = utils.nowMs() + 2000;
        state.syncStatus = 'syncing';
        OWP.playback.safePlay(video, 'host play command');
        if (ui.showToast) ui.showToast('Host resumed playback');
        break;
      case 'pause':
        applyPosition(video, position);
        state.lastSyncPlayState = 'paused';
        state.syncCooldownUntil = 0;
        state.syncStatus = 'synced';
        video.pause();
        if (ui.showToast) ui.showToast('Host paused playback');
        break;
      case 'seek':
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
        applyPosition(video, position);
        state.lastSyncPlayState = 'paused';
        state.syncStatus = 'syncing';
        video.pause();
        break;
    }
    if (ui.updateSyncIndicator) ui.updateSyncIndicator();
    return true;
  };

  h.handlePlayerEvent = (msg, video) => {
    if (state.isHost) return;
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
      if (!applyPlayerEvent(msg, video) && utils.nowMs() < retryDeadline) {
        state.pendingActionTimer = OWP.timers.setTimeout(applyScheduledEvent, VIDEO_ACTION_RETRY_MS, 'room');
      }
    };
    utils.scheduleAt(targetTs, applyScheduledEvent);
  };
})();
