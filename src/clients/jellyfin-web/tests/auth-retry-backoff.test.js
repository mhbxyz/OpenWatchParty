const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');

let toasts = [];
let connectCalls = 0;
let accessToken = 'token-a';
const realConnect = [];

globalThis.ApiClient = {
  accessToken: () => accessToken,
  serverAddress: () => 'https://media.example'
};
globalThis.WebSocket = class WebSocket {
  static OPEN = 1;
};
globalThis.localStorage = { getItem: () => null };
globalThis.sessionStorage = { getItem: () => null };

OWP.ui = { showToast: message => toasts.push(message), render: () => {} };
OWP.playback = {};
require('../ws/auth.js');
require('../ws/connection.js');
realConnect.push(OWP.actions.connect);
require('../app/lifecycle.js');

const retryConnectionAfterLogin = OWP._lifecycle.retryConnectionAfterLogin;
const realNow = Date.now;
let fakeNow = 1_000_000;

describe('authentication retry watchdog', () => {
  beforeEach(() => {
    fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    toasts = [];
    connectCalls = 0;
    accessToken = 'token-a';
    OWP.actions.connect = () => { connectCalls++; };
    OWP.state.authBlocked = false;
    OWP.state.authError = '';
    OWP.state.isConnecting = false;
    OWP.state.ws = null;
    OWP.state.authFailedToken = '';
    OWP.state.authRetryAttempts = 0;
    OWP.state.authRetryAt = 0;
    OWP.state.lastAuthToastMessage = '';
    OWP.state.lastAuthToastAt = 0;
  });

  afterEach(() => {
    Date.now = realNow;
    OWP._lifecycle.clearAllIntervals();
  });

  it('does not retry while authentication is not blocked', () => {
    assert.equal(retryConnectionAfterLogin(), false);
    assert.equal(connectCalls, 0);
  });

  it('does not retry without a Jellyfin access token', () => {
    accessToken = '';
    OWP.state.authBlocked = true;

    assert.equal(retryConnectionAfterLogin(), false);
    assert.equal(connectCalls, 0);
  });

  it('retries immediately when the rejected token was replaced by a login', () => {
    OWP.state.authBlocked = true;
    OWP.state.authError = 'blocked';
    OWP.state.authFailedToken = 'token-old';
    OWP.state.authRetryAt = fakeNow + 300000;

    assert.equal(retryConnectionAfterLogin(), true);
    assert.equal(connectCalls, 1);
    assert.equal(OWP.state.authBlocked, false);
    assert.equal(OWP.state.authFailedToken, 'token-old');
  });

  it('backs off exponentially while the same token keeps failing', () => {
    OWP.state.authBlocked = true;
    OWP.state.authError = 'blocked';
    OWP.state.authFailedToken = 'token-a';

    assert.equal(retryConnectionAfterLogin(), true, 'first retry is immediate');
    assert.equal(connectCalls, 1);
    const firstDelay = OWP.state.authRetryAt - fakeNow;
    assert.ok(firstDelay > 0, 'first retry schedules a delay');

    OWP.state.authBlocked = true;
    assert.equal(retryConnectionAfterLogin(), false, 'retry inside the backoff window is skipped');
    assert.equal(connectCalls, 1);

    fakeNow += firstDelay;
    OWP.state.authBlocked = true;
    assert.equal(retryConnectionAfterLogin(), true, 'retry after the backoff window is allowed');
    assert.equal(connectCalls, 2);
    const secondDelay = OWP.state.authRetryAt - fakeNow;
    assert.ok(secondDelay > firstDelay, 'the delay grows between attempts');

    fakeNow += secondDelay;
    OWP.state.authBlocked = true;
    assert.equal(retryConnectionAfterLogin(), true);
    assert.equal(connectCalls, 3);
  });

  it('caps the retry delay', () => {
    OWP.state.authBlocked = true;
    OWP.state.authFailedToken = 'token-a';
    OWP.state.authRetryAttempts = 40;

    assert.equal(retryConnectionAfterLogin(), true);
    assert.equal(OWP.state.authRetryAt - fakeNow, OWP.constants.AUTH_RETRY_MAX_MS);
  });

  it('shows the same authentication error only once', async () => {
    const connect = realConnect[0];
    OWP.ui.showToast = message => toasts.push(message);
    OWP.state.autoReconnect = true;
    globalThis.fetch = async () => ({ ok: false, status: 401 });

    await connect();
    await connect();

    assert.equal(OWP.state.authBlocked, true);
    assert.equal(toasts.length, 1, `expected a single toast, got ${JSON.stringify(toasts)}`);
    assert.match(toasts[0], /401/);
  });
});
