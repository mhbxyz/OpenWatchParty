const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let styleAttempts = 0;
let connectCalls = 0;
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
  });
});
