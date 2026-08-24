const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
OWP.ui = {
  render: () => {},
  showToast: () => {}
};
globalThis.ApiClient = {
  accessToken: () => 'jellyfin-token',
  serverAddress: () => 'https://media.example'
};
globalThis.localStorage = { getItem: () => null };
globalThis.sessionStorage = { getItem: () => null };
globalThis.WebSocket = class WebSocket {
  static OPEN = 1;

  constructor() {
    throw new Error('WebSocket must not be created while authentication is blocked');
  }
};

require('../ws/auth.js');
require('../ws/connection.js');
const fetchAuthToken = OWP.actions.fetchAuthToken;

describe('authentication configuration', () => {
  beforeEach(() => {
    OWP.state.authBlocked = false;
    OWP.state.authError = '';
    OWP.state.authToken = null;
    OWP.state.isConnecting = false;
    OWP.state.ws = null;
    OWP.state.autoReconnect = true;
    OWP.actions.fetchAuthToken = fetchAuthToken;
  });

  it('marks an unconfigured plugin response as blocking', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503 });

    const token = await OWP.actions.fetchAuthToken();

    assert.equal(token, null);
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /not configured/);
  });

  for (const status of [401, 429, 500]) {
    it(`blocks websocket fallback after token endpoint HTTP ${status}`, async () => {
      globalThis.fetch = async () => ({ ok: false, status });

      const token = await OWP.actions.fetchAuthToken();

      assert.equal(token, null);
      assert.equal(OWP.state.authBlocked, true);
      assert.match(OWP.state.authError, new RegExp(String(status)));
    });
  }

  it('blocks websocket fallback after a token endpoint network failure', async () => {
    globalThis.fetch = async () => { throw new Error('network failure'); };

    const token = await OWP.actions.fetchAuthToken();

    assert.equal(token, null);
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /token endpoint/);
  });

  it('blocks a successful response that does not explicitly choose an auth mode', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: true, token: null })
    });

    const token = await OWP.actions.fetchAuthToken();

    assert.equal(token, null);
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /invalid authentication response/);
  });

  it('rejects legacy implicit auth-disabled responses', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: false })
    });

    const token = await OWP.actions.fetchAuthToken();

    assert.equal(token, null);
    assert.equal(OWP.state.authBlocked, true);
  });

  it('allows tokenless connection only for explicit insecure mode', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: false, insecure_mode: true })
    });

    const token = await OWP.actions.fetchAuthToken();

    assert.equal(token, null);
    assert.equal(OWP.state.authBlocked, false);
  });

  it('does not create a websocket while authentication is blocked', async () => {
    OWP.actions.fetchAuthToken = async () => {
      OWP.state.authBlocked = true;
      OWP.state.authError = 'blocked';
      return null;
    };

    await OWP.actions.connect();

    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.isConnecting, false);
  });
});
