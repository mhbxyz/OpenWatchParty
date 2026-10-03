const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let styleAttempts = 0;
let connectCalls = 0;
let headerInjections = 0;
const elements = new Map();
globalThis.document.getElementById = id => elements.get(id) || null;
globalThis.document.createElement = () => ({
  id: '',
  className: '',
  addEventListener: () => {}
});
globalThis.document.body = {
  appendChild: element => { elements.set(element.id, element); }
};
OWP.ui = {
  injectStyles: () => {
    styleAttempts++;
    if (styleAttempts === 1) throw new Error('style injection failed');
  },
  injectOsdButton: () => {},
  injectGlobalButton: () => {},
  injectHeaderButtons: () => { headerInjections++; },
  renderHomeWatchParties: () => {}
};
OWP.playback = { syncLoop: () => {} };
OWP.actions = { connect: () => { connectCalls++; } };
OWP.utils.getVideo = () => null;
OWP.utils.isHomeView = () => false;
require('../app/lifecycle.js');

describe('application lifecycle initialization', () => {
  afterEach(() => {
    OWP._lifecycle.clearAllIntervals();
  });

  it('keeps initialization retryable after a synchronous failure', () => {
    OWP.state.initialized = false;
    assert.throws(() => OWP.app.init(), /style injection failed/);
    assert.equal(OWP.state.initialized, false);

    OWP.app.init();

    assert.equal(OWP.state.initialized, true);
    assert.equal(connectCalls, 1);
    assert.equal(headerInjections, 1);
  });

  it('loads the header module itself when an older cached loader skipped it', () => {
    const injectHeaderButtons = OWP.ui.injectHeaderButtons;
    const appended = [];
    delete OWP.ui.injectHeaderButtons;
    OWP.loader = { base: '/OpenWatchParty/Client', cacheBust: '42' };
    globalThis.document.head = { appendChild: script => appended.push(script) };
    OWP.state.initialized = false;
    try {
      OWP.app.init();
      assert.equal(OWP.state.initialized, true);
      assert.equal(appended.length, 1);
      assert.equal(appended[0].src, '/OpenWatchParty/Client/ui/header.js?v=42');

      // A second attempt while the module is loading does not request it again.
      OWP.state.initialized = false;
      OWP.app.init();
      assert.equal(appended.length, 1);

      let injected = 0;
      OWP.ui.injectHeaderButtons = () => { injected++; };
      // A cleanup while the module was loading: nothing to inject.
      OWP.state.initialized = false;
      appended[0].onload();
      assert.equal(injected, 0);

      OWP.state.initialized = true;
      appended[0].onload();
      assert.equal(injected, 1);
    } finally {
      OWP.ui.injectHeaderButtons = injectHeaderButtons;
      delete OWP.loader;
      delete globalThis.document.head;
    }
  });

  it('retries connection after Jellyfin login becomes available', () => {
    globalThis.ApiClient = { accessToken: () => 'token' };
    OWP.state.authBlocked = true;
    OWP.state.authError = 'not available';
    OWP.state.isConnecting = false;
    OWP.state.ws = null;
    connectCalls = 0;

    assert.equal(OWP._lifecycle.retryConnectionAfterLogin(), true);
    assert.equal(connectCalls, 1);
    assert.equal(OWP.state.authBlocked, false);
    assert.equal(OWP.state.authError, '');
  });
});
