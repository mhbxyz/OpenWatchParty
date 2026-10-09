(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const t = OWP.i18n.t;
  const {
    PANEL_ID,
    BTN_ID,
    HEADER_BTN_CLASS,
    LEGACY_HEADER_BTN_ID,
    MODERN_HEADER_BTN_ID,
    PANEL_HEADER_CLASS,
    PANEL_BUBBLE_CLASS,
    ROOM_MODE_CLASS
  } = OWP.constants;
  const state = OWP.state;

  const PANEL_GAP_PX = 8;
  const PANEL_MAX_HEIGHT_PX = 450;
  // The bubble's arrow stays clear of its rounded corners.
  const ARROW_INSET_PX = 16;
  // Set once the first-run help has been shown in this browser.
  const HELP_SEEN_KEY = 'owp-help-seen';

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
  // Both containers above live in one of these.
  const HEADER_SELECTOR = 'header, .skinHeader';

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

  // Without the scrollbar, which fixed elements do not cover.
  const viewportWidth = () => document.documentElement?.clientWidth || window.innerWidth;

  const clearBubble = (panel) => {
    if (panel.classList.contains(PANEL_BUBBLE_CLASS)) panel.classList.remove(PANEL_BUBBLE_CLASS);
    panel.style.left = '';
    panel.style.removeProperty('--owp-arrow-left');
  };

  // The lobby hangs from the button like a speech bubble: centred on it while
  // the window has room, with the arrow always on the button. The room bar
  // keeps to the right edge.
  const placeBubble = (panel, button) => {
    if (panel.classList.contains(ROOM_MODE_CLASS) || typeof button.getBoundingClientRect !== 'function') {
      clearBubble(panel);
      return;
    }
    if (!panel.classList.contains(PANEL_BUBBLE_CLASS)) panel.classList.add(PANEL_BUBBLE_CLASS);
    const buttonBox = button.getBoundingClientRect();
    const center = buttonBox.left + buttonBox.width / 2;
    const width = panel.getBoundingClientRect().width;
    const left = Math.max(PANEL_GAP_PX, Math.min(viewportWidth() - PANEL_GAP_PX - width, center - width / 2));
    const arrow = Math.max(ARROW_INSET_PX, Math.min(width - ARROW_INSET_PX, center - left));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.setProperty('--owp-arrow-left', `${Math.round(arrow)}px`);
  };

  // The panel must be shown, so that its width can be measured.
  const placePanelBelowHeader = (panel, button) => {
    const header = button.closest('header, .skinHeader') || button;
    const top = Math.round(header.getBoundingClientRect().bottom) + PANEL_GAP_PX;
    panel.classList.add(PANEL_HEADER_CLASS);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(PANEL_MAX_HEIGHT_PX, Math.round(viewportHeight()) - top - PANEL_GAP_PX))}px`;
    placeBubble(panel, button);
  };

  const applyDefaultPlacement = (panel) => {
    panel.classList.remove(PANEL_HEADER_CLASS);
    panel.style.top = '';
    panel.style.maxHeight = '';
    clearBubble(panel);
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

  // The header buttons and the player's OSD button all toggle the panel.
  const panelToggleButtons = () => [...headerButtons(), document.getElementById(BTN_ID)].filter(Boolean);

  const syncExpandedState = () => {
    const panel = document.getElementById(PANEL_ID);
    const expanded = String(!!panel && !panel.classList.contains('hide'));
    panelToggleButtons().forEach(button => {
      if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    });
  };

  // Draws the panel, then places it: the lobby's bubble needs its width.
  const openPanelFromHeader = (panel, button, { help = false } = {}) => {
    openedFromHeader = true;
    panel.dataset.opener = button.id;
    state.lobbyHelpOpen = help;
    panel.classList.remove('hide');
    if (ui.render) ui.render(true);
    placePanelBelowHeader(panel, button);
  };

  const togglePanelFromHeader = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!panel.classList.contains('hide')) {
      panel.classList.add('hide');
    } else {
      openPanelFromHeader(panel, event.currentTarget);
      if (ui.isKeyboardClick && ui.isKeyboardClick(event) && ui.focusPanelStart) ui.focusPanelStart(panel);
    }
    syncExpandedState();
  };

  const helpSeen = () => {
    try {
      return window.localStorage.getItem(HELP_SEEN_KEY) === '1';
    } catch (err) {
      return false;
    }
  };

  const markHelpSeen = () => {
    try {
      window.localStorage.setItem(HELP_SEEN_KEY, '1');
    } catch (err) {
      // Without storage (a private window, say) it may show again next time.
    }
  };

  let helpChecked = false;

  // New users rarely notice the header button, so the first time Jellyfin Web
  // runs in a browser the lobby opens from it by itself, with its help. Once
  // shown it is not shown again; the lobby's "?" brings the help back. People
  // already in a watch party (an invite link, say) do not need it.
  const showFirstRunHelp = () => {
    if (helpChecked) return;
    if (helpSeen()) {
      helpChecked = true;
      return;
    }
    const loggedIn = OWP.actions?.getJellyfinAccessToken ? OWP.actions.getJellyfinAccessToken() : '';
    const button = headerButtons().find(isShown);
    const panel = document.getElementById(PANEL_ID);
    if (!loggedIn || !button || !panel) return;
    helpChecked = true;
    markHelpSeen();
    if (state.inRoom || state.rejoinPending || state.pendingJoinRoomId) return;
    if (panel.classList.contains('hide')) {
      openPanelFromHeader(panel, button, { help: true });
      syncExpandedState();
    } else if (ui.setLobbyHelpOpen) {
      ui.setLobbyHelpOpen(true);
    }
    if (ui.announceLobbyHelp) ui.announceLobbyHelp();
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
    button.title = t('watchParty');
    button.setAttribute('aria-label', t('watchParty'));
    button.setAttribute('aria-controls', PANEL_ID);
    button.appendChild(ui.createWatchPartyIcon());
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

  const panelFollowsHeader = () => {
    const panel = document.getElementById(PANEL_ID);
    return openedFromHeader && !!panel && !panel.classList.contains('hide');
  };

  // A change inside a header, or a header added to the page.
  const touchesHeader = records => records.some(record => (
    (record.target && typeof record.target.closest === 'function' && record.target.closest(HEADER_SELECTOR))
    || Array.from(record.addedNodes || []).some(node => node.nodeType === 1
      && (node.closest(HEADER_SELECTOR) || node.querySelector(HEADER_SELECTOR)))
  ));

  // Busy pages (the player, chat, library grids) change all the time, so only
  // header changes trigger a lookup, unless the open panel follows the header
  // (the player swaps headers, say). The periodic injection in lifecycle
  // catches anything missed here.
  const onPageChange = (records) => {
    if (panelFollowsHeader() || touchesHeader(records)) scheduleUpdate();
  };

  // Jellyfin rebuilds its app bar when leaving the dashboard or switching
  // layouts, and swaps headers when the player opens; watch the page so the
  // button comes back and the panel moves right away.
  const startObservers = () => {
    if (typeof window.MutationObserver !== 'function' || typeof window.requestAnimationFrame !== 'function') return;
    if (!observer && document.body) {
      observer = new window.MutationObserver(onPageChange);
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
    showFirstRunHelp();
  };

  Object.assign(ui, { injectHeaderButtons, removeHeaderButtons, resetPanelPlacement, updatePanelPlacement });
})();
