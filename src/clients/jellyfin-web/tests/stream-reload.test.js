const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let currentVideo;
let sent;
let now;
let stateTick;
OWP.ui = { showToast: () => {}, updateSyncIndicator: () => {} };
OWP.utils.getPlaybackManager = () => null;
OWP.utils.getVideo = () => currentVideo;
OWP.utils.isVideoReady = () => Boolean(currentVideo && currentVideo.readyState >= 3);
OWP.utils.isSeeking = () => Boolean(currentVideo && currentVideo.seeking);
OWP.utils.log = () => {};
OWP.actions = { send: (type, payload) => sent.push([type, payload]) };
require('../playback/play.js');
require('../playback/bind.js');

const { STREAM_RELOAD_MAX_MS } = OWP.constants;
const realNowMs = OWP.utils.nowMs;
const realTimers = { setInterval: OWP.timers.setInterval, clear: OWP.timers.clear };

// A video element that fires the events bind.js listens to, after taking the
// given state, as Jellyfin's player does.
const fakeVideo = () => {
  const listeners = new Map();
  return {
    currentTime: 0,
    readyState: 4,
    paused: true,
    seeking: false,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    fire(type, props = {}) {
      Object.assign(this, props);
      const listener = listeners.get(type);
      if (listener) listener();
    }
  };
};

const events = () => sent.map(([type, payload]) => `${type} ${payload.action || payload.play_state} ${payload.position}`);

describe('the host switches an audio or subtitle track', () => {
  let video;

  beforeEach(() => {
    sent = [];
    now = 1000;
    stateTick = null;
    OWP.utils.nowMs = () => now;
    OWP.timers.setInterval = (fn) => { stateTick = fn; return 1; };
    OWP.timers.clear = () => {};
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: true,
      isSyncing: false,
      isBuffering: false,
      suppressUntil: 0,
      bound: false,
      currentVideoElement: null,
      videoListeners: null,
      streamReloadUntil: 0,
      pendingMediaId: '',
      lastPlayedPosition: 0,
      lastPlayedPlaying: false,
      lastSentPosition: 0,
      lastSeekSentAt: 0,
      lastStateSentAt: 0
    });
    video = fakeVideo();
    currentVideo = video;
    OWP.playback.bindVideo();
  });

  afterEach(() => {
    OWP.playback.cleanupVideoListeners();
    OWP.utils.nowMs = realNowMs;
    Object.assign(OWP.timers, realTimers);
  });

  // The order recorded from Jellyfin 12.2 switching to a track the server
  // converts: the reload starts at 0:00 and seeks back to the old position.
  const reloadAndPlay = (resumeAt) => {
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    video.fire('play', { paused: false });
    video.fire('waiting');
    now += 3000;
    video.fire('seeked', { currentTime: resumeAt, readyState: 4 });
    video.fire('canplay');
    stateTick();
    video.fire('playing');
  };

  it('has the room wait where the host was, then play on, never from 0:00', () => {
    video.fire('timeupdate', { currentTime: 737.9, readyState: 4, paused: false });

    reloadAndPlay(738.13);

    assert.deepEqual(events(), [
      'player_event buffering 737.9',
      'player_event play 738.13'
    ]);
    assert.equal(OWP.state.streamReloadUntil, 0);
  });

  it("does not take opening the room's next queue item for a reload", () => {
    video.fire('timeupdate', { currentTime: 600, readyState: 4, paused: false });
    OWP.state.pendingMediaId = 'next-item';
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    assert.equal(OWP.state.streamReloadUntil, 0);
    assert.deepEqual(events(), []);
  });

  it('broadcasts the host again once the reload has played', () => {
    video.fire('timeupdate', { currentTime: 737.9, readyState: 4, paused: false });
    reloadAndPlay(738.13);
    sent = [];

    now += 500;
    video.fire('seeked', { currentTime: 738.5 });
    assert.deepEqual(events(), []);

    now += 500;
    video.fire('seeked', { currentTime: 900 });
    assert.deepEqual(events(), ['player_event seek 900', 'state_update playing 900']);
  });

  it('keeps a paused room paused, and sends nothing for the reload', () => {
    video.fire('timeupdate', { currentTime: 120, readyState: 4, paused: true });

    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    video.fire('waiting');
    video.fire('seeked', { currentTime: 120, readyState: 4 });
    video.fire('canplay');

    assert.deepEqual(events(), []);
    assert.equal(OWP.state.streamReloadUntil, 0);
  });

  it('lets the host through again when a reload never plays', () => {
    video.fire('timeupdate', { currentTime: 50, readyState: 4, paused: false });
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    sent = [];

    now += STREAM_RELOAD_MAX_MS + 1;
    video.fire('seeked', { currentTime: 300, readyState: 4 });

    assert.deepEqual(events(), ['player_event seek 300', 'state_update paused 300']);
  });

  it('keeps waiting when the empty video is ready before it plays again', () => {
    video.fire('timeupdate', { currentTime: 500, readyState: 4, paused: false });

    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    video.fire('canplay', { readyState: 4 });
    video.fire('play', { paused: false });
    video.fire('seeked', { currentTime: 500.2 });
    video.fire('playing');

    assert.deepEqual(events(), ['player_event buffering 500', 'player_event play 500.2']);
  });

  it('keeps one wait and its time limit when the video empties again', () => {
    video.fire('timeupdate', { currentTime: 70, readyState: 4, paused: false });
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    now += 10000;
    video.fire('emptied');
    assert.deepEqual(events(), ['player_event buffering 70']);
    sent = [];

    now += STREAM_RELOAD_MAX_MS - 10000 + 1;
    video.fire('seeked', { currentTime: 300, readyState: 4 });

    assert.deepEqual(events(), ['player_event seek 300', 'state_update paused 300']);
  });

  it('still resumes the room when the reload plays after the time limit', () => {
    video.fire('timeupdate', { currentTime: 80, readyState: 4, paused: false });
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    sent = [];

    now += STREAM_RELOAD_MAX_MS + 1;
    video.fire('canplay', { currentTime: 80.5, readyState: 4, paused: false });
    video.fire('playing');

    assert.deepEqual(events(), ['player_event play 80.5']);
    assert.equal(OWP.state.streamReloadUntil, 0);
    assert.equal(OWP.state.lastSentPosition, 80.5);
  });

  it('sends one play when the host plays a reload stuck past the time limit', () => {
    video.fire('timeupdate', { currentTime: 90, readyState: 4, paused: false });
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    sent = [];

    now += STREAM_RELOAD_MAX_MS + 1;
    video.fire('play', { currentTime: 90, readyState: 4, paused: false });
    video.fire('playing');

    assert.deepEqual(events(), ['player_event play 90', 'state_update playing 90']);
    assert.equal(OWP.state.streamReloadUntil, 0);
  });

  it('ignores the position of a video that is not playing yet', () => {
    video.fire('timeupdate', { currentTime: 400, readyState: 4, paused: false });
    video.fire('timeupdate', { currentTime: 0, readyState: 1, paused: false });
    video.fire('timeupdate', { currentTime: 10, readyState: 4, paused: false, seeking: true });

    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true, seeking: false });

    assert.deepEqual(events(), ['player_event buffering 400']);
  });

  it('tracks a guest reload locally and does nothing outside a room', () => {
    video.fire('timeupdate', { currentTime: 60, readyState: 4, paused: false });
    OWP.state.isHost = false;
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });
    assert.equal(OWP.state.streamReloadUntil, now + STREAM_RELOAD_MAX_MS);
    assert.deepEqual(events(), []);

    OWP.state.streamReloadUntil = 0;
    OWP.state.isHost = true;
    OWP.state.inRoom = false;
    video.fire('emptied', { currentTime: 0, readyState: 0, paused: true });

    assert.equal(OWP.state.streamReloadUntil, 0);
    assert.deepEqual(events(), []);
  });

  it('still has the room wait for an ordinary buffer, and resume with the next update', () => {
    video.fire('timeupdate', { currentTime: 30, readyState: 4, paused: false });

    video.fire('waiting', { readyState: 2 });
    video.fire('canplay', { readyState: 4 });
    video.fire('playing');
    stateTick();

    assert.deepEqual(events(), ['player_event buffering 30', 'state_update playing 30']);
  });
});
