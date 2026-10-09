const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

let video;
let serverNow;
let localNow;
let safePlayCalls;

class FakeVideo {
  constructor() {
    this.currentTime = 10;
    this.playbackRate = 1;
    this.paused = false;
    this.readyState = 4;
    this.isConnected = true;
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

  dispatch(type) {
    this.listeners.get(type)?.();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pauseCalls++;
    this.dispatch('pause');
  }

  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this.playCalls++;
    this.dispatch('play');
    return Promise.resolve();
  }
}

OWP.ui = {
  render: () => {},
  showToast: () => {},
  updateSyncIndicator: () => {}
};
OWP.playback = {
  safePlay: target => {
    safePlayCalls++;
    return target.play();
  }
};
OWP.chat = { clear: () => {} };
OWP.utils.getVideo = () => video;
OWP.utils.getServerNow = () => serverNow;
OWP.utils.nowMs = () => localNow;
OWP.utils.adjustedPosition = position => position;
OWP.utils.isVideoReady = () => true;
OWP.utils.isSeeking = () => false;
OWP.utils.shouldSend = () => true;
OWP.utils.startSyncing = () => {};
OWP.utils.scheduleAt = (target, callback) => callback();
OWP.utils.suppress = () => {};
OWP.utils.log = () => {};

require('../playback/bind.js');
require('../playback/sync.js');
require('../ws/send.js');
require('../ws/handlers/sync.js');
require('../ws/handlers/playback.js');

const playerEvent = (action, position, playState) => ({
  room: 'room-a',
  server_ts: serverNow,
  payload: {
    action,
    position,
    ...(playState ? { play_state: playState } : {})
  }
});

const setPlayingGuest = () => {
  video.paused = false;
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-a',
    clientId: 'guest',
    isHost: false,
    guestPaused: false,
    roomWaiting: false,
    isBuffering: false,
    isSyncing: false,
    pendingMediaId: '',
    pendingPlayUntil: 0,
    lastSyncServerTs: serverNow,
    lastSyncPosition: 10,
    lastSyncPlayState: 'playing',
    playbackActionAttempt: 0,
    currentVideoElement: video,
    isInitialSync: false,
    initialSyncUntil: 0,
    initialSyncTargetPos: null,
    syncCooldownUntil: 0,
    syncStatus: 'synced',
    rejectedRejoinRoomIds: [],
    rejoinPending: false,
    desiredRoomId: ''
  });
};

describe('guest-owned pause', () => {
  beforeEach(() => {
    if (OWP.state.bound) OWP.playback.cleanupVideoListeners();
    serverNow = 1000;
    localNow = 1000;
    safePlayCalls = 0;
    video = new FakeVideo();
    setPlayingGuest();
    OWP.state.bound = false;
    OWP.playback.bindVideo();
  });

  afterEach(() => {
    OWP.playback.cleanupVideoListeners();
    OWP.timers.clearScope('room');
  });

  it('holds through state updates, host play, and playing seek while tracking room position', () => {
    video.pause();
    assert.equal(OWP.state.guestPaused, true);

    serverNow = 2000;
    localNow = 2000;
    OWP._wsHandlers.handleStateUpdate({
      server_ts: serverNow,
      payload: { play_state: 'playing', position: 30 }
    }, video);
    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 10);
    assert.equal(safePlayCalls, 0);
    assert.equal(OWP.state.lastSyncPosition, 30);
    assert.equal(OWP.state.lastSyncServerTs, 2000);
    assert.equal(OWP.state.lastSyncPlayState, 'playing');

    OWP._wsHandlers.handlePlayerEvent(playerEvent('play', 40), video);
    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 10);
    assert.equal(safePlayCalls, 0);
    assert.equal(OWP.state.lastSyncPosition, 40);

    OWP._wsHandlers.handlePlayerEvent(playerEvent('seek', 50, 'playing'), video);
    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 10);
    assert.equal(safePlayCalls, 0);
    assert.equal(OWP.state.lastSyncPosition, 50);
    assert.equal(OWP.state.lastSyncPlayState, 'playing');
  });

  it('does not treat OWP pauses as a guest-owned pause', () => {
    const assertRoomPause = (action, playState) => {
      setPlayingGuest();
      OWP._wsHandlers.handlePlayerEvent(playerEvent(action, 20, playState), video);
      assert.equal(video.paused, true, action);
      assert.equal(OWP.state.guestPaused, false, action);
    };

    assertRoomPause('pause');
    assertRoomPause('buffering');
    assertRoomPause('seek', 'paused');

    setPlayingGuest();
    OWP._wsHandlers.handleStateUpdate({
      server_ts: serverNow,
      payload: { play_state: 'paused', position: 20 }
    }, video);
    assert.equal(OWP.state.guestPaused, false);

    setPlayingGuest();
    OWP.state.lastSyncPlayState = 'paused';
    OWP.playback.syncLoop();
    assert.equal(video.paused, true);
    assert.equal(OWP.state.guestPaused, false);

    setPlayingGuest();
    OWP._wsHandlers.handleRoomState({
      room: 'room-a',
      client: 'guest',
      server_ts: serverNow,
      payload: {
        name: 'Room',
        participant_count: 2,
        host_id: 'host',
        state: { position: 20, play_state: 'paused' }
      }
    }, video);
    assert.equal(video.paused, true);
    assert.equal(OWP.state.guestPaused, false);
  });

  it('clears on guest play and catches up on the next sync tick', async () => {
    video.pause();
    OWP.state.isInitialSync = true;
    OWP.state.initialSyncUntil = 9000;
    OWP.state.initialSyncTargetPos = 12;
    OWP.state.syncCooldownUntil = 9000;

    serverNow = 5000;
    localNow = 5000;
    OWP._wsHandlers.handleStateUpdate({
      server_ts: serverNow,
      payload: { play_state: 'playing', position: 30 }
    }, video);

    await video.play();
    assert.equal(OWP.state.guestPaused, false);
    assert.equal(OWP.state.isInitialSync, false);
    assert.equal(OWP.state.initialSyncUntil, 0);
    assert.equal(OWP.state.initialSyncTargetPos, null);
    assert.equal(OWP.state.syncCooldownUntil, 0);
    assert.equal(video.currentTime, 10);

    OWP.playback.syncLoop();
    assert.equal(video.currentTime, 30);
  });

  it('does not carry a pause over to a new video', () => {
    OWP.state.guestPaused = true;
    video = new FakeVideo();

    OWP.playback.bindVideo();

    assert.equal(OWP.state.currentVideoElement, video);
    assert.equal(OWP.state.guestPaused, false);
  });

  it('resets on leave, join, and host transfer', () => {
    OWP.state.guestPaused = true;
    OWP.actions.resetRoomState();
    assert.equal(OWP.state.guestPaused, false);

    OWP.state.guestPaused = true;
    OWP.actions.joinRoom('room-b');
    assert.equal(OWP.state.guestPaused, false);

    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-a',
      clientId: 'guest',
      isHost: false,
      guestPaused: true,
      rejoinPending: false,
      rejectedRejoinRoomIds: []
    });
    OWP._wsHandlers.handleRoomState({
      room: 'room-a',
      client: 'guest',
      server_ts: serverNow,
      payload: {
        name: 'Room',
        participant_count: 2,
        host_id: 'guest',
        state: { position: 30, play_state: 'playing' }
      }
    }, video);
    assert.equal(OWP.state.isHost, true);
    assert.equal(OWP.state.guestPaused, false);
  });
});
