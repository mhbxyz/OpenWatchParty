const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

let queueUpdates = 0;
let refreshes = 0;
let queueStates = 0;
OWP.queue = { refresh: () => { refreshes++; }, onQueueState: () => { queueStates++; } };
OWP.ui = { render: () => {}, updateQueue: () => { queueUpdates++; } };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
OWP.actions = { completeRoomRejoin: () => {} };
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');

const h = OWP._wsHandlers;
const item = (id, title = `Episode ${id}`) => ({ id, title });

const queueState = (room, payload) => ({ type: 'queue_state', room, payload });

const roomState = (room, mediaId) => ({
  type: 'room_state',
  room,
  client: 'host',
  server_ts: Date.now(),
  payload: {
    name: room,
    host_id: 'host',
    participant_count: 2,
    media_id: mediaId,
    state_server_ts: Date.now(),
    target_server_ts: null,
    state: { position: 0, play_state: 'paused' }
  }
});

describe('room queue', () => {
  let started;
  let watched;
  let ready;

  beforeEach(() => {
    queueUpdates = 0;
    refreshes = 0;
    queueStates = 0;
    started = [];
    watched = [];
    OWP.playback = {
      ensurePlayback: mediaId => { started.push(mediaId); },
      watchReady: options => { watched.push(options.mediaId); ready = options.onReady; }
    };
    Object.assign(OWP.state, OWP.stateFactories.createRoomState(), {
      clientId: 'host',
      inRoom: true,
      roomId: 'room-1',
      isHost: true,
      roomHostId: 'host',
      roomMediaId: 'a',
      readyRoomId: 'room-1',
      pendingMediaId: '',
      rejoinPending: false,
      desiredRoomId: '',
      rejectedRejoinRoomIds: []
    });
  });

  it('stores the queue of its own room only', () => {
    h.handleQueueState(queueState('room-1', { items: [item('a'), item('b')], current: 0, last_added: 'b', countdown_until: 1234 }));
    assert.deepEqual(OWP.state.queueItems, [item('a'), item('b')]);
    assert.equal(OWP.state.queueCurrent, 0);
    assert.equal(OWP.state.queueCountdownUntil, 1234);
    assert.equal(OWP.state.queueLastAdded, 'b');
    assert.equal(OWP.state.queueReceived, true);
    assert.equal(queueUpdates, 1);

    // The host removed b, the last one added.
    h.handleQueueState(queueState('room-1', { items: [item('a')], current: 0, last_added: 'b', countdown_until: null }));
    assert.equal(OWP.state.queueCountdownUntil, 0);
    assert.equal(OWP.state.queueLastAdded, 'b');

    h.handleQueueState(queueState('room-2', { items: [], current: null, last_added: null, countdown_until: null }));
    assert.deepEqual(OWP.state.queueItems, [item('a')]);
    assert.equal(queueUpdates, 2);
    assert.equal(queueStates, 2);
  });

  it('lets the host logic look again after each room state and host change', () => {
    h.handleRoomState(roomState('room-1', 'a'), null);
    assert.equal(refreshes, 1);
    OWP.ui.updateRoomRoleControls = () => {};
    OWP.ui.showToast = () => {};
    Object.assign(OWP.state, { isHost: false, clientId: 'guest' });
    h.handleHostChanged({ room: 'room-1', payload: { host_id: 'other', host_name: 'Other' } });
    assert.equal(refreshes, 2);
    h.handleHostChanged({ room: 'room-1', payload: { host_id: 'guest', host_name: 'Guest' } });
    assert.equal(refreshes, 3);
  });

  it('forgets the queue on entering another room', () => {
    h.handleQueueState(queueState('room-1', { items: [item('a')], current: 0, last_added: 'a', countdown_until: 1234 }));
    OWP.state.roomPermissions = { seek: true, change_media: true, edit_queue: true };
    OWP.state.roomPermissionsReceived = true;
    h.handleRoomState(roomState('room-2', 'x'), null);
    assert.deepEqual(OWP.state.queueItems, []);
    assert.equal(OWP.state.queueCurrent, null);
    assert.equal(OWP.state.queueCountdownUntil, 0);
    assert.equal(OWP.state.queueLastAdded, null);
    assert.equal(OWP.state.queueReceived, false);
    assert.equal(OWP.state.roomMediaId, 'x');
    assert.deepEqual(OWP.state.roomPermissions, { seek: false, change_media: false, edit_queue: false });
    assert.equal(OWP.state.roomPermissionsReceived, false);
  });

  it('loads the next item on the host too and reports ready again after an advance', () => {
    h.handleRoomState(roomState('room-1', 'b'), null);
    assert.deepEqual(started, ['b']);
    assert.deepEqual(watched, ['b']);
    assert.equal(OWP.state.pendingMediaId, 'b');
    assert.equal(OWP.state.readyRoomId, '');
    assert.equal(OWP.state.roomMediaId, 'b');
  });

  it('lets a play that came while the next item loaded stand over the paused room state', () => {
    let pauses = 0;
    const video = { currentTime: 0, isConnected: true, pause: () => { pauses++; } };
    Object.assign(OWP.state, { currentVideoElement: null, hasTimeSync: true, serverOffsetMs: 0 });
    OWP.utils.startSyncing = () => {};

    h.handleRoomState(roomState('room-1', 'b'), null);
    ready(video);
    assert.equal(pauses, 1);

    h.handleRoomState(roomState('room-1', 'c'), null);
    OWP.state.playbackActionAttempt++; // the room's scheduled play arrived
    ready(video);
    assert.equal(pauses, 1);
  });

  it('keeps a host on its item when the room state names the same one', () => {
    h.handleRoomState(roomState('room-1', 'a'), null);
    assert.deepEqual(started, []);
    assert.deepEqual(watched, []);
    assert.equal(OWP.state.readyRoomId, 'room-1');
  });
});
