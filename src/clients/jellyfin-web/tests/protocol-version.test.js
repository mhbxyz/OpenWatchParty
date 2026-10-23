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
    this.onmessage({
      data: JSON.stringify({
        ts: Date.now(),
        server_ts: Date.now(),
        ...message
      })
    });
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
OWP.ui = {
  render: () => {},
  showToast: () => {},
  updateRoomListUI: () => {},
  updateParticipantList: () => {},
  renderHomeWatchParties: () => {}
};
OWP.utils.getVideo = () => null;

// auth.js is intentionally not loaded: a stored token is reused, so the tests
// isolate the WebSocket handshake from the Jellyfin token endpoint.
require('../ws/send.js');
require('../ws/validation.js');
require('../ws/handlers/room.js');
require('../ws/connection.js');

describe('protocol version negotiation', () => {
  beforeEach(() => {
    sockets.length = 0;
    Object.assign(OWP.state, {
      ws: null,
      authToken: 'jwt-token',
      authBlocked: false,
      userName: 'Guest',
      userId: 'user',
      clientId: '',
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
    OWP.state.ws = null;
  });

  it('defines the current protocol version as 1', () => {
    assert.equal(OWP.constants.PROTOCOL_VERSION, 1);
  });

  it('declares the protocol version in the auth message', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();

    const auth = socket.sent.find(message => message.type === 'auth');
    assert.equal(auth.payload.protocol_version, OWP.constants.PROTOCOL_VERSION);
    assert.deepEqual(auth.payload.features, ['host_transfer', 'participant_status', 'shared_playback_control', 'media_queue', 'chat_history']);
    assert.equal(auth.payload.token, 'jwt-token');
  });

  it('accepts auth_success with the matching protocol version', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();
    assert.equal(OWP.state.connectionPhase, 'authenticating');

    socket.receive({ type: 'auth_success', payload: { user_name: 'Guest', protocol_version: 1 } });

    assert.equal(OWP.state.connectionPhase, 'authenticated');
  });

  it('accepts auth_success without a protocol version from older servers', async () => {
    await OWP.actions.connect();
    const socket = sockets[0];
    socket.open();

    socket.receive({ type: 'auth_success', payload: { user_name: 'Guest' } });

    assert.equal(OWP.state.connectionPhase, 'authenticated');
  });

  it('stays forward compatible with a newer server protocol version', () => {
    const message = {
      type: 'auth_success',
      payload: { user_name: 'Guest', protocol_version: OWP.constants.PROTOCOL_VERSION + 1 },
      ts: Date.now(),
      server_ts: Date.now()
    };

    assert.deepEqual(OWP.wsValidation.validateMessage(message), { valid: true, error: null });
  });
});
