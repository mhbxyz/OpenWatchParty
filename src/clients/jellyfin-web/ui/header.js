(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const t = OWP.i18n.t;
  const {
    PANEL_ID,
    HEADER_BTN_CLASS,
    LEGACY_HEADER_BTN_ID,
    MODERN_HEADER_BTN_ID,
    PANEL_HEADER_CLASS,
    PANEL_BUBBLE_CLASS,
    PANEL_CONTROLS_HIDDEN_CLASS,
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
  // Jellyfin 12's MUI app bar keeps SyncPlay, Cast and Search in one box, and
  // the player's own header (`.osdHeader`) keeps SyncPlay and Cast. These
  // attributes do not depend on the interface language, and the prefixes skip
  // the sort and filter toolbars of library pages.
  const MODERN_ANCHOR_SELECTOR = [
    'header.MuiAppBar-root [aria-controls="app-sync-play-menu"]',
    'header.MuiAppBar-root [aria-controls="app-remote-play-menu"]',
    'header.MuiAppBar-root a[href="#/search"]',
    '.osdHeader [aria-controls="app-sync-play-menu"]',
    '.osdHeader [aria-controls="app-remote-play-menu"]'
  ].join(', ');
  const LEGACY_BUTTON_CLASSES = 'headerButton headerButtonRight paper-icon-button-light';
  // Both containers above live in one of these.
  const HEADER_SELECTOR = 'header, .skinHeader';
  // While the player is open Jellyfin marks its header `.osdHeader`, and adds
  // `osdHeader-hidden` while the player's controls are hidden.
  const PLAYER_HEADER_SELECTOR = '.osdHeader';
  const PLAYER_CONTROLS_HIDDEN_SELECTOR = '.osdHeader.osdHeader-hidden';
  // The player takes a press on its page as play/pause (by touch, as showing
  // its controls), except on its bottom controls and up-next card. Buttons
  // and fields there do their own thing.
  const PLAYER_PAGE_SELECTOR = '#videoOsdPage';
  const PLAYER_CONTROLS_SELECTOR = '.videoOsdBottom, .upNextContainer, button, a, input, select, textarea, [role="button"]';
  // OWP's own elements outside the panel: a press on them keeps it open.
  const KEEP_PANEL_OPEN_SELECTOR = `.${HEADER_BTN_CLASS}, .owp-toast-container, .owp-toast-system, #owp-emoji-panel, #owp-emoji-autocomplete`;
  const TEXT_FIELD_SELECTOR = 'input, textarea, [contenteditable]';
  const UP_NEXT_SELECTOR = '.owp-queue-next';

  let observer = null;
  let panelObserver = null;
  let controlsObserver = null;
  let watchedPlayerHeader = null;
  let pageListenersInstalled = false;
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
    // The player header is taller than its row of buttons: hang below the row.
    const header = button.closest('.osdHeader .MuiToolbar-root') || button.closest('header, .skinHeader') || button;
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

  const syncExpandedState = () => {
    const panel = document.getElementById(PANEL_ID);
    const expanded = String(!!panel && !panel.classList.contains('hide'));
    headerButtons().forEach(button => {
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

  const typingInPanel = (panel) => {
    const active = document.activeElement;
    return !!active && panel.contains(active) && typeof active.closest === 'function'
      && !!active.closest(TEXT_FIELD_SELECTOR);
  };

  // Over the player the panel goes with Jellyfin's controls: out of sight
  // while they are hidden, even under a resting pointer as they are, and back
  // as it was when they show. It stays while someone is typing in it or the
  // queue's "up next" countdown is in it (the host's Cancel and Next).
  const applyPlayerControls = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const fade = !!document.querySelector(PLAYER_CONTROLS_HIDDEN_SELECTOR) && !typingInPanel(panel)
      && !panel.querySelector(UP_NEXT_SELECTOR);
    if (panel.classList.contains(PANEL_CONTROLS_HIDDEN_CLASS) !== fade) panel.classList.toggle(PANEL_CONTROLS_HIDDEN_CLASS, fade);
  };

  // The header keeps its element and swaps classes when the player opens and
  // closes; a header Jellyfin rebuilds is followed on the next injection.
  const watchPlayerControls = () => {
    const header = document.querySelector(PLAYER_HEADER_SELECTOR);
    if (header && header !== watchedPlayerHeader && typeof window.MutationObserver === 'function') {
      if (controlsObserver) controlsObserver.disconnect();
      watchedPlayerHeader = header;
      controlsObserver = new window.MutationObserver(applyPlayerControls);
      controlsObserver.observe(header, { attributes: true, attributeFilter: ['class'] });
    }
    applyPlayerControls();
  };

  const isPlayerPicture = target => !!target && typeof target.closest === 'function'
    && !!target.closest(PLAYER_PAGE_SELECTOR) && !target.closest(PLAYER_CONTROLS_SELECTOR);

  // A primary press outside the open panel closes it, as its X does. Returns
  // whether it did. Guest controls call it for the presses they stop.
  const closePanelOnPress = (event) => {
    if (event.type !== 'pointerdown' || event.button) return false;
    const panel = document.getElementById(PANEL_ID);
    const target = event.target;
    if (!panel || panel.classList.contains('hide') || panel.classList.contains(PANEL_CONTROLS_HIDDEN_CLASS)) return false;
    if (!target || typeof target.closest !== 'function' || panel.contains(target)
      || target.closest(KEEP_PANEL_OPEN_SELECTOR)) return false;
    if (ui.hidePanel) ui.hidePanel();
    else panel.classList.add('hide');
    syncExpandedState();
    return true;
  };

  // On the player's picture the press only closes the panel: the player would
  // also take it as play or pause, which for a host pauses the whole room.
  // A double click is two presses, and only the browser knows the system's
  // double-click time. So the next mouse press on the picture waits for its
  // mousedown, which carries the click count: the second click of a double
  // click stops there too, with its click and the double click (no pause, no
  // full screen); a new click goes on to the player, as it came.
  // The gesture is 'closing' until the click of the press that closed the
  // panel, then 'open' until the double click or a new single click.
  let pictureGesture = '';
  let heldPress = null;
  const HANDED_ON_FIELDS = [
    'pointerId', 'pointerType', 'isPrimary', 'button', 'buttons', 'clientX', 'clientY',
    'screenX', 'screenY', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey'
  ];

  const stopEvent = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };

  const onPressOutside = (event) => {
    heldPress = null;
    const closed = closePanelOnPress(event);
    if (event.button) return;
    if (!isPlayerPicture(event.target)) {
      pictureGesture = '';
      return;
    }
    if (closed) {
      stopEvent(event);
      pictureGesture = 'closing';
    } else if (pictureGesture && event.pointerType === 'mouse') {
      // Held, not prevented: preventing it would drop the mousedown.
      heldPress = event;
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };

  const onMouseDown = (event) => {
    const press = heldPress;
    heldPress = null;
    if (!press) return;
    if (event.detail > 1) {
      stopEvent(event);
      return;
    }
    pictureGesture = '';
    const init = { bubbles: true, cancelable: true, composed: true };
    HANDED_ON_FIELDS.forEach((name) => { init[name] = press[name]; });
    press.target.dispatchEvent(new window.PointerEvent('pointerdown', init));
  };

  const onPictureClick = (event) => {
    if (!pictureGesture || !isPlayerPicture(event.target)) return;
    // A single click after the one that closed the panel is a new click: by
    // touch or pen, whose presses are not held, the gesture ends here.
    if (event.detail <= 1 && pictureGesture === 'open') {
      pictureGesture = '';
      return;
    }
    stopEvent(event);
    if (event.type === 'dblclick') pictureGesture = '';
    else pictureGesture = 'open';
  };

  const PAGE_LISTENERS = [
    ['pointerdown', onPressOutside],
    ['mousedown', onMouseDown],
    ['click', onPictureClick],
    ['dblclick', onPictureClick],
    ['focusin', applyPlayerControls],
    ['focusout', applyPlayerControls]
  ];

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
    // In the capture phase, so a press on the player's picture is caught
    // before the player sees it.
    if (!pageListenersInstalled && typeof window.addEventListener === 'function') {
      PAGE_LISTENERS.forEach(([type, listener]) => window.addEventListener(type, listener, true));
      pageListenersInstalled = true;
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
    if (controlsObserver) controlsObserver.disconnect();
    observer = null;
    panelObserver = null;
    controlsObserver = null;
    watchedPlayerHeader = null;
    pictureGesture = '';
    heldPress = null;
    if (typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', scheduleUpdate);
      PAGE_LISTENERS.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
    }
    pageListenersInstalled = false;
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', scheduleUpdate);
    if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
    frame = 0;
    openedFromHeader = false;
    headerButtons().forEach(button => button.remove());
  };

  const injectHeaderButtons = () => {
    ensureButton(document.querySelector(LEGACY_CONTAINER_SELECTOR), LEGACY_HEADER_BTN_ID, LEGACY_BUTTON_CLASSES);
    // While the player opens or closes, the app bar and the player header can
    // both be in the page: follow the one that is shown.
    const anchors = Array.from(document.querySelectorAll(MODERN_ANCHOR_SELECTOR));
    const anchor = anchors.find(isShown) || anchors[0];
    if (anchor) ensureButton(anchor.parentNode, MODERN_HEADER_BTN_ID, nativeIconButtonClasses(anchor));
    syncExpandedState();
    updatePanelPlacement();
    startObservers();
    watchPlayerControls();
    showFirstRunHelp();
  };

  Object.assign(ui, { injectHeaderButtons, removeHeaderButtons, resetPanelPlacement, updatePanelPlacement, closePanelOnPress, applyPlayerControls });
})();
