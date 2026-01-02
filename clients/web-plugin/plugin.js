(() => {
  if (window.OpenSyncParty && window.OpenSyncParty.__loaded) return;
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  OSP.__loaded = true;

  const currentScript = document.currentScript;
  let cacheBust = '';
  if (currentScript && currentScript.src) {
    try {
      const url = new URL(currentScript.src, window.location.href);
      cacheBust = url.searchParams.get('v') || '';
    } catch (err) {}
  }
  if (!cacheBust) cacheBust = String(Date.now());

  const base = '/web/plugins/opensyncparty';
  const scripts = [
    'osp-state.js',
    'osp-utils.js',
    'osp-ui.js',
    'osp-playback.js',
    'osp-ws.js',
    'osp-app.js'
  ];

  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${base}/${src}?v=${cacheBust}`;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });

  scripts.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
    .then(() => {
      if (window.OpenSyncParty && window.OpenSyncParty.app && typeof window.OpenSyncParty.app.init === 'function') {
        window.OpenSyncParty.app.init();
      }
    })
    .catch((err) => {
      console.error('[OpenSyncParty] Loader error:', err);
    });
})();
