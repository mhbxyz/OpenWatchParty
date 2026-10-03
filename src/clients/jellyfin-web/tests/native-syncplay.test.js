const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { FakeDocument } = require('./fake-dom.js');

const OWP = require('./setup.js');
const document = new FakeDocument();
globalThis.document = document;
globalThis.ApiClient = {
  accessToken: () => 'jellyfin-token',
  serverAddress: () => 'https://media.example'
};
globalThis.localStorage = { getItem: () => null };
globalThis.sessionStorage = { getItem: () => null };
require('../ui/styles.js');
require('../ws/auth.js');

const { SYNCPLAY_HIDE_STYLE_ID } = OWP.constants;

const hideStyles = () => [document.head, document.body]
  .flatMap(root => root.querySelectorAll('style'))
  .filter(style => style.id === SYNCPLAY_HIDE_STYLE_ID);

const respondWith = (body) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
};

const responses = {
  authenticated: (settings = {}) => ({
    token: 'session-jwt',
    auth_enabled: true,
    expires_in: 3600,
    user_id: 'user-id',
    user_name: 'User',
    session_server_url: 'wss://media.example/ws',
    ...settings
  }),
  insecure: (settings = {}) => ({
    token: null,
    auth_enabled: false,
    insecure_mode: true,
    user_id: 'user-id',
    user_name: 'User',
    session_server_url: 'wss://media.example/ws',
    ...settings
  })
};

const fetchWith = async (body) => {
  respondWith(body);
  return OWP.actions.fetchAuthToken();
};

describe('native SyncPlay button setting', () => {
  afterEach(() => {
    OWP.timers.clearAll();
    OWP.state.tokenRefreshTimer = null;
    OWP.state.hideNativeSyncPlayButton = false;
    hideStyles().forEach(style => style.remove());
  });

  for (const [mode, response] of Object.entries(responses)) {
    it(`hides SyncPlay in both headers when the ${mode} response enables it`, async () => {
      const result = await fetchWith(response({ hide_native_syncplay_button: true }));

      assert.equal(result.mode, mode);
      assert.equal(OWP.state.hideNativeSyncPlayButton, true);
      const styles = hideStyles();
      assert.equal(styles.length, 1);
      assert.equal(styles[0].parentNode, document.head);
      assert.match(styles[0].textContent, /\.headerSyncButton/);
      assert.match(styles[0].textContent, /button\[aria-controls="app-sync-play-menu"\]/);
      assert.match(styles[0].textContent, /display: none !important/);
    });

    it(`keeps SyncPlay visible when the ${mode} response disables or omits it`, async () => {
      for (const settings of [{ hide_native_syncplay_button: false }, {}, { hide_native_syncplay_button: 'true' }]) {
        await fetchWith(response(settings));

        assert.equal(OWP.state.hideNativeSyncPlayButton, false);
        assert.equal(hideStyles().length, 0);
      }
    });

    it(`removes the hiding style when a later ${mode} response turns it off`, async () => {
      await fetchWith(response({ hide_native_syncplay_button: true }));
      assert.equal(hideStyles().length, 1);

      await fetchWith(response({ hide_native_syncplay_button: false }));

      assert.equal(OWP.state.hideNativeSyncPlayButton, false);
      assert.equal(hideStyles().length, 0);
    });
  }

  it('adds the hiding style only once across token refreshes', async () => {
    await fetchWith(responses.authenticated({ hide_native_syncplay_button: true }));
    await fetchWith(responses.authenticated({ hide_native_syncplay_button: true }));

    assert.equal(hideStyles().length, 1);
  });

  it('ignores a superseded token response that arrives late', async () => {
    let releaseStale;
    globalThis.fetch = () => new Promise(resolve => {
      releaseStale = () => resolve({
        ok: true,
        status: 200,
        json: async () => responses.authenticated({ hide_native_syncplay_button: false })
      });
    });
    const stale = OWP.actions.fetchAuthToken();
    await fetchWith(responses.authenticated({ hide_native_syncplay_button: true }));

    releaseStale();
    const result = await stale;

    assert.equal(result.code, 'request_invalidated');
    assert.equal(OWP.state.hideNativeSyncPlayButton, true);
    assert.equal(hideStyles().length, 1);
  });

  it('restores SyncPlay when the token request fails', async () => {
    await fetchWith(responses.authenticated({ hide_native_syncplay_button: true }));
    assert.equal(hideStyles().length, 1);

    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const result = await OWP.actions.fetchAuthToken();

    assert.equal(result.mode, 'error');
    assert.equal(OWP.state.hideNativeSyncPlayButton, false);
    assert.equal(hideStyles().length, 0);
  });
});
