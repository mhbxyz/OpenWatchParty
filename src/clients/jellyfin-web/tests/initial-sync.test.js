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
      pendingPlayUntil: 0,
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
    video.currentTime = 2.5;

    OWP.playback.syncLoop();

    assert.equal(video.currentTime, 0);
    assert.equal(OWP.state.initialSyncTargetPos, null);
  });

  for (const initial of [true, false]) {
    for (const reason of ['seek', 'scheduled command']) {
      for (const drift of [0.8, 11]) {
        it(`leaves a ${drift}s drift alone during a ${reason} (${initial ? 'initial' : 'steady'} sync), then resumes`, () => {
          video.currentTime = drift;
          video.playbackRate = 1.1;
          OWP.state.isInitialSync = initial;
          if (reason === 'seek') video.seeking = true;
          else OWP.state.pendingPlayUntil = serverNow + 1000;
          const target = OWP.state.initialSyncTargetPos;

          OWP.playback.syncLoop();

          assert.equal(video.currentTime, drift);
          assert.equal(video.playbackRate, 1);
          assert.equal(OWP.state.lastSyncPosition, 0);
          assert.equal(OWP.state.initialSyncTargetPos, target);
          assert.equal(OWP.state.isInitialSync, initial);

          video.seeking = false;
          // At the server deadline correction must be allowed again, even
          // when the local clock is unrelated to the server's clock.
          localNow = 4000;
          OWP.state.pendingPlayUntil = serverNow;
          OWP.playback.syncLoop();

          if (drift === 11) assert.equal(video.currentTime, 0);
          else {
            assert.equal(video.currentTime, drift);
            assert.ok(video.playbackRate < 1);
          }
        });
      }
    }
  }

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
});
