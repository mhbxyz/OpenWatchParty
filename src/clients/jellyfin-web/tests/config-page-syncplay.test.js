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

const VALID_SECRET = 'B0vLhmX5ZY1mQ4NfIYBcr8VWxOTQ02cbeQ9x7B3K4ow=';

// Minimal jQuery stand-in: form fields keep their value/checked/text state and
// their handlers, and the page and form selectors record the handlers the
// configuration page registers.
const loadConfigPage = (storedConfig, { diagnostics } = {}) => {
  const fields = new Map();
  const handlers = {};
  const saved = [];
  const pageElement = { id: 'page' };
  const formElement = { id: 'form' };
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: '', checked: false, text: '', handlers: {}, events: [] });
    const state = fields.get(id);
    return {
      0: { dispatchEvent: event => state.events.push(event.type) },
      val(value) {
        if (value === undefined) return state.value;
        state.value = value;
        return this;
      },
      prop(name, value) {
        if (value === undefined) return state[name];
        state[name] = value;
        return this;
      },
      text(value) {
        if (value === undefined) return state.text;
        state.text = value;
        return this;
      },
      css() {
        return this;
      },
      on: (events, handler) => {
        events.split(' ').forEach((event) => { state.handlers[event] = handler; });
      }
    };
  };
  const $ = (selector) => {
    if (selector === pageElement || selector === formElement) {
      return { parents: () => [pageElement] };
    }
    if (selector === '.pluginConfigurationPage' || selector === '.openwatchpartyConfigurationForm') {
      return { on: (event, handler) => { handlers[event] = handler; } };
    }
    if (typeof selector === 'string' && selector.startsWith('#')) return field(selector.slice(1));
    return { on: () => {} };
  };
  const context = vm.createContext({
    console,
    URL,
    Map,
    Array,
    Math,
    Number,
    atob,
    Event: class { constructor(type) { this.type = type; } },
    navigator: { userAgent: 'test-agent' },
    window: {
      location: { origin: 'https://media.example', protocol: 'https:', hostname: 'media.example', port: '' },
      confirm: () => true
    },
    document: { getElementById: () => null, createElement: () => ({}) },
    fetch: async () => ({ json: async () => ({}) }),
    ApiClient: {
      accessToken: () => 'jelly-token',
      getUrl: name => '/jellyfin/' + name,
      getPluginConfiguration: async () => ({ ...storedConfig }),
      updatePluginConfiguration: async (id, config) => { saved.push(config); }
    },
    Dashboard: {
      showLoadingMsg: () => {},
      hideLoadingMsg: () => {},
      alert: (message) => { throw new Error(`Unexpected alert: ${message}`); },
      processPluginConfigurationUpdateResult: () => {}
    },
    $
  });
  vm.runInContext(script, context, { filename: 'configPage.html' });
  const page = context.OpenWatchPartyConfigurationPage;
  const updateAuthStatus = page.updateAuthStatus;
  const authStatusCalls = [];
  page.init = async () => {};
  page.runDiagnostics = async () => diagnostics;
  page.updateAuthStatus = (target, config, result) => { authStatusCalls.push([config, result]); };

  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    fields,
    saved,
    authStatusCalls,
    authStatus(config, result) {
      updateAuthStatus.call(page, pageElement, config, result);
      return fields.get('AuthStatus').text;
    },
    async show() {
      handlers.pageshow.call(pageElement);
      await settle();
    },
    async submit() {
      handlers.submit.call(formElement, { preventDefault: () => {} });
      await settle();
      await settle();
    },
    click(id) {
      fields.get(id).handlers.click.call(pageElement);
    }
  };
};

describe('configuration page native SyncPlay setting', () => {
  const baseConfig = {
    JwtSecret: VALID_SECRET,
    SessionServerUrl: 'wss://media.example/ws'
  };

  it('leaves the checkbox unchecked when the setting is missing or off', async () => {
    const missing = loadConfigPage(baseConfig);
    await missing.show();
    assert.equal(missing.fields.get('HideNativeSyncPlayButton').checked, false);

    const off = loadConfigPage({ ...baseConfig, HideNativeSyncPlayButton: false });
    await off.show();
    assert.equal(off.fields.get('HideNativeSyncPlayButton').checked, false);
  });

  it('round-trips an enabled setting through load and save', async () => {
    const form = loadConfigPage({ ...baseConfig, HideNativeSyncPlayButton: true });
    await form.show();
    assert.equal(form.fields.get('HideNativeSyncPlayButton').checked, true);

    await form.submit();

    assert.equal(form.saved.length, 1);
    assert.equal(form.saved[0].HideNativeSyncPlayButton, true);
  });

  it('saves the setting as off once the checkbox is cleared', async () => {
    const form = loadConfigPage({ ...baseConfig, HideNativeSyncPlayButton: true });
    await form.show();
    form.fields.get('HideNativeSyncPlayButton').checked = false;

    await form.submit();

    assert.equal(form.saved.length, 1);
    assert.equal(form.saved[0].HideNativeSyncPlayButton, false);
  });
});

describe('configuration page sync adjustment setting', () => {
  const baseConfig = {
    JwtSecret: VALID_SECRET,
    SessionServerUrl: 'wss://media.example/ws'
  };

  it('leaves the checkbox unchecked when the setting is missing or off', async () => {
    const missing = loadConfigPage(baseConfig);
    await missing.show();
    assert.equal(missing.fields.get('ShowSyncNudgeButton').checked, false);

    const off = loadConfigPage({ ...baseConfig, ShowSyncNudgeButton: false });
    await off.show();
    assert.equal(off.fields.get('ShowSyncNudgeButton').checked, false);
  });

  it('round-trips an enabled setting through load and save, apart from the SyncPlay one', async () => {
    const form = loadConfigPage({ ...baseConfig, ShowSyncNudgeButton: true });
    await form.show();
    assert.equal(form.fields.get('ShowSyncNudgeButton').checked, true);
    assert.equal(form.fields.get('HideNativeSyncPlayButton').checked, false);

    await form.submit();

    assert.equal(form.saved.length, 1);
    assert.equal(form.saved[0].ShowSyncNudgeButton, true);
    assert.equal(form.saved[0].HideNativeSyncPlayButton, false);
  });

  it('saves the setting as off once the checkbox is cleared', async () => {
    const form = loadConfigPage({ ...baseConfig, ShowSyncNudgeButton: true, HideNativeSyncPlayButton: true });
    await form.show();
    form.fields.get('ShowSyncNudgeButton').checked = false;

    await form.submit();

    assert.equal(form.saved.length, 1);
    assert.equal(form.saved[0].ShowSyncNudgeButton, false);
    assert.equal(form.saved[0].HideNativeSyncPlayButton, true);
  });
});

describe('configuration page appearance settings', () => {
  const baseConfig = {
    JwtSecret: VALID_SECRET,
    SessionServerUrl: 'wss://media.example/ws'
  };
  const shown = form => ({
    opacity: form.fields.get('AppearanceOpacity').value,
    textSize: form.fields.get('AppearanceTextSize').value,
    labels: [form.fields.get('AppearanceOpacityValue').text, form.fields.get('AppearanceTextSizeValue').text]
  });

  it('shows and saves the defaults when the settings are missing', async () => {
    const form = loadConfigPage(baseConfig);
    await form.show();
    assert.deepEqual(shown(form), { opacity: 55, textSize: 14, labels: ['55 %', '14 px'] });
    // The sliders redraw their track for the new value.
    assert.deepEqual(form.fields.get('AppearanceOpacity').events, ['change']);

    await form.submit();

    assert.equal(form.saved[0].AppearanceOpacity, 55);
    assert.equal(form.saved[0].AppearanceTextSize, 14);
  });

  it('round-trips stored values through load and save', async () => {
    const form = loadConfigPage({ ...baseConfig, AppearanceOpacity: 80, AppearanceTextSize: 17 });
    await form.show();
    assert.deepEqual(shown(form), { opacity: 80, textSize: 17, labels: ['80 %', '17 px'] });

    await form.submit();

    assert.equal(form.saved[0].AppearanceOpacity, 80);
    assert.equal(form.saved[0].AppearanceTextSize, 17);
  });

  it('restores the defaults with the reset button', async () => {
    const form = loadConfigPage({ ...baseConfig, AppearanceOpacity: 80, AppearanceTextSize: 17 });
    await form.show();
    form.click('ResetAppearanceButton');
    assert.deepEqual(shown(form), { opacity: 55, textSize: 14, labels: ['55 %', '14 px'] });

    await form.submit();

    assert.equal(form.saved[0].AppearanceOpacity, 55);
    assert.equal(form.saved[0].AppearanceTextSize, 14);
  });
});

describe('configuration page authentication status', () => {
  const keyDiagnostics = (status, summary) => ({
    AuthenticationMode: 'jwt',
    Checks: [{ Id: 'authentication_configuration', Status: status, Summary: summary }]
  });

  it('shows an active RSA signing key as enabled, whatever the shared secret', () => {
    const form = loadConfigPage({});
    const active = keyDiagnostics('pass', 'Authentication configuration is valid');
    assert.equal(form.authStatus({ JwtSecret: '' }), 'BLOCKED: configure a JWT secret');
    assert.equal(form.authStatus({ JwtSecret: '' }, active), 'Authentication enabled');
    assert.equal(form.authStatus({ JwtSecret: 'short' }), 'BLOCKED: JWT secret must contain at least 32 Unicode characters');
    assert.equal(form.authStatus({ JwtSecret: 'short' }, active), 'Authentication enabled');
  });

  it('shows the key error the diagnostics report, even with a valid shared secret', () => {
    const form = loadConfigPage({});
    const summary = 'The RSA signing key file (keys/signing-key.json) cannot be read; restore it or remove it';
    assert.equal(form.authStatus({ JwtSecret: '' }, keyDiagnostics('fail', summary)), `BLOCKED: ${summary}`);
    assert.equal(form.authStatus({ JwtSecret: VALID_SECRET }, keyDiagnostics('fail', summary)), `BLOCKED: ${summary}`);
  });

  it('keeps the shared secret and development mode statuses', () => {
    const form = loadConfigPage({});
    const insecure = { AuthenticationMode: 'insecure', Checks: [{ Id: 'authentication_configuration', Status: 'pass' }] };
    assert.equal(form.authStatus({ JwtSecret: VALID_SECRET }, keyDiagnostics('pass')), 'Authentication enabled');
    assert.equal(form.authStatus({ JwtSecret: '', AllowInsecureNoAuth: true }, insecure), 'INSECURE DEVELOPMENT MODE');
    // Without a key or a secret the diagnostics fail too, but the page's own message is translated.
    const unconfigured = { AuthenticationMode: 'insecure',
      Checks: [{ Id: 'authentication_configuration', Status: 'fail', Summary: 'JWT authentication is not configured' }] };
    assert.equal(form.authStatus({ JwtSecret: '' }, unconfigured), 'BLOCKED: configure a JWT secret');
    const invalidSecret = { AuthenticationMode: 'jwt',
      Checks: [{ Id: 'authentication_configuration', Status: 'fail', Summary: 'JWT secret must contain at least 32 Unicode characters' }] };
    assert.equal(form.authStatus({ JwtSecret: 'short' }, invalidSecret), 'BLOCKED: JWT secret must contain at least 32 Unicode characters');
  });

  it('updates the status with the diagnostics once the page loads', async () => {
    const diagnostics = keyDiagnostics('pass', 'Authentication configuration is valid');
    const form = loadConfigPage({ JwtSecret: '' }, { diagnostics });
    await form.show();
    assert.equal(form.authStatusCalls.length, 2);
    assert.equal(form.authStatusCalls[0][1], undefined);
    assert.equal(form.authStatusCalls[1][1], diagnostics);
  });
});
