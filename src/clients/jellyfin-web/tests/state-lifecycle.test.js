const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OWP = require('./setup.js');

OWP.ui = { updateGuestControls: () => {}, removeHeaderButtons: () => {} };
OWP.utils.getVideo = () => OWP.state.currentVideoElement;
OWP.chat = { clear: () => {} };
require('../ws/send.js');
require('../app/cleanup.js');
OWP.playback = {};
require('../playback/bind.js');

describe('state lifecycle boundaries', () => {
  afterEach(() => {
    OWP.timers.clearAll();
    OWP.state.pendingActionTimer = null;
    OWP.state.mediaReadyCleanup = null;
    OWP.state.videoListeners = null;
    OWP.state.currentVideoElement = null;
  });

  it('leaving a room preserves credentials, preferences, lobby and the active player binding', () => {
    const credentials = { authToken: 'session-token', userId: 'user', userName: 'Alice', tokenExpiresAt: 42 };
    const preferences = { followHost: false, showSyncNudge: true, hideNativeSyncPlayButton: true, inviteTtlSeconds: 60 };
    const video = { playbackRate: 1.1 };
    const listeners = { pause: () => {} };
    const rooms = [{ id: 'other-room' }];
    Object.assign(OWP.state, credentials, preferences, {
      inRoom: true, roomId: 'old-room', isHost: true, rooms,
      bound: true, currentVideoElement: video, videoListeners: listeners,
      lobbyHelpOpen: true, desiredRoomId: 'recovery-target', rejoinPending: true
    });
    OWP.actions.resetRoomState();
    for (const [field, value] of Object.entries({ ...credentials, ...preferences })) {
      assert.equal(OWP.state[field], value, field);
    }
    assert.equal(OWP.state.currentVideoElement, video);
    assert.equal(OWP.state.videoListeners, listeners);
    assert.equal(OWP.state.bound, true);
    assert.equal(OWP.state.rooms, rooms);
    assert.equal(OWP.state.lobbyHelpOpen, true);
    // Rejoin intent belongs to connection; callers explicitly cancel it on Leave.
    assert.equal(OWP.state.desiredRoomId, 'recovery-target');
    assert.equal(OWP.state.rejoinPending, true);
    assert.equal(video.playbackRate, 1);
    assert.equal(OWP.state.inRoom, false);
  });

  it('cancels room/media work, invalidates asynchronous attempts and preserves other timers', () => {
    const scopes = ['room', 'media', 'connection', 'lifecycle', 'video'];
    const handles = scopes.map(scope => OWP.timers.setTimeout(() => {}, 10_000, scope));
    const counters = ['playbackRequestAttempt', 'autoJoinAttempt', 'cardPollAttempt', 'mediaSyncAttempt', 'playbackActionAttempt'];
    for (const field of counters) OWP.state[field] = 7;
    let disposed = 0;
    OWP.state.mediaReadyCleanup = () => {
      disposed++;
      OWP.state.mediaReadyCleanup = null;
    };
    OWP.actions.resetRoomState();
    assert.equal(disposed, 1);
    for (const field of counters) assert.equal(OWP.state[field], 8, field);
    assert.equal(OWP.timers.count('room'), 0);
    assert.equal(OWP.timers.count('media'), 0);
    for (const scope of scopes.slice(2)) assert.equal(OWP.timers.count(scope), 1, scope);
    assert.equal(OWP.timers.clear(handles[0]), false);
    assert.equal(OWP.timers.clear(handles[1]), false);
  });

  it('uses fresh participant arrays on repeated room resets', () => {
    OWP.actions.resetRoomState();
    const oldParticipants = OWP.state.participants;
    oldParticipants.push({ name: 'stale' });
    OWP.actions.resetRoomState();
    assert.notEqual(OWP.state.participants, oldParticipants);
    assert.deepEqual(OWP.state.participants, []);
  });

  it('creates independent mutable defaults for every new application state', () => {
    const first = OWP.stateFactories.createState();
    const second = OWP.stateFactories.createState();
    for (const field of ['participants', 'rooms', 'serverFeatures', 'rejectedRejoinRoomIds',
      'timeSyncSamples', 'logBuffer', 'intervals', 'homeRoomCache']) {
      assert.notEqual(first[field], second[field], field);
    }
    first.participants.push({ name: 'Alice' });
    first.intervals.ping = 42;
    first.homeRoomCache.set('poster', 'image');
    assert.deepEqual(second.participants, []);
    assert.equal(second.intervals.ping, null);
    assert.equal(second.homeRoomCache.has('poster'), false);
  });

  it('installs missing helpers on loader retry without discarding live state, constants or timers', () => {
    const liveState = { ...OWP.stateFactories.createState(), roomId: 'live-room', authToken: 'live-token' };
    const timers = { clearScope: () => {} };
    const constants = { marker: 'existing constants' };
    const existing = { state: liveState, timers, constants };
    const context = { OpenWatchParty: existing, location: { protocol: 'https:', hostname: 'localhost' } };
    context.window = context;
    const source = fs.readFileSync(path.join(__dirname, '../state.js'), 'utf8');
    vm.runInNewContext(source, context);
    assert.equal(existing.state, liveState);
    assert.equal(existing.timers, timers);
    assert.equal(existing.constants, constants);
    assert.equal(existing.state.roomId, 'live-room');
    assert.equal(existing.state.authToken, 'live-token');
    assert.equal(typeof existing.stateFactories.createRoomState, 'function');
    assert.equal(typeof existing.stateLifecycle.releaseVideoBinding, 'function');
    const factories = existing.stateFactories;
    vm.runInNewContext(source, context);
    assert.equal(existing.stateFactories, factories);
  });

  it('resets room playback without clearing membership, UI or the active video', () => {
    const video = { playbackRate: 1.1 };
    Object.assign(OWP.state, { inRoom: true, roomId: 'active', isHost: true,
      roomBarSection: 'people', currentVideoElement: video, bound: true,
      pendingMediaId: 'stale', isInitialSync: true, initialSyncTargetPos: 40 });
    OWP.actions.resetRoomPlayback();
    assert.equal(OWP.state.roomId, 'active');
    assert.equal(OWP.state.inRoom, true);
    assert.equal(OWP.state.isHost, true);
    assert.equal(OWP.state.roomBarSection, 'people');
    assert.equal(OWP.state.currentVideoElement, video);
    assert.equal(OWP.state.bound, true);
    assert.equal(OWP.state.pendingMediaId, '');
    assert.equal(OWP.state.isInitialSync, false);
    assert.equal(OWP.state.initialSyncTargetPos, null);
    assert.equal(video.playbackRate, 1);
  });

  it('releases all video events and its timer exactly once, including reload events', () => {
    const removed = [];
    const listeners = Object.fromEntries(['waiting', 'canplay', 'playing', 'play', 'pause',
      'seeked', 'emptied', 'timeupdate'].map(event => [event, () => {}]));
    OWP.state.currentVideoElement = {
      removeEventListener: (event, listener) => removed.push([event, listener])
    };
    OWP.state.videoListeners = listeners;
    OWP.state.bound = true;
    OWP.state.initialized = true;
    OWP.state.intervals.stateUpdate = OWP.timers.setInterval(() => {}, 10_000, 'video');
    OWP.app.cleanup();
    OWP.app.cleanup();
    assert.deepEqual(removed.map(([event]) => event).sort(), Object.keys(listeners).sort());
    for (const [event, listener] of removed) assert.equal(listener, listeners[event]);
    assert.equal(OWP.state.currentVideoElement, null);
    assert.equal(OWP.state.videoListeners, null);
    assert.equal(OWP.state.bound, false);
    assert.equal(OWP.state.initialized, false);
    assert.equal(OWP.state.intervals.stateUpdate, null);
    assert.equal(OWP.timers.count(), 0);
  });

  it('cleans up panel event listeners including wheel on cleanup', () => {
    const events = [];
    const panel = {
      removeEventListener: (event) => {
        events.push(event);
      }
    };
    const prevGetElementById = globalThis.document?.getElementById;
    globalThis.document = globalThis.document || {};
    globalThis.document.getElementById = (id) => (id === OWP.constants.PANEL_ID ? panel : null);
    OWP._lifecycle = OWP._lifecycle || {};
    OWP._lifecycle.panelStopPropagation = () => {};
    try {
      OWP.app.cleanup();
      assert.deepEqual(events.sort(), ['click', 'keydown', 'keypress', 'keyup', 'mousedown', 'wheel']);
      assert.equal(OWP._lifecycle.panelStopPropagation, null);
    } finally {
      if (prevGetElementById) globalThis.document.getElementById = prevGetElementById;
    }
  });

  it('replaces the player without duplicate listeners or video intervals and can bind after cleanup', () => {
    const makeVideo = () => {
      const listeners = new Map();
      return { listeners,
        addEventListener: (event, callback) => {
          assert.equal(listeners.has(event), false, `duplicate ${event}`);
          listeners.set(event, callback);
        },
        removeEventListener: (event, callback) => {
          assert.equal(listeners.get(event), callback);
          listeners.delete(event);
        }
      };
    };
    const first = makeVideo();
    const second = makeVideo();
    const getVideo = OWP.utils.getVideo;
    let current = first;
    OWP.utils.getVideo = () => current;
    try {
      OWP.state.bound = false;
      OWP.playback.bindVideo();
      OWP.playback.bindVideo();
      assert.equal(first.listeners.size, 8);
      assert.equal(OWP.timers.count('video'), 1);
      const connectionTimer = OWP.timers.setTimeout(() => {}, 10_000, 'connection');
      current = second;
      OWP.playback.bindVideo();
      assert.equal(first.listeners.size, 0);
      assert.equal(second.listeners.size, 8);
      assert.equal(OWP.state.currentVideoElement, second);
      assert.equal(OWP.timers.count('video'), 1);
      assert.equal(OWP.timers.clear(connectionTimer), true);
      OWP.app.cleanup();
      assert.equal(second.listeners.size, 0);
      OWP.playback.bindVideo();
      assert.equal(second.listeners.size, 8);
      assert.equal(OWP.timers.count('video'), 1);
      OWP.playback.cleanupVideoListeners();
    } finally {
      OWP.utils.getVideo = getVideo;
    }
  });
});
