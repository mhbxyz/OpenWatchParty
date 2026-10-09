const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

let video;
let serverNow;
let localNow;
let safePlayCalls;
let sent;
let toasts;

class FakeVideo {
  constructor() {
    this.currentTime = 10;
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
    if (this.paused) return;
    this.paused = true;
    this.dispatch('pause');
  }

  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }
}

OWP.ui = {
  render: () => {},
  showToast: message => toasts.push(message),
  updateSyncIndicator: () => {}
};
OWP.playback = {
  safePlay: target => {
    safePlayCalls++;
    return target.play();
  }
};
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
require('../ws/handlers/room.js');

const h = OWP._wsHandlers;
const playerEvents = () => sent.filter(message => message.type === 'player_event');

const playerEvent = (action, position, { client = 'host', playState } = {}) => ({
  room: 'room-a',
  client,
  server_ts: serverNow,
  payload: {
    action,
    position,
    play_state: playState || (action === 'play' ? 'playing' : 'paused')
  }
});

const stateUpdate = (playState, position) => ({
  room: 'room-a',
  server_ts: serverNow,
  payload: { play_state: playState, position }
});

const joinAs = (clientId, { playing = true } = {}) => {
  video.paused = !playing;
  Object.assign(OWP.state, {
    ws: { readyState: 1, send: json => sent.push(JSON.parse(json)) },
    inRoom: true,
    roomId: 'room-a',
    clientId,
    roomHostId: 'host',
    isHost: clientId === 'host',
    roomWaiting: false,
    isBuffering: false,
    isSyncing: false,
    pendingMediaId: '',
    pendingPlayUntil: 0,
    lastSyncServerTs: serverNow,
    lastSyncPosition: 10,
    lastSyncPlayState: playing ? 'playing' : 'paused',
    ownCommandUntil: 0,
    ownCommandPlayState: '',
    playbackActionAttempt: 0,
    currentVideoElement: video,
    isInitialSync: false,
    initialSyncUntil: 0,
    initialSyncTargetPos: null,
    syncCooldownUntil: 0,
    syncStatus: 'synced',
    lastStateSentAt: 0,
    rejectedRejoinRoomIds: [],
    rejoinPending: false,
    desiredRoomId: ''
  });
};

describe('play and pause shared by the room', () => {
  beforeEach(() => {
    if (OWP.state.bound) OWP.playback.cleanupVideoListeners();
    serverNow = 1000;
    localNow = 1000;
    safePlayCalls = 0;
    sent = [];
    toasts = [];
    video = new FakeVideo();
    joinAs('guest');
    OWP.state.bound = false;
    OWP.playback.bindVideo();
  });

  afterEach(() => {
    OWP.playback.cleanupVideoListeners();
    OWP.timers.clearScope('room');
    OWP.timers.clearScope('video');
  });

  describe('a guest', () => {
    it('pauses the room, and an update the host sent before that does not resume it', () => {
      video.currentTime = 12;
      video.pause();

      assert.deepEqual(playerEvents().map(message => message.payload), [
        { action: 'pause', position: 12, play_state: 'paused' }
      ]);
      assert.equal(OWP.state.lastSyncPlayState, 'paused');

      localNow = 1000 + OWP.constants.OWN_COMMAND_HOLD_MS - 1;
      h.handleStateUpdate(stateUpdate('playing', 12.5), video);
      assert.equal(video.paused, true);
      assert.equal(safePlayCalls, 0);
      assert.equal(OWP.state.lastSyncPlayState, 'paused');

      // Past the hold, the room's state wins again.
      localNow = 1000 + OWP.constants.OWN_COMMAND_HOLD_MS;
      h.handleStateUpdate(stateUpdate('playing', 13), video);
      assert.equal(video.paused, false);
    });

    it('takes a paused update of its own pause within the hold', () => {
      video.pause();
      h.handleStateUpdate(stateUpdate('paused', 10.4), video);
      assert.equal(OWP.state.lastSyncPlayState, 'paused');
      assert.equal(OWP.state.lastSyncPosition, 10.4);
    });

    it('plays the room from a pause, and the next sync tick does not pause it again', async () => {
      joinAs('guest', { playing: false });
      OWP.state.syncCooldownUntil = 9000;
      OWP.state.isInitialSync = true;

      await video.play();

      assert.deepEqual(playerEvents().map(message => message.payload), [
        { action: 'play', position: 10, play_state: 'playing' }
      ]);
      assert.equal(OWP.state.lastSyncPlayState, 'playing');
      assert.equal(OWP.state.isInitialSync, false);
      assert.equal(OWP.state.syncCooldownUntil, 1000 + 2000);
      OWP.playback.syncLoop();
      assert.equal(video.paused, false);
    });

    it('resumes with the room when the host plays after its pause', () => {
      video.pause();
      sent = [];

      localNow = 4000;
      serverNow = 4000;
      h.handlePlayerEvent(playerEvent('play', 10), video);

      assert.equal(video.paused, false);
      assert.equal(safePlayCalls, 1);
      assert.deepEqual(playerEvents(), []);
      assert.deepEqual(toasts, ['Host resumed playback']);
    });

    it('does not send the room plays and pauses that OWP applies', () => {
      h.handlePlayerEvent(playerEvent('pause', 20), video);
      h.handlePlayerEvent(playerEvent('play', 20), video);
      h.handlePlayerEvent(playerEvent('buffering', 20), video);
      h.handlePlayerEvent(playerEvent('seek', 20, { playState: 'playing' }), video);
      h.handlePlayerEvent(playerEvent('seek', 20, { playState: 'paused' }), video);
      h.handleStateUpdate(stateUpdate('playing', 20), video);
      h.handleStateUpdate(stateUpdate('paused', 20), video);
      h.handleRoomState({
        room: 'room-a',
        client: 'guest',
        server_ts: serverNow,
        payload: {
          name: 'Room',
          participant_count: 2,
          host_id: 'host',
          state: { position: 20, play_state: 'playing' }
        }
      }, video);
      OWP.state.lastSyncPlayState = 'paused';
      OWP.state.isSyncing = false;
      OWP.playback.syncLoop();

      assert.equal(video.paused, true);
      assert.deepEqual(playerEvents(), []);
    });

    it('does not send the pause that ends an episode or comes with leaving the player', () => {
      video.ended = true;
      video.pause();
      joinAs('guest');
      video.ended = false;
      video.readyState = 0;
      video.pause();
      joinAs('guest');
      video.readyState = 4;
      video.isConnected = false;
      video.pause();

      assert.deepEqual(playerEvents(), []);
    });

    it('shares a pause while its video is still loading', () => {
      video.readyState = 1;
      video.pause();

      assert.deepEqual(playerEvents().map(message => message.payload.action), ['pause']);
    });

    it('does not play the room while it waits for the host', () => {
      joinAs('guest', { playing: false });
      OWP.state.roomWaiting = true;

      video.play();

      assert.deepEqual(playerEvents(), []);
      OWP.playback.syncLoop();
      assert.equal(video.paused, true);
      assert.deepEqual(toasts, ['Waiting for the host…']);
    });

    it('tells a guest-made pause and play from the host ones', () => {
      h.handlePlayerEvent(playerEvent('pause', 10, { client: 'other-guest' }), video);
      h.handlePlayerEvent(playerEvent('play', 10, { client: 'other-guest' }), video);
      h.handlePlayerEvent(playerEvent('pause', 10), video);

      assert.deepEqual(toasts, ['A guest paused playback', 'A guest resumed playback', 'Host paused playback']);
    });
  });

  describe('the host', () => {
    beforeEach(() => {
      joinAs('host');
    });

    it('pauses for a guest, at the guest position, without sending it back', () => {
      video.currentTime = 14;
      h.handlePlayerEvent(playerEvent('pause', 12, { client: 'guest' }), video);

      assert.equal(video.paused, true);
      assert.equal(video.currentTime, 12);
      assert.equal(OWP.state.wantsToPlay, false);
      video.dispatch('seeked');
      assert.deepEqual(sent, []);
      assert.deepEqual(toasts, ['A guest paused playback']);
    });

    it('plays for a guest from where the room was', () => {
      video.paused = true;
      serverNow = 1000;
      const msg = playerEvent('play', 10, { client: 'guest' });
      serverNow = 2500;

      h.handlePlayerEvent(msg, video);

      assert.equal(video.paused, false);
      assert.equal(video.currentTime, 11.5);
      assert.equal(safePlayCalls, 1);
      assert.equal(OWP.state.wantsToPlay, true);
      assert.deepEqual(sent, []);
      assert.deepEqual(toasts, ['A guest resumed playback']);
    });

    it('stays put when already in that state, as with its own pending play', () => {
      video.currentTime = 30;
      h.handlePlayerEvent(playerEvent('play', 20), video);

      assert.equal(video.currentTime, 30);
      assert.equal(safePlayCalls, 0);
      assert.equal(OWP.state.isSyncing, false);
      assert.deepEqual(toasts, []);
    });

    it('applies a guest pause that came during its stream reload once the reload ends', () => {
      OWP.state.streamReloadUntil = localNow + 10000;
      OWP.state.streamReloadResume = true;
      video.paused = true;
      h.handlePlayerEvent(playerEvent('pause', 12, { client: 'guest' }), video);

      assert.equal(OWP.state.isSyncing, false);
      assert.deepEqual(toasts, []);

      // Jellyfin plays the reloaded stream again.
      video.paused = false;
      video.dispatch('playing');

      assert.equal(OWP.state.streamReloadUntil, 0);
      assert.equal(video.paused, true);
      assert.equal(OWP.state.reloadGuestCommand, null);
      assert.deepEqual(toasts, ['A guest paused playback']);
      assert.deepEqual(playerEvents(), []);
    });

    it('drops a guest command from the reload if it left the room meanwhile', () => {
      OWP.state.streamReloadUntil = localNow + 10000;
      h.handlePlayerEvent(playerEvent('pause', 12, { client: 'guest' }), video);
      OWP.state.roomId = 'room-b';

      video.dispatch('playing');

      assert.equal(video.paused, false);
      assert.deepEqual(toasts, []);
    });

    it('plays its own pending play without a guest toast', () => {
      video.paused = true;
      h.handlePlayerEvent(playerEvent('play', 10), video);

      assert.equal(video.paused, false);
      assert.deepEqual(toasts, []);
    });

    it('ignores the commands only a host sends', () => {
      for (const action of ['seek', 'buffering']) {
        h.handlePlayerEvent(playerEvent(action, 50, { client: 'guest' }), video);
      }
      assert.equal(video.paused, false);
      assert.equal(video.currentTime, 10);
    });

    it('drops a scheduled guest command after a role change', () => {
      let scheduled;
      const realScheduleAt = OWP.utils.scheduleAt;
      OWP.utils.scheduleAt = (target, callback) => { scheduled = callback; };
      try {
        h.handlePlayerEvent(playerEvent('pause', 10, { client: 'guest' }), video);
        OWP.state.isHost = false;
        scheduled();
      } finally {
        OWP.utils.scheduleAt = realScheduleAt;
      }
      assert.equal(video.paused, false);
    });
  });

  it('follows the host role when it passes on', () => {
    h.handleHostChanged({ room: 'room-a', payload: { host_id: 'guest-2', host_name: 'Ana' } });
    assert.equal(OWP.state.roomHostId, 'guest-2');
    toasts = [];

    // The old host is a guest now: its pause is a guest's.
    h.handlePlayerEvent(playerEvent('pause', 10, { client: 'host' }), video);
    assert.deepEqual(toasts, ['A guest paused playback']);
  });

  it('records the host from the room state', () => {
    OWP.state.roomHostId = '';
    h.handleRoomState({
      room: 'room-a',
      client: 'guest',
      server_ts: serverNow,
      payload: {
        name: 'Room',
        participant_count: 2,
        host_id: 'host-2',
        state: { position: 10, play_state: 'playing' }
      }
    }, video);
    assert.equal(OWP.state.roomHostId, 'host-2');
  });
});
