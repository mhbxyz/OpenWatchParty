const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let chatClearCount = 0;
const panel = { classList: { add: () => {} } };
globalThis.document.getElementById = () => panel;
OWP.chat = { clear: () => { chatClearCount++; } };
OWP.ui = {
  render: () => {},
  showToast: () => {}
};

require('../ws/send.js');
require('../ws/handlers/room.js');

const makeDirtyRoomState = () => {
  const video = { playbackRate: 2 };
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-a',
    roomName: 'Room A',
    participantCount: 4,
    lastParticipantCount: 4,
    isHost: true,
    readyRoomId: 'room-a',
    isBuffering: true,
    wantsToPlay: true,
    isSyncing: true,
    syncCooldownUntil: Date.now() + 1000,
    isInitialSync: true,
    initialSyncUntil: Date.now() + 1000,
    initialSyncTargetPos: 42,
    syncStatus: 'pending_play',
    currentDrift: 3,
    pendingPlayUntil: Date.now() + 1000,
    lastSyncServerTs: Date.now(),
    lastSyncPosition: 42,
    lastSyncPlayState: 'playing',
    joiningItemId: 'item',
    pendingJoinRoomId: 'room-b',
    suppressUntil: Date.now() + 1000,
    currentVideoElement: video,
    playbackRequestAttempt: 4,
    playbackBlocked: true,
    playbackFailureNotified: true,
    pendingActionTimer: OWP.timers.setTimeout(() => {
      throw new Error('cancelled room action executed');
    }, 10000, 'room')
  });
  return video;
};

const assertRoomStateReset = (video) => {
  assert.equal(video.playbackRate, 1);
  assert.equal(OWP.state.inRoom, false);
  assert.equal(OWP.state.roomId, '');
  assert.equal(OWP.state.roomName, '');
  assert.equal(OWP.state.participantCount, 0);
  assert.equal(OWP.state.lastParticipantCount, 0);
  assert.equal(OWP.state.isHost, false);
  assert.equal(OWP.state.readyRoomId, '');
  assert.equal(OWP.state.isBuffering, false);
  assert.equal(OWP.state.wantsToPlay, false);
  assert.equal(OWP.state.isSyncing, false);
  assert.equal(OWP.state.isInitialSync, false);
  assert.equal(OWP.state.initialSyncTargetPos, null);
  assert.equal(OWP.state.syncStatus, 'synced');
  assert.equal(OWP.state.currentDrift, 0);
  assert.equal(OWP.state.pendingPlayUntil, 0);
  assert.equal(OWP.state.lastSyncServerTs, 0);
  assert.equal(OWP.state.lastSyncPosition, 0);
  assert.equal(OWP.state.lastSyncPlayState, '');
  assert.equal(OWP.state.pendingActionTimer, null);
  assert.equal(OWP.state.playbackRequestAttempt, 5);
  assert.equal(OWP.state.playbackBlocked, false);
  assert.equal(OWP.state.playbackFailureNotified, false);
  assert.equal(chatClearCount, 1);
};

describe('room state reset', () => {
  beforeEach(() => {
    chatClearCount = 0;
    OWP.state.ws = null;
  });

  afterEach(() => {
    if (OWP.state.pendingActionTimer) OWP.timers.clear(OWP.state.pendingActionTimer);
    OWP.state.pendingActionTimer = null;
  });

  it('clears playback and synchronization state directly', () => {
    const video = makeDirtyRoomState();

    OWP.actions.resetRoomState();

    assertRoomStateReset(video);
  });

  it('uses the common reset when leaving voluntarily', () => {
    const video = makeDirtyRoomState();
    const sent = [];
    OWP.state.ws = {
      readyState: 1,
      send: data => sent.push(JSON.parse(data))
    };

    OWP.actions.leaveRoom();

    assert.equal(sent[0].type, 'leave_room');
    assertRoomStateReset(video);
  });

  it('uses the common reset when the host closes the room', () => {
    const video = makeDirtyRoomState();

    OWP._wsHandlers.handleRoomClosed({ payload: { reason: 'Host left' } });

    assertRoomStateReset(video);
  });
});
