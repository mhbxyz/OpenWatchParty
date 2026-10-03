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

// Minimal jQuery stand-in: form fields keep their value/checked state, and the
// page and form selectors record the handlers the configuration page registers.
const loadConfigPage = (storedConfig) => {
  const fields = new Map();
  const handlers = {};
  const saved = [];
  const pageElement = { id: 'page' };
  const formElement = { id: 'form' };
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: '', checked: false });
    const state = fields.get(id);
    return {
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
      on: () => {}
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
    atob,
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
  page.init = async () => {};
  page.runDiagnostics = () => {};
  page.updateAuthStatus = () => {};

  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    fields,
    saved,
    async show() {
      handlers.pageshow.call(pageElement);
      await settle();
    },
    async submit() {
      handlers.submit.call(formElement, { preventDefault: () => {} });
      await settle();
      await settle();
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
