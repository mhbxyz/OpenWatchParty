const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const LOADER_URL = 'http://localhost:8096/OpenWatchParty/ClientScript?v=test-version';
const PAGE_URL = 'http://localhost:8096/web/index.html';

const createHarness = ({ currentScriptSrc = LOADER_URL, pageUrl = PAGE_URL, behavior, initBehavior } = {}) => {
  const location = new URL(pageUrl);
  location.reload = () => { reloadCount++; };
  const scripts = [];
  const timers = new Map();
  let nextTimer = 1;
  let initCount = 0;
  let reloadCount = 0;

  const harness = {
    behavior: behavior || ((script) => queueMicrotask(() => harness.load(script))),
    scripts,
    load(script) {
      if (script.module === 'app/lifecycle.js') {
        window.OpenWatchParty.app = {
          init: () => {
            initCount++;
            if (initBehavior) initBehavior(initCount);
          }
        };
      }
      script.onload();
    },
    error(script) {
      script.onerror();
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    inject(src = currentScriptSrc) {
      document.currentScript = src ? { src } : null;
      vm.runInContext(loaderSource, context, { filename: 'plugin.js' });
      return window.OpenWatchParty.loader;
    },
    get initCount() { return initCount; },
    get reloadCount() { return reloadCount; },
    get OWP() { return window.OpenWatchParty; },
  };

  const head = {
    appendChild(script) {
      script.parentNode = head;
      scripts.push(script);
      harness.behavior(script, harness);
    },
    removeChild(script) {
      script.removed = true;
      script.parentNode = null;
    },
  };
  const document = {
    currentScript: null,
    createElement() {
      const script = { async: true, onload: null, onerror: null, parentNode: null, removed: false };
      Object.defineProperty(script, 'src', {
        get: () => script.resolvedSrc,
        set(value) {
          script.resolvedSrc = new URL(value, location.href).href;
          script.module = new URL(script.resolvedSrc).pathname.split('/OpenWatchParty/Client/')[1];
        },
      });
      return script;
    },
    head,
  };
  const window = { location };
  const context = vm.createContext({
    window,
    document,
    URL,
    Date,
    Promise,
    Set,
    queueMicrotask,
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { error() {} },
  });

  harness.inject();
  return harness;
};

const waitForLoad = async (harness) => {
  await harness.OWP.loader.promise;
  return harness.scripts.map(script => script.src);
};

describe('plugin loader base path', () => {
  it('loads modules from the server root', async () => {
    const harness = createHarness({
      currentScriptSrc: 'http://localhost:8096/OpenWatchParty/ClientScript?v=root-version',
    });
    const scripts = await waitForLoad(harness);

    assert.equal(scripts.length, 26);
    assert.equal(scripts[0], 'http://localhost:8096/OpenWatchParty/Client/state.js?v=root-version');
    assert.ok(scripts.every(src => src.startsWith('http://localhost:8096/OpenWatchParty/Client/')));
  });

  it('preserves a Jellyfin base path from the loader URL', async () => {
    const harness = createHarness({
      currentScriptSrc: 'https://media.example/jellyfin/OpenWatchParty/ClientScript?v=base-version',
      pageUrl: 'https://media.example/jellyfin/web/index.html',
    });
    const scripts = await waitForLoad(harness);

    assert.equal(scripts[0], 'https://media.example/jellyfin/OpenWatchParty/Client/state.js?v=base-version');
    assert.ok(scripts.every(src => src.startsWith('https://media.example/jellyfin/OpenWatchParty/Client/')));
  });

  it('falls back to the root when currentScript is unavailable', async () => {
    const harness = createHarness({
      currentScriptSrc: null,
      pageUrl: 'https://media.example/jellyfin/web/index.html',
    });
    const scripts = await waitForLoad(harness);

    assert.ok(scripts.every(src => src.startsWith('https://media.example/OpenWatchParty/Client/')));
  });
});

describe('plugin loader failure recovery', () => {
  it('fails on timeout and removes the timed-out script', async () => {
    const harness = createHarness({ behavior() {} });
    const loader = harness.inject();
    const loading = loader.promise;

    harness.runTimers();
    await assert.rejects(loading, /Timeout loading state\.js/);
    assert.equal(loader.state, 'failed');
    assert.equal(loader.promise, null);
    assert.equal(harness.OWP.__loaded, false);
    assert.equal(harness.scripts[0].removed, true);
  });

  it('fails on a network error and removes the failed script', async () => {
    const harness = createHarness({ behavior: (script, h) => queueMicrotask(() => h.error(script)) });
    const loader = harness.inject();

    await assert.rejects(loader.promise, /Failed to load state\.js/);
    assert.equal(loader.state, 'failed');
    assert.equal(harness.scripts[0].removed, true);
  });

  it('ignores a module callback arriving after timeout', async () => {
    const harness = createHarness({ behavior() {} });
    const loader = harness.inject();
    const lateOnload = harness.scripts[0].onload;
    const loading = loader.promise;

    harness.runTimers();
    await assert.rejects(loading);
    lateOnload();
    await Promise.resolve();

    assert.equal(loader.state, 'failed');
    assert.equal(loader.loadedModules.has('state.js'), false);
    assert.equal(harness.scripts.length, 1);
  });

  it('shares one promise when plugin.js is injected twice while loading', () => {
    const harness = createHarness({ behavior() {} });
    const loader = harness.inject();
    const loading = loader.promise;

    const reinjected = harness.inject();

    assert.equal(reinjected, loader);
    assert.equal(reinjected.promise, loading);
    assert.equal(harness.scripts.length, 1);
  });

  it('retries on reinjection, retaining successful modules without running init twice', async () => {
    let failFirstAttempt = true;
    const harness = createHarness({
      behavior(script, h) {
        if (failFirstAttempt && script.module === 'utils/video.js') {
          queueMicrotask(() => h.error(script));
        } else if (failFirstAttempt && script.module === 'utils/misc.js') {
          // Keep one sibling pending so failure cancellation can remove it.
        } else {
          queueMicrotask(() => h.load(script));
        }
      },
    });
    const loader = harness.inject();
    const firstLoad = loader.promise;

    await assert.rejects(firstLoad, /Failed to load utils\/video\.js/);
    assert.equal(loader.state, 'failed');
    assert.equal(loader.loadedModules.has('state.js'), true);
    assert.equal(loader.loadedModules.has('utils/time.js'), true);
    assert.equal(harness.scripts.find(script => script.module === 'utils/misc.js').removed, true);

    failFirstAttempt = false;
    const beforeRetry = harness.scripts.length;
    harness.inject();
    const retry = loader.promise;
    harness.inject();
    assert.equal(loader.promise, retry);
    await retry;

    const retriedModules = harness.scripts.slice(beforeRetry).map(script => script.module);
    assert.equal(loader.state, 'loaded');
    assert.equal(harness.OWP.__loaded, true);
    assert.equal(loader.loadedModules.size, 26);
    assert.equal(retriedModules.includes('state.js'), false);
    assert.equal(retriedModules.includes('utils/time.js'), false);
    assert.equal(harness.initCount, 1);
    assert.equal(harness.scripts.length, 28);

    const loadedPromise = loader.promise;
    assert.equal(loader.retry(), loadedPromise);
    harness.inject();
    assert.equal(harness.initCount, 1);
    assert.equal(harness.scripts.length, 28);
  });

  it('automatically retries a transient module failure', async () => {
    let fail = true;
    const harness = createHarness({
      behavior(script, h) {
        if (fail && script.module === 'state.js') queueMicrotask(() => h.error(script));
        else queueMicrotask(() => h.load(script));
      },
    });
    const loader = harness.OWP.loader;
    await assert.rejects(loader.promise, /Failed to load state\.js/);

    fail = false;
    harness.runTimers();
    await loader.promise;

    assert.equal(loader.state, 'loaded');
    assert.equal(harness.initCount, 1);
  });

  it('reconfigures base and cache after failure before any module succeeds', async () => {
    let fail = true;
    const harness = createHarness({
      behavior(script, h) {
        if (fail) queueMicrotask(() => h.error(script));
        else queueMicrotask(() => h.load(script));
      },
    });
    const loader = harness.OWP.loader;
    await assert.rejects(loader.promise);

    fail = false;
    const beforeRetry = harness.scripts.length;
    harness.inject('https://media.example/jellyfin/OpenWatchParty/ClientScript?v=new-version');
    await loader.promise;

    assert.ok(harness.scripts[beforeRetry].src.startsWith(
      'http://localhost:8096/jellyfin/OpenWatchParty/Client/state.js?v=new-version'
    ));
    assert.equal(harness.reloadCount, 0);
  });

  it('reloads the page instead of mixing versions after a partial load', async () => {
    const harness = createHarness({
      behavior(script, h) {
        if (script.module === 'utils/video.js') queueMicrotask(() => h.error(script));
        else queueMicrotask(() => h.load(script));
      },
    });
    const loader = harness.OWP.loader;
    await assert.rejects(loader.promise);

    harness.inject('https://media.example/OpenWatchParty/ClientScript?v=other-version');
    const scriptsBeforeTimers = harness.scripts.length;
    harness.runTimers();

    assert.equal(loader.requiresReload, true);
    assert.equal(harness.reloadCount, 1);
    assert.equal(loader.state, 'failed');
    assert.equal(harness.scripts.length, scriptsBeforeTimers);
    await assert.rejects(loader.retry(), /Page reload required/);
  });

  it('retries app initialization and marks initialized only after success', async () => {
    const harness = createHarness({
      initBehavior(count) {
        if (count === 1) throw new Error('initialization failed');
      },
    });
    const loader = harness.OWP.loader;
    await assert.rejects(loader.promise, /initialization failed/);
    assert.equal(loader.initialized, false);

    harness.runTimers();
    await loader.promise;

    assert.equal(loader.state, 'loaded');
    assert.equal(loader.initialized, true);
    assert.equal(harness.initCount, 2);
  });
});
