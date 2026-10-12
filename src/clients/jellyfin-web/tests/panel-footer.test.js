const { describe, it, beforeEach, afterEach } = require('node:test');
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
require('./load-panel-views.js');
require('../ws/auth.js');

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
    OWP.state.ws = null;
  });

  afterEach(() => OWP.timers.clearScope('auth'));

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

  it('keeps the active socket target after fetching a refreshed token with a new target', async () => {
    const originalFetch = globalThis.fetch;
    const originalApiClient = window.ApiClient;
    window.ApiClient = { accessToken: () => 'test-token', serverAddress: () => 'https://jellyfin.example.com' };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      session_server_url: 'wss://new.example.com/ws', auth_enabled: true, token: 'new-token', user_name: 'Test'
    }) });
    OWP.state.ws = { readyState: 1, url: 'wss://active.example.com/ws' };
    try {
      assert.equal((await OWP.actions.fetchAuthToken()).mode, 'authenticated');
      assert.equal(OWP.state.wsUrl, 'wss://new.example.com/ws');
      OWP.ui.render(true);
      assert.equal(footer(), 'Server: active.example.com');
      OWP.state.ws = { readyState: 1, url: OWP.state.wsUrl };
      OWP.ui.render();
      assert.equal(footer(), 'Server: new.example.com');
    } finally {
      globalThis.fetch = originalFetch;
      window.ApiClient = originalApiClient;
    }
  });

  it('uses the configured target once the old socket is closed', () => {
    OWP.state.ws = { readyState: 3, url: 'wss://old.example.com/ws' };
    OWP.state.wsUrl = 'wss://new.example.com/ws';
    OWP.ui.render(true);
    assert.equal(footer(), 'Server: new.example.com');
  });

  it('never reveals malformed raw URLs or unsupported schemes', () => {
    for (const value of ['wss://user:private@[bad/ws?token=private#private', 'broken?token=private', 'javascript:private']) {
      OWP.state.wsUrl = value;
      OWP.ui.render(true);
      assert.equal(footer(), 'Server: Unavailable');
    }
    OWP.state.ws = { readyState: 1, url: 'wss://user:private@[bad/ws?token=private' };
    OWP.ui.render();
    assert.equal(footer(), 'Server: Unavailable');
  });
});
