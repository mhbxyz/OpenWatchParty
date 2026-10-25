const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let currentMediaId = 'old-media';
// The item the player is playing; undefined follows currentMediaId.
let playingMediaId;
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
OWP.constants.VIDEO_ACTION_RETRY_MS = 1;
OWP.constants.VIDEO_ACTION_MAX_WAIT_MS = 30;
OWP.ui = { render: () => {}, updateSyncIndicator: () => {} };
OWP.ui.showToast = () => {};
OWP.utils.getVideo = () => currentVideo;
OWP.utils.getCurrentItemId = () => currentMediaId;
OWP.utils.getPlayingItemId = () => (playingMediaId === undefined ? currentMediaId : playingMediaId);
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

const roomState = (room, mediaId, position = 20, targetServerTs = null) => ({
  type: 'room_state',
  room,
  client: 'guest',
  server_ts: Date.now(),
  payload: {
    name: room,
    host_id: 'host',
    participant_count: 2,
    media_id: mediaId,
    state_server_ts: Date.now(),
    target_server_ts: targetServerTs,
    state: { position, play_state: 'paused' }
  }
});

describe('media-correlated ready state', () => {
  beforeEach(() => {
    currentMediaId = 'old-media';
    playingMediaId = undefined;
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 5 });
    sent = [];
    ensuredMedia = [];
    ensureCalls = [];
    Object.assign(OWP.state, {
      mediaSwitchUntil: 0,
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

  it('declares ready on the playing media while a hidden page names the previous one', async () => {
    const previousVideo = currentVideo;
    // OWP left the player to open the room media (see launchViaDetailsPage).
    OWP.state.mediaSwitchUntil = Date.now() + 20000;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), previousVideo);

    // Jellyfin plays the room media, but the hidden page of the previous item
    // still names it, so getCurrentItemId keeps returning 'old-media'.
    playingMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(currentMediaId, 'old-media');
    assert.ok(currentVideo.currentTime > 19 && currentVideo.currentTime < 21);
    assert.equal(currentVideo.pauseCalls, 1);
    // The room media plays: closing the player now leaves the room at once.
    assert.equal(OWP.state.mediaSwitchUntil, 0);
    assert.deepEqual(sent.map(message => message.payload), [{ room: 'room-a', media_id: 'new-media' }]);
    assert.equal(ensureCalls.some(call => call[3] === true), false);
  });

  it('declares ready at once when the room media already plays and a hidden page names another', async () => {
    const video = currentVideo;
    video.currentSrc = 'blob:new-media';
    playingMediaId = 'new-media';
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), video);
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(currentMediaId, 'old-media');
    assert.ok(video.currentTime > 19 && video.currentTime < 21);
    assert.deepEqual(sent.map(message => message.payload), [{ room: 'room-a', media_id: 'new-media' }]);
    assert.equal(ensureCalls.some(call => call[3] === true), false);
  });

  it('does not synchronize a stale video while a details page names the room media', async () => {
    const staleVideo = currentVideo;
    currentMediaId = 'new-media';
    playingMediaId = null;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), staleVideo);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(staleVideo.currentTime, 5);
    assert.equal(staleVideo.pauseCalls, 0);
    assert.equal(sent.length, 0);

    playingMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(staleVideo.currentTime, 5);
  });

  it('accepts the room media replayed on the same video element after a details page', async () => {
    // A details page of the room media is shown and nothing plays yet; the
    // video element left from an earlier playback of that media is reused.
    const video = currentVideo;
    video.currentSrc = 'blob:new-media';
    currentMediaId = 'new-media';
    playingMediaId = null;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), video);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sent.length, 0);

    playingMediaId = 'new-media';
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(sent.length, 1);
    assert.equal(ensureCalls.some(call => call[3] === true), false);
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

  it('does not reopen the room media while its video is still loading', async () => {
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'slow-media'), currentVideo);
    currentMediaId = 'slow-media';
    currentVideo = new FakeVideo({ readyState: 0, currentTime: 0 });

    await new Promise(resolve => setTimeout(resolve, 130));

    assert.equal(ensureCalls.some(call => call[3] === true), false);
    assert.deepEqual(ensuredMedia, ['slow-media']);
    assert.equal(sent.length, 0);
    currentVideo.readyState = 2;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(sent.map(message => message.type), ['ready']);
  });

  it('reopens the room media when its video failed to load', async () => {
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'broken-media'), currentVideo);
    currentMediaId = 'broken-media';
    currentVideo = new FakeVideo({ readyState: 0, currentTime: 0 });
    currentVideo.error = { code: 4 };

    await new Promise(resolve => setTimeout(resolve, 70));

    assert.equal(ensureCalls.some(call => call[0] === 'broken-media' && call[3] === true), true);
  });

  it('reopens room media that never shows up only a few times', async () => {
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'missing-media'), currentVideo);

    const reopenCount = () => ensureCalls.filter(call => call[3] === true).length;
    const deadline = Date.now() + 2000;
    while (reopenCount() < OWP.constants.MEDIA_READY_MAX_REOPENS && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(reopenCount(), OWP.constants.MEDIA_READY_MAX_REOPENS);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(reopenCount(), OWP.constants.MEDIA_READY_MAX_REOPENS);
    assert.equal(sent.length, 0);
  });

  it('a host that rejoins with its role declares the loaded room media ready', () => {
    currentMediaId = 'room-media';
    Object.assign(OWP.state, { rejoinPending: true, desiredRoomId: 'room-a', rejectedRejoinRoomIds: [] });
    const msg = roomState('room-a', 'room-media');
    msg.payload.host_id = 'guest';

    OWP._wsHandlers.handleRoomState(msg, currentVideo);

    assert.equal(OWP.state.isHost, true);
    assert.deepEqual(sent.filter(message => message.type === 'ready'),
      [{ type: 'ready', payload: { room: 'room-a', media_id: 'room-media' }, room: 'room-a' }]);
    assert.deepEqual(ensuredMedia, []);
  });

  it('a guest that rejoins declares ready once, through the guest path', async () => {
    currentMediaId = 'room-media';
    Object.assign(OWP.state, { rejoinPending: true, desiredRoomId: 'room-a', rejectedRejoinRoomIds: [] });
    const msg = roomState('room-a', 'room-media');
    msg.payload.host_id = 'host';

    OWP._wsHandlers.handleRoomState(msg, currentVideo);
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(OWP.state.isHost, false);
    assert.equal(sent.filter(message => message.type === 'ready').length, 1);
  });

  it('a host does not declare ready on a room state it did not rejoin', () => {
    currentMediaId = 'room-media';
    Object.assign(OWP.state, { rejoinPending: false, desiredRoomId: '', rejectedRejoinRoomIds: [] });
    const msg = roomState('room-a', 'room-media');
    msg.payload.host_id = 'guest';

    OWP._wsHandlers.handleRoomState(msg, currentVideo);

    assert.equal(OWP.state.isHost, true);
    assert.equal(sent.some(message => message.type === 'ready'), false);
  });

  it('forces restart after timeout when item id changed without video transition', async () => {
    const previousVideo = currentVideo;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media'), previousVideo);
    currentMediaId = 'new-media';

    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(sent.length, 0);
    assert.equal(ensureCalls.some(call => call[3] === true), true);
  });

  it('does not apply a future room state before its target', async () => {
    currentMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 50 });
    const target = Date.now() + 20;

    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media', 10, target), currentVideo);

    assert.equal(currentVideo.currentTime, 50);
    assert.equal(currentVideo.pauseCalls, 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(currentVideo.currentTime, 10);
    assert.equal(currentVideo.pauseCalls, 1);
  });

  it('applies future room state to a replacement appearing after target', async () => {
    currentMediaId = 'new-media';
    const originalVideo = new FakeVideo({ readyState: 2, currentTime: 50 });
    currentVideo = originalVideo;
    const target = Date.now() + 15;
    OWP._wsHandlers.handleRoomState(roomState('room-a', 'new-media', 10, target), originalVideo);

    setTimeout(() => {
      originalVideo.isConnected = false;
      currentVideo = null;
    }, 5);
    setTimeout(() => {
      currentVideo = new FakeVideo({ readyState: 2, currentTime: 30 });
    }, 20);
    await new Promise(resolve => setTimeout(resolve, 35));

    assert.equal(originalVideo.currentTime, 50);
    assert.equal(currentVideo.currentTime, 10);
    assert.equal(currentVideo.pauseCalls, 1);
  });
});
