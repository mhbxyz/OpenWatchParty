const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

const toasts = [];
OWP.ui = { showToast: message => toasts.push(message) };
OWP.actions = { send: () => {} };
OWP.state.ws = null;

require('../chat/input.js');

describe('chat input length', () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  it('accepts a message of 500 code points', () => {
    assert.equal(OWP.chat.send('🎉'.repeat(500)), false, 'not connected, but not rejected as too long');
    assert.ok(
      !toasts.some(message => /too long/.test(message)),
      `the length check must not reject it, got ${JSON.stringify(toasts)}`
    );
  });

  it('refuses a message of 501 code points', () => {
    OWP.chat.send('🎉'.repeat(501));

    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /too long/);
  });

  it('still refuses a message that is too long in plain characters', () => {
    OWP.chat.send('a'.repeat(501));

    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /too long/);
  });
});
