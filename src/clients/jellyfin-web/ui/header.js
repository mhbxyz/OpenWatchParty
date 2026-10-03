(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const {
    PANEL_ID,
    HEADER_BTN_CLASS,
    LEGACY_HEADER_BTN_ID,
    MODERN_HEADER_BTN_ID,
    PANEL_HEADER_CLASS
  } = OWP.constants;

  const PANEL_GAP_PX = 8;
  const PANEL_MAX_HEIGHT_PX = 450;

  // The legacy header. Jellyfin also renders it, hidden, under the MUI layout.
  const LEGACY_CONTAINER_SELECTOR = '.skinHeader .headerRight';
  // Jellyfin 12's MUI app bar keeps SyncPlay, Cast and Search in one box. These
  // attributes do not depend on the interface language, and the `header`
  // prefix skips the sort and filter toolbars of library pages.
  const MODERN_ANCHOR_SELECTOR = [
    'header.MuiAppBar-root [aria-controls="app-sync-play-menu"]',
    'header.MuiAppBar-root [aria-controls="app-remote-play-menu"]',
    'header.MuiAppBar-root a[href="#/search"]'
  ].join(', ');
  const LEGACY_BUTTON_CLASSES = 'headerButton headerButtonRight paper-icon-button-light';

  let observer = null;
  let panelObserver = null;
  let frame = 0;
  // Whether the open panel belongs below the header. It survives the moments
  // without a header button, so the panel goes back below it when it returns.
  let openedFromHeader = false;

  const headerButtons = () => [MODERN_HEADER_BTN_ID, LEGACY_HEADER_BTN_ID]
    .map(id => document.getElementById(id))
    .filter(Boolean);

  // An element hidden by itself or by an ancestor has no layout boxes.
  const isShown = element => typeof element.getClientRects === 'function' && element.getClientRects().length > 0;

  // The visual viewport excludes an on-screen keyboard; fall back to the window.
  const viewportHeight = () => (window.visualViewport ? window.visualViewport.height : window.innerHeight);

  const placePanelBelowHeader = (panel, button) => {
    const header = button.closest('header, .skinHeader') || button;
    const top = Math.round(header.getBoundingClientRect().bottom) + PANEL_GAP_PX;
    panel.classList.add(PANEL_HEADER_CLASS);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(PANEL_MAX_HEIGHT_PX, Math.round(viewportHeight()) - top - PANEL_GAP_PX))}px`;
  };

  const applyDefaultPlacement = (panel) => {
    panel.classList.remove(PANEL_HEADER_CLASS);
    panel.style.top = '';
    panel.style.maxHeight = '';
  };

  // Restores the default placement used by the player button.
  const resetPanelPlacement = (panel) => {
    openedFromHeader = false;
    applyDefaultPlacement(panel);
  };

  // Keeps a panel opened from the header below the header that is shown now:
  // it follows header rebuilds, layout and size changes, and uses the default
  // placement while no header button is shown (in the player, say).
  const updatePanelPlacement = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !openedFromHeader || panel.classList.contains('hide')) return;
    const button = headerButtons().find(isShown);
    if (button) placePanelBelowHeader(panel, button);
    else applyDefaultPlacement(panel);
  };

  const syncExpandedState = () => {
    const panel = document.getElementById(PANEL_ID);
    const expanded = String(!!panel && !panel.classList.contains('hide'));
    headerButtons().forEach(button => {
      if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    });
  };

  const togglePanelFromHeader = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!panel.classList.contains('hide')) {
      panel.classList.add('hide');
    } else {
      openedFromHeader = true;
      panel.dataset.opener = event.currentTarget.id;
      placePanelBelowHeader(panel, event.currentTarget);
      panel.classList.remove('hide');
      if (ui.render) ui.render(true);
    }
    syncExpandedState();
  };

  // MUI state classes (Mui-focusVisible, Mui-disabled, ...) belong to the
  // button they were copied from, not to ours.
  const nativeIconButtonClasses = (anchor) => String(anchor.className)
    .split(/\s+/)
    .filter(name => name && !name.startsWith('Mui-'))
    .join(' ');

  const createHeaderButton = (id, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = `${className} ${HEADER_BTN_CLASS}`;
    button.title = 'Watch Party';
    button.setAttribute('aria-label', 'Watch Party');
    button.setAttribute('aria-controls', PANEL_ID);
    const icon = document.createElement('span');
    icon.className = 'material-icons groups';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', togglePanelFromHeader);
    return button;
  };

  const ensureButton = (container, id, className) => {
    if (!container) return;
    const existing = document.getElementById(id);
    if (existing && existing.parentNode === container) return;
    container.prepend(existing || createHeaderButton(id, className));
  };

  const scheduleUpdate = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      injectHeaderButtons();
    });
  };

  // Jellyfin rebuilds its app bar when leaving the dashboard or switching
  // layouts, and swaps headers when the player opens; watch the page so the
  // button comes back and the panel moves right away.
  const startObservers = () => {
    if (typeof window.MutationObserver !== 'function' || typeof window.requestAnimationFrame !== 'function') return;
    if (!observer && document.body) {
      observer = new window.MutationObserver(scheduleUpdate);
      observer.observe(document.body, { childList: true, subtree: true });
      if (typeof window.addEventListener === 'function') window.addEventListener('resize', scheduleUpdate);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleUpdate);
    }
    const panel = document.getElementById(PANEL_ID);
    if (!panelObserver && panel) {
      panelObserver = new window.MutationObserver(syncExpandedState);
      panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
  };

  const removeHeaderButtons = () => {
    if (observer) observer.disconnect();
    if (panelObserver) panelObserver.disconnect();
    observer = null;
    panelObserver = null;
    if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', scheduleUpdate);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', scheduleUpdate);
    if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
    frame = 0;
    openedFromHeader = false;
    headerButtons().forEach(button => button.remove());
  };

  const injectHeaderButtons = () => {
    ensureButton(document.querySelector(LEGACY_CONTAINER_SELECTOR), LEGACY_HEADER_BTN_ID, LEGACY_BUTTON_CLASSES);
    const anchor = document.querySelector(MODERN_ANCHOR_SELECTOR);
    if (anchor) ensureButton(anchor.parentNode, MODERN_HEADER_BTN_ID, nativeIconButtonClasses(anchor));
    syncExpandedState();
    updatePanelPlacement();
    startObservers();
  };

  Object.assign(ui, { injectHeaderButtons, removeHeaderButtons, resetPanelPlacement });
})();
