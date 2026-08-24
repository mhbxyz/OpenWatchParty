const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');

const runLoader = async (currentScriptSrc, pageUrl) => {
  const loadedScripts = [];
  const location = new URL(pageUrl);
  const document = {
    currentScript: currentScriptSrc ? { src: currentScriptSrc } : null,
    createElement: () => {
      const script = { async: true, onload: null, onerror: null };
      Object.defineProperty(script, 'src', {
        get: () => script.resolvedSrc,
        set: (value) => { script.resolvedSrc = new URL(value, location.href).href; }
      });
      return script;
    },
    head: {
      appendChild: (script) => {
        loadedScripts.push(script.src);
        queueMicrotask(() => script.onload());
      }
    }
  };
  const window = { location };
  const context = vm.createContext({
    window,
    document,
    URL,
    Date,
    Promise,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console
  });

  vm.runInContext(loaderSource, context, { filename: 'plugin.js' });
  for (let attempt = 0; attempt < 100 && loadedScripts.length < 26; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(loadedScripts.length, 26, 'the loader should request every declared module');
  return loadedScripts;
};

describe('plugin loader base path', () => {
  it('loads modules from the server root', async () => {
    const scripts = await runLoader(
      'http://localhost:8096/OpenWatchParty/ClientScript?v=root-version',
      'http://localhost:8096/web/index.html'
    );

    assert.equal(
      scripts[0],
      'http://localhost:8096/OpenWatchParty/Client/state.js?v=root-version'
    );
    assert.ok(scripts.every(src => src.startsWith('http://localhost:8096/OpenWatchParty/Client/')));
  });

  it('preserves a Jellyfin base path from the loader URL', async () => {
    const scripts = await runLoader(
      'https://media.example/jellyfin/OpenWatchParty/ClientScript?v=base-version',
      'https://media.example/jellyfin/web/index.html'
    );

    assert.equal(
      scripts[0],
      'https://media.example/jellyfin/OpenWatchParty/Client/state.js?v=base-version'
    );
    assert.ok(scripts.every(src => src.startsWith('https://media.example/jellyfin/OpenWatchParty/Client/')));
  });

  it('falls back to the root when currentScript is unavailable', async () => {
    const scripts = await runLoader(null, 'https://media.example/jellyfin/web/index.html');

    assert.ok(scripts.every(src => src.startsWith('https://media.example/OpenWatchParty/Client/')));
  });
});
