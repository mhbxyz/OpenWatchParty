(() => {
  if (window.OpenWatchParty && window.OpenWatchParty.__loaded) return;
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  OWP.__loaded = true;

  const currentScript = document.currentScript;
  let cacheBust = '';
  let basePrefix = '';
  if (currentScript && currentScript.src) {
    try {
      const url = new URL(currentScript.src, window.location.href);
      cacheBust = url.searchParams.get('v') || '';
      const suffix = '/OpenWatchParty/ClientScript';
      if (url.pathname.endsWith(suffix)) {
        basePrefix = url.pathname.slice(0, -suffix.length);
      }
    } catch (err) {}
  }
  if (!cacheBust) cacheBust = String(Date.now());

  const base = `${basePrefix}/OpenWatchParty/Client`;

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

  const loadAll = async () => {
    await loadScript('state.js');
    await Promise.all([
      loadScript('utils/time.js'),
      loadScript('utils/video.js'),
      loadScript('utils/misc.js'),
    ]);
    await Promise.all([
      loadScript('utils/media.js'),
      loadScript('utils/log.js'),
    ]);
    await Promise.all([
      loadScript('ui/styles.js'),
      loadScript('ui/indicators.js'),
      loadScript('ui/toasts.js'),
      loadScript('ui/cards.js'),
    ]);
    await Promise.all([
      loadScript('ui/home.js'),
      loadScript('ui/render.js'),
    ]);
    await Promise.all([
      loadScript('playback/play.js'),
      loadScript('playback/bind.js'),
      loadScript('playback/sync.js'),
    ]);
    await Promise.all([
      loadScript('chat/messages.js'),
      loadScript('chat/input.js'),
    ]);
    await loadScript('ws/send.js');
    await loadScript('ws/auth.js');
    await Promise.all([
      loadScript('ws/handlers/room.js'),
      loadScript('ws/handlers/sync.js'),
      loadScript('ws/handlers/playback.js'),
      loadScript('ws/handlers/clock.js'),
    ]);
    await loadScript('ws/connection.js');
    await loadScript('app/lifecycle.js');
    await loadScript('app/cleanup.js');
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
