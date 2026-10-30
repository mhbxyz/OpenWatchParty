const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

const T = 10000000;
let video;
let serverNow;
let localNow;
let toasts;
let requests;

class FakeVideo {
  constructor() {
    this.currentTime = 8;
    this.playbackRate = 1;
    this.paused = false;
    this.ended = false;
    this.readyState = 4;
    this.isConnected = true;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatch(type) {
    this.listeners.get(type)?.();
  }

  pause() {
    this.paused = true;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }
}

OWP.ui = {
  render: () => {},
  showToast: message => toasts.push(message),
  updateSyncIndicator: () => {}
};
OWP.playback = { safePlay: target => target.play() };
OWP.chat = { clear: () => {} };
OWP.utils.getVideo = () => video;
OWP.utils.getServerNow = () => serverNow;
OWP.utils.nowMs = () => localNow;
OWP.utils.adjustedPosition = position => position;
OWP.utils.isVideoReady = () => true;
OWP.utils.isSeeking = () => false;
OWP.utils.shouldSend = () => true;
OWP.utils.startSyncing = () => { OWP.state.isSyncing = true; };
OWP.utils.scheduleAt = (target, callback) => callback();
OWP.utils.suppress = () => {};
OWP.utils.log = () => {};

require('../playback/bind.js');
require('../playback/sync.js');
require('../ws/send.js');
require('../ws/handlers/sync.js');
require('../ws/handlers/playback.js');
require('../app/segments.js');

const h = OWP._wsHandlers;

// The answers Jellyfin owes for each item, oldest request first, so a test
// decides when each one arrives.
const answers = new Map();
const segment = (type, start, end) => ({ Id: type, ItemId: 'x', Type: type, StartTicks: start * T, EndTicks: end * T });
const SEGMENTS = [segment('Intro', 5, 30), segment('Recap', 40, 50), segment('Outro', 60, 70), segment('Preview', 80, 90)];

globalThis.ApiClient = {
  getUrl: (path, query) => ({ path, query }),
  getJSON: (url) => {
    requests.push(url);
    return new Promise((resolve) => answers.set(url.path, [...(answers.get(url.path) || []), resolve]));
  }
};

const answer = async (mediaId, items = SEGMENTS) => {
  answers.get(`MediaSegments/${mediaId}`).shift()({ Items: items });
  await new Promise(resolve => setImmediate(resolve));
};

const joinAs = (clientId, mediaId = 'item-a') => {
  Object.assign(OWP.state, {
    ws: { readyState: 1, send: () => {} },
    inRoom: true,
    roomId: 'room-a',
    roomMediaId: mediaId,
    clientId,
    roomHostId: 'host',
    isHost: clientId === 'host',
    sharedPlaybackControl: true,
    guestPaused: false,
    roomWaiting: false,
    isBuffering: false,
    isSyncing: false,
    pendingMediaId: '',
    pendingPlayUntil: 0,
    lastSyncServerTs: serverNow,
    lastSyncPosition: 8,
    lastSyncPlayState: 'playing',
    ownCommandUntil: 0,
    playbackActionAttempt: 0,
    currentVideoElement: video,
    isInitialSync: false,
    initialSyncUntil: 0,
    initialSyncTargetPos: null,
    syncCooldownUntil: 0,
    syncStatus: 'synced'
  });
};

const seek = (position, client = 'host') => ({
  room: 'room-a',
  client,
  server_ts: serverNow,
  payload: { action: 'seek', position, play_state: 'playing' }
});

describe('skippable segments of the room item', () => {
  beforeEach(() => {
    if (OWP.state.bound) OWP.playback.cleanupVideoListeners();
    serverNow = 1000;
    localNow = 1000;
    toasts = [];
    requests = [];
    answers.clear();
    video = new FakeVideo();
    joinAs('guest');
    OWP.state.bound = false;
    OWP.playback.bindVideo();
  });

  afterEach(() => {
    OWP.playback.cleanupVideoListeners();
    OWP.timers.clearScope('room');
    OWP.timers.clearScope('video');
    joinAs('guest', '');
    OWP.segments.refresh();
  });

  it("loads the room item's segments once per item and drops a late answer for another one", async () => {
    OWP.segments.refresh();
    OWP.segments.refresh();
    assert.deepEqual(requests.map(url => url.path), ['MediaSegments/item-a']);

    OWP.state.roomMediaId = 'item-b';
    OWP.segments.refresh();
    await answer('item-a');
    assert.equal(OWP.segments.skipped(8, 30), '');
    await answer('item-b', [segment('Intro', 2, 20)]);
    assert.equal(OWP.segments.skipped(3, 20), 'Intro');
    assert.deepEqual(requests.map(url => url.path), ['MediaSegments/item-a', 'MediaSegments/item-b']);
  });

  it('tells a skip to the end of an intro, recap or credits from any other seek', async () => {
    OWP.segments.refresh();
    await answer('item-a');
    assert.equal(OWP.segments.skipped(8, 30), 'Intro');
    assert.equal(OWP.segments.skipped(5, 31), 'Intro');
    // Jellyfin skips as the video enters the segment, maybe before the last
    // position this client saw there.
    assert.equal(OWP.segments.skipped(3.6, 30), 'Intro');
    assert.equal(OWP.segments.skipped(27, 29.6), 'Intro');
    assert.equal(OWP.segments.skipped(45, 50), 'Recap');
    assert.equal(OWP.segments.skipped(61, 70), 'Outro');
    // From before the segment, in its last moments, short of its end (still in
    // it) or past it.
    assert.equal(OWP.segments.skipped(3.4, 30), '');
    assert.equal(OWP.segments.skipped(29, 30), '');
    assert.equal(OWP.segments.skipped(27, 29.4), '');
    assert.equal(OWP.segments.skipped(8, 25), '');
    assert.equal(OWP.segments.skipped(8, 31.4), 'Intro');
    assert.equal(OWP.segments.skipped(8, 31.6), '');
    // Jellyfin can also skip previews; the room says nothing about them.
    assert.equal(OWP.segments.skipped(85, 90), '');
  });

  it("knows nothing outside a room, or before the item's answer", async () => {
    OWP.segments.refresh();
    assert.equal(OWP.segments.skipped(8, 30), '');
    await answer('item-a');
    OWP.state.inRoom = false;
    assert.equal(OWP.segments.skipped(8, 30), '');
    const checks = [];
    OWP.segments.whenKnown(() => checks.push('outside'));
    // Back in a room with the same item, it is asked for again.
    OWP.state.inRoom = true;
    OWP.segments.refresh();
    assert.deepEqual(requests.map(url => url.path), ['MediaSegments/item-a', 'MediaSegments/item-a']);
    assert.deepEqual(checks, []);
    await answer('item-a');
    // The room moved to another item that was not asked for yet.
    OWP.state.roomMediaId = 'item-b';
    assert.equal(OWP.segments.skipped(8, 30), '');
  });

  it('runs checks at once, finding nothing, without an API client', () => {
    const api = globalThis.ApiClient;
    delete globalThis.ApiClient;
    try {
      const checks = [];
      OWP.segments.whenKnown(() => checks.push(OWP.segments.skipped(8, 30)));
      assert.deepEqual(checks, ['']);
    } finally {
      globalThis.ApiClient = api;
    }
  });

  it('runs a check at once, or once Jellyfin answers, and drops it if the room moves on', async () => {
    const checks = [];
    // The first check asks for the item when room_state did not.
    OWP.segments.whenKnown(() => checks.push(OWP.segments.skipped(8, 30)));
    assert.deepEqual(requests.map(url => url.path), ['MediaSegments/item-a']);
    assert.deepEqual(checks, []);
    await answer('item-a');
    assert.deepEqual(checks, ['Intro']);
    OWP.segments.whenKnown(() => checks.push('at once'));
    assert.deepEqual(checks, ['Intro', 'at once']);

    OWP.state.roomMediaId = 'item-b';
    OWP.segments.whenKnown(() => checks.push('item-b'));
    OWP.state.roomMediaId = 'item-c';
    OWP.segments.refresh();
    await answer('item-b');
    assert.deepEqual(checks, ['Intro', 'at once']);
    // A failed answer still runs the checks, which find nothing.
    OWP.segments.whenKnown(() => checks.push(OWP.segments.skipped(8, 30)));
    answers.get('MediaSegments/item-c').shift()(Promise.reject(new Error('offline')));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(checks, ['Intro', 'at once', '']);
  });

  it('tells the guests when the host skips the intro, recap or credits, and only then', async () => {
    OWP.segments.refresh();
    await answer('item-a');
    // The room was at 8 s, and plays on for a second.
    serverNow += 1000;
    h.handlePlayerEvent(seek(30), video);
    assert.equal(video.currentTime, 30);
    OWP.state.lastSyncPosition = 45;
    h.handlePlayerEvent(seek(50), video);
    // The room was paused in the credits.
    OWP.state.lastSyncPosition = 61;
    OWP.state.lastSyncPlayState = 'paused';
    h.handlePlayerEvent(seek(70), video);
    assert.deepEqual(toasts, ['The host skipped the intro', 'The host skipped the recap', 'The host skipped the credits']);

    // Where the room was counts, not where this guest's video is (its own
    // Jellyfin may have skipped already).
    toasts = [];
    OWP.state.lastSyncPosition = 8;
    OWP.state.lastSyncServerTs = serverNow;
    OWP.state.lastSyncPlayState = 'playing';
    video.currentTime = 30;
    h.handlePlayerEvent(seek(30), video);
    assert.deepEqual(toasts, ['The host skipped the intro']);

    toasts = [];
    OWP.state.lastSyncPosition = 8;
    h.handlePlayerEvent(seek(25), video);
    OWP.state.lastSyncPosition = 2;
    h.handlePlayerEvent(seek(30), video);
    // Playing, the room had reached the intro's last moments 2 s after 27 s.
    OWP.state.lastSyncPosition = 27;
    OWP.state.lastSyncServerTs = serverNow - 2000;
    h.handlePlayerEvent(seek(30), video);
    assert.deepEqual(toasts, []);
    // Paused at 27 s, it stayed there.
    OWP.state.lastSyncPosition = 27;
    OWP.state.lastSyncServerTs = serverNow - 2000;
    OWP.state.lastSyncPlayState = 'paused';
    h.handlePlayerEvent(seek(30), video);
    assert.deepEqual(toasts, ['The host skipped the intro']);
  });

  it("tells the guests of the host's skip once Jellyfin answers, if it comes first", async () => {
    OWP.segments.refresh();
    h.handlePlayerEvent(seek(30), video);
    assert.deepEqual(toasts, []);
    await answer('item-a');
    assert.deepEqual(toasts, ['The host skipped the intro']);
  });

  it('brings a guest whose Jellyfin skipped the intro by itself back to the room at once', async () => {
    OWP.segments.refresh();
    await answer('item-a');
    // An item that just started holds hard seeks for a while.
    OWP.state.syncCooldownUntil = localNow + 8000;
    video.currentTime = 30;
    video.dispatch('seeked');
    assert.deepEqual(toasts, ['Only the host can seek']);
    assert.equal(OWP.state.syncCooldownUntil, 0);

    serverNow += 500;
    localNow += 500;
    OWP.playback.syncLoop();
    assert.equal(video.currentTime, 8.5);
  });

  it('catches a skip Jellyfin made before its answer reached this client', async () => {
    OWP.segments.refresh();
    OWP.state.syncCooldownUntil = localNow + 8000;
    video.currentTime = 30;
    video.dispatch('seeked');
    assert.equal(OWP.state.syncCooldownUntil, localNow + 8000);
    // The video played on meanwhile; the skip was where it landed.
    video.currentTime = 32;
    await answer('item-a');
    assert.deepEqual(toasts, ['Only the host can seek']);
    assert.equal(OWP.state.syncCooldownUntil, 0);
  });

  it('leaves a guest the host skipped meanwhile, or one already back, to the room', async () => {
    OWP.segments.refresh();
    OWP.state.syncCooldownUntil = localNow + 8000;
    video.currentTime = 30;
    video.dispatch('seeked');
    // The host skips too before Jellyfin answers.
    h.handlePlayerEvent(seek(30), video);
    await answer('item-a');
    assert.deepEqual(toasts, ['The host skipped the intro']);
    assert.equal(OWP.state.syncCooldownUntil, localNow + 2000);

    joinAs('guest', 'item-b');
    OWP.segments.refresh();
    video.currentTime = 30;
    video.dispatch('seeked');
    // The sync loop brought it back before the answer.
    video.currentTime = 8;
    await answer('item-b');
    assert.deepEqual(toasts, ['The host skipped the intro']);
  });

  it("drops a room's pending checks on leaving it, even for another room with the same item", async () => {
    OWP.segments.refresh();
    const checks = [];
    OWP.segments.whenKnown(() => checks.push('room-a'));
    Object.assign(OWP.state, { inRoom: false, roomId: '' });
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-b' });
    OWP.segments.refresh();
    assert.deepEqual(requests.map(url => url.path), ['MediaSegments/item-a', 'MediaSegments/item-a']);
    // The first answer is for room-a's request.
    await answer('item-a');
    assert.deepEqual(checks, []);
    await answer('item-a');
    assert.equal(OWP.segments.skipped(8, 30), 'Intro');
  });

  it('does nothing for a video the player replaced before the answer', async () => {
    OWP.segments.refresh();
    OWP.state.syncCooldownUntil = localNow + 8000;
    video.currentTime = 30;
    video.dispatch('seeked');
    OWP.state.currentVideoElement = new FakeVideo();
    await answer('item-a');
    assert.deepEqual(toasts, []);
    assert.equal(OWP.state.syncCooldownUntil, localNow + 8000);
  });

  it('does nothing when the guest became the host before the answer', async () => {
    OWP.segments.refresh();
    OWP.state.syncCooldownUntil = localNow + 8000;
    video.currentTime = 30;
    video.dispatch('seeked');
    OWP.state.isHost = true;
    await answer('item-a');
    assert.deepEqual(toasts, []);
    assert.equal(OWP.state.syncCooldownUntil, localNow + 8000);
  });

  it('leaves alone a guest the room took past the intro, or one paused with the room', async () => {
    OWP.segments.refresh();
    await answer('item-a');
    OWP.state.syncCooldownUntil = localNow + 2000;
    // The room's last update put it at 27.5 s, 2.5 s ago.
    OWP.state.lastSyncPosition = 27.5;
    serverNow += 2500;
    video.currentTime = 30;
    video.dispatch('seeked');
    // Nor one that went to the end of the intro while the room was before it.
    OWP.state.lastSyncPosition = 2;
    OWP.state.lastSyncServerTs = serverNow;
    video.dispatch('seeked');
    assert.equal(OWP.state.syncCooldownUntil, localNow + 2000);

    OWP.state.lastSyncPosition = 8;
    OWP.state.lastSyncPlayState = 'paused';
    video.dispatch('seeked');
    joinAs('host');
    video.dispatch('seeked');
    assert.deepEqual(toasts, []);
  });
});
