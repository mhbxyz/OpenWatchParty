const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('../ui/render.js');
require('../ws/handlers/room.js');
require('../ws/send.js');
const realRoomActions = {
  leaveRoom: OWP.actions.leaveRoom,
  closeRoom: OWP.actions.closeRoom
};
OWP.actions = { schedulePing: () => {} };
require('../ws/handlers/clock.js');

const { PANEL_ID, ROOM_MODE_CLASS } = OWP.constants;
const realStopPlayerCapture = OWP.ui.stopPlayerCapture;
const updateRoomListUI = OWP.ui.updateRoomListUI;
let focused = null;
Object.getPrototypeOf(document.createElement('div')).focus = function focus() {
  focused = this;
};
Object.getPrototypeOf(document.createElement('div')).blur = function blur() {
  if (focused === this) focused = null;
};
// The element the focus stubs above last focused.
Object.defineProperty(FakeDocument.prototype, 'activeElement', { configurable: true, get: () => focused });
const byId = id => document.getElementById(id);
const panel = () => byId(PANEL_ID);
const expanded = id => byId(id).getAttribute('aria-expanded');
const openSections = () => ['owp-people-section', 'owp-chat-section', 'owp-leave-confirm']
  .filter(id => byId(id) && !byId(id).hidden);

let left;
let chatToasts;

const renderRoom = (overrides = {}) => {
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-1',
    roomName: "FrancoTosky's room",
    clientId: 'client-a5be',
    isHost: false,
    participantCount: 2,
    participants: [{ name: 'FrancoTosky', isHost: true }, { name: 'Ana', isHost: false }],
    serverFeatures: [],
    syncStatus: 'synced',
    ...overrides
  });
  OWP.ui.render(true);
};

describe('room bar', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const element = document.createElement('div');
    element.id = PANEL_ID;
    document.body.appendChild(element);
    left = 0;
    chatToasts = [];
    OWP.timers.setTimeout = () => 1;
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.ui.showChatToast = (username, text) => chatToasts.push(`${username}: ${text}`);
    OWP.actions = {
      leaveRoom: () => { left++; },
      closeRoom: () => { left++; }
    };
    OWP.chat.messages = [];
    OWP.chat.unreadCount = 0;
    OWP.state.roomBarSection = '';
  });

  it('shows the sync dot, latency, room name and buttons in that order', () => {
    renderRoom();
    const bar = panel().querySelector('.owp-room-bar');
    const ids = bar.children.map(child => child.id || child.className.split(' ')[0]);
    assert.deepEqual(ids, [
      'owp-sync-indicator',
      'owp-latency',
      'owp-room-name',
      'owp-btn-people',
      'owp-btn-chat',
      'owp-btn-leave',
      'owp-close-btn'
    ]);
    assert.equal(bar.querySelector('.owp-room-name').textContent, "FrancoTosky's room");
    assert.equal(bar.querySelector('.owp-room-name').title, "FrancoTosky's room");
    assert.equal(byId('owp-people-count').textContent, '2');
    assert.ok(panel().classList.contains(ROOM_MODE_CLASS));
    // Outline SVG icons, not Jellyfin's filled Material icons.
    assert.ok(byId('owp-btn-people').querySelector('.owp-icon-users'));
    assert.ok(byId('owp-btn-people').querySelector('.owp-expand'));
    assert.ok(byId('owp-btn-chat').querySelector('.owp-icon-chat'));
    assert.ok(byId('owp-btn-leave').querySelector('.owp-icon-logout'));
    assert.ok(bar.querySelector('.owp-close-btn .owp-icon-x'));
    assert.ok(byId('owp-chat-send').querySelector('.owp-icon-send'));
    assert.equal(bar.querySelector('.material-icons'), null);
  });

  it('starts with every drop-down closed', () => {
    renderRoom();
    assert.equal(byId('owp-room-drop').hidden, true);
    assert.deepEqual(openSections(), []);
    assert.equal(expanded('owp-btn-people'), 'false');
    assert.equal(expanded('owp-btn-chat'), 'false');
  });

  it('opens one drop-down at a time and closes it from the same button', () => {
    renderRoom();
    byId('owp-btn-people').click();
    assert.equal(byId('owp-room-drop').hidden, false);
    assert.deepEqual(openSections(), ['owp-people-section']);
    assert.equal(expanded('owp-btn-people'), 'true');

    byId('owp-btn-chat').click();
    assert.deepEqual(openSections(), ['owp-chat-section']);
    assert.equal(expanded('owp-btn-people'), 'false');
    assert.equal(expanded('owp-btn-chat'), 'true');

    byId('owp-btn-chat').click();
    assert.equal(byId('owp-room-drop').hidden, true);
    assert.deepEqual(openSections(), []);
  });

  it('keeps the open drop-down when the panel is drawn again', () => {
    renderRoom();
    byId('owp-btn-people').click();
    OWP.ui.render(true);
    assert.deepEqual(openSections(), ['owp-people-section']);
  });

  it('counts chat messages as unread, with a toast, while the chat is closed', () => {
    renderRoom();
    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'pause' }, server_ts: 1 });
    assert.equal(OWP.chat.unreadCount, 1);
    assert.equal(byId('owp-chat-badge').textContent, '1');
    assert.equal(byId('owp-chat-badge').style.display, 'inline-block');
    assert.deepEqual(chatToasts, ['Ana: pause']);

    byId('owp-btn-chat').click();
    assert.equal(OWP.chat.unreadCount, 0);
    assert.equal(byId('owp-chat-badge').style.display, 'none');
    assert.equal(OWP.chat.isChatVisible(), true);

    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'back' }, server_ts: 2 });
    assert.equal(OWP.chat.unreadCount, 0);
    assert.equal(chatToasts.length, 1);
    assert.equal(byId('owp-chat-messages').children.length, 2);
    // One line per message: the time moves to the tooltip.
    assert.match(String(byId('owp-chat-messages').children[0].title), /\d/);
  });

  it('does not count your own messages as unread', () => {
    renderRoom();
    OWP.chat.receive({ client: 'client-a5be', payload: { username: 'FrancoTosky', text: 'sent' }, server_ts: 1 });
    assert.equal(OWP.chat.unreadCount, 0);
    assert.equal(byId('owp-chat-badge').style.display, 'none');
    assert.deepEqual(chatToasts, []);
    assert.equal(byId('owp-chat-messages').children.length, 1);
  });

  it('keeps unread messages unread when the panel is drawn with the chat closed', () => {
    renderRoom();
    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'pause' }, server_ts: 1 });
    OWP.ui.render(true);
    assert.equal(OWP.chat.unreadCount, 1);
    assert.equal(byId('owp-chat-badge').textContent, '1');
    assert.equal(byId('owp-chat-messages').children.length, 1);
  });

  it('keeps chat content, draft and scroll intent across a full room draw', () => {
    renderRoom();
    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'pause' }, server_ts: 1 });
    const originalMessages = byId('owp-chat-messages');
    const oldMessage = originalMessages.children[0];
    originalMessages.scrollTop = 20;
    originalMessages.clientHeight = 100;
    originalMessages.scrollHeight = 500;
    byId('owp-chat-input').value = 'still typing';

    OWP.ui.render(true);

    const scrolledUpMessages = byId('owp-chat-messages');
    assert.equal(scrolledUpMessages.children[0], oldMessage);
    assert.equal(byId('owp-chat-input').value, 'still typing');
    assert.equal(scrolledUpMessages.scrollTop, 20);

    scrolledUpMessages.scrollTop = 400;
    scrolledUpMessages.clientHeight = 100;
    scrolledUpMessages.scrollHeight = 500;
    OWP.ui.render(true);

    const bottomMessages = byId('owp-chat-messages');
    assert.equal(bottomMessages.children[0], oldMessage);
    assert.equal(Object.hasOwn(bottomMessages, 'scrollTop'), true);
    assert.equal(bottomMessages.scrollTop, bottomMessages.scrollHeight);
  });

  it('does not mark the chat read while the panel is hidden', () => {
    renderRoom();
    byId('owp-btn-chat').click();
    panel().classList.add('hide');
    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'pause' }, server_ts: 1 });
    assert.equal(OWP.chat.unreadCount, 1);

    OWP.ui.render(true);
    assert.equal(OWP.chat.unreadCount, 1);
    assert.equal(byId('owp-chat-badge').textContent, '1');

    panel().classList.remove('hide');
    OWP.ui.render(true);
    assert.equal(OWP.chat.unreadCount, 0);
  });

  it('names the participant count and unread messages on the icon buttons', () => {
    renderRoom();
    assert.equal(byId('owp-btn-people').getAttribute('aria-label'), 'Participants, 2');
    assert.equal(byId('owp-btn-chat').getAttribute('aria-label'), 'Chat');

    OWP.state.participants = [{ name: 'FrancoTosky', isHost: true }];
    OWP.ui.updateParticipantList();
    assert.equal(byId('owp-btn-people').getAttribute('aria-label'), 'Participants, 1');

    OWP.chat.receive({ client: 'client-other', payload: { username: 'Ana', text: 'pause' }, server_ts: 1 });
    assert.equal(byId('owp-btn-chat').getAttribute('aria-label'), 'Chat, 1 unread');
    byId('owp-btn-chat').click();
    assert.equal(byId('owp-btn-chat').getAttribute('aria-label'), 'Chat');
  });

  it('keeps the last measured latency when the bar is drawn again', () => {
    OWP.state.lastRttMs = null;
    renderRoom();
    assert.equal(panel().querySelector('.owp-latency').textContent, '-');

    OWP._wsHandlers.handlePong({ payload: { client_ts: OWP.utils.nowMs() - 12 } });
    assert.equal(OWP.state.lastRttMs >= 12, true);
    const shown = panel().querySelector('.owp-latency').textContent;
    assert.equal(shown, `${OWP.state.lastRttMs} ms`);

    OWP.ui.render(true);
    assert.equal(panel().querySelector('.owp-latency').textContent, shown);
    OWP.state.lastRttMs = null;
  });

  it('offers the host an invite button that requests a link', () => {
    let invites = 0;
    OWP.actions.copyInviteLink = () => { invites++; };

    renderRoom({ isHost: true, clientId: 'client-host' });

    const invite = byId('owp-btn-invite');
    assert.equal(invite.getAttribute('aria-label'), 'Invite');
    assert.ok(invite.querySelector('.owp-icon-share'));
    invite.click();
    assert.equal(invites, 1);
  });

  it('does not offer an invite button to guests', () => {
    renderRoom({ isHost: false });

    assert.equal(byId('owp-btn-invite'), null);
  });

  it('only offers Close room when the host is alone', () => {
    renderRoom({
      isHost: true,
      serverFeatures: ['host_transfer'],
      participantCount: 1,
      participants: [{ name: 'FrancoTosky', isHost: true }]
    });

    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Close room');
    assert.equal(byId('owp-btn-leave').title, 'Close room');
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Close the room for everyone?');
    assert.deepEqual(
      byId('owp-leave-confirm').querySelectorAll('button').map(button => button.textContent),
      ['Cancel', 'Close room']
    );
    assert.equal(panel().querySelector('.owp-leave-hint'), null);
  });

  it('offers Leave and Close for everyone when host transfer is available', () => {
    renderRoom({
      isHost: true,
      serverFeatures: ['host_transfer'],
      participants: [
        { name: 'FrancoTosky', isHost: true },
        { name: 'Ana', isHost: false },
        { name: 'Bo', isHost: false }
      ]
    });

    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Leave room');
    assert.equal(byId('owp-btn-leave').title, 'Leave room');
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Leave the room?');
    const buttons = byId('owp-leave-confirm').querySelectorAll('button');
    assert.deepEqual(buttons.map(button => button.textContent), ['Cancel', 'Leave', 'Close for everyone']);
    assert.equal(buttons[0].className, 'owp-pill-btn secondary');
    assert.equal(buttons[1].className, 'owp-pill-btn secondary');
    assert.equal(buttons[2].className, 'owp-pill-btn danger');
    assert.equal(
      panel().querySelector('.owp-leave-hint').textContent,
      'If you leave, Ana becomes the host and the room stays open.'
    );
  });

  it('keeps the close-only host confirmation without host_transfer', () => {
    renderRoom({
      isHost: true,
      serverFeatures: [],
      participants: [
        { name: 'FrancoTosky', isHost: true },
        { name: 'Ana', isHost: false }
      ]
    });

    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Close room');
    assert.deepEqual(
      byId('owp-leave-confirm').querySelectorAll('button').map(button => button.textContent),
      ['Cancel', 'Close room']
    );
  });

  it('dispatches host Leave and Close for everyone through separate buttons', () => {
    let leaves = 0;
    let closes = 0;
    OWP.actions.leaveRoom = () => { leaves++; };
    OWP.actions.closeRoom = () => { closes++; };
    renderRoom({
      isHost: true,
      serverFeatures: ['host_transfer'],
      participants: [
        { name: 'FrancoTosky', isHost: true },
        { name: 'Ana', isHost: false }
      ]
    });

    byId('owp-btn-leave-room').click();
    assert.equal(leaves, 1);
    assert.equal(closes, 0);
    byId('owp-btn-confirm-leave').click();
    assert.equal(leaves, 1);
    assert.equal(closes, 1);
  });

  it('sends leave_room and close_room through the rendered host choices', () => {
    const sent = [];
    OWP.actions = { ...realRoomActions };
    OWP.state.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
    const hostRoom = {
      isHost: true,
      serverFeatures: ['host_transfer'],
      participants: [
        { name: 'FrancoTosky', isHost: true },
        { name: 'Ana', isHost: false }
      ]
    };

    renderRoom(hostRoom);
    byId('owp-btn-leave-room').click();
    assert.equal(sent[0].type, 'leave_room');

    renderRoom(hostRoom);
    byId('owp-btn-confirm-leave').click();
    assert.equal(sent[1].type, 'close_room');
  });

  it('updates host leave choices and focus as participants change', () => {
    renderRoom({
      isHost: true,
      serverFeatures: ['host_transfer'],
      participantCount: 1,
      participants: [{ name: 'FrancoTosky', isHost: true }]
    });
    byId('owp-btn-leave').click();
    const confirm = byId('owp-leave-confirm');

    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [
        { name: 'FrancoTosky', is_host: true },
        { name: 'Ana', is_host: false },
        { name: 'Bo', is_host: false }
      ] }
    });
    assert.equal(byId('owp-leave-confirm'), confirm);
    assert.equal(panel().querySelector('.owp-leave-hint').textContent.includes('Ana becomes the host'), true);

    byId('owp-btn-leave-room').focus();
    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [
        { name: 'FrancoTosky', is_host: true },
        { name: 'Bo', is_host: false }
      ] }
    });
    assert.equal(panel().querySelector('.owp-leave-hint').textContent.includes('Bo becomes the host'), true);
    assert.equal(focused, byId('owp-btn-leave-room'));

    byId('owp-btn-leave-room').focus();
    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [{ name: 'FrancoTosky', is_host: true }] }
    });
    assert.equal(byId('owp-btn-leave-room'), null);
    assert.equal(focused, byId('owp-btn-cancel-leave'));
    assert.deepEqual(openSections(), ['owp-leave-confirm']);
  });

  it('moves focus to Cancel when promotion changes Leave into a close action', () => {
    renderRoom({
      isHost: false,
      serverFeatures: ['host_transfer'],
      participantCount: 3,
      participants: [
        { name: 'Old Host', isHost: true },
        { name: 'FrancoTosky', isHost: false },
        { name: 'Ana', isHost: false }
      ]
    });
    byId('owp-btn-leave').click();
    const guestLeave = byId('owp-btn-confirm-leave');
    assert.equal(guestLeave.dataset.action, 'leave');
    guestLeave.focus();

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-a5be', host_name: 'FrancoTosky' }
    });

    const closeForEveryone = byId('owp-btn-confirm-leave');
    assert.equal(closeForEveryone.dataset.action, 'close');
    assert.equal(closeForEveryone.textContent, 'Close for everyone');
    assert.equal(focused, byId('owp-btn-cancel-leave'));
    assert.notEqual(focused, closeForEveryone);
  });

  it('keeps focus when a rebuilt leave choice retains the same action', () => {
    renderRoom({
      isHost: true,
      serverFeatures: ['host_transfer'],
      participantCount: 1,
      participants: [{ name: 'FrancoTosky', isHost: true }]
    });
    byId('owp-btn-leave').click();
    const closeRoom = byId('owp-btn-confirm-leave');
    assert.equal(closeRoom.dataset.action, 'close');
    closeRoom.focus();

    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [
        { name: 'FrancoTosky', is_host: true },
        { name: 'Ana', is_host: false }
      ] }
    });

    const closeForEveryone = byId('owp-btn-confirm-leave');
    assert.equal(closeForEveryone.dataset.action, 'close');
    assert.equal(closeForEveryone.textContent, 'Close for everyone');
    assert.equal(focused, closeForEveryone);
  });

  it('updates a promoted host without redrawing the room bar', () => {
    renderRoom({
      isHost: false,
      serverFeatures: ['host_transfer'],
      participantCount: 3,
      participants: [
        { name: 'Old Host', isHost: true },
        { name: 'FrancoTosky', isHost: false },
        { name: 'Ana', isHost: false }
      ]
    });
    const bar = panel().querySelector('.owp-room-bar');

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-a5be', host_name: 'FrancoTosky' }
    });

    assert.equal(panel().querySelector('.owp-room-bar'), bar);
    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Leave room');
    assert.ok(byId('owp-btn-invite'));
    assert.deepEqual(OWP.state.participants, [
      { name: 'Old Host', isHost: true },
      { name: 'FrancoTosky', isHost: false },
      { name: 'Ana', isHost: false }
    ]);

    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [
        { name: 'FrancoTosky', is_host: true },
        { name: 'Ana', is_host: false }
      ] }
    });

    assert.equal(panel().querySelector('.owp-leave-hint').textContent.includes('Ana becomes the host'), true);
  });

  it('does not guess the promoted participant when names are duplicated', () => {
    const announcedParticipants = [
      { name: 'Alex', isHost: true },
      { name: 'Alex', isHost: false },
      { name: 'Bo', isHost: false }
    ];
    renderRoom({
      isHost: false,
      serverFeatures: ['host_transfer'],
      participantCount: 3,
      participants: announcedParticipants
    });

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-a5be', host_name: 'Alex' }
    });

    assert.equal(OWP.state.isHost, true);
    assert.deepEqual(OWP.state.participants, announcedParticipants);

    OWP._wsHandlers.handleParticipantList({
      room: 'room-1',
      payload: { participants: [
        { name: 'Alex', is_host: true },
        { name: 'Bo', is_host: false }
      ] }
    });
    assert.deepEqual(OWP.state.participants, [
      { name: 'Alex', isHost: true, status: null },
      { name: 'Bo', isHost: false, status: null }
    ]);
    assert.equal(panel().querySelector('.owp-leave-hint').textContent.includes('Bo becomes the host'), true);
  });

  it('keeps guest leave controls and Escape behavior unchanged', () => {
    renderRoom({ isHost: false, serverFeatures: ['host_transfer'] });
    assert.deepEqual(
      byId('owp-leave-confirm').querySelectorAll('button').map(button => button.textContent),
      ['Cancel', 'Leave']
    );
    byId('owp-btn-leave').click();
    byId('owp-btn-confirm-leave').focus();
    byId('owp-btn-confirm-leave').dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault() {}
    });
    assert.deepEqual(openSections(), []);
    assert.equal(focused, byId('owp-btn-leave'));
  });

  it('redraws host controls when this client is promoted', () => {
    renderRoom();

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-a5be', host_name: 'FrancoTosky' }
    });

    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Close room');
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Close the room for everyone?');
    assert.equal(byId('owp-btn-confirm-leave').textContent, 'Close room');
    assert.ok(byId('owp-btn-invite'));
  });

  it('keeps guest controls when another participant becomes host', () => {
    renderRoom();

    OWP._wsHandlers.handleHostChanged({
      room: 'room-1',
      payload: { host_id: 'client-other', host_name: 'Ana' }
    });

    assert.equal(byId('owp-btn-leave').getAttribute('aria-label'), 'Leave room');
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Leave the room?');
    assert.equal(byId('owp-btn-confirm-leave').textContent, 'Leave');
    assert.equal(byId('owp-btn-invite'), null);
  });

  it('asks a guest before leaving the room', () => {
    renderRoom();
    const leave = byId('owp-btn-leave');
    assert.equal(leave.getAttribute('aria-label'), 'Leave room');
    assert.equal(leave.getAttribute('aria-controls'), 'owp-leave-confirm');
    leave.click();
    assert.equal(left, 0);
    assert.deepEqual(openSections(), ['owp-leave-confirm']);
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Leave the room?');
    assert.equal(byId('owp-btn-confirm-leave').textContent, 'Leave');

    focused = null;
    panel().querySelector('.owp-leave-confirm .secondary').click();
    assert.deepEqual(openSections(), []);
    assert.equal(left, 0);
    assert.equal(focused, leave);

    leave.click();
    byId('owp-btn-confirm-leave').click();
    assert.equal(left, 1);
  });

  it('asks the host before closing the room for everyone', () => {
    renderRoom({ isHost: true, clientId: 'client-host' });
    const leave = byId('owp-btn-leave');
    assert.equal(leave.getAttribute('aria-label'), 'Close room');
    leave.click();
    assert.equal(left, 0);
    assert.deepEqual(openSections(), ['owp-leave-confirm']);
    assert.equal(expanded('owp-btn-leave'), 'true');
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Close the room for everyone?');

    focused = null;
    panel().querySelector('.owp-leave-confirm .secondary').click();
    assert.deepEqual(openSections(), []);
    assert.equal(left, 0);
    // Focus does not stay on the hidden Cancel button.
    assert.equal(focused, leave);

    leave.click();
    assert.equal(byId('owp-btn-confirm-leave').textContent, 'Close room');
    byId('owp-btn-confirm-leave').click();
    assert.equal(left, 1);
  });

  it('dispatches the rendered confirmation to the current role action', () => {
    let closes = 0;
    let leaves = 0;
    OWP.actions = {
      closeRoom: () => { closes++; },
      leaveRoom: () => { leaves++; }
    };

    renderRoom({ isHost: true });
    byId('owp-btn-leave').click();
    byId('owp-btn-confirm-leave').click();
    assert.equal(closes, 1);
    assert.equal(leaves, 0);

    OWP.state.roomBarSection = '';
    renderRoom({ isHost: false });
    byId('owp-btn-leave').click();
    byId('owp-btn-confirm-leave').click();
    assert.equal(closes, 1);
    assert.equal(leaves, 1);
  });

  it('words a reopened confirmation for the current role', () => {
    OWP.state.roomBarSection = 'leave';
    renderRoom({ isHost: true });
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Close the room for everyone?');
    renderRoom({ isHost: false });
    assert.deepEqual(openSections(), ['owp-leave-confirm']);
    assert.equal(panel().querySelector('.owp-leave-question').textContent, 'Leave the room?');
  });

  it('leaves focus on the button when a drop-down opens', () => {
    renderRoom();
    focused = null;
    byId('owp-btn-people').click();
    byId('owp-btn-chat').click();
    assert.deepEqual(openSections(), ['owp-chat-section']);
    assert.equal(focused, null);
  });

  it('closes the open drop-down with Escape and goes back to its button', () => {
    renderRoom();
    byId('owp-btn-people').click();
    let prevented = false;
    byId('owp-participants-list').dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
    assert.deepEqual(openSections(), []);
    assert.equal(expanded('owp-btn-people'), 'false');
    assert.equal(focused, byId('owp-btn-people'));
    assert.equal(prevented, true);

    // From a bar button too.
    byId('owp-btn-leave').click();
    byId('owp-btn-chat').dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.deepEqual(openSections(), []);
    assert.equal(focused, byId('owp-btn-leave'));
  });

  it('closes the chat with Escape from its input, which stops key events', () => {
    OWP.ui.stopPlayerCapture = realStopPlayerCapture;
    renderRoom();
    byId('owp-btn-chat').click();
    byId('owp-chat-input').dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.deepEqual(openSections(), []);
    assert.equal(focused, byId('owp-btn-chat'));
  });

  it('leaves Escape alone when no drop-down is open', () => {
    renderRoom();
    focused = null;
    let prevented = false;
    byId('owp-btn-people').dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(focused, null);
  });

  it('puts keyboard focus on the first control of the room list, before its close button', () => {
    OWP.state.inRoom = false;
    OWP.ui.render(true);
    // Create Room is enabled while something plays.
    byId('owp-btn-create').disabled = false;

    focused = null;
    OWP.ui.focusPanelStart(panel());

    assert.equal(focused, byId('owp-btn-create'));
    assert.equal(panel().querySelector('.owp-close-btn') !== focused, true);
  });

  it('falls back to the close button when nothing else can take focus', () => {
    OWP.state.inRoom = false;
    OWP.ui.render(true);
    byId('owp-btn-create').disabled = true;

    focused = null;
    OWP.ui.focusPanelStart(panel());

    assert.equal(focused, panel().querySelector('.owp-close-btn'));
  });

  it('keeps keyboard focus on a control that is drawn again', () => {
    renderRoom();
    byId('owp-chat-input').focus();
    OWP.ui.render(true);
    assert.equal(focused, byId('owp-chat-input'));
  });

  it('keeps keyboard focus in the panel when Create Room turns the lobby into the room bar', () => {
    OWP.state.inRoom = false;
    OWP.ui.render(true);
    byId('owp-btn-create').focus();

    renderRoom();

    assert.equal(focused, byId('owp-btn-people'));
  });

  it('does not take focus when it was outside the panel', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    renderRoom();
    assert.equal(focused, outside);
  });

  it('moves keyboard focus out of the panel it hides', () => {
    const opener = document.createElement('button');
    opener.id = 'owp-test-opener';
    opener.getClientRects = () => [{}];
    document.body.appendChild(opener);
    renderRoom();
    panel().dataset.opener = opener.id;

    byId('owp-btn-people').focus();
    OWP.ui.hidePanel();
    assert.ok(panel().classList.contains('hide'));
    assert.equal(focused, opener);

    // Without a shown opener, focus just leaves the panel.
    panel().classList.remove('hide');
    opener.getClientRects = () => [];
    byId('owp-btn-people').focus();
    OWP.ui.hidePanel();
    assert.equal(focused, null);

    // Focus outside the panel is left alone.
    panel().classList.remove('hide');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    OWP.ui.hidePanel();
    assert.equal(focused, outside);
  });

  describe('room list updates with keyboard focus on a Join button', () => {
    const room = (id, count = 1) => ({ id, name: `${id}'s room`, count, media_id: 'media' });
    const joinFor = id => byId('owp-room-list').querySelectorAll('button').find(button => button.dataset.roomId === id);
    const lobbyWith = (rooms) => {
      OWP.state.inRoom = false;
      OWP.state.rooms = rooms;
      OWP.ui.render(true);
      updateRoomListUI();
    };

    it('keeps focus on the same room when the list is drawn again', () => {
      lobbyWith([room('ana'), room('bo')]);
      joinFor('bo').focus();

      OWP.state.rooms = [room('ana'), room('bo', 2), room('cy')];
      updateRoomListUI();

      assert.equal(focused, joinFor('bo'));
      assert.equal(focused.parentNode.querySelector('.owp-room-count').textContent, '2 users');
    });

    it('moves focus to the first control once the focused room is gone', () => {
      lobbyWith([room('ana'), room('bo')]);
      joinFor('bo').focus();

      OWP.state.rooms = [room('ana')];
      updateRoomListUI();
      assert.equal(focused, joinFor('ana'));

      OWP.state.rooms = [];
      updateRoomListUI();
      assert.ok(panel().contains(focused));
      assert.equal(focused, panel().querySelector('.owp-close-btn'));
    });

    it('leaves focus alone when it is outside the list', () => {
      lobbyWith([room('ana')]);
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();

      OWP.state.rooms = [room('ana', 3)];
      updateRoomListUI();

      assert.equal(focused, outside);
    });
  });

  it('updates the people count with the names and with count updates', () => {
    renderRoom({ participants: [] });
    assert.equal(byId('owp-people-count').textContent, '2');
    OWP.state.participants = [{ name: 'FrancoTosky', isHost: true }];
    OWP.ui.updateParticipantList();
    assert.equal(byId('owp-people-count').textContent, '1');
    assert.equal(byId('owp-participants-list').querySelector('.owp-participant-avatar').textContent, 'F');
  });

  it('shows the sync state as a dot with its label as tooltip', () => {
    renderRoom({ isHost: true });
    assert.equal(byId('owp-sync-indicator').className, 'owp-sync-dot synced');
    assert.equal(byId('owp-sync-indicator').title, 'Hosting');

    renderRoom({ isHost: false, syncStatus: 'syncing' });
    assert.equal(byId('owp-sync-indicator').className, 'owp-sync-dot syncing');
    assert.equal(byId('owp-sync-indicator').getAttribute('aria-label'), 'Out of sync');

    OWP.state.syncStatus = 'pending_play';
    OWP.state.pendingPlayUntil = 0;
    OWP.ui.updateSyncIndicator();
    assert.equal(byId('owp-sync-indicator').className, 'owp-sync-spinner');
  });

  it('draws the lobby in the same style as the bar', () => {
    OWP.state.inRoom = false;
    OWP.state.rooms = [
      { id: 'room-1', name: "Ana's room", count: 1, media_id: 'media' },
      { id: 'room-2', name: "FrancoTosky's room", count: 3, media_id: null }
    ];
    OWP.state.ws = { readyState: 1 };
    OWP.ui.updateRoomListUI = updateRoomListUI;
    OWP.ui.render(true);

    const header = panel().querySelector('.owp-header');
    assert.equal(header.querySelector('.owp-panel-title').textContent, 'OpenWatchParty');
    assert.ok(header.querySelector('.owp-close-btn .owp-icon-x'));
    assert.equal(byId('owp-ws-indicator').className, 'owp-ws-status online');
    assert.equal(byId('owp-ws-indicator').textContent, 'Online');
    assert.equal(panel().querySelector('.owp-label').textContent, 'Available rooms');
    assert.ok(panel().querySelector('.owp-create-section #owp-btn-create'));

    const rows = byId('owp-room-list').querySelectorAll('.owp-room-item');
    assert.deepEqual(rows.map(row => row.querySelector('.owp-room-count').textContent), ['1 user', '3 users']);
    assert.equal(rows[0].querySelector('.owp-room-title').textContent, "Ana's room");
    assert.ok(rows[1].querySelector('.owp-room-note'));

    OWP.state.ws = null;
    OWP.ui.updateStatusIndicator();
    assert.equal(byId('owp-ws-indicator').className, 'owp-ws-status offline');
    assert.equal(byId('owp-ws-indicator').textContent, 'Offline');

    OWP.state.rooms = [];
    OWP.ui.updateRoomListUI();
    assert.equal(byId('owp-room-list').querySelector('.owp-room-empty').textContent, 'No active rooms.');
    OWP.ui.updateRoomListUI = () => {};
  });

  it('draws the Watch Party icon on the 24 grid of the native icons', () => {
    const icon = OWP.ui.createWatchPartyIcon();
    assert.ok(icon.classList.contains('material-icons'));
    assert.ok(icon.classList.contains('owp-watch-party-icon'));
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    const svg = icon.querySelector('svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(svg.getAttribute('fill'), 'currentColor');
    assert.deepEqual(svg.children.map(shape => shape.tagName.toLowerCase()), ['path', 'path', 'circle', 'circle', 'path']);
    // The screen is a 2-unit line, like Jellyfin's Cast icon; the rest is filled.
    assert.equal(svg.children[0].getAttribute('fill'), 'none');
    assert.equal(svg.children[0].getAttribute('stroke-width'), '2');
    assert.equal(icon.querySelector('.theaters'), null);
  });

  it('drops the room style back in the lobby', () => {
    renderRoom();
    OWP.state.inRoom = false;
    OWP.ui.render(true);
    assert.equal(panel().classList.contains(ROOM_MODE_CLASS), false);
    assert.equal(panel().querySelector('.owp-room-bar'), null);
  });
});
