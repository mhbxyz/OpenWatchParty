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

const makeElement = () => ({
  style: {},
  className: '',
  textContent: '',
  replaceChildren: () => {},
  append: () => {},
  appendChild: () => {}
});

const context = vm.createContext({
  console,
  Map,
  Array,
  Math,
  atob,
  navigator: { userAgent: 'test-agent' },
  window: { location: { origin: 'https://media.example' } },
  document: {
    getElementById: () => makeElement(),
    createElement: () => makeElement()
  },
  fetch: async () => ({ json: async () => ({}) }),
  ApiClient: {
    accessToken: () => 'jelly-token',
    getUrl: name => '/jellyfin/' + name
  },
  Dashboard: {},
  $: () => ({ on: () => {} })
});
vm.runInContext(script, context, { filename: 'configPage.html' });
const page = context.OpenWatchPartyConfigurationPage;

describe('configuration page support report', () => {
  it('authenticates plugin requests with the modern Jellyfin header', () => {
    const headers = page.authHeaders();

    assert.equal(headers.Authorization, 'MediaBrowser Token="jelly-token"');
    assert.equal(headers['X-Emby-Token'], undefined);
  });

  it('reports that diagnostics have not run yet instead of staying silent', () => {
    page.lastDiagnostics = null;
    page.lastSuccessfulDiagnostics = null;
    page.lastDiagnosticsError = null;
    const report = page.supportReport();

    assert.equal(report.diagnostics_ran, false);
    assert.equal(report.diagnostics_error, null);
    assert.equal(report.browser_loader, 'not_loaded');
    assert.ok(Array.isArray(report.checks));
    assert.equal(report.checks.length, 0);
    assert.equal(report.user_agent, 'test-agent');
    assert.equal(report.page_origin, 'https://media.example');
  });

  it('keeps the last successful versions when a later run fails', async () => {
    context.fetch = async () => ({
      ok: true,
      json: async () => ({
        OverallStatus: 'ready',
        PluginVersion: '0.4.0',
        JellyfinVersion: '12.1.0',
        JellyfinTargetAbi: '12.0.0.0',
        Checks: []
      })
    });
    await page.runDiagnostics(false);

    context.fetch = async () => { throw new Error('NetworkError'); };
    await page.runDiagnostics(false);

    const report = page.supportReport();
    assert.equal(report.diagnostics_ran, true);
    assert.equal(report.diagnostics_error, 'NetworkError');
    assert.equal(report.plugin_version, '0.4.0');
    assert.equal(report.jellyfin_version, '12.1.0');
    assert.equal(report.target_abi, '12.0.0.0');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].code, 'DIAGNOSTICS_UNREACHABLE');
  });

  it('keeps a failed diagnostics run in the support report', async () => {
    context.fetch = async () => { throw new Error('NetworkError'); };

    await page.runDiagnostics(false);

    assert.equal(page.lastDiagnosticsError, 'NetworkError');
    assert.equal(page.lastDiagnostics.OverallStatus, 'blocked');

    const report = page.supportReport();
    assert.equal(report.diagnostics_ran, true);
    assert.equal(report.diagnostics_error, 'NetworkError');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].id, 'diagnostics');
    assert.equal(report.checks[0].code, 'DIAGNOSTICS_UNREACHABLE');
    assert.match(report.checks[0].summary, /NetworkError/);
  });

  it('uses the modern header for the diagnostics request', async () => {
    let captured = null;
    context.fetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ OverallStatus: 'ready', Checks: [] }) };
    };

    await page.runDiagnostics(false);

    assert.equal(captured.options.headers.Authorization, 'MediaBrowser Token="jelly-token"');
    assert.equal(captured.url, '/jellyfin/OpenWatchParty/Diagnostics/Status');
  });
});
