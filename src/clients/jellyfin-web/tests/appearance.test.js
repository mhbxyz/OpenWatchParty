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

const { APPEARANCE_STYLE_ID, STYLE_ID } = OWP.constants;

const appearanceStyles = () => document.head.querySelectorAll('style')
  .filter(style => style.id === APPEARANCE_STYLE_ID);
const variables = () => {
  const styles = appearanceStyles();
  assert.equal(styles.length, 1);
  const text = styles[0].textContent;
  return {
    scale: Number(text.match(/--owp-scale: ([\d.]+)/)[1]),
    alpha: Number(text.match(/--owp-surface-alpha: ([\d.]+)/)[1])
  };
};
const set = (opacity, textSize) => {
  OWP.state.appearanceOpacity = opacity;
  OWP.state.appearanceTextSize = textSize;
  OWP.ui.applyAppearance();
};

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

describe('appearance settings', () => {
  afterEach(() => {
    OWP.timers.clearAll();
    OWP.state.tokenRefreshTimer = null;
    appearanceStyles().forEach(style => style.remove());
  });

  it('turns the settings into the text scale and the surface opacity', () => {
    set(80, 18);
    assert.deepEqual(variables(), { scale: 1.5, alpha: 0.8 });
    set(55, 14);
    assert.deepEqual(variables(), { scale: 14 / 12, alpha: 0.55 });
    // One style element, updated in place.
    set(40, 12);
    assert.deepEqual(variables(), { scale: 1, alpha: 0.4 });
  });

  it('falls back to the defaults for a missing or out-of-range value', () => {
    for (const [opacity, textSize] of [[undefined, undefined], [35, 11], [105, 19], [57, 14.5], ['60', '15']]) {
      set(opacity, textSize);
      assert.deepEqual(variables(), { scale: 14 / 12, alpha: 0.55 }, `${opacity} ${textSize}`);
    }
    set(100, 15);
    assert.deepEqual(variables(), { scale: 15 / 12, alpha: 1 });
  });

  it('targets the panel, the up-next strip and the toasts above the defaults of the main stylesheet', () => {
    set(70, 16);
    const text = appearanceStyles()[0].textContent;
    for (const selector of [':root #owp-panel', ':root .owp-toast-container', ':root .owp-toast-system', ':root .owp-queue-next']) {
      assert.ok(text.includes(selector), selector);
    }
  });

  for (const [mode, response] of Object.entries(responses)) {
    it(`applies the appearance of the ${mode} token response, and the defaults without one`, async () => {
      respondWith(response({ appearance_opacity: 85, appearance_text_size: 16 }));
      assert.equal((await OWP.actions.fetchAuthToken()).mode, mode);
      assert.deepEqual(variables(), { scale: 16 / 12, alpha: 0.85 });

      // An older plugin sends no appearance.
      respondWith(response());
      await OWP.actions.fetchAuthToken();
      assert.deepEqual(variables(), { scale: 14 / 12, alpha: 0.55 });
    });
  }
});

describe('appearance styles', () => {
  OWP.ui.injectStyles();
  const css = document.getElementById(STYLE_ID).textContent;

  it('scales every size of the panel and the toasts with the text size', () => {
    const panel = css.slice(css.indexOf('#owp-panel, .owp-toast-container'));
    const unscaled = panel.replace(/calc\(-?\d+(\.\d+)?px \* var\(--owp-scale\)\)/g, '');
    // What stays fixed: hairline borders, the visually hidden text, the window
    // widths of the media queries, the places on screen, the margins to the
    // window edges, the animations and the blur.
    const fixed = /1px solid|width: 1px; height: 1px|@media \(max-width: \d+px\)|top: 72px; right: 20px|bottom: 100px; right: 20px|left: 8px; right: 8px|calc\(100v[wh] - \d+px\)|translateX\(20px\)|blur\(1[02]px\)/g;
    assert.deepEqual(unscaled.replace(fixed, '').match(/\d+(\.\d+)?px/g), null);
  });

  it('keeps the room bar and the floating up-next strip inside narrow windows at any text size', () => {
    assert.equal(css.split('min-width: min(calc(300px * var(--owp-scale)), calc(100vw - 40px));').length - 1, 2);
  });

  it('starts at 14 px and 55 %, and turns opaque when less transparency is asked for', () => {
    assert.match(css, /#owp-panel, \.owp-toast-container, \.owp-toast-system, \.owp-queue-next, \.owp-start-float \{\s*--owp-scale: 1\.1666/);
    assert.match(css, /--owp-surface-alpha: 0\.55/);
    assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{\s*#owp-panel, \.owp-toast-container, \.owp-toast-system, \.owp-queue-next, \.owp-start-float \{ --owp-surface-alpha: 1 !important; \}/);
  });

  it('draws every surface with the opacity setting', () => {
    assert.equal(css.match(/rgba\(38, 38, 36, 0\.97\)/g), null);
    assert.equal(css.match(/rgba\(38, 38, 36, var\(--owp-surface-alpha\)\)/g).length, 6);
    assert.match(css, /rgba\(20, 20, 20, var\(--owp-surface-alpha\)\)/);
  });
});
