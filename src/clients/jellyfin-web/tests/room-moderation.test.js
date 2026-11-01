const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0, markRead: () => {}, renderAllMessages: () => {}, clear: () => {} };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../ws/send.js');
require('../ws/handlers/room.js');

let focused = null;
Object.getPrototypeOf(document.createElement('div')).focus = function focus() {
  focused = this;
};
Object.defineProperty(FakeDocument.prototype, 'activeElement', { configurable: true, get: () => focused });

const participants = [
  { id: 'host-id', name: 'Host', isHost: true, status: 'playing' },
  { id: 'guest-id', name: 'Ana', isHost: false, status: 'in_sync' },
  { id: 'other-id', name: 'Bo', isHost: false, status: null }
];
const list = () => document.getElementById('owp-participants-list');
const moreFor = id => list().querySelectorAll('.owp-mod-more')
  .find(button => button.dataset.participantId === id);

const renderPeople = (overrides = {}) => {
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-1',
    roomName: 'Room',
    clientId: 'host-id',
    isHost: true,
    participantCount: participants.length,
    participants,
    serverFeatures: ['room_moderation'],
    roomBarSection: 'people',
    ...overrides
  });
  OWP.ui.render(true);
};

describe('room moderation client', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    focused = null;
    const panel = document.createElement('div');
    panel.id = OWP.constants.PANEL_ID;
    document.body.appendChild(panel);
    Object.assign(OWP.state, OWP.stateFactories.createRoomState(), OWP.stateFactories.createRoomUIState(), {
      connectionPhase: 'authenticated',
      ws: { readyState: 1, send: () => {} },
      clientId: 'host-id',
      serverFeatures: ['room_moderation']
    });
    OWP.timers.setTimeout = () => 1;
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.ui.showToast = () => {};
  });

  it('shows options only to a negotiated host for identified participants other than itself', () => {
    renderPeople();
    assert.deepEqual(list().querySelectorAll('.owp-mod-more').map(button => button.dataset.participantId), ['guest-id', 'other-id']);
    assert.equal(moreFor('guest-id').title, 'Options for Ana');
    assert.equal(moreFor('guest-id').getAttribute('aria-label'), 'Options for Ana');

    renderPeople({ isHost: false });
    assert.equal(list().querySelector('.owp-mod-more'), null);
    renderPeople({ serverFeatures: [] });
    assert.equal(list().querySelector('.owp-mod-more'), null);
    renderPeople({ participants: [{ name: 'Ana', isHost: false, status: null }] });
    assert.equal(list().querySelector('.owp-mod-more'), null);
  });

  it('opens one action block, and Cancel or Escape closes it and restores focus', () => {
    renderPeople();
    moreFor('guest-id').focus();
    moreFor('guest-id').click();
    assert.equal(moreFor('guest-id').getAttribute('aria-expanded'), 'true');
    assert.ok(moreFor('guest-id').closest('.owp-participant').classList.contains('owp-mod-row'));
    assert.equal(list().querySelector('.owp-mod-hint').textContent, 'Someone removed can join again. Someone blocked can’t come back to this room.');
    assert.deepEqual(list().querySelectorAll('.owp-mod-buttons button').map(button => button.textContent), ['Cancel', 'Remove', 'Block']);

    moreFor('other-id').click();
    assert.equal(moreFor('guest-id').getAttribute('aria-expanded'), 'false');
    assert.equal(moreFor('other-id').getAttribute('aria-expanded'), 'true');
    list().querySelector('.owp-mod-cancel').click();
    assert.equal(OWP.state.moderationOpenParticipantId, '');
    assert.equal(focused, moreFor('other-id'));

    moreFor('guest-id').click();
    const block = list().querySelector('.owp-mod-block');
    block.focus();
    let prevented = false;
    block.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(OWP.state.moderationOpenParticipantId, '');
    assert.equal(focused, moreFor('guest-id'));
    assert.equal(OWP.state.roomBarSection, 'people');
  });

  it('closes an open action block when its options button is clicked again', () => {
    renderPeople();
    moreFor('guest-id').click();
    assert.equal(moreFor('guest-id').getAttribute('aria-expanded'), 'true');
    assert.ok(list().querySelector('.owp-mod-actions'));

    moreFor('guest-id').click();
    assert.equal(moreFor('guest-id').getAttribute('aria-expanded'), 'false');
    assert.equal(list().querySelector('.owp-mod-actions'), null);
  });

  it('moves focus to the replacement action button after a participant status update', () => {
    renderPeople();
    moreFor('guest-id').click();
    const oldRemove = list().querySelector('.owp-mod-remove');
    oldRemove.focus();

    OWP._wsHandlers.handleParticipantStatuses({
      room: 'room-1',
      payload: { statuses: ['paused', 'playing', 'buffering'] }
    });

    const newRemove = list().querySelector('.owp-mod-remove');
    assert.notEqual(newRemove, oldRemove);
    assert.equal(document.activeElement, newRemove);
    assert.equal(list().contains(document.activeElement), true);
  });

  it('redraws moderation options when re-authentication changes the negotiated feature', () => {
    renderPeople({ serverFeatures: [] });
    assert.equal(list().querySelector('.owp-mod-more'), null);

    OWP._wsHandlers.handleAuthSuccess({ payload: { features: ['room_moderation'] } });
    assert.deepEqual(list().querySelectorAll('.owp-mod-more').map(button => button.dataset.participantId), ['guest-id', 'other-id']);
    moreFor('guest-id').click();

    OWP._wsHandlers.handleAuthSuccess({ payload: { features: [] } });
    assert.equal(list().querySelector('.owp-mod-more'), null);
    assert.equal(list().querySelector('.owp-mod-actions'), null);
    assert.equal(OWP.state.moderationOpenParticipantId, '');
  });

  it('redraws moderation options when host_changed grants or removes the host role', () => {
    renderPeople({ clientId: 'guest-id', isHost: false });
    assert.equal(list().querySelector('.owp-mod-more'), null);

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'guest-id', host_name: 'Ana' }
    });
    assert.deepEqual(list().querySelectorAll('.owp-mod-more').map(button => button.dataset.participantId), ['host-id', 'other-id']);
    moreFor('other-id').click();
    assert.ok(list().querySelector('.owp-mod-actions'));

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'host-id', host_name: 'Host' }
    });
    assert.equal(list().querySelector('.owp-mod-more'), null);
    assert.equal(list().querySelector('.owp-mod-actions'), null);
    assert.equal(OWP.state.moderationOpenParticipantId, '');
  });

  it('keeps the open block and its focus across updates, then drops it with the participant or host role', () => {
    renderPeople();
    moreFor('guest-id').click();
    list().querySelector('.owp-mod-remove').focus();
    OWP.state.participants = OWP.state.participants.map(member => ({ ...member, status: 'paused' }));
    OWP.ui.updateParticipantList();
    assert.equal(OWP.state.moderationOpenParticipantId, 'guest-id');
    assert.ok(focused.classList.contains('owp-mod-remove'));

    OWP.state.participants = OWP.state.participants.filter(member => member.id !== 'guest-id');
    OWP.ui.updateParticipantList();
    assert.equal(OWP.state.moderationOpenParticipantId, '');

    moreFor('other-id').click();
    OWP.state.isHost = false;
    OWP.ui.updateParticipantList();
    assert.equal(OWP.state.moderationOpenParticipantId, '');
    assert.equal(list().querySelector('.owp-mod-more'), null);
  });

  it('sends strict remove and block payloads and remembers each requested participant', () => {
    const sent = [];
    renderPeople({ ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) } });
    moreFor('guest-id').click();
    list().querySelector('.owp-mod-remove').click();
    moreFor('other-id').click();
    list().querySelector('.owp-mod-block').click();
    assert.deepEqual(sent.map(message => ({ type: message.type, payload: message.payload })), [
      { type: 'remove_participant', payload: { id: 'guest-id', block: false } },
      { type: 'remove_participant', payload: { id: 'other-id', block: true } }
    ]);
    assert.deepEqual(OWP.state.pendingModerations, [
      { id: 'guest-id', name: 'Ana', block: false },
      { id: 'other-id', name: 'Bo', block: true }
    ]);
  });

  it('uses the requested name for client_left notices and keeps generic notices for everyone else', () => {
    const toasts = [];
    OWP.ui.showToast = message => toasts.push(message);
    renderPeople({ participants: [participants[0]], participantCount: 1 });
    OWP.state.pendingModerations = [{ id: 'guest-id', name: 'Ana', block: false }];
    OWP._wsHandlers.handleClientLeft({ client: 'guest-id', payload: { participant_count: 1 } });
    OWP._wsHandlers.handleClientLeft({ client: 'someone-else', payload: { participant_count: 1 } });
    OWP.state.pendingModerations = [{ id: 'other-id', name: 'Bo', block: true }];
    OWP._wsHandlers.handleClientLeft({ client: 'other-id', payload: { participant_count: 1 } });
    assert.deepEqual(toasts, [
      'Ana was removed from the room',
      'A participant left the room',
      'Bo was blocked from this room'
    ]);
  });

  it('uses the latest moderation request for a participant who leaves', () => {
    const toasts = [];
    const sent = [];
    OWP.ui.showToast = message => toasts.push(message);
    renderPeople({ ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) } });

    OWP.actions.removeParticipant('guest-id', false);
    OWP.actions.removeParticipant('guest-id', true);
    assert.deepEqual(sent.map(message => message.payload), [
      { id: 'guest-id', block: false },
      { id: 'guest-id', block: true }
    ]);
    OWP._wsHandlers.handleClientLeft({ client: 'guest-id', payload: { participant_count: 2 } });

    assert.deepEqual(toasts, ['Ana was blocked from this room']);
    assert.equal(OWP.state.pendingModerations.some(request => request.id === 'guest-id'), false);
  });

  it('clears pending moderation on errors and resets a refused direct join to the lobby', () => {
    const toasts = [];
    OWP.ui.showToast = message => toasts.push(message);
    OWP.state.pendingModerations = [{ id: 'guest-id', name: 'Ana', block: true }];
    OWP._wsHandlers.handleError({ payload: { code: 'PARTICIPANT_NOT_FOUND', message: 'That participant is no longer in the room' } });
    assert.deepEqual(OWP.state.pendingModerations, []);
    assert.deepEqual(toasts, ['That person is no longer in the room']);

    OWP.actions.joinRoom('blocked-room');
    assert.equal(OWP.state.roomId, 'blocked-room');
    OWP._wsHandlers.handleError({ payload: { code: 'BLOCKED_FROM_ROOM', message: 'The host blocked you from this room' } });
    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.roomId, '');
    assert.equal(OWP.state.desiredRoomId, 'blocked-room');
    assert.equal(toasts.at(-1), 'The host blocked you from this room');
  });

  it('localizes removal reasons and gives only those room-closed notices the long duration', () => {
    const toasts = [];
    OWP.ui.showToast = (...args) => toasts.push(args);
    renderPeople();
    OWP._wsHandlers.handleRoomClosed({ payload: { reason: 'The host removed you from the room' } });
    renderPeople();
    OWP._wsHandlers.handleRoomClosed({ payload: { reason: 'Host closed the room' } });
    assert.deepEqual(toasts, [
      ['The host removed you from the room', { duration: 6000 }],
      ['Host closed the room']
    ]);
  });
});
