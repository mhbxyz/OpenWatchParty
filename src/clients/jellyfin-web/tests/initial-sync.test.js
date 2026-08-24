const { describe, it, beforeEach } = require('node:test');
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
require('../playback/sync.js');

describe('initial synchronization hard-seek policy', () => {
  beforeEach(() => {
    serverNow = 1000;
    localNow = 1000;
    video = {
      currentTime: 0,
      playbackRate: 1,
      paused: false,
      readyState: 4
    };
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: false,
      isBuffering: false,
      pendingMediaId: '',
      lastSyncServerTs: 1000,
      lastSyncPosition: 0,
      lastSyncPlayState: 'playing',
      isInitialSync: true,
      initialSyncUntil: 5000,
      initialSyncTargetPos: 0,
      syncCooldownUntil: 0,
      syncStatus: 'syncing'
    });
  });

  it('preserves and applies a zero-position target after cooldown', () => {
    video.currentTime = 0.6;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 0);
    assert.equal(OWP.state.initialSyncTargetPos, null);
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
});
