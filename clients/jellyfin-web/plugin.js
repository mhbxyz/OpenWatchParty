(() => {
  if (window.OpenWatchParty && window.OpenWatchParty.__loaded) return;
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  OWP.__loaded = true;

  const currentScript = document.currentScript;
  let cacheBust = '';
  if (currentScript && currentScript.src) {
    try {
      const url = new URL(currentScript.src, window.location.href);
      cacheBust = url.searchParams.get('v') || '';
    } catch (err) {}
  }
  if (!cacheBust) cacheBust = String(Date.now());

  const base = '/web/plugins/openwatchparty';

  const SCRIPT_TIMEOUT_MS = 10000;  // 10 seconds timeout per script

  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${base}/${src}?v=${cacheBust}`;
    script.async = false;
    const timer = setTimeout(() => {
      reject(new Error(`Timeout loading ${src}`));
    }, SCRIPT_TIMEOUT_MS);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); };
    document.head.appendChild(script);
  });

  // Optimized parallel loading based on dependencies:
  // 1. state (no deps) → 2. utils (state) → 3. ui + playback (parallel) → 4. chat (ui) → 5. ws (ui, chat) → 6. app (all)
  const loadAll = async () => {
    await loadScript('state.js');
    await loadScript('utils.js');
    await Promise.all([
      loadScript('ui.js'),
      loadScript('playback.js')
    ]);
    await loadScript('chat.js');
    await loadScript('ws.js');
    await loadScript('app.js');
  };

  loadAll()
    .then(() => {
      if (window.OpenWatchParty && window.OpenWatchParty.app && typeof window.OpenWatchParty.app.init === 'function') {
        window.OpenWatchParty.app.init();
      }
    })
    .catch((err) => {
      console.error('[OpenWatchParty] Loader error:', err);
    });
})();
