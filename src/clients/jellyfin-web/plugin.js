(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};

  if (OWP.loader) {
    if (OWP.loader.state === 'failed') {
      const configured = OWP.loader.configure ? OWP.loader.configure(document.currentScript) : true;
      if (configured !== false) OWP.loader.retry();
    }
    return;
  }

  const currentScript = document.currentScript;
  let cacheBust = '';
  let basePrefix = '';
  if (currentScript && currentScript.src) {
    try {
      const url = new URL(currentScript.src, window.location.href);
      cacheBust = url.searchParams.get('v') || '';
      const clientScriptPath = '/OpenWatchParty/ClientScript';
      if (url.pathname.endsWith(clientScriptPath)) {
        basePrefix = url.pathname.slice(0, -clientScriptPath.length);
      }
    } catch (err) {}
  }
  if (!cacheBust) cacheBust = String(Date.now());

  const base = `${basePrefix}/OpenWatchParty/Client`;

  const SCRIPT_TIMEOUT_MS = 10000;
  const AUTO_RETRY_BASE_MS = 1000;
  const MAX_AUTO_RETRIES = 2;
  const loader = OWP.loader = {
    state: 'idle',
    promise: null,
    retry: null,
    loadedModules: new Set(),
    initialized: false,
    initializationError: null,
    base,
    cacheBust,
    retryTimer: null,
    autoRetryCount: 0,
    configure: null,
    requiresReload: false,
  };
  OWP.__loaded = false;

  let generation = 0;
  let pending = new Set();

  loader.configure = (scriptElement) => {
    if (!scriptElement?.src) return true;
    try {
      const url = new URL(scriptElement.src, window.location.href);
      const clientScriptPath = '/OpenWatchParty/ClientScript';
      const nextCacheBust = url.searchParams.get('v') || String(Date.now());
      const nextBase = url.pathname.endsWith(clientScriptPath)
        ? `${url.pathname.slice(0, -clientScriptPath.length)}/OpenWatchParty/Client`
        : '/OpenWatchParty/Client';
      const changed = nextBase !== loader.base || nextCacheBust !== loader.cacheBust;
      if (changed && loader.loadedModules.size > 0) {
        loader.requiresReload = true;
        if (loader.retryTimer) {
          clearTimeout(loader.retryTimer);
          loader.retryTimer = null;
        }
        generation++;
        cancelPending();
        window.location.reload();
        return false;
      }
      loader.base = nextBase;
      loader.cacheBust = nextCacheBust;
      return true;
    } catch (err) {
      return false;
    }
  };

  const removeScript = (script) => {
    if (script.parentNode) script.parentNode.removeChild(script);
  };

  const cancelPending = () => {
    for (const cancel of pending) cancel();
    pending = new Set();
  };

  const loadScript = (src, currentGeneration) => {
    if (loader.loadedModules.has(src)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let active = true;
      let timer;

      const stop = (remove) => {
        if (!active) return false;
        active = false;
        clearTimeout(timer);
        pending.delete(cancel);
        if (remove) removeScript(script);
        return true;
      };
      const cancel = () => {
        if (stop(true)) reject(new Error(`Cancelled loading ${src}`));
      };
      const fail = (error) => {
        if (stop(true)) reject(error);
      };

      script.src = `${loader.base}/${src}?v=${loader.cacheBust}`;
      script.async = false;
      script.onload = () => {
        if (!active || currentGeneration !== generation || loader.state !== 'loading') return;
        stop(false);
        loader.loadedModules.add(src);
        resolve();
      };
      script.onerror = () => fail(new Error(`Failed to load ${src}`));
      timer = setTimeout(() => fail(new Error(`Timeout loading ${src}`)), SCRIPT_TIMEOUT_MS);
      pending.add(cancel);
      document.head.appendChild(script);
    });
  };

  const loadAll = async (currentGeneration) => {
    const load = (src) => loadScript(src, currentGeneration);
    await load('state.js');
    await Promise.all([
      load('utils/time.js'),
      load('utils/video.js'),
      load('utils/misc.js'),
    ]);
    await Promise.all([
      load('utils/media.js'),
      load('utils/log.js'),
    ]);
    await Promise.all([
      load('ui/styles.js'),
      load('ui/indicators.js'),
      load('ui/toasts.js'),
      load('ui/cards.js'),
    ]);
    await Promise.all([
      load('ui/home.js'),
      load('ui/render.js'),
    ]);
    await Promise.all([
      load('playback/play.js'),
      load('playback/bind.js'),
      load('playback/sync.js'),
    ]);
    await Promise.all([
      load('chat/messages.js'),
      load('chat/input.js'),
    ]);
    await load('ws/send.js');
    await load('ws/auth.js');
    await load('ws/validation.js');
    await Promise.all([
      load('ws/handlers/room.js'),
      load('ws/handlers/sync.js'),
      load('ws/handlers/playback.js'),
      load('ws/handlers/clock.js'),
    ]);
    await load('ws/connection.js');
    await load('app/lifecycle.js');
    await load('app/cleanup.js');
  };

  loader.retry = () => {
    if (loader.requiresReload) {
      return Promise.reject(new Error('Page reload required before retrying loader'));
    }
    if (loader.state === 'loading' || loader.state === 'loaded') return loader.promise;
    if (loader.state !== 'idle' && loader.state !== 'failed') {
      return Promise.reject(new Error(`Invalid loader state: ${loader.state}`));
    }

    loader.state = 'loading';
    if (loader.retryTimer) {
      clearTimeout(loader.retryTimer);
      loader.retryTimer = null;
    }
    OWP.__loaded = false;
    const currentGeneration = ++generation;
    const promise = loadAll(currentGeneration)
      .then(() => {
        if (!loader.initialized) {
          if (!OWP.app || typeof OWP.app.init !== 'function') {
            throw new Error('OpenWatchParty app.init is unavailable');
          }
          try {
            OWP.app.init();
            loader.initialized = true;
            loader.initializationError = null;
          } catch (err) {
            loader.initializationError = err;
            throw err;
          }
        }
        loader.state = 'loaded';
        loader.autoRetryCount = 0;
        OWP.__loaded = true;
      })
      .catch((err) => {
        if (currentGeneration === generation) {
          cancelPending();
          loader.state = 'failed';
          loader.promise = null;
          OWP.__loaded = false;
          if (loader.autoRetryCount < MAX_AUTO_RETRIES) {
            const delay = AUTO_RETRY_BASE_MS * Math.pow(2, loader.autoRetryCount++);
            loader.retryTimer = setTimeout(() => {
              loader.retryTimer = null;
              if (loader.state === 'failed' && !loader.requiresReload) loader.retry();
            }, delay);
          }
        }
        throw err;
      });
    loader.promise = promise;
    promise.catch((err) => {
      console.error('[OpenWatchParty] Loader error:', err);
    });
    return promise;
  };

  loader.retry();
})();
