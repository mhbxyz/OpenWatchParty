const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

describe('suppress / shouldSend', () => {
  const { suppress, shouldSend } = OWP.utils;

  it('shouldSend returns false during suppression', () => {
    suppress(1000);
    assert.equal(shouldSend(), false);
  });

  it('shouldSend returns true after suppression expires', () => {
    // Set suppressUntil to the past so shouldSend() returns true
    OWP.state.suppressUntil = 0;
    assert.equal(shouldSend(), true);
  });
});
