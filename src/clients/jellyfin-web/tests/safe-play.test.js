const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let toasts;
let currentVideo;
OWP.ui = {
  showToast: message => toasts.push(message),
  updateSyncIndicator: () => {}
};
OWP.utils.getPlaybackManager = () => null;
OWP.utils.getVideo = () => currentVideo;
OWP.utils.log = () => {};
OWP.utils.startSyncing = () => {};
OWP.utils.isVideoReady = () => true;
OWP.actions = { send: () => {} };
require('../playback/play.js');
require('../playback/bind.js');
require('../ws/handlers/sync.js');

describe('safePlay', () => {
  beforeEach(() => {
    toasts = [];
    OWP.state.playbackBlocked = false;
    OWP.state.playbackFailureNotified = false;
    OWP.state.syncStatus = 'syncing';
    OWP.state.pendingPlayUntil = 100;
    OWP.state.inRoom = true;
    OWP.state.roomId = 'room-a';
    OWP.state.isHost = false;
    OWP.state.playbackActionAttempt = 1;
    OWP.state.bound = false;
    OWP.state.currentVideoElement = null;
    OWP.state.videoListeners = null;
    OWP.state.guestPaused = false;
    OWP.state.ownCommandUntil = 0;
    OWP.state.heardRoomState = null;
    OWP.state.isBuffering = false;
    OWP.state.syncCooldownUntil = 0;
    currentVideo = null;
  });

  it('surfaces autoplay rejection and restores safe playback state', async () => {
    const error = new Error('user gesture required');
    error.name = 'NotAllowedError';
    const video = {
      playbackRate: 1.5,
      play: () => Promise.reject(error)
    };

    assert.equal(await OWP.playback.safePlay(video, 'test'), false);

    assert.equal(OWP.state.playbackBlocked, true);
    assert.equal(OWP.state.syncStatus, 'blocked');
    assert.equal(OWP.state.pendingPlayUntil, 0);
    assert.equal(video.playbackRate, 1);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /Press Play/);

    await OWP.playback.safePlay(video, 'test');
    assert.equal(toasts.length, 1);
  });

  it('recovers blocked state after a successful user-initiated play', async () => {
    OWP.state.playbackBlocked = true;
    OWP.state.syncStatus = 'blocked';
    const video = { playbackRate: 1, play: () => Promise.resolve() };

    assert.equal(await OWP.playback.safePlay(video, 'retry'), true);
    assert.equal(OWP.state.playbackBlocked, false);
    assert.equal(OWP.state.syncStatus, 'syncing');
  });

  it('returns false when no playable video exists', async () => {
    assert.equal(await OWP.playback.safePlay(null), false);
  });

  it('tracks room updates without retrying playback after an autoplay rejection', async () => {
    const error = new Error('user gesture required');
    error.name = 'NotAllowedError';
    let playCalls = 0;
    const video = {
      paused: true,
      currentTime: 5,
      playbackRate: 1,
      play: () => { playCalls++; return Promise.reject(error); }
    };
    const update = (position, serverTs, playState = 'playing') => {
      OWP._wsHandlers.handleStateUpdate({
        room: 'room-a', server_ts: serverTs,
        payload: { position, play_state: playState }
      }, video);
    };

    update(30, 1000);
    await Promise.resolve();
    assert.equal(OWP.state.playbackBlocked, true);

    update(31, 2000);
    await Promise.resolve();
    update(0, 3000, 'paused');
    await Promise.resolve();

    assert.equal(playCalls, 1);
    assert.equal(OWP.state.lastSyncPosition, 0);
    assert.equal(OWP.state.lastSyncServerTs, 3000);
    assert.equal(OWP.state.lastSyncPlayState, 'paused');
    assert.equal(OWP.state.syncStatus, 'blocked');
    assert.equal(toasts.length, 1);
  });

  it('tracks a playing room at its reported position while waiting for a user play', () => {
    OWP.state.playbackBlocked = true;
    OWP.state.syncStatus = 'blocked';
    const video = {
      paused: true, currentTime: 5, playbackRate: 1,
      play: () => Promise.resolve()
    };

    OWP._wsHandlers.handleStateUpdate({
      room: 'room-a', server_ts: 4000,
      payload: { position: 32, play_state: 'playing' }
    }, video);

    assert.equal(OWP.state.lastSyncPosition, 32);
    assert.equal(OWP.state.lastSyncServerTs, 4000);
    assert.equal(OWP.state.syncStatus, 'blocked');
  });

  it('still applies a room pause if the video is playing with a stale blocked flag', () => {
    OWP.state.playbackBlocked = true;
    const video = {
      paused: false, currentTime: 5,
      pause() { this.paused = true; }
    };

    OWP._wsHandlers.handleStateUpdate({
      room: 'room-a', server_ts: 5000,
      payload: { position: 5, play_state: 'paused' }
    }, video);

    assert.equal(video.paused, true);
  });

  it('ignores a rejection invalidated by a newer action in the same room', async () => {
    let rejectPlay;
    const video = {
      playbackRate: 1,
      play: () => new Promise((resolve, reject) => { rejectPlay = reject; })
    };
    const pending = OWP.playback.safePlay(video, 'obsolete');
    OWP.state.playbackActionAttempt++;
    rejectPlay(new Error('late rejection'));

    assert.equal(await pending, false);
    assert.equal(OWP.state.playbackBlocked, false);
    assert.equal(toasts.length, 0);
  });

  it('clears blocked state on a user play and allows later room playback recovery', async () => {
    const listeners = new Map();
    currentVideo = {
      currentTime: 0,
      readyState: 4,
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: () => {}
    };
    OWP.state.playbackBlocked = true;
    OWP.state.playbackFailureNotified = true;
    OWP.state.syncStatus = 'blocked';

    OWP.playback.bindVideo();
    listeners.get('play')();

    assert.equal(OWP.state.playbackBlocked, false);
    assert.equal(OWP.state.playbackFailureNotified, false);
    assert.equal(OWP.state.syncStatus, 'syncing');
    let playCalls = 0;
    currentVideo.paused = true;
    currentVideo.play = () => {
      playCalls++;
      currentVideo.paused = false;
      return Promise.resolve();
    };
    OWP._wsHandlers.handleStateUpdate({
      room: 'room-a', server_ts: 6000,
      payload: { position: 6, play_state: 'playing' }
    }, currentVideo);
    await Promise.resolve();
    assert.equal(playCalls, 1);
    assert.equal(currentVideo.paused, false);
    assert.equal(OWP.state.playbackBlocked, false);
    OWP.playback.cleanupVideoListeners();
  });
});
