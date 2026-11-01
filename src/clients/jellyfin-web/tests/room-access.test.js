const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');
globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.utils.getVideo = () => ({ currentTime: 2 });
OWP.utils.getPlayingItemId = () => 'movie';
require('../ui/cards.js');
require('./load-panel-views.js');
require('../ws/send.js');
require('../ws/validation.js');
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');
const state = OWP.state;
const h = OWP._wsHandlers;
const msg = (type, payload) => ({ type, payload, room: 'room', ts: 1, server_ts: 1 });
let sent;
let toasts;
const render = () => {
  const panel = document.createElement('div');
  panel.id = OWP.constants.PANEL_ID;
  document.body.appendChild(panel);
  OWP.ui.render(true);
  return panel;
};

beforeEach(() => {
  globalThis.document = new FakeDocument();
  Object.assign(state, OWP.stateFactories.createState(), {
    serverFeatures: ['room_access'], connectionPhase: 'authenticated',
    ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) },
    rooms: [{ id: 'room', name: "Host's room", count: 1, media_id: 'movie', approval: true }]
  });
  sent = [];
  toasts = [];
  OWP.utils.getPlayingItemId = () => 'movie';
  OWP.utils.getVideo = () => ({ currentTime: 2 });
  for (const name of ['updateStatusIndicator', 'updateSyncIndicator', 'renderHomeWatchParties', 'updateLeaveConfirm', 'showToast', 'stopPlayerCapture']) OWP.ui[name] = () => {};
  OWP.ui.showToast = text => toasts.push(text);
  OWP.ui.buildSyncStatusIndicator = () => document.createElement('span');
});

describe('room access protocol', () => {
  it('validates all four messages strictly', () => {
    for (const [type, payload] of [
      ['room_access', { approval: true, unlisted: false }],
      ['join_requests', { requests: [{ id: 'id', name: 'Guest' }] }],
      ['join_pending', { host_name: 'Host' }],
      ['join_rejected', { reason: 'rejected', host_name: 'Host' }]
    ]) {
      assert.equal(OWP.wsValidation.validateMessage(msg(type, payload)).valid, true);
      assert.equal(OWP.wsValidation.validateMessage(msg(type, { ...payload, extra: true })).valid, false);
      assert.equal(OWP.wsValidation.validateMessage({ ...msg(type, payload), room: undefined }).valid, false);
    }
    for (const payload of [{ approval: true }, { approval: 1, unlisted: false }]) assert.equal(OWP.wsValidation.validateMessage(msg('room_access', payload)).valid, false);
    assert.equal(OWP.wsValidation.validateMessage(msg('join_requests', { requests: Array(21).fill({ id: 'id', name: 'Guest' }) })).valid, false);
    assert.equal(OWP.wsValidation.validateMessage(msg('join_rejected', { reason: 'other', host_name: 'Host' })).valid, false);
    for (const approval of [undefined, false, true]) {
      const room = { id: 'room', name: 'Room', count: 1, ...(approval === undefined ? {} : { approval }) };
      assert.equal(OWP.wsValidation.validateMessage({ type: 'room_list', payload: [room], ts: 1, server_ts: 1 }).valid, true);
    }
  });
  it('clears pending work on admission and room reset', () => {
    state.pendingJoin = { roomId: 'room', hostName: 'Host' };
    state.joinOutcome = { roomId: 'room', reason: 'rejected', hostName: 'Host' };
    state.clientId = 'host';
    state.createAccess = { approval: true, unlisted: true };
    h.handleRoomState({ ...msg('room_state', { name: 'Room', host_id: 'host', participant_count: 1, state: { position: 0, play_state: 'paused' } }), client: 'host' }, null);
    assert.equal(state.pendingJoin, null);
    assert.equal(state.joinOutcome, null);
    assert.deepEqual(state.createAccess, { approval: false, unlisted: false });
    h.handleRoomAccess(msg('room_access', { approval: true, unlisted: true }));
    h.handleJoinRequests(msg('join_requests', { requests: [{ id: 'id', name: 'Guest' }] }));
    assert.equal(state.roomAccess.approval, true);
    assert.equal(state.joinRequests.length, 1);
    OWP.actions.resetRoomState();
    assert.deepEqual(state.roomAccess, { approval: false, unlisted: false });
    assert.deepEqual(state.joinRequests, []);
  });

  it('keeps waiting until rejection, and cancels explicitly', () => {
    OWP.actions.joinRoom('room');
    assert.equal(state.pendingJoin.roomId, 'room');
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    assert.equal(state.pendingJoin.hostName, 'Host');
    h.handleJoinRejected(msg('join_rejected', { reason: 'rejected', host_name: 'Host' }));
    assert.equal(state.pendingJoin, null);
    assert.equal(state.joinOutcome.reason, 'rejected');
    OWP.actions.joinRoom('room');
    assert.equal(state.joinOutcome, null);
    OWP.actions.cancelJoin();
    assert.equal(sent.at(-1).type, 'cancel_join');
    assert.equal(state.pendingJoin, null);
  });
});

describe('access controls and requests', () => {
  it('shows creation switches only with media and negotiation and sends both settings', () => {
    render();
    const switches = document.querySelectorAll('[role="switch"]');
    assert.equal(switches.length, 2);
    switches[0].onclick();
    OWP.actions.createRoom();
    assert.deepEqual(sent.at(-1).payload.access, { approval: true, unlisted: false });
    state.serverFeatures = [];
    OWP.ui.render(true);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0);
    OWP.actions.createRoom();
    assert.equal(sent.at(-1).payload.access, undefined);
  });
  it('shows host switches, request rows, a card and a badge without counting requests', () => {
    Object.assign(state, { inRoom: true, isHost: true, roomId: 'room', participantCount: 1,
      participants: [{ name: 'Host', isHost: true }], joinRequests: [{ id: 'one', name: 'Guest' }, { id: 'two', name: 'Other' }] });
    render();
    assert.equal(document.querySelectorAll('[role="switch"]').length, 2);
    assert.equal(document.getElementById('owp-people-count').textContent, '1');
    assert.match(document.getElementById('owp-request-card').textContent, /and 1 more waiting/);
    assert.equal(document.getElementById('owp-request-badge').textContent, '2');
    document.querySelector('[role="switch"]').onclick();
    assert.deepEqual(sent.at(-1).payload, { approval: true, unlisted: false });
    document.getElementById('owp-btn-people').onclick();
    assert.equal(document.getElementById('owp-request-card'), null);
    const rows = document.getElementById('owp-participants-list').querySelectorAll('.owp-request-row');
    assert.equal(rows.length, 2);
    rows[0].querySelectorAll('button')[1].onclick();
    assert.deepEqual(sent.at(-1).payload, { id: 'one', admit: true });
    state.isHost = false;
    OWP.ui.render(true);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0);
  });
  it('renders waiting, cancel and each rejection in the list', () => {
    render();
    assert.match(document.getElementById('owp-room-list').textContent, /Approval needed/);
    OWP.actions.joinRoom('room');
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    assert.match(document.getElementById('owp-room-list').textContent, /Waiting for Host/);
    assert.equal(document.getElementById('owp-room-list').querySelector('button').textContent, 'Cancel');
    assert.ok(document.querySelector('.owp-access-spinner'));
    document.getElementById('owp-room-list').querySelector('.owp-room-item').onclick();
    assert.equal(sent.at(-1).type, 'cancel_join');
    for (const [reason, text] of [['rejected', "Host didn't let you in"], ['closed', 'The room was closed'], ['unavailable', "This room can't take requests right now"]]) {
      OWP.actions.joinRoom('room');
      h.handleJoinRejected(msg('join_rejected', { reason, host_name: 'Host' }));
      assert.ok(document.getElementById('owp-room-list').textContent.includes(text));
      assert.equal(document.getElementById('owp-room-list').querySelector('button').textContent, 'Ask to join');
      assert.ok(document.querySelector('.owp-join-error'));
    }
    const card = OWP.ui.createRoomCard(state.rooms[0], 0);
    assert.equal(card.querySelector('.owp-join-btn').title, 'Ask to join');
    assert.match(card.querySelector('.owp-card-approval').textContent, /Approval needed/);
  });
});


describe('approval room regressions', () => {
  it('preserves requests and outcomes when the current room sends room_state', () => {
    OWP.utils.getVideo = () => null;
    Object.assign(state, {
      inRoom: true, roomId: 'current', clientId: 'guest',
      pendingJoin: { roomId: 'requested', hostName: 'Host' },
      joinOutcome: { roomId: 'requested', reason: 'rejected', hostName: 'Host' }
    });
    const payload = { name: 'Current', host_id: 'host', participant_count: 1, state: { position: 0, play_state: 'paused' } };
    h.handleRoomState({ ...msg('room_state', payload), room: 'current' }, null);
    assert.deepEqual(state.pendingJoin, { roomId: 'requested', hostName: 'Host' });
    assert.deepEqual(state.joinOutcome, { roomId: 'requested', reason: 'rejected', hostName: 'Host' });
    h.handleRoomState({ ...msg('room_state', payload), room: 'requested' }, null);
    assert.equal(state.pendingJoin, null);
    assert.equal(state.joinOutcome, null);
  });

  it('refuses approval joins while in a room without changing membership or sending', () => {
    Object.assign(state, { inRoom: true, roomId: 'current', desiredRoomId: 'current' });
    OWP.actions.joinRoom('room');
    assert.deepEqual(sent, []);
    assert.deepEqual(toasts, ['Leave your room to ask to join another one']);
    assert.equal(state.roomId, 'current');
    assert.equal(state.desiredRoomId, 'current');
    assert.equal(state.pendingJoin, null);
  });

  it('also refuses the home card join while in a room', () => {
    Object.assign(state, { inRoom: true, roomId: 'current' });
    const card = OWP.ui.createRoomCard(state.rooms[0], 0);
    OWP.ui.showPanel = () => {};
    card.querySelector('.owp-join-btn').click();
    assert.deepEqual(sent, []);
    assert.deepEqual(toasts, ['Leave your room to ask to join another one']);
    assert.equal(state.pendingJoin, null);
  });
});

describe('access UI visibility and actions', () => {
  const hostState = () => Object.assign(state, {
    inRoom: true, isHost: true, roomId: 'room', participantCount: 1,
    participants: [{ name: 'Host', isHost: true }]
  });

  it('hides creation switches while Create is disabled and restores the choice when media returns', () => {
    OWP.utils.getPlayingItemId = () => '';
    render();
    assert.equal(document.getElementById('owp-btn-create').disabled, true);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0);
    OWP.utils.getPlayingItemId = () => 'movie';
    OWP.ui.updateCreateRoomButton();
    const controls = document.getElementById('owp-create-access');
    const switches = controls.querySelectorAll('[role="switch"]');
    assert.equal(switches.length, 2);
    assert.equal(switches[0].getAttribute('aria-label'), 'Ask to join');
    switches[1].onclick();
    assert.deepEqual(state.createAccess, { approval: false, unlisted: true });
    assert.deepEqual(sent, []);
    OWP.utils.getPlayingItemId = () => '';
    OWP.ui.updateCreateRoomButton();
    assert.equal(controls.hidden, true);
    OWP.utils.getPlayingItemId = () => 'movie';
    OWP.ui.updateCreateRoomButton();
    assert.equal(controls.hidden, false);
    assert.equal(switches[1].getAttribute('aria-checked'), 'true');
  });

  it('shows People switches only to a host with the feature', () => {
    hostState();
    state.joinRequests = [{ id: 'one', name: 'Guest' }];
    render();
    assert.equal(document.querySelectorAll('[role="switch"]').length, 2);
    state.serverFeatures = [];
    OWP.ui.render(true);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0);
    assert.equal(document.getElementById('owp-request-card'), null);
    assert.equal(document.querySelectorAll('.owp-request-row').length, 0);
    state.serverFeatures = ['room_access'];
    state.isHost = false;
    OWP.ui.render(true);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0);
  });

  it('sends both People settings and waits for the server to update their values', () => {
    hostState();
    state.roomAccess = { approval: true, unlisted: false };
    render();
    const switches = document.querySelectorAll('[role="switch"]');
    switches[1].onclick();
    assert.equal(sent.at(-1).type, 'set_room_access');
    assert.deepEqual(sent.at(-1).payload, { approval: true, unlisted: true });
    assert.equal(switches[1].getAttribute('aria-checked'), 'false');
    h.handleRoomAccess(msg('room_access', { approval: true, unlisted: true }));
    assert.equal(document.querySelectorAll('[role="switch"]')[1].getAttribute('aria-checked'), 'true');
  });

  it('counts only members and sends Reject and Let in for the selected request', () => {
    hostState();
    state.joinRequests = [{ id: 'one', name: 'Guest' }, { id: 'two', name: 'Other' }];
    state.roomBarSection = 'people';
    render();
    assert.equal(document.getElementById('owp-people-count').textContent, '1');
    const rows = document.getElementById('owp-participants-list').querySelectorAll('.owp-request-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /GuestWants to join/);
    rows[0].querySelectorAll('button')[0].onclick();
    assert.equal(sent.at(-1).type, 'answer_join');
    assert.deepEqual(sent.at(-1).payload, { id: 'one', admit: false });
    rows[1].querySelectorAll('button')[1].onclick();
    assert.deepEqual(sent.at(-1).payload, { id: 'two', admit: true });
  });

  it('shows card and badge only while People is closed, with singular and plural waiting counts', () => {
    hostState();
    render();
    assert.equal(document.getElementById('owp-request-card'), null);
    assert.equal(document.getElementById('owp-request-badge'), null);
    state.joinRequests = [{ id: 'one', name: 'Guest' }];
    OWP.ui.updateAccessUI();
    assert.equal(document.getElementById('owp-request-badge').getAttribute('aria-label'), '1 waiting to join');
    assert.doesNotMatch(document.getElementById('owp-request-card').textContent, /more waiting/);
    for (let index = 2; index <= 3; index++) {
      state.joinRequests.push({ id: String(index), name: `Guest ${index}` });
      OWP.ui.updateAccessUI();
      assert.match(document.getElementById('owp-request-card').textContent, new RegExp(`and ${index - 1} more waiting`));
    }
    document.getElementById('owp-request-card').querySelectorAll('button')[0].onclick();
    assert.deepEqual(sent.at(-1).payload, { id: 'one', admit: false });
    document.getElementById('owp-btn-people').onclick();
    assert.equal(document.getElementById('owp-request-card'), null);
    assert.equal(document.getElementById('owp-request-badge'), null);
    document.getElementById('owp-btn-people').onclick();
    assert.ok(document.getElementById('owp-request-card'));
    state.isHost = false;
    OWP.ui.updateAccessUI();
    assert.equal(document.getElementById('owp-request-card'), null);
    assert.equal(document.getElementById('owp-request-badge'), null);
  });

  it('distinguishes public and approval list buttons and home card labels', () => {
    render();
    const item = document.getElementById('owp-room-list').querySelector('.owp-room-item');
    assert.equal(item.querySelector('button').textContent, 'Ask to join');
    assert.equal(item.querySelector('.material-icons').textContent, 'lock');
    assert.match(item.textContent, /1 user · Approval needed/);
    const approval = OWP.ui.createRoomCard(state.rooms[0], 0);
    assert.equal(approval.querySelector('.owp-join-btn').getAttribute('aria-label'), 'Ask to join');
    assert.equal(approval.querySelector('.owp-card-approval .material-icons').textContent, 'lock');
    state.rooms[0].approval = false;
    OWP.ui.updateRoomListUI();
    assert.equal(document.getElementById('owp-room-list').querySelector('button').textContent, 'Join');
    const publicCard = OWP.ui.createRoomCard(state.rooms[0], 0);
    assert.equal(publicCard.querySelector('.owp-card-approval'), null);
    assert.equal(publicCard.querySelector('.owp-join-btn').title, 'Join');
    assert.equal(publicCard.querySelector('.owp-join-btn').getAttribute('aria-label'), 'Join');
  });
});


describe('waiting request lifecycle', () => {
  it('ignores pending and rejected replies after cancellation and for another target', () => {
    OWP.actions.joinRoom('room');
    assert.equal(state.joinTarget, 'room');
    OWP.actions.cancelJoin();
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    h.handleJoinRejected(msg('join_rejected', { reason: 'rejected', host_name: 'Host' }));
    assert.equal(state.joinTarget, '');
    assert.equal(state.pendingJoin, null);
    assert.equal(state.joinOutcome, null);
    OWP.actions.joinRoom('room');
    OWP.actions.joinRoom('other');
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    h.handleJoinRejected(msg('join_rejected', { reason: 'closed', host_name: 'Host' }));
    assert.equal(state.joinTarget, 'other');
    assert.equal(state.pendingJoin, null);
    assert.equal(state.joinOutcome, null);
  });

  it('clears the reply target on admission, rejection and room reset', () => {
    OWP.utils.getVideo = () => null;
    OWP.actions.joinRoom('room');
    h.handleRoomState({ ...msg('room_state', { name: 'Room', host_id: 'host', participant_count: 1, state: { position: 0, play_state: 'paused' } }), client: 'guest' }, null);
    assert.equal(state.joinTarget, '');
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    assert.equal(state.pendingJoin, null);
    OWP.actions.resetRoomState();
    OWP.actions.joinRoom('room');
    h.handleJoinRejected(msg('join_rejected', { reason: 'rejected', host_name: 'Host' }));
    assert.equal(state.joinTarget, '');
    const outcome = { ...state.joinOutcome };
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    assert.equal(state.pendingJoin, null);
    assert.deepEqual(state.joinOutcome, outcome);
    OWP.actions.joinRoom('room');
    OWP.actions.resetRoomState();
    assert.equal(state.joinTarget, '');
  });

  it('keeps a hidden waiting room at the top with its name and Cancel button', () => {
    render();
    OWP.actions.joinRoom('room');
    const other = { id: 'other', name: 'Another room', count: 1, media_id: 'movie' };
    h.handleRoomList({ payload: [other] });
    h.handleJoinPending(msg('join_pending', { host_name: 'Host' }));
    const list = document.getElementById('owp-room-list');
    const rows = list.querySelectorAll('.owp-room-item');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('.owp-room-title').textContent, OWP.i18n.localizeRoomName("Host's room"));
    assert.match(rows[0].textContent, /Waiting for Host/);
    assert.equal(rows[0].querySelector('button').textContent, 'Cancel');
    assert.equal(state.pendingJoin.roomName, "Host's room");
    // Reappearing in the public list must not duplicate the retained row.
    h.handleRoomList({ payload: [other, { id: 'room', name: "Host's room", count: 1, approval: true }] });
    assert.equal(list.querySelectorAll('.owp-room-item').length, 2);
    h.handleRoomList({ payload: [other] });
    list.querySelector('.owp-room-item').onclick();
    assert.equal(sent.at(-1).type, 'cancel_join');
    assert.equal(list.querySelectorAll('.owp-room-item').length, 1);
    assert.match(list.textContent, /Another room/);
  });

  it('retains hidden rejection outcomes and lets the guest retry without playing media', () => {
    OWP.utils.getPlayingItemId = () => '';
    render();
    const list = document.getElementById('owp-room-list');
    for (const [reason, text] of [['rejected', "Host didn't let you in"], ['closed', 'The room was closed'], ['unavailable', "This room can't take requests right now"]]) {
      OWP.actions.joinRoom('room');
      h.handleRoomList({ payload: [] });
      h.handleJoinRejected(msg('join_rejected', { reason, host_name: 'Host' }));
      h.handleRoomList({ payload: [] });
      assert.equal(state.joinOutcome.roomName, "Host's room");
      assert.equal(list.querySelectorAll('.owp-room-item').length, 1);
      assert.ok(list.textContent.includes(text));
      assert.equal(list.querySelector('button').textContent, 'Ask to join');
      list.querySelector('.owp-room-item').onclick();
      assert.equal(sent.at(-1).type, 'join_room');
      assert.equal(sent.at(-1).room, 'room');
      assert.equal(state.pendingJoin.roomName, "Host's room");
      assert.equal(state.joinOutcome, null);
      assert.match(list.textContent, /Waiting for Host/);
    }
    OWP.actions.cancelJoin();
    assert.equal(list.querySelectorAll('.owp-room-item').length, 0);
    assert.match(list.textContent, /No active rooms/);
  });
});
