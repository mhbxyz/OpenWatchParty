const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
require('../ws/validation.js');

const validate = message => OWP.wsValidation.validateMessage(message);
const valid = message => assert.deepEqual(validate(message), { valid: true, error: null });
const invalid = message => assert.equal(validate(message).valid, false);
const envelope = (type, payload, extra = {}) => ({
  type,
  payload,
  ts: 1_700_000_000_000,
  server_ts: 1_700_000_000_001,
  ...extra
});

describe('WebSocket message schema validation', () => {
  const nominal = [
    envelope('room_list', [{ id: 'room-1', name: 'Movie night', count: 2, media_id: null }]),
    envelope('client_hello', { client_id: 'client-1' }, { client: 'client-1' }),
    envelope('auth_success', { user_name: 'Alice' }, { client: 'client-1' }),
    envelope('room_state', {
      name: 'Movie night',
      host_id: 'client-1',
      state: { position: 0, play_state: 'paused' },
      state_server_ts: 1_700_000_000_000,
      target_server_ts: null,
      participant_count: 2,
      media_id: '0123456789abcdef0123456789abcdef'
    }, { room: 'room-1', client: 'client-2' }),
    envelope('participants_update', { participant_count: 3 }, { room: 'room-1' }),
    envelope('client_left', { participant_count: 2 }, { room: 'room-1', client: 'client-3' }),
    envelope('room_closed', { reason: 'Host left the room' }, { room: 'room-1' }),
    envelope('player_event', {
      action: 'seek', position: 42.5, play_state: 'playing', target_server_ts: 1_700_000_001_000
    }, { room: 'room-1', client: 'client-1' }),
    envelope('state_update', { position: 43, play_state: 'playing' }, { room: 'room-1', client: 'client-1' }),
    envelope('pong', { client_ts: 1_700_000_000_000 }),
    envelope('chat_message', { username: 'Alice', text: 'Hello' }, { room: 'room-1', client: 'client-1' }),
    envelope('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found' }, { client: 'client-1' })
  ];

  for (const message of nominal) {
    it(`accepts a nominal ${message.type} message`, () => valid(message));
  }

  it('rejects non-object envelopes and unknown message types', () => {
    invalid(null);
    invalid([]);
    invalid(envelope('future_message', {}));
  });

  it('rejects absent payloads and invalid envelope fields', () => {
    invalid({ type: 'pong', server_ts: 1 });
    invalid(envelope('pong', { client_ts: 1 }, { room: 42 }));
    invalid(envelope('pong', { client_ts: 1 }, { client: {} }));
    invalid(envelope('pong', { client_ts: 1 }, { server_ts: Number.MAX_SAFE_INTEGER + 1 }));
  });

  it('rejects wrong payload types', () => {
    invalid(envelope('client_hello', { client_id: 42 }));
    invalid(envelope('participants_update', { participant_count: '2' }));
    invalid(envelope('state_update', { position: '12', play_state: 'playing' }));
    invalid(envelope('chat_message', { username: 'Alice', text: 42 }));
    invalid(envelope('error', { code: 500, message: 'Failure' }));
  });

  it('rejects non-array room lists and malformed entries', () => {
    invalid(envelope('room_list', {}));
    invalid(envelope('room_list', [{ id: 'room-1', name: 'Room', count: -1 }]));
  });

  it('rejects non-finite and out-of-range positions', () => {
    for (const value of [NaN, Infinity, -Infinity, -1, 86400.1, Number.MAX_VALUE]) {
      invalid(envelope('state_update', { position: value, play_state: 'paused' }));
    }
  });

  it('rejects invalid playback actions, states, and target timestamps', () => {
    invalid(envelope('player_event', {
      action: 'stop', position: 1, play_state: 'paused', target_server_ts: 2
    }));
    invalid(envelope('player_event', {
      action: 'play', position: 1, play_state: 'buffering', target_server_ts: 2
    }));
    invalid(envelope('player_event', {
      action: 'play', position: 1, play_state: 'playing', target_server_ts: Infinity
    }));
  });

  it('rejects excessive participant, name, chat, and error lengths', () => {
    invalid(envelope('participants_update', { participant_count: 21 }));
    invalid(envelope('auth_success', { user_name: 'a'.repeat(101) }));
    invalid(envelope('chat_message', { username: 'Alice', text: 'a'.repeat(501) }));
    invalid(envelope('error', { code: 'X'.repeat(65), message: 'Failure' }));
  });

  it('counts Unicode names by code point and permits prefixed room names', () => {
    valid(envelope('auth_success', { user_name: '😀'.repeat(51) }, { client: 'client-1' }));
    valid(envelope('room_list', [{
      id: 'room-1',
      name: `Room de ${'a'.repeat(100)}`,
      count: 1,
      media_id: null
    }]));
  });

  it('requires type-specific room and server envelope timestamps', () => {
    invalid(envelope('room_state', {
      name: 'Room',
      host_id: 'host',
      participant_count: 1,
      state: { position: 0, play_state: 'paused' }
    }));
    invalid({ type: 'pong', payload: { client_ts: 1 }, server_ts: 1 });
    invalid({ type: 'pong', payload: { client_ts: 1 }, ts: 1 });
  });

  it('rejects unknown envelope and payload fields', () => {
    invalid(envelope('pong', { client_ts: 1 }, { injected: true }));
    invalid(envelope('state_update', {
      position: 1,
      play_state: 'paused',
      injected: true
    }, { room: 'room-1' }));
    invalid(envelope('room_list', [{
      id: 'room-1', name: 'Room', count: 1, admin: true
    }]));
  });
});
