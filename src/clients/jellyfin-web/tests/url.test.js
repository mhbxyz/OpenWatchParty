const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
const normalize = OWP.utils.normalizeSessionServerUrl;

describe('session server URL validation', () => {
  const httpsPage = { protocol: 'https:', hostname: 'media.example', port: '' };
  const httpPage = { protocol: 'http:', hostname: 'media.example', port: '8096' };

  for (const value of [undefined, null, '', '   ']) {
    it(`accepts the automatic value ${String(value)}`, () => {
      assert.deepEqual(normalize(value, httpsPage), { valid: true, url: '', thirdParty: false });
    });
  }

  it('normalizes valid secure, IPv6, and sub-path URLs', () => {
    assert.deepEqual(normalize(' WSS://MEDIA.EXAMPLE:443/rooms/main ', httpsPage), {
      valid: true,
      url: 'wss://media.example/rooms/main',
      thirdParty: false
    });
    assert.deepEqual(normalize('wss://[2001:db8::1]:8443/deep/ws', httpsPage), {
      valid: true,
      url: 'wss://[2001:db8::1]:8443/deep/ws',
      thirdParty: true
    });
    assert.equal(normalize('ws://media.example:8096/ws', httpPage).valid, true);
  });

  for (const value of [
    'invalid',
    '/ws',
    'http://media.example/ws',
    'https://media.example/ws',
    'wss://user:secret@media.example/ws',
    'wss://media.example/ws?',
    'wss://media.example/ws?token=secret',
    'wss://media.example/ws#',
    'wss://media.example/ws#fragment'
  ]) {
    it(`rejects ${value}`, () => {
      assert.equal(normalize(value, httpsPage).valid, false);
    });
  }

  it('rejects ws mixed content under HTTPS', () => {
    const result = normalize('ws://media.example/ws', httpsPage);
    assert.equal(result.valid, false);
    assert.match(result.error, /HTTPS.*wss/);
  });

  it('flags a different hostname or effective port', () => {
    assert.equal(normalize('wss://sessions.example/ws', httpsPage).thirdParty, true);
    assert.equal(normalize('wss://media.example:8443/ws', httpsPage).thirdParty, true);
    assert.equal(normalize('wss://media.example/ws', httpsPage).thirdParty, false);
  });
});
