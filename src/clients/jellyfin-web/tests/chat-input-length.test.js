const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

const toasts = [];
OWP.ui = { showToast: message => toasts.push(message) };
OWP.actions = { send: () => {} };
OWP.state.ws = null;

require('../chat/emoji-data.js');
require('../chat/emoji-picker.js');
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

describe('chat emoji shortcodes and autocomplete', () => {
  it('expands case-insensitive shortcodes on message send', () => {
    assert.equal(OWP.emoji.expand(':SOB:'), '😭');
    assert.equal(OWP.emoji.expand(':sob:'), '😭');
    assert.equal(OWP.emoji.expand(':Sob:'), '😭');
    assert.equal(OWP.emoji.expand(':SoB:'), '😭');
    assert.equal(OWP.emoji.expand(':soB:'), '😭');
    assert.equal(OWP.emoji.expand('hello :SoB: world'), 'hello 😭 world');
  });

  it('replaces full shortcodes case-insensitively during input', () => {
    ['SOB:', 'Sob:', 'SoB:', 'soB:', 'sob:'].forEach((shortcode) => {
      const input = {
        value: `Testing :${shortcode}`,
        selectionStart: 9 + shortcode.length + 1,
        setSelectionRange(start) { this.selectionStart = start; },
        focus() {}
      };
      OWP.emoji.insertEmoji('😭', shortcode, input);
      assert.equal(input.value, 'Testing 😭', `Failed for shortcode :${shortcode}`);
    });
  });
});
