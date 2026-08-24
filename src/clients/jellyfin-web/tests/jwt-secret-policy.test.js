const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const configPagePath = path.join(
  __dirname,
  '..', '..', '..',
  'plugins', 'jellyfin', 'OpenWatchParty', 'Web', 'configPage.html'
);
const configPage = fs.readFileSync(configPagePath, 'utf8');
const script = configPage.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({
  console,
  Map,
  Array,
  Math,
  atob,
  fetch: async () => ({ json: async () => ({}) }),
  ApiClient: {},
  Dashboard: {},
  $: () => ({ on: () => {} })
});
vm.runInContext(script, context, { filename: 'configPage.html' });
const validate = context.OpenWatchPartyConfigurationPage.validateJwtSecret;

describe('JWT secret policy parity', () => {
  for (const secret of [
    'B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=',
    'B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow',
    '98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ=',
    '98WPRKE6UmMf3yz96_mQPgkiEnDw4mIo1BPYNUA45rQ'
  ]) {
    it(`accepts supported random encoding ${secret.slice(0, 8)}`, () => {
      assert.equal(validate(secret), '');
    });
  }

  for (const secret of [
    'short-but-varied-123!',
    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=',
    'abcdefghijklmnopqrstuvwxyzABCDEF',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr',
    '98WPRKE6UmMf3yz96/mQPgkiEnDw4mIo1BPYNUA45rQ',
    'd1wVY4zF4kyG84jG/NshZg0ypQTurZv-7+jzya6ZF70=',
    ' B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=',
    'B0vL    hmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow='
  ]) {
    it(`rejects weak or ambiguous value ${secret.slice(0, 8)}`, () => {
      assert.notEqual(validate(secret), '');
    });
  }
});
