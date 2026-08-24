const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

OWP.chat = { clear: () => {} };
require('../ws/send.js');
require('../app/cleanup.js');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('deferred operation registry', () => {
  beforeEach(() => {
    OWP.timers.clearAll();
    OWP.state.ws = null;
    OWP.state.currentVideoElement = null;
    OWP.state.videoListeners = null;
  });

  afterEach(() => OWP.timers.clearAll());

  it('removes completed timeouts and explicitly cleared intervals', async () => {
    let timeoutCalls = 0;
    const timeout = OWP.timers.setTimeout(() => { timeoutCalls++; }, 5, 'ui');
    const interval = OWP.timers.setInterval(() => {}, 1000, 'lifecycle');

    assert.equal(OWP.timers.count(), 2);
    assert.equal(OWP.timers.count('ui'), 1);
    await wait(20);

    assert.equal(timeoutCalls, 1);
    assert.equal(OWP.timers.count('ui'), 0);
    assert.equal(OWP.timers.count(), 1);
    assert.equal(OWP.timers.clear(timeout), false);
    assert.equal(OWP.timers.clear(interval), true);
    assert.equal(OWP.timers.count(), 0);
  });

  it('keeps connection, lifecycle, auth and UI work across a room reset', async () => {
    const calls = [];
    for (const scope of ['connection', 'lifecycle', 'auth', 'ui', 'video', 'room', 'media']) {
      OWP.timers.setTimeout(() => calls.push(scope), 10, scope);
    }

    OWP.actions.resetRoomState();

    assert.equal(OWP.timers.count('room'), 0);
    assert.equal(OWP.timers.count('media'), 0);
    assert.equal(OWP.timers.count('video'), 1);
    assert.equal(OWP.timers.count(), 5);
    await wait(30);
    assert.deepEqual(calls.sort(), ['auth', 'connection', 'lifecycle', 'ui', 'video']);
    assert.equal(OWP.timers.count(), 0);
  });

  it('cancels every timeout and interval at cleanup without late callbacks', async () => {
    let calls = 0;
    for (const scope of ['connection', 'lifecycle', 'auth', 'ui', 'room', 'media']) {
      OWP.timers.setTimeout(() => { calls++; }, 10, scope);
      OWP.timers.setInterval(() => { calls++; }, 10, scope);
    }
    assert.equal(OWP.timers.count(), 12);

    OWP.app.cleanup();

    assert.equal(OWP.timers.count(), 0);
    await wait(30);
    assert.equal(calls, 0);
    assert.equal(OWP.timers.count(), 0);
  });
});
