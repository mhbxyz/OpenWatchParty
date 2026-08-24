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
    if (OWP.state.tokenRefreshTimer) OWP.timers.clear(OWP.state.tokenRefreshTimer);
    OWP.state.authBlocked = false;
    OWP.state.authError = '';
    OWP.state.authToken = null;
    OWP.state.authEnabled = false;
    OWP.state.tokenExpiresAt = 0;
    OWP.state.tokenRefreshTimer = null;
    OWP.state.authRequestAttempt = 0;
    OWP.state.userId = '';
    OWP.state.userName = '';
    OWP.state.wsUrl = '';
    OWP.state.isConnecting = false;
    OWP.state.ws = null;
    OWP.state.autoReconnect = true;
    OWP.actions.fetchAuthToken = fetchAuthToken;
  });

  it('marks an unconfigured plugin response as blocking', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503 });

    const result = await OWP.actions.fetchAuthToken();

    assert.deepEqual(result, {
      mode: 'error',
      code: 'server_unavailable',
      message: 'JWT authentication is not configured or unavailable in the OpenWatchParty plugin (HTTP 503)'
    });
    assert.equal(OWP.state.authBlocked, true);
    assert.equal(OWP.state.authToken, null);
    assert.match(OWP.state.authError, /not configured/);
  });

  it('returns an error when Jellyfin ApiClient is unavailable', async () => {
    const apiClient = globalThis.ApiClient;
    const originalSetTimeout = OWP.timers.setTimeout;
    globalThis.ApiClient = null;
    OWP.timers.setTimeout = (callback) => {
      callback();
      return 1;
    };

    try {
      const result = await OWP.actions.fetchAuthToken();

      assert.equal(result.mode, 'error');
      assert.equal(result.code, 'api_client_unavailable');
      assert.equal(OWP.state.authToken, null);
      assert.equal(OWP.state.authBlocked, true);
    } finally {
      globalThis.ApiClient = apiClient;
      OWP.timers.setTimeout = originalSetTimeout;
    }
  });

  for (const status of [401, 429, 500]) {
    it(`blocks websocket fallback after token endpoint HTTP ${status}`, async () => {
      globalThis.fetch = async () => ({ ok: false, status });

      const result = await OWP.actions.fetchAuthToken();

      assert.equal(result.mode, 'error');
      assert.equal(result.code, { 401: 'unauthorized', 429: 'rate_limited', 500: 'server_error' }[status]);
      assert.equal(OWP.state.authBlocked, true);
      assert.match(OWP.state.authError, new RegExp(String(status)));
    });
  }

  it('blocks websocket fallback after a token endpoint network failure', async () => {
    globalThis.fetch = async () => { throw new Error('network failure'); };

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'network_error');
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /token endpoint/);
  });

  it('distinguishes an aborted token request from a network failure', async () => {
    globalThis.fetch = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'aborted');
    assert.equal(OWP.state.authBlocked, true);
  });

  it('aborts a token request when its auth-scoped timeout expires', async () => {
    const originalSetTimeout = OWP.timers.setTimeout;
    const originalClear = OWP.timers.clear;
    let timeoutScope;
    OWP.timers.setTimeout = (callback, delay, scope) => {
      assert.equal(delay, 10000);
      timeoutScope = scope;
      callback();
      return 1;
    };
    OWP.timers.clear = () => true;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.signal.aborted, true);
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    try {
      const result = await OWP.actions.fetchAuthToken();

      assert.equal(result.mode, 'error');
      assert.equal(result.code, 'timeout');
      assert.equal(timeoutScope, 'auth');
      assert.equal(OWP.state.authBlocked, true);
    } finally {
      OWP.timers.setTimeout = originalSetTimeout;
      OWP.timers.clear = originalClear;
    }
  });

  it('returns an error when the token endpoint JSON is invalid', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('invalid JSON'); }
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'invalid_json');
    assert.equal(OWP.state.authToken, null);
    assert.equal(OWP.state.authBlocked, true);
  });

  it('blocks a successful response that does not explicitly choose an auth mode', async () => {
    OWP.state.userId = 'existing-user';
    OWP.state.userName = 'Existing';
    OWP.state.wsUrl = 'wss://existing.example/ws';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        auth_enabled: true,
        token: null,
        user_id: 'forged-user',
        user_name: 'Forged',
        session_server_url: 'wss://forged.example/ws'
      })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'invalid_response');
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /invalid authentication response/);
    assert.equal(OWP.state.userId, 'existing-user');
    assert.equal(OWP.state.userName, 'Existing');
    assert.equal(OWP.state.wsUrl, 'wss://existing.example/ws');
  });

  it('rejects legacy implicit auth-disabled responses', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: false })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'invalid_response');
    assert.equal(OWP.state.authBlocked, true);
  });

  it('allows tokenless connection only for explicit insecure mode', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: false, insecure_mode: true, session_server_url: '' })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.deepEqual(result, { mode: 'insecure', token: null });
    assert.equal(OWP.state.authToken, null);
    assert.equal(OWP.state.authEnabled, false);
    assert.equal(OWP.state.authBlocked, false);
  });

  it('returns and stores a valid authenticated token', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        auth_enabled: true,
        token: 'owp-token',
        expires_in: 120,
        user_id: 'user-1',
        user_name: 'Alice',
        session_server_url: 'wss://session.example/ws'
      })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.deepEqual(result, { mode: 'authenticated', token: 'owp-token', expiresIn: 120 });
    assert.equal(OWP.state.authToken, 'owp-token');
    assert.equal(OWP.state.authEnabled, true);
    assert.equal(OWP.state.authBlocked, false);
    assert.equal(OWP.state.userId, 'user-1');
    assert.equal(OWP.state.userName, 'Alice');
    assert.equal(OWP.state.wsUrl, 'wss://session.example/ws');
    assert.ok(OWP.state.tokenExpiresAt > Date.now());
  });

  it('rejects absent or non-string session server URL fields', async () => {
    for (const payload of [
      { auth_enabled: false, insecure_mode: true },
      { auth_enabled: false, insecure_mode: true, session_server_url: null }
    ]) {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
      const result = await OWP.actions.fetchAuthToken();
      assert.equal(result.mode, 'error');
      assert.equal(result.code, 'invalid_response');
    }
  });

  it('fails closed when the token response contains an invalid websocket URL', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        auth_enabled: true,
        token: 'owp-token',
        session_server_url: 'https://session.example/ws'
      })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'invalid_response');
    assert.equal(OWP.state.authBlocked, true);
    assert.equal(OWP.state.authToken, null);
    assert.equal(OWP.state.ws, null);
  });

  it('fails closed when the token response would create mixed content', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        auth_enabled: false,
        insecure_mode: true,
        session_server_url: 'ws://session.example/ws'
      })
    });

    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'invalid_response');
    assert.match(result.message, /HTTPS.*wss/);
  });

  it('does not create a websocket while authentication is blocked', async () => {
    OWP.actions.fetchAuthToken = async () => {
      OWP.state.authBlocked = true;
      OWP.state.authError = 'blocked';
      return { mode: 'error', code: 'test_error', message: 'blocked' };
    };

    await OWP.actions.connect();

    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.isConnecting, false);
  });

  it('rejects unknown authentication result modes', async () => {
    OWP.actions.fetchAuthToken = async () => ({ mode: 'future-mode' });

    await OWP.actions.connect();

    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /invalid result/);
  });

  it('revalidates the websocket URL immediately before construction', async () => {
    OWP.state.wsUrl = 'wss://user:secret@session.example/ws';
    OWP.actions.fetchAuthToken = async () => ({ mode: 'insecure', token: null });

    await OWP.actions.connect();

    assert.equal(OWP.state.ws, null);
    assert.equal(OWP.state.isConnecting, false);
    assert.equal(OWP.state.authBlocked, true);
    assert.match(OWP.state.authError, /credentials/);
  });

  it('rearms refresh for a reusable token after cleanup', () => {
    OWP.state.authEnabled = true;
    OWP.state.authToken = 'existing-token';
    OWP.state.tokenExpiresAt = Date.now() + 120000;
    OWP.state.tokenRefreshTimer = null;

    assert.equal(OWP.actions.ensureTokenRefresh(), true);
    assert.notEqual(OWP.state.tokenRefreshTimer, null);
    assert.equal(OWP.timers.count('auth'), 1);
  });

  it('invalidates an expired reusable token', () => {
    OWP.state.authEnabled = true;
    OWP.state.authToken = 'expired-token';
    OWP.state.tokenExpiresAt = Date.now() - 1;

    assert.equal(OWP.actions.ensureTokenRefresh(), false);
    assert.equal(OWP.state.authToken, null);
  });

  it('creates a websocket for an explicit insecure auth result', async () => {
    const WebSocket = globalThis.WebSocket;
    const sockets = [];
    globalThis.WebSocket = class TestWebSocket {
      static OPEN = 1;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = 0;
        sockets.push(this);
      }

      close() {
        this.readyState = TestWebSocket.CLOSED;
      }
    };
    OWP.actions.fetchAuthToken = async () => ({ mode: 'insecure', token: null });

    try {
      await OWP.actions.connect();

      assert.equal(sockets.length, 1);
      assert.equal(OWP.state.ws, sockets[0]);
    } finally {
      OWP.actions.disconnect();
      globalThis.WebSocket = WebSocket;
    }
  });

  it('closes an open socket when token refresh fails', async () => {
    const originalSetTimeout = OWP.timers.setTimeout;
    const originalClear = OWP.timers.clear;
    const WebSocket = globalThis.WebSocket;
    let refresh;
    let request = 0;
    let closed = false;
    globalThis.WebSocket = { OPEN: 1, CLOSED: 3 };
    OWP.timers.setTimeout = (callback, delay, scope) => {
      if (scope === 'auth' && delay < 10000) refresh = callback;
      return {};
    };
    OWP.timers.clear = () => true;
    globalThis.fetch = async () => {
      request++;
      if (request === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ auth_enabled: true, token: 'initial-token', expires_in: 1, session_server_url: '' })
        };
      }
      return { ok: false, status: 500 };
    };
    OWP.state.ws = {
      readyState: 1,
      close: () => { closed = true; }
    };

    try {
      await OWP.actions.fetchAuthToken();
      await refresh();

      assert.equal(closed, true);
      assert.equal(OWP.state.ws, null);
      assert.equal(OWP.state.authBlocked, true);
      assert.equal(OWP.state.autoReconnect, false);
    } finally {
      OWP.state.ws = null;
      OWP.timers.setTimeout = originalSetTimeout;
      OWP.timers.clear = originalClear;
      globalThis.WebSocket = WebSocket;
    }
  });

  it('keeps an open socket when token refresh explicitly switches to insecure mode', async () => {
    const originalSetTimeout = OWP.timers.setTimeout;
    const originalClear = OWP.timers.clear;
    const WebSocket = globalThis.WebSocket;
    let refresh;
    let request = 0;
    const socket = { readyState: 1, send: () => { throw new Error('insecure refresh must not authenticate'); } };
    globalThis.WebSocket = { OPEN: 1 };
    OWP.timers.setTimeout = (callback, delay, scope) => {
      if (scope === 'auth' && delay < 10000) refresh = callback;
      return {};
    };
    OWP.timers.clear = () => true;
    globalThis.fetch = async () => {
      request++;
      return {
        ok: true,
        status: 200,
        json: async () => request === 1
          ? { auth_enabled: true, token: 'initial-token', expires_in: 1, session_server_url: '' }
          : { auth_enabled: false, insecure_mode: true, session_server_url: '' }
      };
    };
    OWP.state.ws = socket;

    try {
      await OWP.actions.fetchAuthToken();
      await refresh();

      assert.equal(OWP.state.ws, socket);
      assert.equal(OWP.state.authToken, null);
      assert.equal(OWP.state.authBlocked, false);
    } finally {
      OWP.state.ws = null;
      OWP.timers.setTimeout = originalSetTimeout;
      OWP.timers.clear = originalClear;
      globalThis.WebSocket = WebSocket;
    }
  });

  it('ignores a token response invalidated by disconnect or a newer request', async () => {
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    const pending = fetchAuthToken();
    OWP.state.authRequestAttempt++;
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ auth_enabled: true, token: 'stale-token', expires_in: 3600, session_server_url: '' })
    });
    const result = await pending;

    assert.equal(result.mode, 'error');
    assert.equal(result.code, 'request_invalidated');
    assert.equal(OWP.state.authToken, null);
    assert.equal(OWP.state.authBlocked, false);
  });
});
