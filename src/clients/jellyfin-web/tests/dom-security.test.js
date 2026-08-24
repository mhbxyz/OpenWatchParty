const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

const IMG = '<img onerror="globalThis.pwned=true">';
const SCRIPT = '<script>globalThis.pwned=true</script>';
const defaultWsUrl = OWP.constants.DEFAULT_WS_URL;

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../ui/toasts.js');
require('../ui/home.js');
OWP.constants.DEFAULT_WS_URL = `ws://${SCRIPT}/ws`;
require('../ui/render.js');
OWP.constants.DEFAULT_WS_URL = defaultWsUrl;

const renderHomeWatchParties = OWP.ui.renderHomeWatchParties;
const updateRoomListUI = OWP.ui.updateRoomListUI;
const assertNoExecutableNodes = (root = document.body) => {
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('script'), null);
};

describe('dynamic DOM rendering', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    globalThis.pwned = false;
    window.location.hash = '';
    OWP.state.rooms = [];
    OWP.state.inRoom = false;
    OWP.state.isHost = false;
    OWP.state.syncStatus = 'synced';
    OWP.chat.messages = [];
    delete window.ApiClient;
    OWP.constants.DEFAULT_WS_URL = defaultWsUrl;
    OWP.timers.setTimeout = () => 1;
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = renderHomeWatchParties;
    OWP.ui.updateRoomListUI = updateRoomListUI;
  });

  it('renders hostile room names, counts, and media names as card text', async () => {
    const list = document.createElement('div');
    list.id = 'owp-room-list';
    document.body.appendChild(list);
    const room = { id: 'room', name: IMG, count: SCRIPT, media_id: '' };
    OWP.state.rooms = [room];
    OWP.ui.updateRoomListUI();
    assert.equal(list.children[0].children[0].children[0].textContent, IMG);
    assert.equal(list.children[0].children[0].children[1].textContent, `${SCRIPT} users`);

    window.ApiClient = {
      getCurrentUserId: () => 'user',
      getItem: async () => ({ Name: SCRIPT })
    };
    room.media_id = 'media';
    const card = OWP.ui.createRoomCard(room, 0);
    document.body.appendChild(card);
    await Promise.resolve();
    assert.equal(card.querySelector('.owp-card-name').textContent, IMG);
    assert.equal(card.querySelector('.innerCardFooter .cardText').textContent, `groups ${SCRIPT} watching`);
    assert.equal(card.querySelector('.owp-media-title').textContent, SCRIPT);
    assertNoExecutableNodes();
  });

  it('renders hostile usernames and chat messages as exact text', () => {
    const messages = document.createElement('div');
    messages.id = 'owp-chat-messages';
    document.body.appendChild(messages);
    OWP.chat.renderMessage({ username: IMG, text: SCRIPT, timestamp: 0, isOwn: false });
    assert.equal(messages.querySelector('.owp-chat-username').textContent, IMG);
    assert.equal(messages.querySelector('.owp-chat-text').textContent, SCRIPT);
    assertNoExecutableNodes();
  });

  it('renders hostile chat toast values as exact text', () => {
    OWP.ui.showChatToast(IMG, SCRIPT);
    assert.equal(document.querySelector('.owp-toast-username').textContent, IMG);
    assert.equal(document.querySelector('.owp-toast-text').textContent, SCRIPT);
    assertNoExecutableNodes();
  });

  it('renders hostile room, participant, client, and server values as text', () => {
    const panel = document.createElement('div');
    panel.id = OWP.constants.PANEL_ID;
    document.body.appendChild(panel);
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.chat.markRead = () => {};
    OWP.chat.renderAllMessages = () => {};

    OWP.state.inRoom = true;
    OWP.state.roomName = IMG;
    OWP.state.participantCount = SCRIPT;
    OWP.state.clientId = `client-${IMG}`;
    OWP.ui.render(true);
    assert.equal(panel.querySelector('.owp-header').children[1].textContent, IMG);
    assert.equal(document.getElementById('owp-participants-list').textContent, `Online: ${SCRIPT}`);
    assert.equal(panel.querySelector('.owp-meta').children[1].textContent, `ID: ${IMG}`);
    assertNoExecutableNodes();

    OWP.state.inRoom = false;
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.render(true);
    assert.equal(panel.querySelector('.owp-footer').textContent, `Server: ${SCRIPT}`);
    assertNoExecutableNodes();
  });

  it('updates hostile home counters as exact text', () => {
    const home = document.createElement('div');
    home.className = 'homeSectionsContainer homePage';
    document.body.appendChild(home);
    OWP.state.rooms = [{ id: 'room', name: 'Room', count: '1', media_id: '' }];
    OWP.ui.renderHomeWatchParties();
    const itemsContainer = document.querySelector('.itemsContainer');
    assert.equal(itemsContainer.creationOptions, 'emby-itemscontainer');
    OWP.state.rooms[0].count = SCRIPT;
    OWP.ui.renderHomeWatchParties();
    const count = document.querySelector('.innerCardFooter .cardText');
    assert.equal(count.textContent, `groups ${SCRIPT} watching`);
    assertNoExecutableNodes();
  });

  it('preserves click handlers and event bubbling on rebuilt nodes', () => {
    const list = document.createElement('div');
    list.id = 'owp-room-list';
    document.body.appendChild(list);
    let joinedRoom = '';
    let bubbled = false;
    OWP.actions = { joinRoom: roomId => { joinedRoom = roomId; } };
    list.addEventListener('click', () => { bubbled = true; });
    OWP.state.rooms = [{ id: 'room-handler', name: 'Room', count: 1, media_id: '' }];

    OWP.ui.updateRoomListUI();
    list.children[0].click();

    assert.equal(joinedRoom, 'room-handler');
    assert.equal(bubbled, true);
  });

  it('honors stopPropagation in rebuilt handlers', () => {
    const parent = document.createElement('div');
    const child = document.createElement('button');
    parent.appendChild(child);
    document.body.appendChild(parent);
    let bubbled = false;
    parent.addEventListener('click', () => { bubbled = true; });
    child.addEventListener('click', event => event.stopPropagation());

    child.click();

    assert.equal(bubbled, false);
  });
});
