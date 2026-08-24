const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let currentMediaId = 'old-media';
let currentVideo = null;
let sent = [];
let ensuredMedia = [];
let ensureCalls = [];

class FakeVideo {
  constructor({ readyState = 2, currentTime = 0 } = {}) {
    this.readyState = readyState;
    this.currentTime = currentTime;
    this.playbackRate = 1;
    this.paused = true;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  pause() {
    this.paused = true;
    this.pauseCalls++;
  }

  play() {
    this.paused = false;
    this.playCalls++;
    return Promise.resolve();
  }
}

OWP.constants.MEDIA_READY_POLL_MS = 1;
OWP.constants.MEDIA_READY_TIMEOUT_MS = 50;
OWP.ui = { render: () => {}, updateSyncIndicator: () => {} };
OWP.ui.showToast = () => {};
OWP.utils.getVideo = () => currentVideo;
OWP.utils.getCurrentItemId = () => currentMediaId;
OWP.utils.startSyncing = () => {};
OWP.utils.log = () => {};
OWP.utils.isVideoReady = () => Boolean(currentVideo && currentVideo.readyState >= 2);
OWP.actions = {
  send: (type, payload) => sent.push({ type, payload, room: OWP.state.roomId }),
  completeRoomRejoin: () => {}
};

require('../playback/sync.js');
OWP.playback.ensurePlayback = (...args) => {
  ensuredMedia.push(args[0]);
  ensureCalls.push(args);
};
require('../ws/handlers/sync.js');

const roomState = (room, mediaId, position = 20) => ({
  type: 'room_state',
  room,
  client: 'guest',
  server_ts: Date.now(),
  payload: {
    name: room,
    host_id: 'host',
    participant_count: 2,
    media_id: mediaId,
    state: { position, play_state: 'paused' }
  }
});

describe('media-correlated ready state', () => {
  beforeEach(() => {
    currentMediaId = 'old-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 5 });
    sent = [];
    ensuredMedia = [];
    ensureCalls = [];
    Object.assign(OWP.state, {
      clientId: 'guest',
      inRoom: false,
      roomId: '',
      isHost: false,
      readyRoomId: '',
      mediaSyncAttempt: 0,
      mediaReadyCleanup: null,
      pendingMediaId: '',
      currentVideoElement: null,
      hasTimeSync: true,
      serverOffsetMs: 0
    });
  });

  afterEach(() => {
    if (OWP.state.mediaReadyCleanup) OWP.state.mediaReadyCleanup();
  });

  it('never synchronizes or declares ready on the previous media', async () => {
    const previousVideo = currentVideo;

    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), previousVideo);

    assert.deepEqual(ensuredMedia, ['new-media']);
    assert.equal(previousVideo.currentTime, 5);
    assert.equal(sent.length, 0);

    currentMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(currentVideo.currentTime > 19 && currentVideo.currentTime < 21);
    assert.equal(currentVideo.pauseCalls, 1);
    assert.deepEqual(sent, [{
      type: 'ready',
      payload: { room: 'room-a', media_id: 'new-media' },
      room: 'room-a'
    }]);
    assert.equal(OWP.state.pendingMediaId, '');
  });

  it('waits for video transition when Jellyfin changes item id first', async () => {
    const previousVideo = currentVideo;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), previousVideo);

    currentMediaId = 'new-media';
    previousVideo.playbackRate = 2;
    OWP.playback.syncLoop();
    assert.equal(previousVideo.playbackRate, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sent.length, 0);
    assert.equal(previousVideo.currentTime, 5);

    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.media_id, 'new-media');
  });

  it('accepts an explicitly changed source on a reused video element', async () => {
    const reusedVideo = currentVideo;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), reusedVideo);

    currentMediaId = 'new-media';
    reusedVideo.currentSrc = 'blob:new-media';
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(currentVideo, reusedVideo);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.media_id, 'new-media');
  });

  it('follows a replacement video element for the target media', async () => {
    currentMediaId = 'new-media';
    const bufferingVideo = new FakeVideo({ readyState: 0, currentTime: 0 });
    currentVideo = bufferingVideo;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), bufferingVideo);

    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(sent.length, 1);
    assert.equal(bufferingVideo.currentTime, 0);
    assert.equal(bufferingVideo.listeners.size, 0);
  });

  it('cancels the previous tuple when room changes during loading', async () => {
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'media-a'), currentVideo);
    OWP._wsHandlers.handleRoomState(roomState('room-b', 'media-b'), currentVideo);

    currentMediaId = 'media-a';
    currentVideo = new FakeVideo({ readyState: 2 });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sent.length, 0);

    currentMediaId = 'media-b';
    currentVideo = new FakeVideo({ readyState: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].room, 'room-b');
  });

  it('preserves a zero-position synchronization target', async () => {
    currentMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 10 });

    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media', 0), currentVideo);
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(currentVideo.currentTime >= 0 && currentVideo.currentTime < 1);
    assert.equal(sent.length, 1);
  });

  it('retries media startup after readiness timeout and accepts late media', async () => {
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'late-media'), currentVideo);
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.ok(ensuredMedia.filter(id => id === 'late-media').length >= 2);
    assert.equal(ensureCalls.some(call => call[0] === 'late-media' && call[3] === true), true);
    assert.equal(sent.length, 0);

    currentMediaId = 'late-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(OWP.state.pendingMediaId, '');
  });

  it('forces restart after timeout when item id changed without video transition', async () => {
    const previousVideo = currentVideo;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), previousVideo);
    currentMediaId = 'new-media';

    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(sent.length, 0);
    assert.equal(ensureCalls.some(call => call[3] === true), true);
  });
});
