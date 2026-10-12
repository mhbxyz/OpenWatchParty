const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

const IMG = '<img onerror="globalThis.pwned=true">';

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0, markRead: () => {}, renderAllMessages: () => {} };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
OWP.actions = { completeRoomRejoin: () => {} };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../ws/validation.js');
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');

const h = OWP._wsHandlers;
const validate = message => OWP.wsValidation.validateMessage(message);

const envelope = (payload, extra = {}) => ({
  type: 'participant_list',
  room: 'room-1',
  payload,
  ts: 1_700_000_000_000,
  server_ts: 1_700_000_000_001,
  ...extra
});

const listMessage = (participants, room = 'room-1') => envelope({ participants }, { room });

const roomState = room => ({
  type: 'room_state',
  room,
  client: 'host',
  server_ts: Date.now(),
  payload: {
    name: room,
    host_id: 'host',
    participant_count: 2,
    media_id: null,
    state_server_ts: Date.now(),
    target_server_ts: null,
    state: { position: 0, play_state: 'paused' }
  }
});

const participantsList = () => document.getElementById('owp-participants-list');
const participantsText = () => participantsList().textContent;
const participantChips = () => participantsList().querySelectorAll('.owp-participant').map(chip => ({
  name: chip.querySelector('.owp-participant-name').textContent,
  host: chip.querySelector('.owp-host-badge') !== null
}));

const renderRoomPanel = () => {
  const panel = document.createElement('div');
  panel.id = OWP.constants.PANEL_ID;
  document.body.appendChild(panel);
  OWP.ui.render(true);
};

describe('participant_list schema', () => {
  it('accepts names with the host flagged, including an empty name', () => {
    assert.equal(validate(listMessage([
      { name: 'Franco', is_host: true },
      { name: 'Ana', is_host: false },
      { name: '', is_host: false }
    ])).valid, true);
    assert.equal(validate(listMessage([])).valid, true);
  });

  it('rejects malformed lists', () => {
    const invalid = message => assert.equal(validate(message).valid, false);
    invalid(envelope({ participants: [{ name: 'Ana', is_host: false }] }, { room: undefined }));
    invalid(envelope({ participants: [], extra: true }));
    invalid(envelope({ participants: 'Ana' }));
    invalid(listMessage([{ name: 'Ana' }]));
    invalid(listMessage([{ name: 'Ana', is_host: 'no' }]));
    invalid(listMessage([{ name: 'Ana', is_host: false, id: 'client-1' }]));
    invalid(listMessage([{ name: 42, is_host: false }]));
    invalid(listMessage([{ name: 'x'.repeat(101), is_host: false }]));
    invalid(listMessage(['Ana']));
    invalid(listMessage(Array.from({ length: 21 }, (_, i) => ({ name: `User ${i}`, is_host: false }))));
  });
});

describe('participant names in the room panel', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    globalThis.pwned = false;
    OWP.timers.setTimeout = () => 1;
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.ui.showToast = () => {};
    Object.assign(OWP.state, {
      inRoom: true,
      roomId: 'room-1',
      roomName: 'Movie night',
      clientId: 'host',
      isHost: true,
      participantCount: 2,
      lastParticipantCount: 2,
      participants: []
    });
  });

  const hostAndGuest = [
    { name: 'Franco', host: true },
    { name: 'Ana', host: false }
  ];

  it('shows the count until the server sends names', () => {
    renderRoomPanel();
    assert.equal(participantsText(), 'Online: 2');
    assert.deepEqual(participantChips(), []);
  });

  it('replaces the count with one chip per name and a host badge', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([
      { name: 'Franco', is_host: true },
      { name: 'Ana', is_host: false }
    ]));
    assert.deepEqual(OWP.state.participants, [
      { name: 'Franco', isHost: true, status: null },
      { name: 'Ana', isHost: false, status: null }
    ]);
    assert.deepEqual(participantChips(), hostAndGuest);
    assert.equal(participantsList().querySelector('.owp-host-badge').textContent, 'Host');
    assert.equal(participantsText().includes('Online'), false);

    renderRoomPanel();
    assert.deepEqual(participantChips(), hostAndGuest);
  });

  it('keeps the names when a count update arrives', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([
      { name: 'Franco', is_host: true },
      { name: 'Ana', is_host: false }
    ]));
    h.handleParticipantsUpdate({ payload: { participant_count: 3 } });
    assert.deepEqual(participantChips(), hostAndGuest);
    h.handleClientLeft({ payload: { participant_count: 1 } });
    assert.deepEqual(participantChips(), hostAndGuest);
    h.handleParticipantList(listMessage([{ name: 'Franco', is_host: true }]));
    assert.deepEqual(participantChips(), [{ name: 'Franco', host: true }]);
  });

  it('still updates the count when no names were sent', () => {
    renderRoomPanel();
    h.handleParticipantsUpdate({ payload: { participant_count: 3 } });
    assert.equal(participantsText(), 'Online: 3');
    h.handleClientLeft({ payload: { participant_count: 2 } });
    assert.equal(participantsText(), 'Online: 2');
  });

  it('labels an empty name as Guest', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([
      { name: 'Franco', is_host: true },
      { name: '', is_host: false }
    ]));
    assert.deepEqual(participantChips(), [
      { name: 'Franco', host: true },
      { name: 'Guest', host: false }
    ]);
  });

  it('does not let a name pass for the host or for several people', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([
      { name: 'Franco', is_host: true },
      { name: 'Ana (host), Juan', is_host: false }
    ]));
    assert.deepEqual(participantChips(), [
      { name: 'Franco', host: true },
      { name: 'Ana (host), Juan', host: false }
    ]);
    assert.equal(participantsList().querySelectorAll('.owp-host-badge').length, 1);
  });

  it('ignores lists for another room or when not in a room', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([{ name: 'Other', is_host: true }], 'room-2'));
    assert.deepEqual(OWP.state.participants, []);
    assert.equal(participantsText(), 'Online: 2');

    OWP.state.inRoom = false;
    h.handleParticipantList(listMessage([{ name: 'Other', is_host: true }]));
    assert.deepEqual(OWP.state.participants, []);
  });

  it('drops the previous room names when joining another room', () => {
    OWP.state.participants = [{ name: 'Old', isHost: true }];
    h.handleRoomState(roomState('room-2'), null);
    assert.equal(OWP.state.roomId, 'room-2');
    assert.deepEqual(OWP.state.participants, []);
  });

  it('keeps the names when the same room sends its state again', () => {
    OWP.state.participants = [{ name: 'Franco', isHost: true }];
    h.handleRoomState(roomState('room-1'), null);
    assert.deepEqual(OWP.state.participants, [{ name: 'Franco', isHost: true }]);
  });

  it('renders hostile names as exact text', () => {
    renderRoomPanel();
    h.handleParticipantList(listMessage([{ name: IMG, is_host: true }]));
    assert.deepEqual(participantChips(), [{ name: IMG, host: true }]);
    assert.equal(document.body.querySelector('img'), null);
    assert.equal(document.body.querySelector('script'), null);
    assert.equal(globalThis.pwned, false);
  });
});
