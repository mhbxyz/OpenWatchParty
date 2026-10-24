(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const t = OWP.i18n.t;
  const { PANEL_ID } = OWP.constants;


  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };


  // Outline icons for the room bar, from Tabler Icons (MIT, https://tabler.io/icons;
  // see THIRD_PARTY_NOTICES.md). Jellyfin only ships the filled Material icons.
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ICON_PATHS = {
    users: ['M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2', 'M16 3.13a4 4 0 0 1 0 7.75', 'M21 21v-2a4 4 0 0 0 -3 -3.85'],
    chat: ['M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1'],
    logout: ['M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2', 'M9 12h12l-3 -3', 'M18 15l3 -3'],
    x: ['M18 6l-12 12', 'M6 6l12 12'],
    chevron: ['M6 9l6 6l6 -6'],
    send: ['M10 14l11 -11', 'M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5'],
    share: ['M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M8.7 10.7l6.6 -3.4', 'M8.7 13.3l6.6 3.4'],
    refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
    playlist: ['M14 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M17 17v-13h4', 'M13 5h-10', 'M3 9h10', 'M9 13h-6'],
    play: ['M7 4v16l13 -8z'],
    next: ['M3 5v14l8 -7z', 'M14 5v14l8 -7z'],
    prev: ['M21 5v14l-8 -7z', 'M10 5v14l-8 -7z'],
    up: ['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'],
    down: ['M12 5l0 14', 'M18 13l-6 6', 'M6 13l6 6'],
    check: ['M5 12l5 5l10 -10']
  };


  // The Watch Party icon for the header and player buttons: a screen with a
  // play button and two viewers. Original artwork contributed to the project
  // by francotosqui, drawn on Material's 24 grid with 2-unit lines so it sits
  // next to Jellyfin's own icons (Cast, Search) at the same size and weight.
  const WATCH_PARTY_ICON = [
    ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', d: 'M5.9 15H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2.9' }],
    ['path', { d: 'M10.2 6.9v4.6l4-2.3z' }],
    ['circle', { cx: '8.6', cy: '14.8', r: '1.9' }],
    ['circle', { cx: '15.4', cy: '14.8', r: '1.9' }],
    ['path', { d: 'M5 21a3.6 3.1 0 0 1 7.2 0zM11.8 21a3.6 3.1 0 0 1 7.2 0z' }]
  ];


  // Wrapped in `.material-icons` so it takes the size the native icons get in
  // each button.
  const createWatchPartyIcon = () => {
    const wrapper = createElement('span', 'material-icons owp-watch-party-icon');
    wrapper.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('focusable', 'false');
    WATCH_PARTY_ICON.forEach(([tag, attributes]) => {
      const shape = document.createElementNS(SVG_NS, tag);
      Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, value));
      svg.appendChild(shape);
    });
    wrapper.appendChild(svg);
    return wrapper;
  };


  const createIcon = (name) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `owp-icon owp-icon-${name}`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    ICON_PATHS[name].forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  };


  // Hides the panel. Keyboard focus inside it must not stay in a hidden panel:
  // it goes back to the button that opened the panel when that button is
  // shown, or out of the panel otherwise.
  const hidePanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    OWP.emoji?.closePicker?.();
    OWP.emoji?.hideSuggestions?.();
    const active = document.activeElement;
    const hadFocus = !!active && active !== panel && typeof panel.contains === 'function' && panel.contains(active);
    panel.classList.add('hide');
    if (!hadFocus) return;
    const opener = panel.dataset.opener && document.getElementById(panel.dataset.opener);
    if (opener && typeof opener.getClientRects === 'function' && opener.getClientRects().length > 0) opener.focus();
    else if (typeof active.blur === 'function') active.blur();
  };


  // Hides the panel from inside it, so closing does not mean reaching for the
  // button that opened it.
  const createCloseButton = () => {
    const button = createElement('button', 'owp-close-btn owp-bar-btn');
    button.type = 'button';
    button.title = t('closePanel');
    button.setAttribute('aria-label', t('closePanel'));
    button.appendChild(createIcon('x'));
    button.onclick = hidePanel;
    return button;
  };


  // The panel's own controls: the help, its "?" and the close button.
  const PANEL_FRAME_CONTROLS = ['owp-close-btn', 'owp-help-btn', 'owp-help-ok'];


  // A panel opened from the keyboard takes focus, as a dialog should: its first
  // control other than its own, or the close button. A mouse click leaves
  // focus alone, so the player's keyboard shortcuts keep working.
  const focusPanelStart = (panel) => {
    const buttons = Array.from(panel.querySelectorAll('button')).filter(button => !button.disabled);
    const target = buttons.find(button => !PANEL_FRAME_CONTROLS.some(name => button.classList.contains(name)))
      || buttons.find(button => button.classList.contains('owp-close-btn'));
    if (target) target.focus({ preventScroll: true });
  };


  // Enter and Space fire `click` with `detail` 0; a mouse click counts its clicks.
  const isKeyboardClick = event => !!event && event.detail === 0;

  Object.assign(views, { createElement, createIcon, createCloseButton });
  Object.assign(ui, { createWatchPartyIcon, hidePanel, focusPanelStart, isKeyboardClick });
})();
