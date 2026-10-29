const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let serverNow;
let localNow;
let video;
OWP.ui = { updateSyncIndicator: () => {} };
OWP.utils.getVideo = () => video;
OWP.utils.getServerNow = () => serverNow;
OWP.utils.nowMs = () => localNow;
OWP.utils.isVideoReady = () => true;
OWP.utils.log = () => {};
require('../playback/bind.js');
require('../playback/sync.js');

let sent;

const assertSeekIsLocal = () => {
  const realSuppress = OWP.utils.suppress;
  const realShouldSend = OWP.utils.shouldSend;
  OWP.utils.suppress = () => { OWP.state.suppressUntil = localNow + 2000; };
  OWP.utils.shouldSend = () => localNow > OWP.state.suppressUntil;
  try {
    OWP.playback.syncLoop();
    video.dispatch('seeked');
    assert.deepEqual(sent, []);
  } finally {
    OWP.utils.suppress = realSuppress;
    OWP.utils.shouldSend = realShouldSend;
  }
};

describe('initial synchronization hard-seek policy', () => {
  beforeEach(() => {
    if (OWP.state.bound) OWP.playback.cleanupVideoListeners();
    serverNow = 1000;
    localNow = 1000;
    sent = [];
    const listeners = new Map();
    video = {
      currentTime: 0,
      playbackRate: 1,
      paused: false,
      readyState: 4,
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      dispatch: type => listeners.get(type)?.()
    };
    OWP.actions = { send: (...args) => sent.push(args) };
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: false,
      roomId: 'room-1',
      roomPermissions: { seek: true, change_media: false, edit_queue: false },
      isBuffering: false,
      pendingMediaId: '',
      pendingPlayUntil: 0,
      streamReloadUntil: 0,
      suppressUntil: 0,
      bound: false,
      currentVideoElement: video,
      lastSyncServerTs: 1000,
      lastSyncPosition: 0,
      lastSyncPlayState: 'playing',
      isInitialSync: true,
      initialSyncUntil: 5000,
      initialSyncTargetPos: 0,
      syncCooldownUntil: 0,
      syncStatus: 'syncing'
    });
    OWP.playback.bindVideo();
  });

  afterEach(() => {
    OWP.playback.cleanupVideoListeners();
  });

  it('preserves and applies a zero-position target after cooldown', () => {
    video.currentTime = 2.5;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 0);
    assert.equal(OWP.state.initialSyncTargetPos, null);
  });

  it('does not publish the post-buffer seek as the guest own seek', () => {
    video.currentTime = 2.5;
    assertSeekIsLocal();
    assert.equal(video.currentTime, 0);
  });

  it('keeps catching up a drift under 2 s after cooldown, without a seek', () => {
    video.currentTime = 1.9;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 1.9);
    assert.equal(video.playbackRate, 0.9);
    assert.equal(OWP.state.initialSyncTargetPos, 0);
  });

  it('does not hard seek an ordinary drift during cooldown', () => {
    video.currentTime = 2;
    OWP.state.syncCooldownUntil = 2000;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 2);
    assert.equal(OWP.state.initialSyncTargetPos, 0);
  });

  it('allows a critical hard seek during cooldown', () => {
    video.currentTime = 11;
    OWP.state.syncCooldownUntil = 2000;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 0);
    assert.equal(OWP.state.initialSyncTargetPos, null);
  });

  it('does not publish a critical-drift seek as the guest own seek', () => {
    video.currentTime = 11;
    OWP.state.syncCooldownUntil = 2000;
    assertSeekIsLocal();
    assert.equal(video.currentTime, 0);
  });
});
