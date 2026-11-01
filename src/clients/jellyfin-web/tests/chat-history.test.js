const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

globalThis.document.getElementById = () => null;
OWP.ui = { updateParticipantList: () => {}, showToast: () => {}, showChatToast: () => {} };
require('../chat/messages.js');
let chatVisible = false;
OWP.chat.isChatVisible = () => chatVisible;
OWP.chat.updateBadge = () => {};
require('../ws/validation.js');
require('../ws/handlers/room.js');

const h = OWP._wsHandlers;
const validate = message => OWP.wsValidation.validateMessage(message);
const entry = (client, username, text, serverTs = 1_700_000_000_000, own = false) => ({ client, username, text, server_ts: serverTs, own });
const history = (messages, room = 'room-1') => ({
  type: 'chat_history',
  room,
  payload: { messages },
  ts: 1_700_000_000_000,
  server_ts: 1_700_000_000_001
});

describe('chat history', () => {
  beforeEach(() => {
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-1', clientId: 'client-9', userName: 'Ana' });
    OWP.chat.messages = [];
    OWP.chat.unreadCount = 0;
    chatVisible = false;
  });

  it('is validated strictly', () => {
    assert.equal(validate(history([entry('c1', 'Franco', 'hola')])).valid, true);
    assert.equal(validate(history([])).valid, true);
    assert.equal(validate(history([entry('c1', '', 'hola')])).valid, true);
    for (const messages of [
      [{ ...entry('c1', 'Franco', 'hola'), extra: 1 }],
      [{ ...entry('c1', 'Franco', 'hola'), own: 'yes' }],
      [entry('c1', 'Franco', '')],
      [entry('c1', 'Franco', 'x'.repeat(501))],
      [entry('', 'Franco', 'hola')],
      [entry('c1', 'Franco', 'hola', -1)],
      Array(51).fill(entry('c1', 'Franco', 'hola')),
      'hola'
    ]) {
      assert.equal(validate(history(messages)).valid, false, JSON.stringify(messages).slice(0, 40));
    }
    assert.equal(validate({ ...history([]), payload: { messages: [], extra: 1 } }).valid, false);
    const { room, ...withoutRoom } = history([]);
    assert.equal(room, 'room-1');
    assert.equal(validate(withoutRoom).valid, false);
  });

  it('shows the room\'s earlier messages, in order, none of them unread', () => {
    OWP.chat.unreadCount = 3;
    h.handleChatHistory(history([
      entry('c1', 'Franco', 'empezamos?', 1),
      entry('c2', 'Ana', 'dale', 2, true),
      entry('client-9', 'Ana', 'ya estoy', 3),
      entry('c3', 'Ana', 'otra Ana', 4)
    ]));
    assert.deepEqual(OWP.chat.messages.map(message => [message.username, message.text, message.timestamp, message.isOwn]), [
      ['Franco', 'empezamos?', 1, false],
      // This member's own: marked by the server (an earlier connection), or this connection's.
      ['Ana', 'dale', 2, true],
      ['Ana', 'ya estoy', 3, true],
      // The same name is not enough.
      ['Ana', 'otra Ana', 4, false]
    ]);
    assert.equal(OWP.chat.unreadCount, 0);
  });

  it('draws the messages in the chat', () => {
    const container = { children: [], scrollTop: 0, scrollHeight: 0, replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); } };
    const realDocument = globalThis.document;
    globalThis.document = {
      ...realDocument,
      getElementById: id => (id === 'owp-chat-messages' ? container : null),
      createElement: () => ({ className: '', title: '', textContent: '', append() {} })
    };
    try {
      h.handleChatHistory(history([entry('c1', 'Franco', 'uno', 1), entry('c2', 'Eva', 'dos', 2)]));
    } finally {
      globalThis.document = realDocument;
    }
    assert.equal(container.children.length, 2);
  });

  it('replaces what the chat shows, as after a rejoin', () => {
    OWP.chat.messages = [{ clientId: 'c1', username: 'Franco', text: 'old', timestamp: 1, isOwn: false }];
    h.handleChatHistory(history([entry('c1', 'Franco', 'old', 1), entry('c1', 'Franco', 'new', 2)]));
    assert.deepEqual(OWP.chat.messages.map(message => message.text), ['old', 'new']);
  });

  it('is for this room only', () => {
    h.handleChatHistory(history([entry('c1', 'Franco', 'other room')], 'room-2'));
    assert.deepEqual(OWP.chat.messages, []);
    OWP.state.inRoom = false;
    h.handleChatHistory(history([entry('c1', 'Franco', 'not in a room')]));
    assert.deepEqual(OWP.chat.messages, []);
  });

  it('names an unnamed sender like a live message does', () => {
    h.handleChatHistory(history([entry('c1', '', 'hola')]));
    assert.equal(OWP.chat.messages[0].username, 'Anonymous');
    assert.equal(OWP.chat.messages[0].isOwn, false);
  });
});
