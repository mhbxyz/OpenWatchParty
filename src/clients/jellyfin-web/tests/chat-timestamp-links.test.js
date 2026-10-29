const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.actions = {};
require('../chat/messages.js');

describe('chat timestamp pattern detection and link rendering', () => {
  let fakeVideo;
  let toastMessage;

  beforeEach(() => {
    globalThis.document = new FakeDocument();
    toastMessage = null;
    OWP.chat.messages = [];
    OWP.chat.unreadCount = 0;
    OWP.state.inRoom = true;
    OWP.state.isHost = true;
    OWP.state.clientId = 'host-client';

    fakeVideo = {
      currentTime: 0,
      duration: 3600,
      closest: () => null
    };

    OWP.utils.getVideo = () => fakeVideo;
    OWP.ui.showToast = (msg) => { toastMessage = msg; };
  });

  describe('parseTimestampSeconds', () => {
    it('parses valid MM:SS timestamps', () => {
      assert.equal(OWP.chat.parseTimestampSeconds('12:34'), 754);
      assert.equal(OWP.chat.parseTimestampSeconds('0:45'), 45);
      assert.equal(OWP.chat.parseTimestampSeconds('00:15'), 15);
      assert.equal(OWP.chat.parseTimestampSeconds('99:59'), 5999);
    });

    it('parses valid HH:MM:SS timestamps', () => {
      assert.equal(OWP.chat.parseTimestampSeconds('1:02:33'), 3753);
      assert.equal(OWP.chat.parseTimestampSeconds('01:23:45'), 5025);
      assert.equal(OWP.chat.parseTimestampSeconds('0:00:00'), 0);
    });

    it('returns null for non-timestamp strings', () => {
      assert.equal(OWP.chat.parseTimestampSeconds('invalid'), null);
      assert.equal(OWP.chat.parseTimestampSeconds('1:2:3:4'), null);
    });
  });

  describe('rendering chat text with timestamps', () => {
    it('renders text without timestamps as plain text node', () => {
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, 'Just a regular message here');
      assert.equal(el.childNodes.length, 1);
      assert.equal(el.childNodes[0].nodeType, 3);
      assert.equal(el.textContent, 'Just a regular message here');
      assert.equal(el.querySelectorAll('.owp-chat-timestamp').length, 0);
    });

    it('detects a single MM:SS timestamp and renders a clickable button', () => {
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, 'Look at 12:34 right now');
      const buttons = el.querySelectorAll('.owp-chat-timestamp');
      assert.equal(buttons.length, 1);
      assert.equal(buttons[0].textContent, '12:34');
      assert.equal(el.textContent, 'Look at 12:34 right now');
    });

    it('detects HH:MM:SS timestamp', () => {
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, 'Watch from 1:02:33 to the end');
      const buttons = el.querySelectorAll('.owp-chat-timestamp');
      assert.equal(buttons.length, 1);
      assert.equal(buttons[0].textContent, '1:02:33');
      assert.equal(el.textContent, 'Watch from 1:02:33 to the end');
    });

    it('detects multiple timestamps in the same message', () => {
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, 'Check 0:30 and also 12:34 or 1:05:00');
      const buttons = el.querySelectorAll('.owp-chat-timestamp');
      assert.equal(buttons.length, 3);
      assert.equal(buttons[0].textContent, '0:30');
      assert.equal(buttons[1].textContent, '12:34');
      assert.equal(buttons[2].textContent, '1:05:00');
    });

    it('handles punctuation around timestamps correctly', () => {
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, 'See (12:34)! Then check 0:45.');
      const buttons = el.querySelectorAll('.owp-chat-timestamp');
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].textContent, '12:34');
      assert.equal(buttons[1].textContent, '0:45');
      assert.equal(el.textContent, 'See (12:34)! Then check 0:45.');
    });

    it('ignores non-timestamp patterns such as scores, ratios, dates, and ports', () => {
      const falsePositives = [
        'The game ended 2:1 yesterday',
        'Video ratio is 16:9',
        'Invalid time 12:65 here',
        'Invalid minutes 1:70:30 here',
        'Hardware address 00:11:22:33:44:55',
        'Proxy port 192.168.1.1:8080',
        'Date format 2024:05:12',
        'Attached letters foo12:34 and 12:34bar'
      ];
      for (const msg of falsePositives) {
        const el = document.createElement('div');
        OWP.chat.appendTextWithTimestamps(el, msg);
        assert.equal(el.querySelectorAll('.owp-chat-timestamp').length, 0, `Should not match in: "${msg}"`);
        assert.equal(el.textContent, msg);
      }
    });

    it('renders malicious HTML strings safely without creating executable elements', () => {
      const malicious = '<script>globalThis.pwned=true</script> look at 12:34 <img onerror="globalThis.pwned=true">';
      const el = document.createElement('div');
      OWP.chat.appendTextWithTimestamps(el, malicious);
      assert.equal(el.querySelector('script'), null);
      assert.equal(el.querySelector('img'), null);
      assert.equal(el.querySelectorAll('.owp-chat-timestamp').length, 1);
      assert.equal(el.textContent, malicious);
    });
  });

  describe('timestamp clicking and seeking permissions', () => {
    it('seeks the video when clicked by the host', () => {
      const container = document.createElement('div');
      container.id = 'owp-chat-messages';
      document.body.appendChild(container);

      OWP.state.isHost = true;
      OWP.chat.renderMessage({ username: 'Alice', text: 'Scrub to 12:34', timestamp: Date.now(), isOwn: false });

      const btn = container.querySelector('.owp-chat-timestamp');
      assert.ok(btn);
      btn.click();

      assert.equal(fakeVideo.currentTime, 754);
      assert.equal(toastMessage, null);
    });

    it('clamps to video duration if timestamp exceeds media length', () => {
      const container = document.createElement('div');
      container.id = 'owp-chat-messages';
      document.body.appendChild(container);

      fakeVideo.duration = 600; // 10 minutes
      OWP.state.isHost = true;
      OWP.chat.renderMessage({ username: 'Alice', text: 'Go to 15:00', timestamp: Date.now(), isOwn: false });

      const btn = container.querySelector('.owp-chat-timestamp');
      btn.click();

      assert.equal(fakeVideo.currentTime, 600);
    });

    it('blocks seek and displays hostOnlySeek toast when clicked by a guest', () => {
      const container = document.createElement('div');
      container.id = 'owp-chat-messages';
      document.body.appendChild(container);

      OWP.state.inRoom = true;
      OWP.state.isHost = false; // Guest
      OWP.chat.renderMessage({ username: 'Alice', text: 'Check 05:00', timestamp: Date.now(), isOwn: false });

      const btn = container.querySelector('.owp-chat-timestamp');
      assert.ok(btn);
      btn.click();

      assert.equal(fakeVideo.currentTime, 0); // Video was not sought
      assert.equal(toastMessage, 'Only the host can seek');
    });

    it('handles clicking gracefully when no video is loaded', () => {
      OWP.utils.getVideo = () => null;
      assert.doesNotThrow(() => {
        OWP.chat.onTimestampClick(120);
      });
    });
  });
});
