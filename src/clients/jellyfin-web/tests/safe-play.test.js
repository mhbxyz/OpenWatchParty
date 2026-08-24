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
OWP.actions = { send: () => {} };
require('../playback/play.js');
require('../playback/bind.js');

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

  it('clears blocked state from the real video play event', () => {
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
    OWP.playback.cleanupVideoListeners();
  });
});
