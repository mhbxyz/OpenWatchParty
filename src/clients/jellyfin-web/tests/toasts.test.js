const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
require('../ui/toasts.js');

describe('system toast duration', () => {
  it('keeps the default and accepts an explicit duration', () => {
    const delays = [];
    OWP.timers.setTimeout = (callback, delay) => {
      delays.push(delay);
      return delays.length;
    };
    OWP.ui.showToast('Short');
    OWP.ui.showToast('Long', { duration: 6000 });
    assert.deepEqual(delays, [1500, 6000]);
  });
});
