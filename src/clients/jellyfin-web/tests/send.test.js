const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let sent;
require('../ws/send.js');

describe('WebSocket outgoing envelope', () => {
  beforeEach(() => {
    sent = [];
    OWP.state.roomId = '';
    OWP.state.clientId = '';
    OWP.state.ws = {
      readyState: 1,
      send: data => sent.push(JSON.parse(data))
    };
  });

  it('omits an empty room outside a watch party', () => {
    OWP.actions.send('ping', { client_ts: 1 });

    assert.equal(Object.hasOwn(sent[0], 'room'), false);
  });

  it('includes active and explicit room identifiers', () => {
    OWP.state.roomId = 'room-a';
    OWP.actions.send('ready');
    OWP.actions.send('join_room', {}, 'room-b');

    assert.equal(sent[0].room, 'room-a');
    assert.equal(sent[1].room, 'room-b');
  });

  it('sends every room permission and resets them before joining', () => {
    OWP.state.roomId = 'room-a';
    OWP.state.clientId = 'guest';
    OWP.actions.setRoomPermissions({ seek: true, change_media: false, edit_queue: true });
    assert.deepEqual(sent[0], {
      type: 'set_room_permissions',
      room: 'room-a',
      client: 'guest',
      payload: { seek: true, change_media: false, edit_queue: true },
      ts: sent[0].ts
    });

    OWP.state.roomPermissions = { seek: true, change_media: true, edit_queue: true };
    OWP.state.roomPermissionsReceived = true;
    OWP.state.connectionPhase = 'authenticated';
    OWP.actions.joinRoom('room-b');
    assert.deepEqual(OWP.state.roomPermissions, { seek: false, change_media: false, edit_queue: false });
    assert.equal(OWP.state.roomPermissionsReceived, false);
  });
});
