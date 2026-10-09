const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginRoot = path.join(__dirname, '..', '..', '..', 'plugins', 'jellyfin', 'OpenWatchParty');
const configPage = fs.readFileSync(path.join(pluginRoot, 'Web', 'configPage.html'), 'utf8');
const diagnostics = fs.readFileSync(path.join(pluginRoot, 'OpenWatchPartyDiagnosticsService.cs'), 'utf8');
const script = configPage.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

const documentElement = { lang: 'es' };
const elements = new Map();
const makeElement = () => ({
  style: {},
  className: '',
  textContent: '',
  children: [],
  replaceChildren() { this.children = []; },
  append(...nodes) { this.children.push(...nodes); },
  appendChild(node) { this.children.push(node); }
});
const byId = id => {
  if (!elements.has(id)) elements.set(id, makeElement());
  return elements.get(id);
};
const context = vm.createContext({
  console,
  Map,
  Array,
  Math,
  atob,
  navigator: { userAgent: 'test-agent', language: 'en-US' },
  window: { location: { origin: 'https://media.example' } },
  document: { documentElement, getElementById: byId, createElement: makeElement },
  fetch: async () => ({ json: async () => ({}) }),
  ApiClient: { accessToken: () => '', getUrl: name => '/' + name },
  Dashboard: {},
  $: () => ({ on: () => {} })
});
vm.runInContext(script, context, { filename: 'configPage.html' });
const placeholders = value => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();

describe('configuration page localization', () => {
  it('keeps every shipped locale complete with matching placeholders', () => {
    const { configMessages, configStatusMessages } = context;
    for (const catalogs of [configMessages, configStatusMessages]) {
      const englishKeys = Object.keys(catalogs.en).sort();
      for (const language of ['es', 'fr', 'de']) {
        assert.deepEqual(Object.keys(catalogs[language]).sort(), englishKeys, language);
        for (const key of englishKeys) {
          assert.deepEqual(placeholders(catalogs[language][key]), placeholders(catalogs.en[key]), `${language}.${key}`);
        }
      }
    }
  });

  it('shows the known diagnostic checks in the page language', () => {
    documentElement.lang = 'es';
    assert.equal(context.configCheckLabel('session_http'), 'Servidor de sesión');
    assert.equal(context.configCheckLabel('future_check'), 'future_check');
    assert.equal(context.configCheckSummary('Authentication configuration is valid'), 'La configuración de autenticación es válida');
    assert.equal(context.configCheckSummary('Session 0.5.0, protocol 1'), 'Sesión 0.5.0, protocolo 1');
    assert.equal(context.configCheckSummary('Session server returned HTTP 502'), 'El servidor de sesión respondió HTTP 502');
    assert.equal(context.configStatus('warning'), 'AVISO');
    assert.equal(context.configStatus('constructor'), 'CONSTRUCTOR');
  });

  it('draws the health checks in the page language', () => {
    documentElement.lang = 'es';
    context.OpenWatchPartyConfigurationPage.renderDiagnostics({
      Status: 'degraded',
      Checks: [
        { Id: 'session_http', Status: 'pass', Summary: 'Session 0.5.0, protocol 1' },
        { Id: 'native_injection', Status: 'warning', Summary: 'Native injection has not been observed since Jellyfin started' }
      ]
    });
    const rows = byId('HealthChecks').children.map(row => row.children.map(node => node.textContent));
    assert.deepEqual(rows, [
      ['CORRECTO · Servidor de sesión', 'Sesión 0.5.0, protocolo 1'],
      ['AVISO · Inyección en el cliente', 'No se observó la inyección en el cliente desde que se inició Jellyfin']
    ]);
    assert.equal(byId('SessionVersion').textContent, 'Sesión 0.5.0, protocolo 1');
  });

  it('keeps any other detail as the plugin wrote it', () => {
    documentElement.lang = 'es';
    assert.equal(context.configCheckSummary('Connection refused (127.0.0.1:3000)'), 'Connection refused (127.0.0.1:3000)');
    assert.equal(context.configCheckSummary('constructor'), 'constructor');
    assert.equal(context.configCheckSummary(undefined), '');
    documentElement.lang = 'en';
    assert.equal(context.configCheckSummary('Session destination is not configured'), 'Session destination is not configured');
  });

  // The page without its <script> or <style> blocks, found by plain text
  // search: only the markup is checked here.
  const withoutBlocks = (html, tag) => {
    const lower = html.toLowerCase();
    let kept = '';
    let index = 0;
    for (;;) {
      const start = lower.indexOf(`<${tag}`, index);
      if (start === -1) return kept + html.slice(index);
      kept += html.slice(index, start);
      const end = lower.indexOf(`</${tag}>`, start);
      if (end === -1) return kept;
      index = end + tag.length + 3;
    }
  };

  it('marks every text and label of the page for translation', () => {
    // Product names and a Material icon glyph stay as they are.
    const untranslated = new Set(['OpenWatchParty', 'visibility']);
    const markup = withoutBlocks(withoutBlocks(configPage, 'script'), 'style');
    const violations = [];
    for (const [, tag, attributes, text] of markup.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>([^<]*[A-Za-z][^<]*)</g)) {
      if (!attributes.includes('data-i18n=') && !untranslated.has(text.trim())) violations.push(`<${tag}> ${text.trim()}`);
    }
    for (const [, tag, attributes] of markup.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
      for (const attribute of ['label', 'placeholder', 'title', 'aria-label']) {
        const value = attributes.match(new RegExp(`\\s${attribute}="([^"]*[A-Za-z][^"]*)"`));
        if (value && !attributes.includes(`data-i18n-${attribute}=`)) violations.push(`<${tag} ${attribute}> ${value[1]}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('passes only catalog messages to the page alerts and confirmations', () => {
    const literal = /(?:Dashboard\.alert|window\.confirm|\.text)\(\s*(['"`])/;
    const offending = script.split(/\r?\n/).filter(line => literal.test(line));
    assert.deepEqual(offending, []);
  });

  it('translates every marked text and label when the page loads', () => {
    documentElement.lang = 'es';
    const marked = [];
    for (const [, attributes] of configPage.matchAll(/<[a-zA-Z][\w-]*([^>]*)>/g)) {
      for (const [, kind, key] of attributes.matchAll(/data-i18n(?:-(label|placeholder|title))?="([^"]+)"/g)) {
        marked.push({ kind: kind || 'text', key, attributes: { [`data-i18n${kind ? '-' + kind : ''}`]: key }, textContent: '' });
      }
    }
    assert.ok(marked.length > 30);
    const element = entry => Object.assign(entry, {
      getAttribute: name => entry.attributes[name] ?? null,
      setAttribute: (name, value) => { entry.attributes[name] = value; }
    });
    marked.forEach(element);
    const root = {
      querySelectorAll: selector => {
        const kind = selector === '[data-i18n]' ? 'text' : selector.match(/data-i18n-(\w+)/)[1];
        return marked.filter(entry => entry.kind === kind);
      }
    };
    const page = { title: '' };
    context.document.querySelector = () => root;
    context.document.querySelectorAll = () => [];
    Object.defineProperty(context.document, 'title', { set: value => { page.title = value; }, configurable: true });
    context.localizeConfigurationPage();

    assert.equal(page.title, 'Configuración de OpenWatchParty');
    for (const entry of marked) {
      const value = entry.kind === 'text' ? entry.textContent : entry.attributes[entry.kind];
      assert.equal(value, context.configMessages.es[entry.key], `${entry.kind} ${entry.key}`);
      assert.ok(value, `${entry.kind} ${entry.key} has a Spanish text`);
    }
  });

  it('maps every fixed summary the plugin reports, and only those', () => {
    const fixed = [...diagnostics.matchAll(/(?<!\$)"([A-Z][A-Za-z-]+ [^"]+)"/g)].map(match => match[1]).sort();
    assert.deepEqual(Object.keys(context.configCheckSummaries).sort(), fixed);
  });

  it('matches the checks and summaries the plugin reports', () => {
    for (const id of Object.keys(context.configCheckLabels)) {
      assert.ok(diagnostics.includes(`"${id}"`), `check id ${id} is no longer reported by the plugin`);
    }
    for (const summary of Object.keys(context.configCheckSummaries)) {
      assert.ok(diagnostics.includes(`"${summary}"`), `summary "${summary}" is no longer reported by the plugin`);
    }
    assert.ok(diagnostics.includes('$"Session {sessionVersion ?? "unknown"}, protocol {protocol}"'));
    assert.ok(diagnostics.includes('$"Session server returned HTTP {(int)response.StatusCode}"'));
  });
});
