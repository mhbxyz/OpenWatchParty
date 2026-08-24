const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
const sockets = [];

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen();
  }

  receive(message) {
    this.onmessage({ data: JSON.stringify(message) });
  }

  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose({ code: 1006, reason: 'network lost' });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.document.getElementById = () => null;
OWP.constants.RECONNECT_BASE_MS = 0;
OWP.constants.RECONNECT_MAX_MS = 0;
OWP.constants.ROOM_REJOIN_TIMEOUT_MS = 20;
OWP.ui = {
  render: () => {},
  showToast: () => {},
  updateRoomListUI: () => {},
  renderHomeWatchParties: () => {}
};
OWP.utils.getVideo = () => null;

require('../ws/send.js');
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');
require('../ws/connection.js');
require('../app/cleanup.js');

const roomState = (room = 'room-a') => ({
  type: 'room_state',
  room,
  client: 'new-client',
  server_ts: Date.now(),
  payload: {
    name: 'Room A',
    host_id: 'host',
    participant_count: 2,
    state: { position: 12, play_state: 'paused' }
  }
});

describe('room reconnection lifecycle', () => {
  beforeEach(() => {
    sockets.length = 0;
    Object.assign(OWP.state, {
      ws: null,
      authToken: 'jwt-token',
      authBlocked: false,
      userName: 'Guest',
      userId: 'user',
      clientId: 'old-client',
      inRoom: false,
      roomId: '',
      desiredRoomId: '',
      rejoinPending: false,
      rejectedRejoinRoomIds: [],
      isHost: false,
      autoReconnect: true,
      isConnecting: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      connectionAttempt: 0,
      authRequestAttempt: 0,
      connectionPhase: 'disconnected',
      roomRejoinTimer: null,
      currentVideoElement: null,
      successfulPings: 0,
      timeSyncSamples: []
    });
  });

  afterEach(() => {
    OWP.state.autoReconnect = false;
    if (OWP.state.intervals.ping) {
      OWP.timers.clear(OWP.state.intervals.ping);
      OWP.state.intervals.ping = null;
    }
    OWP.actions.cancelRoomRejoin();
    OWP.state.ws = null;
  });

  it('reauthenticates before rejoining a guest room', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    const video = { playbackRate: 2 };
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-a',
      isHost: false,
      currentVideoElement: video
    });

    first.serverClose();
    assert.equal(video.playbackRate, 1);
    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.desiredRoomId, 'room-a');
    assert.equal(OWP.state.rejoinPending, true);
    await new Promise(resolve => setTimeout(resolve, 10));

    const second = sockets[1];
    second.open();
    assert.equal(second.sent.some(message => message.type === 'join_room'), false);

    second.receive({ type: 'auth_success', payload: { user_name: 'Guest' } });
    assert.equal(second.sent.some(message => message.type === 'join_room' && message.room === 'room-a'), true);
    assert.equal(OWP.state.inRoom, false);

    second.receive(roomState());
    assert.equal(OWP.state.inRoom, true);
    assert.equal(OWP.state.roomId, 'room-a');
    assert.equal(OWP.state.desiredRoomId, 'room-a');
    assert.equal(OWP.state.rejoinPending, false);
  });

  it('does not attempt to recreate a host room after disconnect', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'host-room', isHost: true });

    socket.serverClose();

    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.roomId, '');
    assert.equal(OWP.state.desiredRoomId, '');
    assert.equal(OWP.state.rejoinPending, false);
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('clears a pending rejoin when the server rejects it', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'deleted-room', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });

    second.receive({ type: 'error', payload: { message: 'Room not found' } });
    second.receive(roomState('deleted-room'));

    assert.equal(OWP.state.rejoinPending, false);
    assert.equal(OWP.state.desiredRoomId, '');
    assert.equal(OWP.state.roomId, '');
    assert.equal(OWP.state.inRoom, false);
  });

  it('abandons a rejoin when the room no longer responds', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'missing-room', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });

    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(OWP.state.rejoinPending, false);
    assert.equal(OWP.state.desiredRoomId, '');
    assert.equal(OWP.state.roomId, '');
  });

  it('times out while waiting for authentication success', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    sockets[1].open();

    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(OWP.state.rejoinPending, false);
    assert.equal(OWP.state.desiredRoomId, '');
  });

  it('keeps the rejoin intent across another network drop', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });
    second.serverClose();
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(OWP.state.rejoinPending, true);
    assert.equal(OWP.state.desiredRoomId, 'room-a');
    const third = sockets[2];
    third.open();
    third.receive({ type: 'auth_success', payload: {} });
    third.receive(roomState('room-a'));
    assert.equal(OWP.state.inRoom, true);
  });

  it('ignores room state for a different rejoin target', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });

    second.receive(roomState('room-b'));
    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.rejoinPending, true);
    second.receive(roomState('room-a'));
    assert.equal(OWP.state.inRoom, true);
    assert.equal(OWP.state.roomId, 'room-a');
  });

  it('ignores a late room state after the user cancels rejoin', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });

    OWP.actions.leaveRoom();
    second.receive(roomState('room-a'));

    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.roomId, '');
    assert.equal(OWP.state.rejectedRejoinRoomIds.includes('room-a'), true);
  });

  it('accepts the target of a new manual join after cancelling rejoin', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false });
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();
    second.receive({ type: 'auth_success', payload: {} });

    OWP.actions.joinRoom('room-b');
    second.receive(roomState('room-a'));
    assert.equal(OWP.state.inRoom, false);
    second.receive(roomState('room-b'));
    assert.equal(OWP.state.inRoom, true);
    assert.equal(OWP.state.roomId, 'room-b');
  });

  it('cancels a scheduled reconnect during intentional disconnect', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();

    socket.serverClose();
    OWP.actions.disconnect();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(sockets.length, 1);
    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.autoReconnect, false);
  });

  it('cleanup closes the socket without reconnecting', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'cleanup-room',
      isHost: true,
      successfulPings: 4,
      timeSyncSamples: [{ rtt: 1 }]
    });

    OWP.app.cleanup();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(sockets.length, 1);
    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.autoReconnect, false);
    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.roomId, '');
    assert.equal(OWP.state.isHost, false);
    assert.equal(OWP.state.clientId, '');
    assert.equal(OWP.state.successfulPings, 0);
    assert.deepEqual(OWP.state.timeSyncSamples, []);
  });

  it('invalidates a connection attempt waiting for a token', async () => {
    OWP.state.authToken = null;
    let resolveToken;
    OWP.actions.fetchAuthToken = () => new Promise(resolve => { resolveToken = resolve; });

    const connecting = OWP.actions.connect();
    OWP.actions.disconnect();
    resolveToken({ mode: 'authenticated', token: 'late-token' });
    await connecting;

    assert.equal(sockets.length, 0);
    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.autoReconnect, false);
  });

  it('ignores late messages and closes from a replaced socket', async () => {
    await OWP.actions.connect();
    const first = sockets[0];
    first.open();
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = sockets[1];
    second.open();

    first.receive(roomState('stale-room'));
    first.serverClose();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(OWP.state.inRoom, false);
    assert.equal(sockets.length, 2);
    assert.equal(OWP.state.ws, second);
  });
});
