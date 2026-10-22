(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const h = OWP._wsHandlers = OWP._wsHandlers || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const t = OWP.i18n.t;
  const { SEEK_THRESHOLD, VIDEO_ACTION_RETRY_MS, VIDEO_ACTION_MAX_WAIT_MS } = OWP.constants;

  // Where a command puts the video: its position, projected while playing.
  const commandTarget = (position, projectPlaying, eventServerTs) => {
    const elapsed = projectPlaying && typeof eventServerTs === 'number'
      ? Math.max(0, utils.getServerNow() - eventServerTs) / 1000
      : 0;
    return position + elapsed;
  };
  const movesVideo = (video, target) => Math.abs(target - video.currentTime) > SEEK_THRESHOLD;

  // Moves the video to the target when it is far enough, and keeps the target
  // as the room position.
  const seekToTarget = (video, target, seekVideo = true) => {
    if (seekVideo && movesVideo(video, target)) video.currentTime = target;
    state.lastSyncPosition = target;
    state.lastSyncServerTs = utils.getServerNow();
  };

  const applyPosition = (video, position, projectPlaying = false, eventServerTs = null, seekVideo = true) => {
    if (typeof position !== 'number' || !Number.isFinite(position)) return;
    seekToTarget(video, commandTarget(position, projectPlaying, eventServerTs), seekVideo);
  };

  const resolveVideo = (fallbackVideo) => {
    const activeVideo = utils.getVideo();
    const fallbackIsUsable = fallbackVideo
      && fallbackVideo.isConnected !== false
      && (!state.currentVideoElement || state.currentVideoElement === fallbackVideo);
    return activeVideo || (fallbackIsUsable ? fallbackVideo : null);
  };

  // The canonical event retains the initiating member, even after readiness.
  const fromGuest = msg => Boolean(msg.client) && msg.client !== state.roomHostId;

  const applyPlayerEvent = (msg, fallbackVideo) => {
    const video = resolveVideo(fallbackVideo);
    if (!video || !msg.payload) return false;
    const action = msg.payload.action;
    const position = msg.payload.position;
    const hostPlayState = msg.payload.play_state || (action === 'play' ? 'playing' : 'paused');
    if (state.isHost) state.hostAppliedPlayState = hostPlayState;
    state.pendingPlayUntil = 0;
    state.isInitialSync = false;
    state.initialSyncUntil = 0;
    state.initialSyncTargetPos = null;
    const applyToVideo = !state.guestPaused || state.sharedPlaybackControl;
    if (state.sharedPlaybackControl) state.guestPaused = false;

    switch (action) {
      case 'play':
        state.roomWaiting = false;
        applyPosition(video, position, true, msg.server_ts, applyToVideo);
        state.lastSyncPlayState = 'playing';
        state.syncCooldownUntil = utils.nowMs() + 2000;
        state.syncStatus = 'syncing';
        if (applyToVideo) OWP.playback.safePlay(video, 'host play command');
        if (ui.showToast) ui.showToast(t(fromGuest(msg) ? 'guestResumed' : 'hostResumed'));
        break;
      case 'pause':
        state.roomWaiting = false;
        applyPosition(video, position, false, null, applyToVideo);
        state.lastSyncPlayState = 'paused';
        state.syncCooldownUntil = 0;
        state.syncStatus = 'synced';
        if (applyToVideo) video.pause();
        if (ui.showToast) ui.showToast(t(fromGuest(msg) ? 'guestPaused' : 'hostPaused'));
        break;
      case 'seek':
        state.roomWaiting = false;
        applyPosition(video, position, hostPlayState === 'playing', msg.server_ts, applyToVideo);
        state.lastSyncPlayState = hostPlayState;
        state.syncCooldownUntil = utils.nowMs() + 2000;
        if (hostPlayState === 'playing') {
          state.syncStatus = 'syncing';
          if (applyToVideo) OWP.playback.safePlay(video, 'host seek command');
        } else {
          state.syncStatus = 'synced';
          if (applyToVideo) video.pause();
        }
        break;
      case 'buffering':
        state.roomWaiting = true;
        applyPosition(video, position, false, null, applyToVideo);
        state.lastSyncPlayState = 'paused';
        state.syncStatus = 'syncing';
        if (applyToVideo) video.pause();
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
    const changed = playing === video.paused;
    const position = msg.payload.position;
    // One target for both the decision and the seek: a playing projection
    // moves on between two reads.
    const target = typeof position === 'number' && Number.isFinite(position)
      ? commandTarget(position, playing, msg.server_ts)
      : null;
    state.hostAppliedPlayState = playing ? 'playing' : 'paused';
    // Only a command that moves the video holds back the events it causes:
    // one that changes nothing would just drop the host's next action.
    if (changed || (target !== null && movesVideo(video, target))) utils.startSyncing();
    if (target !== null) seekToTarget(video, target);
    state.wantsToPlay = playing;
    if (changed && playing) OWP.playback.safePlay(video, 'guest play command');
    else if (changed) video.pause();
    // Scheduled play retains its initiator; only guest actions get this toast.
    if (changed && ui.showToast && fromGuest(msg)) ui.showToast(t(playing ? 'guestResumed' : 'guestPaused'));
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
    // Only controls actually sent as host are acknowledgements. Queue starts
    // and a former guest's pending play must still run after host promotion.
    const acknowledgement = msg.client === state.clientId
      ? state.hostControlAcks.indexOf(msg.payload.action) : -1;
    if (acknowledgement !== -1) {
      // A newer opposite control may have cancelled an unacknowledged play
      // while the server waited for readiness. Retire those older entries too.
      state.hostControlAcks.splice(0, acknowledgement + 1);
      state.playbackActionAttempt++;
      if (state.pendingActionTimer) OWP.timers.clear(state.pendingActionTimer);
      state.pendingActionTimer = null;
      state.pendingPlayUntil = 0;
      state.hostPendingPlayState = '';
      return;
    }
    const targetTs = msg.payload.target_server_ts || msg.server_ts || utils.getServerNow();
    const roomId = msg.room || state.roomId;
    const actionAttempt = ++state.playbackActionAttempt;
    const retryDeadline = utils.nowMs() + Math.max(0, targetTs - utils.getServerNow()) + VIDEO_ACTION_MAX_WAIT_MS;
    state.pendingPlayUntil = targetTs;
    state.hostPendingPlayState = msg.payload.action === 'play' ? 'playing' : 'paused';
    const apply = () => {
      if (actionAttempt !== state.playbackActionAttempt || !state.inRoom || state.roomId !== roomId || !state.isHost) {
        if (actionAttempt === state.playbackActionAttempt && state.roomId === roomId) {
          state.pendingPlayUntil = 0;
          state.pendingActionTimer = null;
        }
        return;
      }
      if (applyGuestCommand(msg, video)) {
        state.pendingPlayUntil = 0;
        state.hostPendingPlayState = '';
        state.pendingActionTimer = null;
      } else if (utils.nowMs() < retryDeadline) {
        state.pendingPlayUntil = utils.getServerNow() + Math.max(0, retryDeadline - utils.nowMs());
        state.pendingActionTimer = OWP.timers.setTimeout(apply, VIDEO_ACTION_RETRY_MS, 'room');
      } else {
        state.pendingPlayUntil = 0;
        state.pendingActionTimer = null;
      }
    };
    utils.scheduleAt(targetTs, apply);
  };

  h.handlePlayerEvent = (msg, video) => {
    if (state.isHost) {
      if (msg.payload) handleHostPlayerEvent(msg, video);
      return;
    }
    utils.startSyncing();
    if (!msg.payload) return;
    state.ownCommandUntil = 0;
    state.ownCommandPlayState = '';
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
