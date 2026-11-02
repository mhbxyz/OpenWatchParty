const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// What a joining guest hears of the room while its video loads.
const OWP = require('./setup.js');
let currentMediaId = 'old-media';
let currentVideo = null;
let sent = [];

class FakeVideo {
  constructor({ readyState = 2, currentTime = 0 } = {}) {
    this.readyState = readyState;
    this.currentTime = currentTime;
    this.playbackRate = 1;
    this.paused = true;
    this.pauseCalls = 0;
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
    return Promise.resolve();
  }
}

OWP.constants.MEDIA_READY_POLL_MS = 1;
OWP.constants.MEDIA_READY_TIMEOUT_MS = 1000;
OWP.constants.VIDEO_ACTION_RETRY_MS = 1;
OWP.constants.VIDEO_ACTION_MAX_WAIT_MS = 20;
OWP.ui = { render: () => {}, updateSyncIndicator: () => {}, showToast: () => {} };
OWP.utils.getVideo = () => currentVideo;
OWP.utils.getCurrentItemId = () => currentMediaId;
OWP.utils.getPlayingItemId = () => currentMediaId;
OWP.utils.startSyncing = () => {};
OWP.utils.log = () => {};
OWP.utils.isVideoReady = () => Boolean(currentVideo && currentVideo.readyState >= 2);
OWP.actions = {
  send: (type, payload) => sent.push({ type, payload, room: OWP.state.roomId }),
  completeRoomRejoin: () => {}
};

require('../playback/sync.js');
OWP.playback.ensurePlayback = () => {};
OWP.playback.safePlay = video => video.play();
require('../ws/handlers/sync.js');
require('../ws/handlers/playback.js');

const h = OWP._wsHandlers;

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
    state_server_ts: Date.now(),
    target_server_ts: null,
    state: { position, play_state: 'paused' }
  }
});

const playingRoomState = (room, mediaId, position = 20) => {
  const msg = roomState(room, mediaId, position);
  msg.payload.state.play_state = 'playing';
  return msg;
};

const roomCommand = (room, action, position, targetServerTs = Date.now()) => ({
  type: 'player_event',
  room,
  client: 'host',
  server_ts: Date.now(),
  payload: { action, position, play_state: action === 'play' ? 'playing' : 'paused', target_server_ts: targetServerTs }
});

const stateUpdate = (room, position, playState) => ({
  type: 'state_update',
  room,
  server_ts: Date.now(),
  payload: { position, play_state: playState }
});

const until = async (check, timeout = 1000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
};

// The guest sends ready right after its ready video synced to the room.
const readySent = () => sent.some(message => message.type === 'ready');

describe('room commands while joining', () => {
  beforeEach(() => {
    currentMediaId = 'old-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 5 });
    sent = [];
    Object.assign(OWP.state, {
      clientId: 'guest',
      inRoom: false,
      roomId: '',
      isHost: false,
      readyRoomId: '',
      pendingMediaId: '',
      heardRoomState: null,
      currentVideoElement: null,
      hasTimeSync: true,
      serverOffsetMs: 0,
      lastSyncPlayState: '',
      lastSyncServerTs: 0,
      isInitialSync: false,
      roomWaiting: false,
      syncStatus: 'synced'
    });
  });

  afterEach(() => {
    if (OWP.state.mediaReadyCleanup) OWP.state.mediaReadyCleanup();
    OWP.timers.clearScope('room');
  });

  // The joining guest's player opens the room item: a video still loading.
  const loadingVideo = () => {
    currentMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 1, currentTime: 0 });
    currentVideo.paused = false; // Jellyfin plays the item it opens
    return currentVideo;
  };

  it('keeps a pause that came while the video loaded over the playing room it joined', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 21);
    assert.equal(OWP.state.lastSyncPlayState, 'paused');
    assert.equal(OWP.state.isInitialSync, false);
    assert.deepEqual(sent.map(message => message.type), ['ready']);
  });

  it('keeps a play that came while the video loaded over the paused room it joined', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();
    video.paused = true;

    h.handlePlayerEvent(roomCommand('room-a', 'play', 20), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, false);
    assert.equal(video.pauseCalls, 0);
    assert.equal(OWP.state.lastSyncPlayState, 'playing');
  });

  it('follows a seek that came while the video loaded, from the time of the seek', async () => {
    const joined = playingRoomState('room-a', 'new-media', 20);
    joined.payload.state_server_ts = Date.now() - 10_000;
    h.handleRoomState(joined, currentVideo);
    const video = loadingVideo();

    const seek = roomCommand('room-a', 'seek', 60);
    seek.payload.play_state = 'playing';
    h.handlePlayerEvent(seek, video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, false);
    assert.ok(video.currentTime > 59.9 && video.currentTime < 61);
    assert.equal(OWP.state.lastSyncPlayState, 'playing');
  });

  it('keeps the latest of a pause and a state update that came while the video loaded', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), video);
    h.handleStateUpdate(stateUpdate('room-a', 25, 'paused'), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 25);
    assert.equal(OWP.state.lastSyncPlayState, 'paused');
  });

  it('applies a pause that came before the video, however late the video shows up', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    currentMediaId = 'new-media';
    currentVideo = null;

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), null);
    // Later than VIDEO_ACTION_MAX_WAIT_MS: the command itself gave up.
    await until(() => OWP.state.pendingPlayUntil === 0);
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    currentVideo.paused = false;
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(currentVideo.currentTime, 21);
    assert.equal(OWP.state.lastSyncPlayState, 'paused');
  });

  it('keeps a state update that came before the video', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    currentMediaId = 'new-media';
    currentVideo = null;

    h.handleStateUpdate(stateUpdate('room-a', 25, 'paused'), null);
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    currentVideo.paused = false;
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(currentVideo.currentTime, 25);
  });

  it('applies a pause that came while the previous item played to the room item', async () => {
    const previousVideo = currentVideo;
    previousVideo.paused = false;
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), previousVideo);

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), previousVideo);
    currentMediaId = 'new-media';
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    currentVideo.paused = false; // Jellyfin plays the item it opens
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(currentVideo.currentTime, 21);
  });

  it('waits for the time of a scheduled play that came while the video loaded', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();
    video.paused = true;

    h.handlePlayerEvent(roomCommand('room-a', 'play', 20, Date.now() + 60), video);
    video.readyState = 2;
    await until(readySent);
    assert.equal(video.paused, true);
    await until(() => !video.paused);

    assert.equal(OWP.state.lastSyncPlayState, 'playing');
  });

  it('still catches up with the playing room when only its state updates came while the video loaded', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handleStateUpdate(stateUpdate('room-a', 20, 'playing'), video);
    video.readyState = 2;
    await until(readySent);

    assert.ok(video.currentTime > 19.9 && video.currentTime < 21);
    assert.equal(video.paused, false);
    assert.equal(OWP.state.isInitialSync, true);
  });

  it('syncs to a later room state, not to what it heard before it', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), video);
    h.handleRoomState(playingRoomState('room-a', 'new-media', 30), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, false);
    assert.ok(video.currentTime > 29.9 && video.currentTime < 31);
  });

  it('keeps a scheduled play over a state update that came before its time', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();
    video.paused = true;

    h.handlePlayerEvent(roomCommand('room-a', 'play', 20, Date.now() + 60), video);
    h.handleStateUpdate(stateUpdate('room-a', 20, 'paused'), video);
    video.readyState = 2;
    await until(readySent);
    assert.equal(video.paused, true);
    await until(() => !video.paused);

    assert.equal(OWP.state.lastSyncPlayState, 'playing');
  });

  it('lets a pause cancel a scheduled play that came while the video loaded', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();
    video.paused = true;
    const target = Date.now() + 40;

    h.handlePlayerEvent(roomCommand('room-a', 'play', 20, target), video);
    h.handlePlayerEvent(roomCommand('room-a', 'pause', 20), video);
    video.readyState = 2;
    await until(readySent);
    await until(() => Date.now() > target + 20);

    assert.equal(video.paused, true);
    assert.equal(OWP.state.lastSyncPlayState, 'paused');
  });

  it('keeps waiting for the host that buffered while the video loaded', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    currentMediaId = 'new-media';
    currentVideo = null;

    h.handlePlayerEvent(roomCommand('room-a', 'buffering', 21), null);
    await until(() => OWP.state.pendingPlayUntil === 0);
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    currentVideo.paused = false;
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(currentVideo.currentTime, 21);
    assert.equal(OWP.state.roomWaiting, true);
    assert.equal(OWP.state.syncStatus, 'syncing');
  });

  it('lets the host\'s buffering cancel a scheduled play that came while the video loaded', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();
    video.paused = true;
    const target = Date.now() + 40;

    h.handlePlayerEvent(roomCommand('room-a', 'play', 20, target), video);
    h.handlePlayerEvent(roomCommand('room-a', 'buffering', 20), video);
    video.readyState = 2;
    await until(readySent);
    await until(() => Date.now() > target + 20);

    assert.equal(video.paused, true);
    assert.equal(OWP.state.roomWaiting, true);
  });

  it('keeps waiting for the host through a paused state update', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    currentMediaId = 'new-media';
    currentVideo = null;

    h.handlePlayerEvent(roomCommand('room-a', 'buffering', 21), null);
    h.handleStateUpdate(stateUpdate('room-a', 21, 'paused'), null);
    await until(() => OWP.state.pendingPlayUntil === 0);
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(OWP.state.roomWaiting, true);
    assert.equal(OWP.state.syncStatus, 'syncing');
  });

  it('stops waiting at a pause that came after the host buffered', async () => {
    const previousVideo = currentVideo;
    previousVideo.paused = false;
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), previousVideo);

    h.handlePlayerEvent(roomCommand('room-a', 'buffering', 21), previousVideo);
    assert.equal(OWP.state.roomWaiting, true);
    currentMediaId = 'new-media';
    currentVideo = null;
    h.handlePlayerEvent(roomCommand('room-a', 'pause', 22), null);
    await until(() => OWP.state.pendingPlayUntil === 0);
    currentVideo = new FakeVideo({ readyState: 2, currentTime: 0 });
    await until(readySent);

    assert.equal(currentVideo.paused, true);
    assert.equal(currentVideo.currentTime, 22);
    assert.equal(OWP.state.roomWaiting, false);
    assert.equal(OWP.state.syncStatus, 'synced');
  });

  it('stops waiting at a room state the host plays in', async () => {
    h.handleRoomState(roomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-a', 'buffering', 21), video);
    h.handleStateUpdate(stateUpdate('room-a', 22, 'playing'), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, false);
    assert.equal(OWP.state.roomWaiting, false);
  });

  it('takes a command that names no room for its room', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand(undefined, 'pause', 21), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 21);
  });

  it('keeps its room\'s command over a later message for another room', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-a', 'pause', 21), video);
    h.handleStateUpdate(stateUpdate('room-b', 40, 'playing'), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 21);
  });

  it('does not take another room\'s command for this room', async () => {
    h.handleRoomState(playingRoomState('room-a', 'new-media', 20), currentVideo);
    const video = loadingVideo();

    h.handlePlayerEvent(roomCommand('room-b', 'pause', 21), video);
    video.readyState = 2;
    await until(readySent);

    assert.equal(video.paused, false);
    assert.ok(video.currentTime > 19.9 && video.currentTime < 21);
  });
});
