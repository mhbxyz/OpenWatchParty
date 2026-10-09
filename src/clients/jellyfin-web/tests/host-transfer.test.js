const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
const sockets = [];
let toasts = [];
let renders = 0;
let syncIndicatorUpdates = 0;
let currentMediaId = '';

class FakeVideo {
  constructor({ currentTime = 0, readyState = 2, playbackRate = 1 } = {}) {
    this.currentTime = currentTime;
    this.readyState = readyState;
    this.playbackRate = playbackRate;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  play() {
    this.paused = false;
    this.playCalls++;
    this.listeners.get('play')?.();
    this.listeners.get('playing')?.();
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.pauseCalls++;
    this.listeners.get('pause')?.();
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  constructor() {
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen();
  }

  receive(message) {
    this.onmessage({
      data: JSON.stringify({ ts: Date.now(), server_ts: Date.now(), ...message })
    });
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.document.getElementById = () => null;
OWP.ui = {
  render: () => { renders++; },
  showToast: message => toasts.push(message),
  updateRoomListUI: () => {},
  updateParticipantList: () => {},
  renderHomeWatchParties: () => {},
  hidePanel: () => {},
  updateSyncIndicator: () => { syncIndicatorUpdates++; }
};
OWP.playback = {};
OWP.utils.getVideo = () => OWP.state.currentVideoElement;
OWP.utils.getCurrentItemId = () => currentMediaId;
OWP.utils.getPlayingItemId = () => currentMediaId;
OWP.utils.isVideoReady = () => Boolean(OWP.state.currentVideoElement?.readyState >= 2);
OWP.utils.isSeeking = () => false;
OWP.utils.log = () => {};
OWP.constants.MEDIA_READY_POLL_MS = 1;
OWP.constants.MEDIA_READY_TIMEOUT_MS = 50;

require('../ws/send.js');
require('../playback/play.js');
require('../playback/sync.js');
require('../playback/bind.js');
require('../ws/validation.js');
require('../ws/handlers/room.js');
require('../ws/handlers/playback.js');
require('../ws/handlers/sync.js');
require('../ws/connection.js');
require('../app/lifecycle.js');

const envelope = (type, payload, room) => ({
  type,
  room,
  payload,
  ts: Date.now(),
  server_ts: Date.now()
});

const promote = () => OWP._wsHandlers.handleHostChanged({
  room: 'room-1',
  payload: { host_id: 'client-1', host_name: 'Guest' }
});

const roomState = (mediaId, position = 20) => ({
  type: 'room_state',
  room: 'room-1',
  client: 'client-1',
  server_ts: Date.now(),
  payload: {
    name: 'Room',
    host_id: 'client-2',
    participant_count: 2,
    media_id: mediaId,
    state_server_ts: Date.now(),
    target_server_ts: null,
    state: { position, play_state: 'paused' }
  }
});

describe('host transfer client support', () => {
  beforeEach(() => {
    sockets.length = 0;
    toasts = [];
    renders = 0;
    syncIndicatorUpdates = 0;
    currentMediaId = '';
    Object.assign(OWP.state, {
      ws: null,
      authToken: 'jwt-token',
      authBlocked: false,
      userName: 'Guest',
      userId: 'user',
      clientId: 'client-1',
      inRoom: false,
      roomId: '',
      isHost: false,
      serverFeatures: [],
      autoReconnect: true,
      isConnecting: false,
      connectionAttempt: 0,
      authRequestAttempt: 0,
      connectionPhase: 'disconnected',
      desiredRoomId: '',
      rejoinPending: false,
      rejectedRejoinRoomIds: [],
      currentVideoElement: null,
      bound: false,
      videoListeners: null,
      pendingActionTimer: null,
      mediaReadyCleanup: null,
      playbackActionAttempt: 0,
      playbackRequestAttempt: 0,
      mediaSyncAttempt: 0,
      pendingMediaId: '',
      pendingMediaUntil: 0,
      readyRoomId: '',
      isSyncing: false,
      isInitialSync: false,
      initialSyncUntil: 0,
      initialSyncTargetPos: null,
      syncStatus: 'synced',
      currentDrift: 0,
      syncCooldownUntil: 0,
      pendingPlayUntil: 0,
      lastSyncServerTs: 0,
      lastSyncPosition: 0,
      lastSyncPlayState: '',
      isBuffering: false,
      wantsToPlay: false,
      suppressUntil: 0,
      hasTimeSync: true,
      serverOffsetMs: 0
    });
  });

  afterEach(() => {
    OWP.state.autoReconnect = false;
    if (OWP.state.intervals.ping) {
      OWP.timers.clear(OWP.state.intervals.ping);
      OWP.state.intervals.ping = null;
    }
    if (OWP.state.pendingActionTimer) OWP.timers.clear(OWP.state.pendingActionTimer);
    if (OWP.state.mediaReadyCleanup) OWP.state.mediaReadyCleanup();
    if (OWP.state.bound) {
      OWP.playback.cleanupVideoListeners();
      OWP.state.bound = false;
    }
    OWP.timers.clearScope('room');
    OWP.timers.clearScope('media');
    OWP.actions.cancelRoomRejoin();
    OWP.state.ws = null;
  });

  it('declares host_transfer in the auth payload and stores the server response', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();

    const auth = socket.sent.find(message => message.type === 'auth');
    assert.deepEqual(auth.payload.features, ['host_transfer', 'participant_status']);
    socket.receive({
      type: 'auth_success',
      payload: { user_name: 'Guest', features: ['host_transfer'] }
    });
    assert.deepEqual(OWP.state.serverFeatures, ['host_transfer']);

    OWP.state.serverFeatures = ['stale'];
    OWP._wsHandlers.handleAuthSuccess({ payload: { user_name: 'Guest' } });
    assert.deepEqual(OWP.state.serverFeatures, []);
  });

  it('declares host_transfer on the insecure identity path', async () => {
    const originalFetchAuthToken = OWP.actions.fetchAuthToken;
    OWP.state.authToken = null;
    OWP.actions.fetchAuthToken = async () => ({ mode: 'insecure', token: null });
    try {
      await OWP.actions.connect();
      const socket = sockets[0];
      socket.open();
      const auth = socket.sent.find(message => message.type === 'auth');
      assert.deepEqual(auth.payload.features, ['host_transfer', 'participant_status']);
      assert.equal(auth.payload.token, undefined);
    } finally {
      OWP.actions.fetchAuthToken = originalFetchAuthToken;
    }
  });

  it('does not repeat pending rejoin after insecure auth_success', async () => {
    const originalFetchAuthToken = OWP.actions.fetchAuthToken;
    OWP.state.authToken = null;
    Object.assign(OWP.state, {
      desiredRoomId: 'room-1',
      rejoinPending: true
    });
    OWP.actions.fetchAuthToken = async () => ({ mode: 'insecure', token: null });
    try {
      await OWP.actions.connect();
      const socket = sockets[0];
      socket.open();
      assert.equal(
        socket.sent.filter(message => message.type === 'join_room').length,
        1
      );

      socket.receive({
        type: 'auth_success',
        payload: { user_name: 'Guest', features: ['host_transfer'] }
      });

      assert.equal(OWP.state.connectionPhase, 'authenticated');
      assert.equal(
        socket.sent.filter(message => message.type === 'join_room').length,
        1
      );
    } finally {
      OWP.actions.fetchAuthToken = originalFetchAuthToken;
    }
  });

  it('clears stale server features when a new connection opens', async () => {
    OWP.state.serverFeatures = ['host_transfer'];
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();

    assert.deepEqual(OWP.state.serverFeatures, []);
    socket.receive({ type: 'auth_success', payload: { user_name: 'Guest' } });
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      isHost: true
    });
    OWP.actions.closeRoom();

    const closeMessage = socket.sent.find(message => (
      message.type === 'close_room' || message.type === 'leave_room'
    ));
    assert.equal(closeMessage.type, 'leave_room');
  });

  it('validates auth features and host_changed strictly', () => {
    assert.equal(OWP.wsValidation.validateMessage(
      envelope('auth_success', { user_name: 'Guest', features: ['host_transfer'] })
    ).valid, true);
    for (const features of ['host_transfer', [1], [null]]) {
      assert.equal(OWP.wsValidation.validateMessage(
        envelope('auth_success', { user_name: 'Guest', features })
      ).valid, false);
    }
    assert.equal(OWP.wsValidation.validateMessage(
      envelope('host_changed', { host_id: 'client-1', host_name: 'Guest' }, 'room-1')
    ).valid, true);
    assert.equal(OWP.wsValidation.validateMessage(
      envelope('host_changed', { host_id: 'client-1', host_name: 'Guest', extra: true }, 'room-1')
    ).valid, false);
    assert.equal(OWP.wsValidation.validateMessage(
      envelope('host_changed', { host_id: 1, host_name: 'Guest' }, 'room-1')
    ).valid, false);
  });

  it('resets only drift correction when this client becomes host', () => {
    let cleaned = 0;
    const video = new FakeVideo({ playbackRate: 1.5 });
    const timer = OWP.timers.setTimeout(() => {}, 10000, 'room');
    const mediaReadyCleanup = () => { cleaned++; OWP.state.mediaReadyCleanup = null; };
    const lastSyncServerTs = Date.now();
    const pendingPlayUntil = Date.now() + 1000;
    const suppressUntil = Date.now() + 1000;
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      clientId: 'client-1',
      isHost: false,
      currentVideoElement: video,
      pendingActionTimer: timer,
      mediaReadyCleanup,
      playbackActionAttempt: 7,
      isBuffering: true,
      wantsToPlay: true,
      isSyncing: true,
      isInitialSync: true,
      initialSyncUntil: Date.now() + 5000,
      initialSyncTargetPos: 12,
      syncStatus: 'pending_play',
      currentDrift: 3,
      syncCooldownUntil: Date.now() + 2000,
      pendingPlayUntil,
      pendingMediaId: 'item',
      lastSyncServerTs,
      lastSyncPosition: 12,
      lastSyncPlayState: 'playing',
      suppressUntil
    });

    promote();

    assert.equal(OWP.state.isHost, true);
    assert.equal(video.playbackRate, 1);
    assert.equal(OWP.state.currentDrift, 0);
    assert.equal(OWP.state.syncCooldownUntil, 0);
    assert.equal(OWP.state.syncStatus, 'pending_play');
    assert.equal(OWP.state.pendingActionTimer, timer);
    assert.equal(OWP.state.mediaReadyCleanup, mediaReadyCleanup);
    assert.equal(OWP.state.playbackActionAttempt, 7);
    assert.equal(OWP.state.isBuffering, true);
    assert.equal(OWP.state.wantsToPlay, true);
    assert.equal(OWP.state.isSyncing, true);
    assert.equal(OWP.state.isInitialSync, true);
    assert.notEqual(OWP.state.initialSyncUntil, 0);
    assert.equal(OWP.state.initialSyncTargetPos, 12);
    assert.equal(OWP.state.pendingPlayUntil, pendingPlayUntil);
    assert.equal(OWP.state.pendingMediaId, 'item');
    assert.equal(OWP.state.lastSyncServerTs, lastSyncServerTs);
    assert.equal(OWP.state.lastSyncPosition, 12);
    assert.equal(OWP.state.lastSyncPlayState, 'playing');
    assert.equal(OWP.state.suppressUntil, suppressUntil);
    assert.equal(cleaned, 0);
    assert.equal(syncIndicatorUpdates, 1);
    assert.equal(renders, 1);
    assert.deepEqual(toasts, ['You are now the host']);
  });

  it('normalizes a catching-up guest when promoting it', () => {
    const video = new FakeVideo({ playbackRate: 1.08 });
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      currentVideoElement: video,
      syncStatus: 'syncing',
      currentDrift: 1.5,
      syncCooldownUntil: Date.now() + 2000
    });

    promote();

    assert.equal(video.playbackRate, 1);
    assert.equal(OWP.state.syncStatus, 'synced');
    assert.equal(OWP.state.currentDrift, 0);
    assert.equal(OWP.state.syncCooldownUntil, 0);
  });

  it('keeps autoplay-blocked status when promoting a guest', () => {
    const video = new FakeVideo({ playbackRate: 0.95 });
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      currentVideoElement: video,
      syncStatus: 'blocked'
    });

    promote();

    assert.equal(video.playbackRate, 1);
    assert.equal(OWP.state.syncStatus, 'blocked');
  });

  it('keeps a scheduled play timer and plays at its target after promotion', async () => {
    const sent = [];
    const video = new FakeVideo({ currentTime: 10 });
    const targetServerTs = Date.now() + 20;
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      inRoom: true,
      roomId: 'room-1',
      currentVideoElement: video,
      isBuffering: true
    });
    OWP.playback.bindVideo();
    OWP._wsHandlers.handlePlayerEvent({
      type: 'player_event',
      room: 'room-1',
      server_ts: Date.now(),
      payload: {
        action: 'play',
        position: 10,
        play_state: 'playing',
        target_server_ts: targetServerTs
      }
    }, video);
    const pendingTimer = OWP.state.pendingActionTimer;

    promote();

    assert.equal(OWP.state.pendingActionTimer, pendingTimer);
    assert.equal(video.playCalls, 0);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(video.playCalls, 1);
    assert.equal(video.paused, false);
    assert.deepEqual(sent, []);
  });

  it('suppresses periodic host state updates until promoted pending work finishes', () => {
    const sent = [];
    const video = new FakeVideo({ currentTime: 10 });
    const originalSetInterval = OWP.timers.setInterval;
    let sendPeriodicState = null;
    OWP.timers.setInterval = (callback) => {
      sendPeriodicState = callback;
      return null;
    };
    try {
      Object.assign(OWP.state, {
        ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
        inRoom: true,
        roomId: 'room-1',
        isHost: false,
        currentVideoElement: video,
        isSyncing: false,
        pendingPlayUntil: Date.now() + 1000,
        lastStateSentAt: 0
      });
      OWP.playback.bindVideo();

      promote();
      sendPeriodicState();
      assert.equal(sent.some(message => message.type === 'state_update'), false);

      OWP.state.pendingPlayUntil = 0;
      sendPeriodicState();
      assert.equal(sent.filter(message => message.type === 'state_update').length, 1);
    } finally {
      OWP.timers.setInterval = originalSetInterval;
    }
  });

  it('broadcasts host controls when pendingPlayUntil is stale', async () => {
    const sent = [];
    const video = new FakeVideo({ currentTime: 10 });
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      inRoom: true,
      roomId: 'room-1',
      isHost: true,
      currentVideoElement: video,
      isSyncing: false,
      pendingPlayUntil: OWP.utils.getServerNow() - 1,
      pendingMediaId: '',
      lastStateSentAt: 0
    });
    OWP.playback.bindVideo();

    await video.play();
    video.pause();

    assert.deepEqual(
      sent.filter(message => message.type === 'player_event').map(message => message.payload.action),
      ['play', 'pause']
    );
    assert.equal(sent.filter(message => message.type === 'state_update').length, 2);
  });

  it('broadcasts host controls when the pending media deadline is stale', async () => {
    const sent = [];
    const video = new FakeVideo({ currentTime: 10 });
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      inRoom: true,
      roomId: 'room-1',
      isHost: true,
      currentVideoElement: video,
      isSyncing: false,
      pendingPlayUntil: 0,
      pendingMediaId: 'stale-media',
      pendingMediaUntil: OWP.utils.nowMs() - 1,
      lastStateSentAt: 0
    });
    OWP.playback.bindVideo();

    await video.play();
    video.pause();

    assert.deepEqual(
      sent.filter(message => message.type === 'player_event').map(message => message.payload.action),
      ['play', 'pause']
    );
    assert.equal(sent.filter(message => message.type === 'state_update').length, 2);
  });

  it('refreshes the syncing guard when a promoted host applies a retried scheduled play', async () => {
    const sent = [];
    const originalStartSyncing = OWP.utils.startSyncing;
    let syncStarts = 0;
    OWP.utils.startSyncing = () => {
      syncStarts++;
      OWP.state.isSyncing = true;
    };
    try {
      Object.assign(OWP.state, {
        ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
        inRoom: true,
        roomId: 'room-1',
        isHost: false,
        currentVideoElement: null,
        isSyncing: false
      });
      OWP._wsHandlers.handlePlayerEvent({
        type: 'player_event',
        room: 'room-1',
        server_ts: Date.now(),
        payload: {
          action: 'play',
          position: 10,
          play_state: 'playing',
          target_server_ts: Date.now() + 10
        }
      }, null);

      await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(OWP.state.pendingActionTimer);
      OWP.state.isSyncing = false;
      promote();

      const replacementVideo = new FakeVideo({ currentTime: 0 });
      OWP.state.currentVideoElement = replacementVideo;
      OWP.playback.bindVideo();
      await new Promise(resolve => setTimeout(resolve, 65));

      assert.equal(replacementVideo.playCalls, 1);
      assert.equal(OWP.state.isSyncing, true);
      assert.equal(syncStarts, 3);
      assert.equal(sent.some(message => ['player_event', 'state_update'].includes(message.type)), false);
    } finally {
      OWP.utils.startSyncing = originalStartSyncing;
    }
  });

  it('releases a promoted host after scheduled play retries are exhausted', async () => {
    const sent = [];
    const originalNowMs = OWP.utils.nowMs;
    const originalGetServerNow = OWP.utils.getServerNow;
    const originalScheduleAt = OWP.utils.scheduleAt;
    const originalStartSyncing = OWP.utils.startSyncing;
    const originalSetTimeout = OWP.timers.setTimeout;
    let now = 1000;
    let applyAtTarget = null;
    let retry = null;
    OWP.utils.nowMs = () => now;
    OWP.utils.getServerNow = () => now;
    OWP.utils.scheduleAt = (target, callback) => {
      applyAtTarget = callback;
      OWP.state.pendingActionTimer = { target };
    };
    OWP.utils.startSyncing = () => { OWP.state.isSyncing = true; };
    OWP.timers.setTimeout = (callback) => {
      retry = callback;
      return { retry: true };
    };
    try {
      Object.assign(OWP.state, {
        ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
        inRoom: true,
        roomId: 'room-1',
        isHost: false,
        currentVideoElement: null,
        isSyncing: false
      });
      OWP._wsHandlers.handlePlayerEvent({
        type: 'player_event',
        room: 'room-1',
        server_ts: now,
        payload: {
          action: 'play',
          position: 10,
          play_state: 'playing',
          target_server_ts: 1100
        }
      }, null);

      now = 1100;
      applyAtTarget();
      assert.ok(retry);
      promote();

      now = 3100;
      retry();
      assert.equal(OWP.state.pendingPlayUntil, 0);
      assert.equal(OWP.state.pendingActionTimer, null);

      OWP.state.isSyncing = false;
      const replacementVideo = new FakeVideo({ currentTime: 10 });
      OWP.state.currentVideoElement = replacementVideo;
      OWP.playback.bindVideo();
      await replacementVideo.play();
      assert.equal(sent.some(message => message.type === 'player_event' && message.payload.action === 'play'), true);
    } finally {
      OWP.utils.nowMs = originalNowMs;
      OWP.utils.getServerNow = originalGetServerNow;
      OWP.utils.scheduleAt = originalScheduleAt;
      OWP.utils.startSyncing = originalStartSyncing;
      OWP.timers.setTimeout = originalSetTimeout;
    }
  });

  it('clears pending guest room sync state when video retries are exhausted', () => {
    const originalNowMs = OWP.utils.nowMs;
    const originalGetServerNow = OWP.utils.getServerNow;
    const originalScheduleAt = OWP.utils.scheduleAt;
    const originalSetTimeout = OWP.timers.setTimeout;
    let now = 1000;
    let applyAtTarget = null;
    let retry = null;
    OWP.utils.nowMs = () => now;
    OWP.utils.getServerNow = () => now;
    OWP.utils.scheduleAt = (target, callback) => {
      applyAtTarget = callback;
      OWP.state.pendingActionTimer = { target };
    };
    OWP.timers.setTimeout = (callback) => {
      retry = callback;
      return { retry: true };
    };
    try {
      Object.assign(OWP.state, {
        inRoom: false,
        roomId: '',
        isHost: false,
        currentVideoElement: null
      });
      OWP._wsHandlers.handleRoomState({
        type: 'room_state',
        room: 'room-1',
        client: 'client-1',
        server_ts: now,
        payload: {
          name: 'Room',
          host_id: 'client-2',
          participant_count: 2,
          media_id: '',
          state_server_ts: now,
          target_server_ts: 1100,
          state: { position: 10, play_state: 'playing' }
        }
      }, null);

      assert.equal(OWP.state.pendingPlayUntil, 1100);
      assert.equal(OWP.state.syncStatus, 'pending_play');
      now = 1100;
      applyAtTarget();
      assert.ok(retry);

      now = 3100;
      retry();
      assert.equal(OWP.state.pendingActionTimer, null);
      assert.equal(OWP.state.pendingPlayUntil, 0);
      assert.notEqual(OWP.state.syncStatus, 'pending_play');
    } finally {
      OWP.utils.nowMs = originalNowMs;
      OWP.utils.getServerNow = originalGetServerNow;
      OWP.utils.scheduleAt = originalScheduleAt;
      OWP.timers.setTimeout = originalSetTimeout;
    }
  });

  it('keeps a media load and applies its room state after promotion', async () => {
    const sent = [];
    currentMediaId = 'old-media';
    const oldVideo = new FakeVideo({ currentTime: 5 });
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      currentVideoElement: oldVideo
    });
    OWP.playback.bindVideo();

    OWP._wsHandlers.handleRoomState(roomState('new-media', 20), oldVideo);
    const mediaReadyCleanup = OWP.state.mediaReadyCleanup;

    promote();

    assert.equal(OWP.state.pendingMediaId, 'new-media');
    assert.equal(OWP.state.mediaReadyCleanup, mediaReadyCleanup);
    await oldVideo.play();
    assert.deepEqual(sent, []);
    currentMediaId = 'new-media';
    const loadedVideo = new FakeVideo({ currentTime: 0 });
    OWP.state.currentVideoElement = loadedVideo;
    await new Promise(resolve => setTimeout(resolve, 15));

    assert.equal(OWP.state.pendingMediaId, '');
    assert.equal(OWP.state.mediaReadyCleanup, null);
    assert.equal(loadedVideo.currentTime, 20);
    assert.equal(loadedVideo.pauseCalls, 1);
    assert.equal(sent.some(message => ['player_event', 'state_update'].includes(message.type)), false);
  });

  it('releases a promoted host after the media readiness deadline', async () => {
    const sent = [];
    currentMediaId = 'old-media';
    const oldVideo = new FakeVideo({ currentTime: 5 });
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      currentVideoElement: oldVideo
    });
    OWP.playback.bindVideo();

    OWP._wsHandlers.handleRoomState(roomState('never-ready', 20), oldVideo);
    promote();
    await oldVideo.play();
    assert.equal(sent.some(message => message.type === 'player_event'), false);

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(OWP.state.pendingMediaId, '');
    assert.equal(OWP.state.pendingMediaUntil, 0);

    await oldVideo.play();
    assert.equal(sent.some(message => message.type === 'player_event' && message.payload.action === 'play'), true);
  });

  it('does not gate a regular host for a future room state', async () => {
    const sent = [];
    const video = new FakeVideo({ currentTime: 10 });
    const targetServerTs = Date.now() + 20;
    Object.assign(OWP.state, {
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
      inRoom: true,
      roomId: 'room-1',
      isHost: true,
      currentVideoElement: video,
      lastStateSentAt: 0
    });
    OWP.playback.bindVideo();

    OWP._wsHandlers.handleRoomState({
      type: 'room_state',
      room: 'room-1',
      client: 'client-1',
      server_ts: Date.now(),
      payload: {
        name: 'Room',
        host_id: 'client-1',
        participant_count: 2,
        media_id: 'current-media',
        state_server_ts: Date.now(),
        target_server_ts: targetServerTs,
        state: { position: 10, play_state: 'playing' }
      }
    }, video);

    assert.equal(OWP.state.pendingPlayUntil, 0);
    assert.equal(OWP.state.pendingActionTimer, null);

    await video.play();
    video.pause();
    assert.deepEqual(
      sent.filter(message => message.type === 'player_event').map(message => message.payload.action),
      ['play', 'pause']
    );
  });

  it('shows the new host name to other members', () => {
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-1', clientId: 'client-1', isHost: true });

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-2', host_name: 'Alice' }
    });

    assert.equal(OWP.state.isHost, false);
    assert.deepEqual(toasts, ['Alice is now the host']);
    assert.equal(renders, 1);
  });

  it('uses close_room only when the server negotiated host transfer', () => {
    const sent = [];
    OWP.state.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-1', isHost: true, serverFeatures: ['host_transfer'] });
    OWP.actions.closeRoom();
    assert.equal(sent[0].type, 'close_room');

    Object.assign(OWP.state, { inRoom: true, roomId: 'room-2', isHost: true, serverFeatures: [] });
    OWP.actions.closeRoom();
    assert.equal(sent[1].type, 'leave_room');
  });

  it('leaving the player still sends leave_room for a host', () => {
    const sent = [];
    OWP.state.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      isHost: true,
      serverFeatures: ['host_transfer']
    });

    OWP._lifecycle.onVideoPlayerExit();

    assert.equal(sent[0].type, 'leave_room');
  });
});
