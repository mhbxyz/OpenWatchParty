(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const start = OWP.start = OWP.start || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const t = OWP.i18n.t;

  // With a server that has start_when_ready, a play waits until every member
  // is ready (up to the server's limit) and the one that starts the room's
  // item counts down. This client says why it isn't ready, holds its video
  // while the room waits, and tells in the chat, as SERVER, who the room
  // waits for and why.
  const FEATURE = 'start_when_ready';
  const supported = () => state.inRoom && state.serverFeatures.includes(FEATURE);
  const send = (type, payload) => {
    if (OWP.actions?.send) OWP.actions.send(type, payload);
  };

  // A stream through the server's HLS (hls.js plays it from a blob: URL,
  // Safari from the playlist): the server converts it while it loads.
  const serverStream = src => src.startsWith('blob:') || /\.m3u8(\?|$)/i.test(src);

  // Why this client can't play now, or null when it can.
  const ownReason = () => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!video || state.pendingMediaId || video.readyState < 2) {
      return video && serverStream(video.currentSrc || '') ? 'transcoding' : 'loading';
    }
    if (state.syncStatus === 'blocked') return 'autoplay_blocked';
    // A paused video stops loading once it has its frame (readyState 2), so
    // only a stall (waiting) or a seek on its way is buffering.
    if (state.isBuffering || video.seeking) return 'buffering';
    return null;
  };

  // Video events change the reason at once; the sync loop catches the rest.
  const WATCHED_EVENTS = ['waiting', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'loadeddata', 'emptied', 'play'];
  let watchedVideo = null;
  const watchVideo = (video) => {
    if (video === watchedVideo) return;
    if (watchedVideo) WATCHED_EVENTS.forEach(type => watchedVideo.removeEventListener(type, onVideoEvent));
    watchedVideo = video;
    if (video) WATCHED_EVENTS.forEach(type => video.addEventListener(type, onVideoEvent));
  };

  // Sends this client's readiness when it changes (and again after a
  // reconnection: a new client id).
  const report = () => {
    // A server that no longer has the feature won't end what it showed.
    if (!supported() && state.startPhase !== 'idle') onStartState({ state: 'idle' });
    if (!supported() || !state.ws || state.ws.readyState !== 1) return;
    watchVideo(state.currentVideoElement || utils.getVideo());
    const reason = ownReason();
    // Per item too: the server forgets what was said about the previous one.
    const key = `${state.roomId}|${state.clientId}|${state.roomMediaId}|${reason || ''}`;
    if (key === state.readinessSentKey) return;
    state.readinessSentKey = key;
    send('readiness', reason ? { ready: false, reason } : { ready: true });
  };

  // Whether this member may start a play: the host, or a guest sharing the controls.
  const canStart = () => state.isHost || state.sharedPlaybackControl;

  const startNow = () => {
    if (state.startPhase !== 'waiting' || !canStart()) return;
    send('start_now', {});
  };

  // OWP's own pause: the video waits for the room's start, and nothing is
  // sent. This client plays it again at the start: the room's play command
  // would not, for the host's own play it sees as already applied.
  let heldVideo = null;
  let resumeTimer = null;
  const hold = (position) => {
    const video = state.currentVideoElement || utils.getVideo();
    if (!video) return;
    utils.suppress();
    utils.startSyncing();
    if (!video.paused) video.pause();
    if (typeof position === 'number' && Math.abs(video.currentTime - position) > 0.5) video.currentTime = position;
    heldVideo = video;
  };
  const resumeHeld = () => {
    resumeTimer = null;
    const video = heldVideo;
    heldVideo = null;
    if (!video || !state.inRoom || video !== (state.currentVideoElement || utils.getVideo()) || !video.paused) return;
    utils.suppress();
    utils.startSyncing();
    if (OWP.playback?.safePlay) OWP.playback.safePlay(video, 'room start');
  };
  const stopResume = () => {
    if (resumeTimer) OWP.timers.clear(resumeTimer);
    resumeTimer = null;
  };
  const resumeAt = (targetServerTs) => {
    stopResume();
    if (heldVideo) resumeTimer = OWP.timers.setTimeout(resumeHeld, Math.max(0, targetServerTs - utils.getServerNow()), 'room');
  };

  // Until when this module holds the room work (pendingPlayUntil), so it only
  // moves or clears its own hold.
  let holdUntil = 0;
  const holdRoomWork = (until) => {
    state.pendingPlayUntil = state.pendingPlayUntil === holdUntil ? until : Math.max(state.pendingPlayUntil || 0, until);
    holdUntil = until;
  };
  const releaseRoomWork = () => {
    if (holdUntil && state.pendingPlayUntil === holdUntil) state.pendingPlayUntil = 0;
    holdUntil = 0;
  };

  // A play pressed while the room waits starts it at once; during the
  // countdown the video keeps waiting for it. OWP's own play (the room's
  // start, applied at its time) goes through.
  const START_MARGIN_MS = 150;
  const onVideoEvent = (event) => {
    const ownPlay = !utils.shouldSend() || state.isSyncing;
    if (event.type === 'play' && !ownPlay) {
      if (state.startPhase === 'waiting') {
        startNow();
        hold(state.startPosition);
      } else if (state.startPhase === 'starting' && utils.getServerNow() < state.startTarget - START_MARGIN_MS) {
        hold();
      }
    }
    report();
  };

  const reasonText = (reason, past) => t(`${past ? 'startWas' : 'startIs'}_${reason}`);
  const serverLine = (key, params, isError = false) => {
    if (OWP.chat?.system) OWP.chat.system(t(key, params), isError);
  };

  const updateUi = () => {
    if (OWP.ui?.updateStartLabel) OWP.ui.updateStartLabel();
  };

  // While the room waits or counts down, the label follows the clock and the
  // panel (it shows on its own while the panel is closed).
  let tickTimer = null;
  const tick = () => {
    tickTimer = null;
    if (state.startPhase === 'starting' && utils.getServerNow() >= state.startTarget) {
      state.startPhase = 'idle';
    }
    updateUi();
    if (state.startPhase !== 'idle') tickTimer = OWP.timers.setTimeout(tick, 250, 'room');
  };
  const scheduleTick = () => {
    if (tickTimer) OWP.timers.clear(tickTimer);
    tick();
  };

  // A member gone from the list got ready, unless it left the room: the
  // server sends the list before client_left, so the line waits a moment.
  const READY_LINE_DELAY_MS = 300;
  const readyLines = new Map();
  const announceReady = (client, member, now) => {
    const seconds = Math.max(0, Math.round((now - member.since) / 1000));
    readyLines.set(client, OWP.timers.setTimeout(() => {
      readyLines.delete(client);
      serverLine('startMemberReady', { name: member.name, seconds });
    }, READY_LINE_DELAY_MS, 'room'));
  };
  const onClientLeft = (client) => {
    const timer = readyLines.get(client);
    if (!timer) return;
    OWP.timers.clear(timer);
    readyLines.delete(client);
  };

  const onStartState = (payload) => {
    const now = utils.nowMs();
    // A play pressed while the room waits must reach this module.
    watchVideo(state.currentVideoElement || utils.getVideo());
    // Who the room waited for, by client id: name, reason and since when (local).
    const before = state.startWaiting;
    const after = {};
    if (payload.state === 'waiting') {
      for (const member of payload.waiting_for) {
        const previous = before[member.client];
        after[member.client] = { name: member.name, reason: member.reason, since: previous ? previous.since : now };
        if (!previous || previous.reason !== member.reason) {
          serverLine('startWaitingFor', { name: member.name, reason: reasonText(member.reason, false) });
        }
      }
    }
    const without = payload.state === 'starting' ? payload.without : [];
    const left = new Set(without.map(member => member.client));
    if (payload.state !== 'idle') {
      for (const [client, member] of Object.entries(before)) {
        if (!after[client] && !left.has(client)) announceReady(client, member, now);
      }
    }
    for (const member of without) {
      serverLine('startWithout', { name: member.name, reason: reasonText(member.reason, true) }, true);
    }
    if (payload.state === 'idle' && state.startPhase === 'waiting') serverLine('startCancelled', {});

    state.startWaiting = after;
    if (payload.state === 'waiting') {
      state.startPhase = 'waiting';
      state.startPosition = payload.position;
      state.startDeadline = payload.deadline_server_ts;
      // The room waits: this video waits too, and its events stay local.
      holdRoomWork(payload.deadline_server_ts);
      stopResume();
      hold(payload.position);
    } else if (payload.state === 'starting') {
      // The room starts at the target: the hold lasts until then.
      holdRoomWork(payload.target_server_ts);
      if (payload.countdown) {
        state.startPhase = 'starting';
        state.startTarget = payload.target_server_ts;
        hold();
      } else {
        state.startPhase = 'idle';
      }
      resumeAt(payload.target_server_ts);
    } else {
      releaseRoomWork();
      stopResume();
      heldVideo = null;
      state.startPhase = 'idle';
    }
    scheduleTick();
  };

  Object.assign(start, { report, ownReason, onStartState, onClientLeft, startNow, canStart, FEATURE });
})();
