const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
OWP.utils.getVideo = () => null;
require('../ui/indicators.js');
require('../ui/cards.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('../ui/render.js');

const { PANEL_ID } = OWP.constants;
const footer = () => document.getElementById(PANEL_ID).querySelector('.owp-footer').textContent;

describe('lobby footer', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.state.inRoom = false;
    OWP.state.rooms = [];
    OWP.state.wsUrl = '';
  });

  it('names the session server the plugin configured', () => {
    OWP.state.wsUrl = 'wss://watch.example.com/ws';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: watch.example.com');
  });

  it('keeps a non-default port and a sub-path', () => {
    OWP.state.wsUrl = 'ws://localhost:3002/ws';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: localhost:3002');

    OWP.state.wsUrl = 'wss://example.com/owp/ws';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: example.com/owp');
  });

  it('drops a trailing slash after /ws or the host', () => {
    OWP.state.wsUrl = 'wss://watch.example.com/ws/';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: watch.example.com');

    OWP.state.wsUrl = 'wss://watch.example.com/';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: watch.example.com');
  });

  it('never shows credentials, a query or a fragment', () => {
    OWP.state.wsUrl = 'wss://user:secret@watch.example.com/ws?token=secret#secret';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: watch.example.com');
  });

  it('names the default server while none is configured', () => {
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: localhost:3000');
  });

  it('follows a server that arrives after the lobby is drawn', () => {
    OWP.ui.render(true);
    OWP.state.wsUrl = 'wss://watch.example.com/ws';
    OWP.ui.render();
    assert.equal(footer(), 'Server: watch.example.com');
  });
});
