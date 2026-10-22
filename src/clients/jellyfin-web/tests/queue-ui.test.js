const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0, markRead: () => {}, renderAllMessages: () => {}, isChatVisible: () => false, updateBadge: () => {} };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
OWP.actions = { completeRoomRejoin: () => {} };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../ui/queue.js');

const { PANEL_ID } = OWP.constants;
const item = id => ({ id, title: `Episode ${id}` });
let commands = [];

// The host logic is app/queue.js; here only what the view asks of it.
const roomIndex = () => OWP.state.queueItems.findIndex(entry => entry.id === OWP.state.roomMediaId);
OWP.queue = {
  nextItem: () => OWP.state.queueItems[roomIndex() + 1] || null,
  previousItem: () => (roomIndex() > 0 ? OWP.state.queueItems[roomIndex() - 1] : null),
  advance: id => commands.push(['advance', id]),
  move: (id, to) => commands.push(['move', id, to]),
  remove: id => commands.push(['remove', id]),
  cancelCountdown: () => commands.push(['cancel'])
};

const byId = id => document.getElementById(id);
const panel = () => byId(PANEL_ID);
const rows = () => byId('owp-queue-section').querySelectorAll('.owp-queue-item');
const rowButtons = row => row.querySelectorAll('button').map(button => [button.title, button.getAttribute('aria-disabled')]);
const strip = () => byId('owp-queue-next');

const enterRoom = (fields = {}) => {
  document.body.replaceChildren();
  const element = document.createElement('div');
  element.id = PANEL_ID;
  document.body.appendChild(element);
  Object.assign(OWP.state, OWP.stateFactories.createRoomState(), {
    inRoom: true,
    roomId: 'room-1',
    roomName: 'Room',
    clientId: 'host',
    isHost: true,
    serverFeatures: ['media_queue'],
    roomMediaId: 'b',
    roomBarSection: '',
    hasTimeSync: true,
    serverOffsetMs: 0
  }, fields);
  OWP.ui.render(true);
};

describe('room queue view', () => {
  beforeEach(() => {
    commands = [];
  });

  afterEach(() => {
    OWP.timers.clearScope('room');
  });

  it('shows the queue button while the room has a queue, before the invite button', () => {
    enterRoom();
    assert.equal(byId('owp-btn-queue'), null);

    OWP.state.queueItems = ['a', 'b', 'c'].map(item);
    OWP.ui.updateQueue();
    const bar = byId('owp-btn-queue').parentNode;
    const ids = bar.querySelectorAll('button').map(button => button.id);
    assert.equal(ids.indexOf('owp-btn-queue') + 1, ids.indexOf('owp-btn-invite'));

    byId('owp-btn-queue').click();
    assert.equal(OWP.state.roomBarSection, 'queue');
    assert.equal(byId('owp-queue-section').hidden, false);

    OWP.state.queueItems = [];
    OWP.ui.updateQueue();
    assert.equal(byId('owp-btn-queue'), null);
    assert.equal(byId('owp-queue-section'), null);
    assert.equal(OWP.state.roomBarSection, '');
  });

  it('lists watched, current and upcoming items, with the host actions on the upcoming ones', () => {
    enterRoom({ queueItems: ['a', 'b', 'c', 'd'].map(item) });
    const [watched, current, first, last] = rows();
    assert.equal(watched.className, 'owp-queue-item done');
    assert.equal(current.className, 'owp-queue-item current');
    assert.equal(current.querySelector('.owp-queue-now').textContent, 'Watching');
    assert.deepEqual([first, last].map(row => row.querySelector('.owp-queue-mark').textContent), ['1', '2']);
    assert.deepEqual(rowButtons(watched), []);
    assert.deepEqual(rowButtons(current), []);
    assert.deepEqual(rowButtons(first), [['Play now', null], ['Move up', 'true'], ['Move down', null], ['Remove', null]]);
    assert.deepEqual(rowButtons(last).map(([, disabled]) => disabled), [null, null, 'true', null]);

    first.querySelectorAll('button').forEach(button => button.click());
    last.querySelectorAll('button')[1].click();
    const [previous, next] = byId('owp-queue-section').querySelectorAll('.owp-queue-head button');
    previous.click();
    next.click();
    assert.deepEqual(commands, [
      ['advance', 'c'], ['move', 'c', 3], ['remove', 'c'], ['move', 'd', 2], ['advance', 'a'], ['advance', 'c']
    ]);
    assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'The next episodes are added automatically.');
  });

  it('keeps the list as it is when only the countdown changes', () => {
    enterRoom({ queueItems: ['a', 'b', 'c'].map(item) });
    const [first] = rows();
    OWP.state.queueCountdownUntil = Date.now() + 5000;
    OWP.ui.updateQueue();
    assert.equal(rows()[0], first);
    OWP.state.queueItems = ['a', 'b', 'c', 'd'].map(item);
    OWP.ui.updateQueue();
    assert.notEqual(rows()[0], first);
    assert.equal(rows().length, 4);
  });

  it('shows guests the queue without controls', () => {
    enterRoom({ isHost: false, clientId: 'guest', queueItems: ['a', 'b', 'c'].map(item) });
    assert.equal(byId('owp-queue-section').querySelectorAll('button').length, 0);
    assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'Only the host can change the queue.');
    assert.notEqual(byId('owp-btn-queue'), null);
  });

  it('shows up next on its own with the panel closed and under the bar with it open', () => {
    enterRoom({ queueItems: ['a', 'b', 'c'].map(item) });
    panel().classList.add('hide');
    OWP.state.queueCountdownUntil = Date.now() + 7500;
    OWP.ui.updateQueue();
    assert.equal(strip().parentNode, document.body);
    assert.equal(strip().classList.contains('owp-queue-float'), true);
    assert.equal(strip().querySelector('b').textContent, 'Episode c');
    assert.equal(strip().querySelector('.owp-queue-next-time').textContent, '8 s');
    const width = parseFloat(strip().querySelector('.owp-queue-next-bar').style.width);
    assert.ok(width > 74 && width <= 75, String(width));

    const [cancel, next] = strip().querySelectorAll('button');
    cancel.click();
    next.click();
    assert.deepEqual(commands, [['cancel'], ['advance', 'c']]);

    panel().classList.remove('hide');
    OWP.ui.updateQueue();
    assert.equal(strip().previousSibling, panel().querySelector('.owp-room-bar'));
    assert.equal(strip().classList.contains('owp-queue-float'), false);
  });

  it('has the panel checked against the player controls when up next comes and goes', () => {
    enterRoom({ queueItems: ['a', 'b', 'c'].map(item) });
    const strips = [];
    OWP.ui.applyPlayerControls = () => strips.push(Boolean(strip()));
    try {
      panel().classList.remove('hide');
      OWP.state.queueCountdownUntil = Date.now() + 5000;
      OWP.ui.updateQueue();
      OWP.state.queueCountdownUntil = 0;
      OWP.ui.updateQueue();
      assert.deepEqual(strips, [true, false]);
    } finally {
      delete OWP.ui.applyPlayerControls;
    }
  });

  it('shows guests up next without buttons, and takes it away when the countdown or the room ends', () => {
    enterRoom({ isHost: false, clientId: 'guest', queueItems: ['a', 'b', 'c'].map(item) });
    panel().classList.add('hide');
    OWP.state.queueCountdownUntil = Date.now() + 5000;
    OWP.ui.updateQueue();
    assert.equal(strip().querySelectorAll('button').length, 0);

    OWP.state.queueCountdownUntil = 0;
    OWP.ui.updateQueue();
    assert.equal(strip(), null);

    OWP.state.queueCountdownUntil = Date.now() + 5000;
    OWP.ui.updateQueue();
    Object.assign(OWP.state, OWP.stateFactories.createRoomState());
    OWP.ui.render(true);
    assert.equal(strip(), null);
  });
});
