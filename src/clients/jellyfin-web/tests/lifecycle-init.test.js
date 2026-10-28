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
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = String(value); },
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

  it('checks queue retries from the existing sync interval', (t) => {
    const intervals = new Map();
    t.mock.method(OWP.timers, 'setInterval', (callback, delay) => {
      intervals.set(delay, callback);
      return intervals.size;
    });
    let retries = 0;
    const previous = OWP.queue;
    OWP.queue = { retryFill: () => { retries++; } };
    OWP.state.initialized = false;
    // The first initialization test deliberately throws once.
    styleAttempts = 1;
    try {
      OWP.app.init();
      intervals.get(OWP.constants.SYNC_LOOP_MS)();
      assert.equal(retries, 1);
    } finally {
      OWP.queue = previous;
      styleAttempts = 0;
      connectCalls = 0;
      headerInjections = 0;
    }
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

  it('hides the panel through ui.hidePanel when the player closes, so focus leaves it', () => {
    let hidden = 0;
    OWP.ui.hidePanel = () => { hidden++; };
    try {
      OWP._lifecycle.onVideoPlayerExit();
    } finally {
      delete OWP.ui.hidePanel;
    }
    assert.equal(hidden, 1);
  });

  it('creates the panel as a labelled non-modal dialog', () => {
    const panel = elements.get(OWP.constants.PANEL_ID);
    assert.ok(panel);
    assert.equal(panel.attributes.role, 'dialog');
    assert.equal(panel.attributes['aria-label'], 'Watch Party');
    assert.equal(panel.attributes['aria-modal'], undefined);
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

  it('reports this client\'s status on every sync tick in a room, host or guest', () => {
    const intervals = new Map();
    const setInterval = OWP.timers.setInterval;
    const calls = [];
    OWP.timers.setInterval = (callback, delay) => {
      intervals.set(delay, callback);
      return intervals.size;
    };
    // lifecycle.js keeps the playback object it found at load time.
    Object.assign(OWP.playback, {
      syncLoop: () => calls.push('syncLoop'),
      reportStatus: () => calls.push('reportStatus')
    });
    OWP.state.initialized = false;
    try {
      OWP.app.init();
    } finally {
      OWP.timers.setInterval = setInterval;
    }
    const tick = intervals.get(OWP.constants.SYNC_LOOP_MS);
    try {
      Object.assign(OWP.state, { inRoom: true, isHost: false });
      tick();
      assert.deepEqual(calls, ['syncLoop', 'reportStatus']);

      calls.length = 0;
      OWP.state.isHost = true;
      tick();
      assert.deepEqual(calls, ['reportStatus']);

      calls.length = 0;
      Object.assign(OWP.state, { inRoom: false, isHost: false });
      tick();
      assert.deepEqual(calls, []);
    } finally {
      Object.assign(OWP.state, { inRoom: false, isHost: false });
      OWP.playback.syncLoop = () => {};
      delete OWP.playback.reportStatus;
    }
  });

  it('refreshes the sync adjustment on every sync tick, only when the plugin offers it', () => {
    const intervals = new Map();
    const setInterval = OWP.timers.setInterval;
    const calls = [];
    OWP.timers.setInterval = (callback, delay) => {
      intervals.set(delay, callback);
      return intervals.size;
    };
    // lifecycle.js keeps the playback object it found at load time.
    Object.assign(OWP.playback, {
      syncLoop: () => calls.push('syncLoop'),
      trackDrift: () => calls.push('trackDrift')
    });
    OWP.ui.updateSyncSection = () => calls.push('updateSyncSection');
    OWP.state.initialized = false;
    try {
      OWP.app.init();
    } finally {
      OWP.timers.setInterval = setInterval;
    }
    const tick = intervals.get(OWP.constants.SYNC_LOOP_MS);
    Object.assign(OWP.state, { inRoom: true, isHost: false, showSyncNudge: false });
    try {
      tick();
      assert.deepEqual(calls, ['syncLoop']);

      calls.length = 0;
      OWP.state.showSyncNudge = true;
      tick();
      assert.deepEqual(calls, ['syncLoop', 'trackDrift', 'updateSyncSection']);

      calls.length = 0;
      OWP.state.isHost = true;
      tick();
      assert.deepEqual(calls, ['trackDrift', 'updateSyncSection']);

      calls.length = 0;
      Object.assign(OWP.state, { inRoom: false, isHost: false });
      tick();
      assert.deepEqual(calls, ['trackDrift', 'updateSyncSection']);

      calls.length = 0;
      OWP.state.showSyncNudge = false;
      tick();
      assert.deepEqual(calls, []);
    } finally {
      Object.assign(OWP.state, { inRoom: false, isHost: false, showSyncNudge: false });
      delete OWP.ui.updateSyncSection;
      OWP.playback.syncLoop = () => {};
      delete OWP.playback.trackDrift;
    }
  });
});
