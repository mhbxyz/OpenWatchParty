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
});
