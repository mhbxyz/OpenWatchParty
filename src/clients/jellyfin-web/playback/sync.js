(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const playback = OWP.playback = OWP.playback || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const {
    DRIFT_DEADZONE_SEC,
    DRIFT_SOFT_MAX_SEC,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    DRIFT_GAIN,
    INITIAL_SYNC_DRIFT_THRESHOLD,
    INITIAL_SYNC_MAX_DRIFT,
    MEDIA_READY_POLL_MS,
    MEDIA_READY_TIMEOUT_MS,
    PARTICIPANT_STATUS_HOLD_MS,
    NUDGE_STEP_SEC,
    NUDGE_MIN_DRIFT_SEC,
    NUDGE_MIN_MOVE_SEC,
    NUDGE_BUFFER_MARGIN_SEC,
    DRIFT_TRACK_GAP_MS
  } = OWP.constants;

  const notifyReady = (roomId, mediaId) => {
    if (!state.inRoom || state.roomId !== roomId || state.readyRoomId === roomId) return;
    if (mediaId && utils.getCurrentItemId() !== mediaId) return;
    const actions = OWP.actions;
    if (!actions || !actions.send) return;
    state.readyRoomId = roomId;
    actions.send('ready', { room: roomId, media_id: mediaId || utils.getCurrentItemId() });
  };

  const watchReady = ({ roomId = state.roomId, mediaId = '', onReady = null } = {}) => {
    if (state.mediaReadyCleanup) state.mediaReadyCleanup();
    const attempt = ++state.mediaSyncAttempt;
    const gateDeadline = Date.now() + MEDIA_READY_TIMEOUT_MS;
    let deadline = gateDeadline;
    state.pendingMediaUntil = gateDeadline;
    const initialMediaId = utils.getCurrentItemId();
    const initialVideo = utils.getVideo();
    const initialSource = initialVideo?.currentSrc || initialVideo?.src || '';
    const requiresVideoTransition = Boolean(mediaId && initialMediaId !== mediaId);
    let timeoutReported = false;
    let watchedVideo = null;
    let timer = null;

    const cleanup = () => {
      if (timer) OWP.timers.clear(timer);
      timer = null;
      if (watchedVideo) {
        watchedVideo.removeEventListener('canplay', check);
        watchedVideo.removeEventListener('loadeddata', check);
      }
      watchedVideo = null;
      if (state.mediaReadyCleanup === cleanup) state.mediaReadyCleanup = null;
    };

    const scheduleCheck = () => {
      if (Date.now() >= deadline) {
        deadline = Date.now() + MEDIA_READY_TIMEOUT_MS;
        if (mediaId && playback.ensurePlayback) playback.ensurePlayback(mediaId, 0, null, true);
        if (!timeoutReported) {
          if (state.pendingMediaId === mediaId) state.pendingMediaId = '';
          if (state.pendingMediaUntil === gateDeadline) state.pendingMediaUntil = 0;
          if (OWP.ui?.showToast) OWP.ui.showToast('Still waiting for the watch party media');
          timeoutReported = true;
        }
      }
      timer = OWP.timers.setTimeout(check, MEDIA_READY_POLL_MS, 'media');
    };

    function check() {
      if (timer) OWP.timers.clear(timer);
      timer = null;
      if (attempt !== state.mediaSyncAttempt || !state.inRoom || state.roomId !== roomId) {
        cleanup();
        return;
      }
      if (mediaId && utils.getCurrentItemId() !== mediaId) {
        scheduleCheck();
        return;
      }
      const video = utils.getVideo();
      if (!video) {
        scheduleCheck();
        return;
      }
      if (requiresVideoTransition && video === initialVideo) {
        const currentSource = video.currentSrc || video.src || '';
        if (currentSource === initialSource) {
          scheduleCheck();
          return;
        }
      }
      if (watchedVideo !== video) {
        if (watchedVideo) {
          watchedVideo.removeEventListener('canplay', check);
          watchedVideo.removeEventListener('loadeddata', check);
        }
        watchedVideo = video;
        watchedVideo.addEventListener('canplay', check);
        watchedVideo.addEventListener('loadeddata', check);
      }
      if (video.readyState < 2) {
        scheduleCheck();
        return;
      }
      state.pendingMediaId = '';
      state.pendingMediaUntil = 0;
      if (typeof onReady === 'function') onReady(video);
      notifyReady(roomId, mediaId);
      cleanup();
    }

    state.mediaReadyCleanup = cleanup;
    check();
  };

  const checkInitialSync = (abs, drift, expected, video, serverNow) => {
    if (!state.isInitialSync) return false;
    const now = utils.nowMs();
    const inCooldown = state.syncCooldownUntil && now < state.syncCooldownUntil;
    if (abs > INITIAL_SYNC_MAX_DRIFT) {
      utils.log('SYNC', { type: 'initial_sync_critical_drift', drift, videoPos: video.currentTime, expected });
      video.currentTime = expected;
      state.lastSyncServerTs = serverNow;
      state.lastSyncPosition = expected;
      state.initialSyncTargetPos = null;
      return true;
    }
    // Past the cooldown, a drift under DRIFT_SOFT_MAX_SEC keeps closing at
    // the catch-up rate, as it does after the initial sync; a larger one seeks.
    if (state.initialSyncTargetPos !== null
        && abs >= DRIFT_SOFT_MAX_SEC
        && !inCooldown) {
      utils.log('SYNC', { type: 'post_buffer_seek', drift, videoPos: video.currentTime, expected });
      video.currentTime = expected;
      state.lastSyncServerTs = serverNow;
      state.lastSyncPosition = expected;
      state.initialSyncTargetPos = null;
      return true;
    }
    if (abs < INITIAL_SYNC_DRIFT_THRESHOLD) {
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = null;
      utils.log('SYNC', { type: 'initial_sync_complete', drift, reason: 'drift_threshold' });
    } else if (state.initialSyncUntil && now >= state.initialSyncUntil) {
      state.isInitialSync = false;
      state.initialSyncUntil = 0;
      state.initialSyncTargetPos = null;
      utils.log('SYNC', { type: 'initial_sync_timeout', drift });
    }
    return false;
  };

  const applySyncCorrection = (drift, abs, video, expected, serverNow) => {
    if (abs < DRIFT_DEADZONE_SEC) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (state.syncStatus !== 'synced') {
        state.syncStatus = 'synced';
        state.currentDrift = 0;
        if (OWP.ui && OWP.ui.updateSyncIndicator) OWP.ui.updateSyncIndicator();
      }
      return;
    }
    if (state.syncStatus !== 'syncing') {
      state.syncStatus = 'syncing';
      if (OWP.ui && OWP.ui.updateSyncIndicator) OWP.ui.updateSyncIndicator();
    }
    state.currentDrift = drift;
    if (abs >= DRIFT_SOFT_MAX_SEC) {
      const now = utils.nowMs();
      const inCooldown = state.syncCooldownUntil && now < state.syncCooldownUntil;
      if (state.isInitialSync || inCooldown) {
        if (abs > 5) {
          utils.log('SYNC', { type: 'skip_hard_seek', drift, reason: state.isInitialSync ? 'initial_sync' : 'cooldown' });
        }
      } else {
        utils.log('SYNC', { type: 'HARD_SEEK', expected, actual: video.currentTime, drift });
        utils.suppress();
        video.currentTime = expected;
        state.lastSyncServerTs = serverNow;
        state.lastSyncPosition = expected;
        if (video.playbackRate !== 1) video.playbackRate = 1;
        return;
      }
    }
    const sign = drift > 0 ? 1 : -1;
    const correction = sign * Math.sqrt(abs) * DRIFT_GAIN;
    const rate = Math.min(Math.max(1 + correction, PLAYBACK_RATE_MIN), PLAYBACK_RATE_MAX);
    if (abs > 0.5) {
      utils.log('SYNC', { expected, actual: video.currentTime, drift, rate });
    }
    video.playbackRate = rate;
  };

  // A guest's play that the room did not take, as while it waits for the host
  // (a guest's own play sets the room state first). While the room is paused
  // the server sends no further updates (it drops unchanged state updates), so
  // nothing else would pause that guest.
  const holdRoomPause = (video) => {
    if (!state.lastSyncServerTs || state.lastSyncPlayState !== 'paused') return;
    if (video.paused || state.isSyncing) return;
    if (state.pendingPlayUntil && utils.getServerNow() < state.pendingPlayUntil) return;
    utils.log('SYNC', { type: 'hold_room_pause', pos: video.currentTime });
    video.pause();
    if (OWP.ui && OWP.ui.showToast) {
      OWP.ui.showToast(state.roomWaiting ? 'Waiting for the host…' : 'Only the host can control playback');
    }
  };

  // Where the host is now, from the last room update, while the room plays.
  const expectedPosition = (serverNow = utils.getServerNow()) =>
    state.lastSyncPosition + Math.max(0, serverNow - state.lastSyncServerTs) / 1000;

  const syncLoop = () => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!video) return;
    if (!state.inRoom || state.isHost) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (state.pendingMediaId) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    if (!state.lastSyncServerTs || state.lastSyncPlayState !== 'playing') {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      holdRoomPause(video);
      return;
    }
    if (state.isBuffering || !utils.isVideoReady()) return;
    if (video.paused) {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      return;
    }
    const serverNow = utils.getServerNow();
    const expected = expectedPosition(serverNow);
    const drift = expected - video.currentTime;
    const abs = Math.abs(drift);
    if (checkInitialSync(abs, drift, expected, video, serverNow)) return;
    applySyncCorrection(drift, abs, video, expected, serverNow);
  };

  // How this client is doing, as the room's participants list shows it.
  const ownStatus = () => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!video) return 'not_watching';
    if (state.pendingMediaId || state.syncStatus === 'pending_play') return 'loading';
    if (state.isBuffering) return 'buffering';
    if (!utils.isVideoReady()) return 'loading';
    if (state.isHost) return video.paused ? 'paused' : 'playing';
    if (state.syncStatus === 'blocked') return 'blocked';
    if (state.syncStatus === 'syncing') return 'catching_up';
    return 'in_sync';
  };

  // Sends this client's status to the room once it has held for a second, so
  // drift correction going in and out of sync does not flood the room. Only to
  // a server that sent participant_statuses for this room: an older one would
  // answer with an error. Sent again after a reconnection (a new client id).
  const reportStatus = () => {
    // A server that declared participant_status accepts it; one that already
    // sent participant_statuses for this room does too (an older one would
    // answer unknown types with an error).
    const serverAcceptsStatuses = state.serverFeatures.includes('participant_status')
      || state.statusesRoomId === state.roomId;
    if (!state.inRoom || !serverAcceptsStatuses || !state.ws || state.ws.readyState !== 1) return;
    const status = ownStatus();
    const now = utils.nowMs();
    if (status !== state.statusCandidate) {
      state.statusCandidate = status;
      state.statusCandidateSince = now;
      return;
    }
    const key = `${state.roomId}|${state.clientId}|${status}`;
    if (key === state.statusSentKey || now - state.statusCandidateSince < PARTICIPANT_STATUS_HOLD_MS) return;
    if (!OWP.actions?.send) return;
    OWP.actions.send('participant_status', { status });
    state.statusSentKey = key;
  };

  // A room command is still being applied (a scheduled start, a fresh room
  // state, the catch-up after joining, a seek): a nudge would fight it.
  const followingHost = (video) => Boolean(state.isSyncing
    || state.pendingActionTimer
    || (state.pendingPlayUntil && utils.getServerNow() < state.pendingPlayUntil)
    || state.isInitialSync
    || (state.syncCooldownUntil && utils.nowMs() < state.syncCooldownUntil)
    || video.seeking);

  // The buffered range around a position, if any: a nudge stays inside it, so
  // it never waits for a new segment to load (HLS fetches them on a seek).
  const bufferedRangeAt = (video, position) => {
    const ranges = video.buffered;
    if (!ranges || typeof ranges.length !== 'number') return null;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= position && position <= ranges.end(i)) return { start: ranges.start(i), end: ranges.end(i) };
    }
    return null;
  };

  // How far a nudge toward the host may move the video: at most one step, no
  // further than the host, and within the buffered range.
  const nudgeStep = (video, drift) => {
    const range = bufferedRangeAt(video, video.currentTime);
    if (!range) return 0;
    const room = drift > 0
      ? range.end - NUDGE_BUFFER_MARGIN_SEC - video.currentTime
      : video.currentTime - (range.start + NUDGE_BUFFER_MARGIN_SEC);
    const exact = Math.min(NUDGE_STEP_SEC, Math.abs(drift), room);
    // Whole multiples of the smallest move, rounded down; the tiny epsilon
    // absorbs floating point error (0.1 computed as 0.09999...).
    const step = Math.floor(exact / NUDGE_MIN_MOVE_SEC + 1e-6) * NUDGE_MIN_MOVE_SEC;
    return step >= NUDGE_MIN_MOVE_SEC ? Math.round(step * 100) / 100 : 0;
  };

  // What the sync adjustment can do for this guest now. It needs the same live
  // room playback as the automatic correction, and nothing else moving the
  // video. A positive drift means behind the host.
  const nudgeState = () => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!state.inRoom || state.isHost || !video) return { kind: 'unavailable' };
    if (state.pendingMediaId || state.isBuffering || !utils.isVideoReady()) return { kind: 'loading' };
    if (!state.lastSyncServerTs || state.lastSyncPlayState !== 'playing' || video.paused) return { kind: 'paused' };
    if (followingHost(video)) return { kind: 'busy' };
    const drift = expectedPosition() - video.currentTime;
    if (Math.abs(drift) < NUDGE_MIN_DRIFT_SEC) return { kind: 'synced', drift };
    const step = nudgeStep(video, drift);
    if (!step) return { kind: 'loading', drift };
    return { kind: drift > 0 ? 'behind' : 'ahead', drift, step };
  };

  // Keeps since when the guest has been out of sync, for the sync adjustment.
  // It follows the drift itself, not whether a nudge is possible: buffering,
  // a seek or a room command do not end the episode; being in sync, the room
  // no longer playing, or a gap in tracking (the setting turned off, hosting,
  // leaving the room) do.
  const trackDrift = () => {
    const now = utils.nowMs();
    if (now - state.driftCheckedAt > DRIFT_TRACK_GAP_MS) state.outOfSyncSince = 0;
    state.driftCheckedAt = now;
    const video = state.currentVideoElement || utils.getVideo();
    if (!state.inRoom || state.isHost || !video || !state.lastSyncServerTs
        || state.lastSyncPlayState !== 'playing' || video.paused) {
      state.outOfSyncSince = 0;
      return;
    }
    if (state.pendingMediaId || state.isBuffering || !utils.isVideoReady() || followingHost(video)) return;
    if (Math.abs(expectedPosition() - video.currentTime) < NUDGE_MIN_DRIFT_SEC) state.outOfSyncSince = 0;
    else if (!state.outOfSyncSince) state.outOfSyncSince = now;
  };

  // Moves this guest's video one step toward the host. Local only: guests do
  // not send seeks, and the room's playback does not change.
  const nudge = () => {
    const current = nudgeState();
    if (current.kind !== 'behind' && current.kind !== 'ahead') return { ...current, moved: 0 };
    const video = state.currentVideoElement || utils.getVideo();
    const from = video.currentTime;
    const moved = current.drift > 0 ? current.step : -current.step;
    video.currentTime = from + moved;
    utils.log('SYNC', { type: 'manual_nudge', from, to: from + moved, drift: current.drift });
    return { ...current, moved };
  };

  Object.assign(playback, { watchReady, syncLoop, ownStatus, reportStatus, nudgeState, trackDrift, nudge });
})();
