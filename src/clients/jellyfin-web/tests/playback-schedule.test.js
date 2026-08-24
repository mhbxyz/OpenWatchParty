const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let currentVideo;
let scheduled;
let serverNow;

class FakeVideo {
  constructor(currentTime = 50) {
    this.currentTime = currentTime;
    this.paused = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.isConnected = true;
  }

  play() {
    this.paused = false;
    this.playCalls++;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.pauseCalls++;
  }
}

OWP.ui = {
  showToast: () => {},
  updateSyncIndicator: () => {}
};
OWP.constants.VIDEO_ACTION_RETRY_MS = 1;
OWP.constants.VIDEO_ACTION_MAX_WAIT_MS = 20;
OWP.utils.getVideo = () => currentVideo;
OWP.utils.getServerNow = () => serverNow;
OWP.utils.nowMs = () => 1000;
OWP.utils.startSyncing = () => {};
OWP.utils.scheduleAt = (target, callback) => { scheduled.push({ target, callback }); };

require('../ws/handlers/playback.js');

const event = (action, overrides = {}) => ({
  type: 'player_event',
  room: 'room-a',
  server_ts: 1000,
  payload: {
    action,
    position: 10,
    target_server_ts: 1300,
    ...overrides
  }
});

describe('scheduled playback controls', () => {
  beforeEach(() => {
    currentVideo = new FakeVideo();
    scheduled = [];
    serverNow = 1000;
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-a',
      isHost: false,
      playbackActionAttempt: 0,
      pendingActionTimer: null,
      currentVideoElement: null,
      syncStatus: 'synced',
      pendingPlayUntil: 0,
      isInitialSync: false
    });
  });

  it('waits until target time before pausing and seeking', () => {
    OWP._wsHandlers.handlePlayerEvent(event('pause'), currentVideo);

    assert.equal(currentVideo.pauseCalls, 0);
    assert.equal(currentVideo.currentTime, 50);
    assert.equal(scheduled[0].target, 1300);
    serverNow = 1300;
    scheduled[0].callback();
    assert.equal(currentVideo.pauseCalls, 1);
    assert.equal(currentVideo.currentTime, 10);
  });

  it('applies paused seeks as well as playing seeks', () => {
    OWP._wsHandlers.handlePlayerEvent(event('seek', { play_state: 'paused' }), currentVideo);
    serverNow = 1300;
    scheduled[0].callback();

    assert.equal(currentVideo.currentTime, 10);
    assert.equal(currentVideo.pauseCalls, 1);
    assert.equal(currentVideo.playCalls, 0);
    assert.equal(OWP.state.syncStatus, 'synced');
  });

  it('schedules buffering and play using the active video element', () => {
    const originalVideo = currentVideo;
    OWP._wsHandlers.handlePlayerEvent(event('buffering'), originalVideo);
    currentVideo = new FakeVideo(30);
    serverNow = 1300;
    scheduled[0].callback();
    assert.equal(originalVideo.pauseCalls, 0);
    assert.equal(currentVideo.pauseCalls, 1);
    assert.equal(currentVideo.currentTime, 10);

    scheduled = [];
    OWP._wsHandlers.handlePlayerEvent(event('play'), currentVideo);
    serverNow = 1300;
    scheduled[0].callback();
    assert.equal(currentVideo.playCalls, 1);
    assert.equal(currentVideo.currentTime, 10);
    assert.ok(OWP.state.lastSyncPosition >= 10.3 && OWP.state.lastSyncPosition < 10.4);
  });

  it('invalidates an older control when a newer one arrives', () => {
    OWP._wsHandlers.handlePlayerEvent(event('pause'), currentVideo);
    OWP._wsHandlers.handlePlayerEvent(event('play'), currentVideo);

    scheduled[0].callback();
    assert.equal(currentVideo.pauseCalls, 0);
    scheduled[1].callback();
    assert.equal(currentVideo.playCalls, 1);
  });

  it('ignores a scheduled action after room change', () => {
    OWP._wsHandlers.handlePlayerEvent(event('pause'), currentVideo);
    OWP.state.roomId = 'room-b';

    scheduled[0].callback();

    assert.equal(currentVideo.pauseCalls, 0);
    assert.equal(currentVideo.currentTime, 50);
  });

  it('projects playing position when a command arrives after its target', () => {
    serverNow = 1600;
    OWP._wsHandlers.handlePlayerEvent(event('play'), currentVideo);
    scheduled[0].callback();

    assert.equal(currentVideo.currentTime, 10.6);
  });

  it('retries on the replacement after a detached fallback video', async () => {
    const detached = currentVideo;
    detached.isConnected = false;
    OWP._wsHandlers.handlePlayerEvent(event('pause'), detached);
    currentVideo = null;
    serverNow = 1300;

    scheduled[0].callback();

    assert.equal(detached.pauseCalls, 0);
    currentVideo = new FakeVideo(30);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(currentVideo.pauseCalls, 1);
    assert.equal(currentVideo.currentTime, 10);
  });

  it('retains a command received while no video element exists', async () => {
    currentVideo = null;
    OWP._wsHandlers.handlePlayerEvent(event('pause'), null);
    serverNow = 1300;
    scheduled[0].callback();

    currentVideo = new FakeVideo(30);
    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(currentVideo.pauseCalls, 1);
    assert.equal(currentVideo.currentTime, 10);
  });
});
