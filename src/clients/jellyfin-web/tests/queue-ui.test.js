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
  cancelCountdown: () => commands.push(['cancel']),
  add: item => commands.push(['add', item.id]),
  suggest: item => commands.push(['suggest', item.id]),
  accept: item => commands.push(['accept', item.id]),
  dismiss: id => commands.push(['dismiss', id]),
  withdraw: id => commands.push(['withdraw', id]),
  search: (term, receive) => receive([
    { item: { id: 'x', title: 'Movie X' }, label: 'Movie X', kind: 'Movie', detail: '2021' },
    { item: { id: 'c', title: 'Show · S1:E3 · Episode c' }, label: 'Show', kind: 'Series', detail: 'continues with S1:E3' }
  ], true)
};

const byId = id => document.getElementById(id);
const panel = () => byId(PANEL_ID);
const rows = () => byId('owp-queue-section').querySelectorAll('.owp-queue-item');
const rowButtons = row => row.querySelectorAll('button').map(button => [button.title, button.getAttribute('aria-disabled')]);
const strip = () => byId('owp-queue-next');

let room = 0;
const enterRoom = (fields = {}) => {
  document.body.replaceChildren();
  const element = document.createElement('div');
  element.id = PANEL_ID;
  document.body.appendChild(element);
  Object.assign(OWP.state, OWP.stateFactories.createRoomState(), {
    inRoom: true,
    roomId: `room-${++room}`,
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
    assert.notEqual(byId('owp-btn-queue'), null);

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
    assert.notEqual(byId('owp-btn-queue'), null);
    assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'The queue is empty.');
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
    const [, previous, next] = byId('owp-queue-section').querySelectorAll('.owp-queue-head button');
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
    assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'The host decides what goes in the queue.');
    assert.notEqual(byId('owp-btn-queue'), null);
  });

  it('shows the button for hosts, suggestion-capable guests and legacy rooms with items only', () => {
    enterRoom({ isHost: true, queueItems: [] });
    assert.notEqual(byId('owp-btn-queue'), null);
    enterRoom({ isHost: false, serverFeatures: ['media_queue', 'queue_suggestions'], queueItems: [] });
    assert.notEqual(byId('owp-btn-queue'), null);
    enterRoom({ isHost: false, queueItems: [item('a')] });
    assert.notEqual(byId('owp-btn-queue'), null);
    enterRoom({ isHost: false, queueItems: [] });
    assert.equal(byId('owp-btn-queue'), null);
  });

  it('shows the host suggestion badge and role-specific head action', () => {
    const suggestion = { id: 'x', title: 'Movie X', by: 'Ana', mine: false };
    enterRoom({ queueSuggestions: [suggestion] });
    assert.equal(byId('owp-btn-queue').querySelector('.owp-queue-badge').textContent, '1');
    assert.equal(byId('owp-queue-add').title, 'Add to the queue');
    enterRoom({ isHost: false, serverFeatures: ['media_queue', 'queue_suggestions'], queueSuggestions: [suggestion] });
    assert.equal(byId('owp-btn-queue').querySelector('.owp-queue-badge'), null);
    assert.equal(byId('owp-queue-add').title, 'Suggest something for the queue');
  });

  it('opens and closes search, keeps it through queue updates and returns focus on Escape', () => {
    enterRoom({ queueItems: [item('a')] });
    const add = byId('owp-queue-add');
    add.click();
    const input = byId('owp-queue-section').querySelector('input');
    assert.equal(document.activeElement, input);
    input.value = 'movie';
    input.dispatchEvent({ type: 'input' });
    OWP.state.queueItems.push(item('b'));
    OWP.ui.updateQueue();
    // The same box: a rebuilt one would lose the caret and keys typed meanwhile.
    assert.equal(byId('owp-queue-section').querySelector('input'), input);
    assert.equal(input.value, 'movie');
    assert.equal(document.activeElement, input);
    let stopped = false;
    input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'Escape must not reach the drop-down, which would close the whole section');
    assert.equal(byId('owp-queue-section').querySelector('input'), null);
    assert.equal(document.activeElement, byId('owp-queue-add'));
  });

  it('updates the same open search input when the host becomes a guest', () => {
    enterRoom({ queueItems: [item('a')] });
    byId('owp-queue-add').click();
    const input = byId('owp-queue-section').querySelector('input');
    assert.equal(input.placeholder, OWP.i18n.t('queueSearchHost'));

    OWP.state.isHost = false;
    OWP.state.serverFeatures = ['media_queue', 'queue_suggestions'];
    OWP.state.queueSuggestions = [{ id: 'x', title: 'Movie X', by: 'Ana', mine: false }];
    OWP.ui.updateQueue();

    assert.equal(byId('owp-queue-section').querySelector('input'), input);
    assert.equal(input.placeholder, OWP.i18n.t('queueSearchGuest'));
  });

  it('closes an open host search after becoming a guest without suggestions', () => {
    enterRoom({ queueItems: [item('a')] });
    byId('owp-queue-add').click();
    assert.notEqual(byId('owp-queue-section').querySelector('input'), null);

    OWP.state.isHost = false;
    OWP.state.serverFeatures = ['media_queue'];
    OWP.ui.updateQueue();

    assert.equal(byId('owp-queue-section').querySelector('input'), null);
    assert.notEqual(byId('owp-queue-section').querySelector('.owp-queue-list'), null);
  });

  it('shows searching and no-results states and closes with the close button', () => {
    let receive;
    const original = OWP.queue.search;
    OWP.queue.search = (term, callback) => {
      receive = callback;
      callback(null, true);
    };
    try {
      enterRoom();
      byId('owp-queue-add').click();
      const input = byId('owp-queue-section').querySelector('input');
      input.value = 'nothing';
      input.dispatchEvent({ type: 'input' });
      assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'Searching…');
      receive([], true);
      assert.equal(byId('owp-queue-section').querySelector('.owp-queue-note').textContent, 'Nothing found');
      byId('owp-queue-section').querySelector('.owp-queue-search').querySelector('button').click();
      assert.equal(byId('owp-queue-section').querySelector('input'), null);
    } finally {
      OWP.queue.search = original;
    }
  });

  it('renders search result states and actions for each role', () => {
    enterRoom({ queueItems: [item('c')] });
    byId('owp-queue-add').click();
    let input = byId('owp-queue-section').querySelector('input');
    input.value = 'movie';
    input.dispatchEvent({ type: 'input' });
    let results = byId('owp-queue-section').querySelectorAll('.owp-queue-result');
    // A series result shows the series, not the title of the episode it adds.
    assert.equal(results[1].querySelector('.owp-queue-name').textContent, 'Show');
    assert.equal(results[1].querySelector('.owp-queue-sub').textContent, 'Series · continues with S1:E3');
    assert.equal(results[1].querySelector('.owp-queue-state').textContent, 'In the queue');
    results[0].querySelector('button').click();
    assert.deepEqual(commands, [['add', 'x']]);

    commands = [];
    enterRoom({
      isHost: false,
      serverFeatures: ['media_queue', 'queue_suggestions'],
      queueSuggestions: [{ id: 'c', title: 'Episode c', by: 'Me', mine: true }]
    });
    byId('owp-queue-add').click();
    input = byId('owp-queue-section').querySelector('input');
    input.value = 'movie';
    input.dispatchEvent({ type: 'input' });
    results = byId('owp-queue-section').querySelectorAll('.owp-queue-result');
    results[0].querySelector('button').click();
    assert.deepEqual(commands, [['suggest', 'x']]);
    assert.equal(results[1].querySelector('.owp-queue-state').textContent, 'Suggested');
    OWP.state.queueSuggestions = Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: String(index), by: 'A', mine: false }));
    OWP.ui.updateQueue();
    const disabled = byId('owp-queue-section').querySelector('.owp-queue-result button');
    assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    assert.equal(disabled.title, 'There are already 10 suggestions');
  });

  it('renders unavailable people and suggestion actions for hosts and guests', () => {
    const suggestion = { id: 'x', title: 'Movie X', by: 'Ana', mine: false };
    enterRoom({
      queueItems: [item('b')],
      queueSuggestions: [suggestion],
      queueUnavailable: [
        { id: 'b', names: [], you: true },
        { id: 'x', names: ['Ana', 'Bea'], you: true }
      ]
    });
    assert.equal(rows()[0].querySelector('.owp-queue-warn').textContent, 'Not available for you');
    const suggestionRow = byId('owp-queue-section').querySelector('.owp-queue-suggestion');
    assert.equal(suggestionRow.querySelector('.owp-queue-warn').textContent, 'Not available for you and 2 more');
    const [accept, dismiss] = suggestionRow.querySelectorAll('button');
    accept.click();
    dismiss.click();
    assert.deepEqual(commands, [['accept', 'x'], ['dismiss', 'x']]);

    commands = [];
    enterRoom({
      isHost: false,
      serverFeatures: ['media_queue', 'queue_suggestions'],
      queueSuggestions: [{ ...suggestion, mine: true }],
      queueUnavailable: [{ id: 'x', names: ['Ana'], you: true }]
    });
    const own = byId('owp-queue-section').querySelector('.owp-queue-suggestion');
    assert.equal(own.querySelector('.owp-queue-sub').textContent.includes('Your suggestion · waiting for the host'), true);
    assert.equal(own.querySelector('.owp-queue-warn').textContent, 'Not available for you and Ana');
    own.querySelector('button').click();
    assert.deepEqual(commands, [['withdraw', 'x']]);
  });

  it('lets a guest withdraw only their own suggestion', () => {
    enterRoom({
      isHost: false,
      serverFeatures: ['media_queue', 'queue_suggestions'],
      queueSuggestions: [
        { id: 'mine', title: 'Mine', by: 'Me', mine: true },
        { id: 'other', title: 'Other', by: 'Ana', mine: false }
      ]
    });
    const [own, other] = byId('owp-queue-section').querySelectorAll('.owp-queue-suggestion');
    assert.equal(own.querySelectorAll('button').length, 1);
    assert.equal(other.querySelectorAll('button').length, 0);
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
