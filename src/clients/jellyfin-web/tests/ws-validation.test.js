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
  it('validates room capability announcements without changing legacy schemas', () => {
    valid(envelope('room_capabilities', { features: ['shared_playback_control'] }, { room: 'room-1' }));
    valid(envelope('room_capabilities', { features: [] }, { room: 'room-1' }));
    for (const payload of [null, [], {}, { features: 'shared_playback_control' }, { features: [7] }, { features: [], extra: true }]) {
      invalid(envelope('room_capabilities', payload, { room: 'room-1' }));
    }
    invalid(envelope('room_capabilities', { features: [] }));
  });

  it('validates the room queue strictly', () => {
    const item = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Pilot' };
    const queue = payload => envelope('queue_state', payload, { room: 'room-1' });
    valid(queue({ items: [item], current: 0, last_added: item.id, countdown_until: 1_700_000_010_000 }));
    valid(queue({ items: [], current: null, last_added: null, countdown_until: null }));
    for (const payload of [
      { items: [item], current: 0, last_added: null },
      { items: [item], current: 0, countdown_until: null },
      { items: [item], current: 1, last_added: null, countdown_until: null },
      { items: [item], current: -1, last_added: null, countdown_until: null },
      { items: [item], current: 0.5, last_added: null, countdown_until: null },
      { items: [{ ...item, extra: true }], current: 0, last_added: null, countdown_until: null },
      { items: [{ id: item.id, title: '' }], current: 0, last_added: null, countdown_until: null },
      { items: Array(21).fill(item), current: null, last_added: null, countdown_until: null },
      { items: [item], current: 0, last_added: 7, countdown_until: null },
      { items: [item], current: 0, last_added: '', countdown_until: null },
      { items: [item], current: 0, last_added: null, countdown_until: -1 },
      { items: [item], current: 0, last_added: null, countdown_until: null, extra: true }
    ]) {
      invalid(queue(payload));
    }
    invalid(envelope('queue_state', { items: [], current: null, last_added: null, countdown_until: null }));
  });
  it('validates the start state strictly', () => {
    const start = payload => envelope('start_state', payload, { room: 'room-1' });
    const ana = { client: 'client-2', name: 'Ana', reason: 'transcoding' };
    valid(start({ state: 'waiting', position: 30, waiting_for: [ana], deadline_server_ts: 1_700_000_020_000 }));
    valid(start({ state: 'waiting', position: 0, waiting_for: [{ ...ana, name: '' }], deadline_server_ts: 1 }));
    valid(start({ state: 'starting', target_server_ts: 1_700_000_003_000, countdown: true, without: [] }));
    valid(start({ state: 'starting', target_server_ts: 1, countdown: false, without: [{ ...ana, reason: 'autoplay_blocked' }] }));
    valid(start({ state: 'idle' }));
    for (const payload of [
      null,
      { state: 'later' },
      { state: 'idle', extra: true },
      { state: 'waiting', position: 30, waiting_for: [ana] },
      { state: 'waiting', position: -1, waiting_for: [ana], deadline_server_ts: 1 },
      { state: 'waiting', position: 30, waiting_for: [{ ...ana, reason: 'sleepy' }], deadline_server_ts: 1 },
      { state: 'waiting', position: 30, waiting_for: [{ ...ana, extra: 1 }], deadline_server_ts: 1 },
      { state: 'waiting', position: 30, waiting_for: [{ name: 'Ana', reason: 'loading' }], deadline_server_ts: 1 },
      { state: 'waiting', position: 30, waiting_for: Array(21).fill(ana), deadline_server_ts: 1 },
      { state: 'waiting', position: 30, waiting_for: [ana], deadline_server_ts: 1, extra: 1 },
      { state: 'starting', target_server_ts: 1, countdown: 'yes', without: [] },
      { state: 'starting', target_server_ts: -1, countdown: true, without: [] },
      { state: 'starting', target_server_ts: 1, countdown: true },
      { state: 'starting', target_server_ts: 1, countdown: true, without: [{ ...ana, reason: 7 }] }
    ]) {
      invalid(start(payload));
    }
    invalid(envelope('start_state', { state: 'idle' }));
  });
  const nominal = [
    envelope('room_list', [{ id: 'room-1', name: 'Movie night', count: 2, media_id: null }]),
    envelope('client_hello', { client_id: 'client-1' }, { client: 'client-1' }),
    envelope('auth_success', { user_name: 'Alice' }, { client: 'client-1' }),
    envelope('auth_success', { user_name: 'Alice', protocol_version: 1 }, { client: 'client-1' }),
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
    envelope('participant_list', { participants: [{ name: 'Alice', is_host: true }] }, { room: 'room-1' }),
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

  it('counts Unicode names by code point and permits room names built from a full-length user name', () => {
    valid(envelope('auth_success', { user_name: '😀'.repeat(51) }, { client: 'client-1' }));
    valid(envelope('room_list', [{
      id: 'room-1',
      name: `${'a'.repeat(100)}'s room`,
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

  it('rejects message types inherited from Object.prototype', () => {
    for (const type of ['toString', 'hasOwnProperty', 'constructor', '__defineGetter__']) {
      invalid(envelope(type, {}));
      assert.equal(OWP.wsValidation.isKnownType(type), false);
    }
  });

  it('rejects invalid auth protocol versions but keeps the field optional', () => {
    valid(envelope('auth_success', { user_name: 'Alice' }, { client: 'client-1' }));
    valid(envelope('auth_success', { user_name: 'Alice', protocol_version: 1 }, { client: 'client-1' }));
    for (const version of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
      invalid(envelope('auth_success', { user_name: 'Alice', protocol_version: version }, { client: 'client-1' }));
    }
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
    invalid(envelope('auth_success', { user_name: 'Alice', injected: true }, { client: 'client-1' }));
  });
});
