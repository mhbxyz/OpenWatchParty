const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../ui/styles.js');
require('../ui/header.js');

const { PANEL_ID, STYLE_ID, MODERN_HEADER_BTN_ID, PANEL_CONTROLS_HIDDEN_CLASS } = OWP.constants;

Object.getPrototypeOf(document.createElement('div')).getClientRects = function getClientRects() {
  return [{}];
};
let focused = null;
Object.getPrototypeOf(document.createElement('div')).focus = function focus() {
  focused = this;
};
Object.getPrototypeOf(document.createElement('div')).blur = function blur() {
  if (focused === this) focused = null;
};
Object.defineProperty(FakeDocument.prototype, 'activeElement', { configurable: true, get: () => focused });

const element = (tag, className = '', attributes = {}) => {
  const node = document.createElement(tag);
  node.className = className;
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
};

const ICON_BUTTON = 'MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeLarge css-icon';

// Jellyfin 12's player: its header (.skinHeader.osdHeader, osdHeader-hidden
// while the controls are hidden) and its page, #videoOsdPage, where a press
// outside the bottom controls is play/pause.
const player = () => {
  const header = element('div', 'skinHeader osdHeader');
  const toolbar = element('div', 'MuiToolbar-root');
  const box = element('div', 'MuiBox-root css-osd-actions');
  box.appendChild(element('button', ICON_BUTTON, { 'aria-controls': 'app-remote-play-menu' }));
  toolbar.appendChild(box);
  header.appendChild(toolbar);
  header.getBoundingClientRect = () => ({ bottom: 112 });
  toolbar.getBoundingClientRect = () => ({ bottom: 48 });
  const page = element('div', 'page libraryPage', { id: 'videoOsdPage' });
  const picture = element('div', 'videoOsdPicture');
  const bottom = element('div', 'videoOsdBottom');
  const pause = element('button', 'btnPause');
  bottom.appendChild(pause);
  page.append(picture, bottom);
  document.body.append(header, page);
  return { header, page, picture, pause };
};

const panel = () => document.getElementById(PANEL_ID);
const faded = () => panel().classList.contains(PANEL_CONTROLS_HIDDEN_CLASS);
const closed = () => panel().classList.contains('hide');

// The browser hooks the header code uses, recorded so tests can fire them.
const installHooks = () => {
  const hooks = { observers: [], listeners: {} };
  window.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      hooks.observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() { this.disconnected = true; }
  };
  window.requestAnimationFrame = () => {};
  window.cancelAnimationFrame = () => {};
  window.addEventListener = (type, listener, options) => {
    (hooks.listeners[type] ||= []).push({ listener, options });
  };
  window.removeEventListener = (type, listener) => {
    hooks.listeners[type] = (hooks.listeners[type] || []).filter(entry => entry.listener !== listener);
  };
  // Window listeners run in the capture phase, before the page's own.
  hooks.fire = (type, props = {}) => {
    const event = {
      type,
      button: 0,
      ...props,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; }
    };
    for (const { listener } of hooks.listeners[type] || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  };
  hooks.headerObserver = header => hooks.observers.find(observer => observer.target === header && !observer.disconnected);
  return hooks;
};

// Opens the panel from the player header and returns the player.
const openOverPlayer = (hooks) => {
  const parts = player();
  OWP.ui.injectHeaderButtons();
  document.getElementById(MODERN_HEADER_BTN_ID).click();
  assert.equal(closed(), false);
  parts.setControlsHidden = (hidden) => {
    parts.header.classList.toggle('osdHeader-hidden', hidden);
    hooks.headerObserver(parts.header).callback([]);
  };
  return parts;
};

const resetPage = () => {
  globalThis.document = new FakeDocument();
  const panelElement = element('div', 'hide');
  panelElement.id = PANEL_ID;
  document.body.appendChild(panelElement);
  globalThis.innerHeight = 800;
  focused = null;
  OWP.ui.updateStatusIndicator = () => {};
  OWP.ui.updateSyncIndicator = () => {};
  OWP.ui.renderHomeWatchParties = () => {};
};

const removeHooks = () => {
  OWP.ui.removeHeaderButtons();
  delete window.MutationObserver;
  delete window.requestAnimationFrame;
  delete window.cancelAnimationFrame;
  delete window.addEventListener;
  delete window.removeEventListener;
  delete window.PointerEvent;
};

describe('the panel over the player', () => {
  let hooks;
  beforeEach(() => {
    resetPage();
    hooks = installHooks();
  });
  afterEach(removeHooks);

  it('fades out with the player controls and comes back as it was', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    OWP.state.roomBarSection = 'chat';
    try {
      setControlsHidden(true);
      assert.equal(faded(), true);
      // Still open: only out of sight, with the same drop-down.
      assert.equal(closed(), false);
      assert.equal(OWP.state.roomBarSection, 'chat');

      setControlsHidden(false);
      assert.equal(faded(), false);
      assert.equal(closed(), false);
    } finally {
      OWP.state.roomBarSection = '';
    }
  });

  it('watches the class of the player header, and moves to a new header', () => {
    const { header } = openOverPlayer(hooks);
    assert.deepEqual(hooks.headerObserver(header).options, { attributes: true, attributeFilter: ['class'] });

    // Jellyfin rebuilt its header.
    header.classList.remove('osdHeader');
    const rebuilt = element('div', 'skinHeader osdHeader osdHeader-hidden');
    document.body.appendChild(rebuilt);
    OWP.ui.injectHeaderButtons();

    assert.equal(hooks.headerObserver(header), undefined);
    assert.ok(hooks.headerObserver(rebuilt));
    assert.equal(faded(), true);
  });

  it('fades with the controls even under a resting pointer, as they do', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    const inside = panel().querySelector('.owp-close-btn');

    hooks.fire('pointerover', { target: inside });
    hooks.fire('pointermove', { target: inside });
    setControlsHidden(true);

    assert.equal(faded(), true);
  });

  it('stays while someone types in it, not for a focused button', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    const input = element('input');
    panel().appendChild(input);

    input.focus();
    hooks.fire('focusin', { target: input });
    setControlsHidden(true);
    assert.equal(faded(), false);

    focused = null;
    hooks.fire('focusout', { target: input });
    assert.equal(faded(), true);

    const button = panel().querySelector('.owp-close-btn');
    button.focus();
    hooks.fire('focusin', { target: button });
    assert.equal(faded(), true);
  });

  it('fades while a field outside it has focus', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    const field = element('input');
    document.body.appendChild(field);

    field.focus();
    hooks.fire('focusin', { target: field });
    setControlsHidden(true);

    assert.equal(faded(), true);
  });

  it('stays in sight while the up-next countdown of the queue is in it', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    setControlsHidden(true);
    assert.equal(faded(), true);

    const strip = element('div', 'owp-queue-next');
    panel().appendChild(strip);
    OWP.ui.applyPlayerControls();
    assert.equal(faded(), false);

    strip.remove();
    OWP.ui.applyPlayerControls();
    assert.equal(faded(), true);
  });

  it('follows the controls again when the header buttons come back', () => {
    const { setControlsHidden } = openOverPlayer(hooks);
    OWP.ui.removeHeaderButtons();
    OWP.ui.injectHeaderButtons();

    setControlsHidden(true);

    assert.equal(faded(), true);
  });

  it('shows again when the player closes', () => {
    const { header, setControlsHidden } = openOverPlayer(hooks);
    setControlsHidden(true);
    assert.equal(faded(), true);

    // Jellyfin takes both classes off the header that stays in the page.
    header.classList.remove('osdHeader', 'osdHeader-hidden');
    hooks.headerObserver(header).callback([]);

    assert.equal(faded(), false);
  });

  it('leaves the panel alone outside the player', () => {
    const header = element('div', 'skinHeader osdHeader-hidden');
    document.body.appendChild(header);
    OWP.ui.injectHeaderButtons();

    assert.equal(hooks.observers.some(observer => observer.target === header), false);
    assert.equal(faded(), false);
  });
});

describe('a press outside the panel', () => {
  let hooks;
  beforeEach(() => {
    resetPage();
    hooks = installHooks();
  });
  afterEach(removeHooks);

  it('closes it like its X, and lets the press through', () => {
    openOverPlayer(hooks);
    const elsewhere = element('div', 'cardBox');
    document.body.appendChild(elsewhere);
    // Focus inside the panel goes back to the Watch Party button, as with the X.
    panel().querySelector('.owp-close-btn').focus();

    const event = hooks.fire('pointerdown', { target: elsewhere });

    assert.equal(closed(), true);
    assert.equal(focused, document.getElementById(MODERN_HEADER_BTN_ID));
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.immediatePropagationStopped, undefined);
    assert.equal(document.getElementById(MODERN_HEADER_BTN_ID).getAttribute('aria-expanded'), 'false');
  });

  it('only closes it on the player picture, so the player does not take it as play or pause', () => {
    const { page, picture } = openOverPlayer(hooks);
    let playerSaw = false;
    window.addEventListener('pointerdown', () => { playerSaw = true; }, { capture: true, passive: true });

    for (const target of [picture, page]) {
      if (closed()) document.getElementById(MODERN_HEADER_BTN_ID).click();
      assert.equal(closed(), false);
      playerSaw = false;
      const event = hooks.fire('pointerdown', { target, pointerType: 'mouse' });

      assert.equal(closed(), true);
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.propagationStopped, true);
      assert.equal(playerSaw, false);
    }
  });

  // The browser's PointerEvent, as a plain event the fake DOM can dispatch.
  const installPointerEvent = () => {
    window.PointerEvent = class {
      constructor(type, init) {
        Object.assign(this, init, { type, init });
      }
    };
  };

  it('stops the second click of a double click too, whatever the system double-click time', () => {
    installPointerEvent();
    const { picture, pause } = openOverPlayer(hooks);
    const handedOn = [];
    picture.addEventListener('pointerdown', event => handedOn.push(event));
    let playerSaw = 0;
    window.addEventListener('pointerdown', () => { playerSaw += 1; }, { capture: true, passive: true });
    const mouse = { target: picture, pointerType: 'mouse' };

    assert.equal(hooks.fire('pointerdown', mouse).defaultPrevented, true);
    assert.equal(closed(), true);
    assert.equal(hooks.fire('click', { target: picture, detail: 1 }).immediatePropagationStopped, true);
    // A click elsewhere, from the keyboard say, is not part of it.
    assert.equal(hooks.fire('click', { target: pause, detail: 0 }).immediatePropagationStopped, undefined);

    // The second press waits for its mousedown, without losing it.
    const second = hooks.fire('pointerdown', mouse);
    assert.equal(second.immediatePropagationStopped, true);
    assert.equal(second.defaultPrevented, false);
    assert.equal(playerSaw, 0);
    // Its click count says it is the second click of a double click.
    assert.equal(hooks.fire('mousedown', { target: picture, detail: 2 }).immediatePropagationStopped, true);
    assert.deepEqual(handedOn, []);
    assert.equal(hooks.fire('click', { target: picture, detail: 2 }).immediatePropagationStopped, true);
    assert.equal(hooks.fire('dblclick', { target: picture, detail: 2 }).immediatePropagationStopped, true);

    // Over: the next press is the player's.
    const next = hooks.fire('pointerdown', mouse);
    assert.equal(next.immediatePropagationStopped, undefined);
    assert.equal(playerSaw, 1);
  });

  it('hands a new click on the picture on to the player, as it came', () => {
    installPointerEvent();
    const { picture } = openOverPlayer(hooks);
    const handedOn = [];
    picture.addEventListener('pointerdown', event => handedOn.push(event));
    hooks.fire('pointerdown', { target: picture, pointerType: 'mouse' });

    const press = hooks.fire('pointerdown', { target: picture, pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 400, clientY: 300 });
    assert.equal(press.immediatePropagationStopped, true);
    hooks.fire('mousedown', { target: picture, detail: 1 });

    assert.equal(handedOn.length, 1);
    assert.equal(handedOn[0].type, 'pointerdown');
    assert.equal(handedOn[0].pointerType, 'mouse');
    assert.equal(handedOn[0].button, 0);
    assert.equal(handedOn[0].init.bubbles, true);
    assert.deepEqual([handedOn[0].pointerId, handedOn[0].isPrimary, handedOn[0].clientX, handedOn[0].clientY], [1, true, 400, 300]);
    // Its click is no longer stopped either.
    assert.equal(hooks.fire('click', { target: picture, detail: 1 }).immediatePropagationStopped, undefined);
  });

  it('drops a held press whose mousedown never came', () => {
    installPointerEvent();
    const { picture, pause } = openOverPlayer(hooks);
    const handedOn = [];
    picture.addEventListener('pointerdown', event => handedOn.push(event));
    hooks.fire('pointerdown', { target: picture, pointerType: 'mouse' });
    hooks.fire('pointerdown', { target: picture, pointerType: 'mouse' });

    // The next press, elsewhere, brings its own mousedown.
    hooks.fire('pointerdown', { target: pause, pointerType: 'mouse' });
    hooks.fire('mousedown', { target: pause, detail: 1 });

    assert.deepEqual(handedOn, []);
  });

  it('lets the second touch through and still stops the double tap', () => {
    installPointerEvent();
    const { picture } = openOverPlayer(hooks);
    const touch = { target: picture, pointerType: 'touch' };

    assert.equal(hooks.fire('pointerdown', touch).defaultPrevented, true);
    assert.equal(closed(), true);
    assert.equal(hooks.fire('click', { target: picture, detail: 1 }).immediatePropagationStopped, true);
    assert.equal(hooks.fire('pointerdown', touch).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('click', { target: picture, detail: 2 }).immediatePropagationStopped, true);
    assert.equal(hooks.fire('dblclick', { target: picture, detail: 2 }).immediatePropagationStopped, true);
  });

  it('ends the gesture at the next single tap, so later clicks get through', () => {
    installPointerEvent();
    const { picture } = openOverPlayer(hooks);
    const touch = { target: picture, pointerType: 'touch' };
    hooks.fire('pointerdown', touch);
    hooks.fire('click', { target: picture, detail: 1 });

    assert.equal(hooks.fire('pointerdown', touch).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('click', { target: picture, detail: 1 }).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('click', { target: picture, detail: 1 }).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('dblclick', { target: picture, detail: 2 }).immediatePropagationStopped, undefined);
  });

  it('ends the gesture on a press elsewhere, and leaves the other mouse buttons alone', () => {
    installPointerEvent();
    const { picture, pause } = openOverPlayer(hooks);
    hooks.fire('pointerdown', { target: picture, pointerType: 'mouse' });

    assert.equal(hooks.fire('pointerdown', { target: picture, pointerType: 'mouse', button: 2 }).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('pointerdown', { target: pause, pointerType: 'mouse' }).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('pointerdown', { target: picture, pointerType: 'mouse' }).immediatePropagationStopped, undefined);
    assert.equal(hooks.fire('dblclick', { target: picture, detail: 2 }).immediatePropagationStopped, undefined);
  });

  it('closes it for a press that guest controls stop, without stopping anything itself', () => {
    const { pause } = openOverPlayer(hooks);
    const press = { type: 'pointerdown', button: 0, target: pause, preventDefault() { this.defaultPrevented = true; } };

    assert.equal(OWP.ui.closePanelOnPress({ ...press, type: 'mousedown' }), false);
    assert.equal(closed(), false);
    assert.equal(OWP.ui.closePanelOnPress(press), true);
    assert.equal(closed(), true);
    assert.equal(press.defaultPrevented, undefined);
    assert.equal(OWP.ui.closePanelOnPress(press), false);
  });

  it('lets the player controls work while closing it', () => {
    const { page, pause } = openOverPlayer(hooks);
    const upNext = element('div', 'upNextContainer');
    page.appendChild(upNext);

    // A button, the bottom bar around it and Jellyfin's own up-next card.
    for (const target of [pause, pause.parentNode, upNext]) {
      if (closed()) document.getElementById(MODERN_HEADER_BTN_ID).click();
      const event = hooks.fire('pointerdown', { target });

      assert.equal(closed(), true);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
  });

  it('ignores presses inside it, on the Watch Party button, on the toasts, and on the emoji picker or autocomplete', () => {
    openOverPlayer(hooks);
    const toasts = element('div', 'owp-toast-container');
    const toast = element('div', 'owp-toast');
    toasts.appendChild(toast);
    const notice = element('div', 'owp-toast-system');
    const emojiPanel = element('div', '', { id: 'owp-emoji-panel' });
    const emojiItem = element('button', 'owp-emoji-item');
    emojiPanel.appendChild(emojiItem);
    const autocomplete = element('div', '', { id: 'owp-emoji-autocomplete' });
    const autocompleteItem = element('div', 'owp-emoji-suggestion');
    autocomplete.appendChild(autocompleteItem);
    document.body.append(toasts, notice, emojiPanel, autocomplete);
    const headerButton = document.getElementById(MODERN_HEADER_BTN_ID);

    const icon = headerButton.querySelector('.owp-watch-party-icon');
    assert.ok(icon);
    for (const target of [panel().querySelector('.owp-close-btn'), panel(), headerButton, icon, toast, notice, emojiPanel, emojiItem, autocomplete, autocompleteItem]) {
      const event = hooks.fire('pointerdown', { target });
      assert.equal(closed(), false);
      assert.equal(event.defaultPrevented, false);
    }
  });

  it('does nothing while the panel is closed or faded out with the controls', () => {
    const { picture, setControlsHidden } = openOverPlayer(hooks);

    setControlsHidden(true);
    let event = hooks.fire('pointerdown', { target: picture });
    // The press shows the controls as usual, and the panel with them.
    assert.equal(closed(), false);
    assert.equal(event.defaultPrevented, false);

    setControlsHidden(false);
    panel().querySelector('.owp-close-btn').click();
    event = hooks.fire('pointerdown', { target: picture });
    assert.equal(closed(), true);
    assert.equal(event.defaultPrevented, false);
  });

  it('ignores the other mouse buttons', () => {
    const { picture } = openOverPlayer(hooks);

    const event = hooks.fire('pointerdown', { target: picture, button: 2 });

    assert.equal(closed(), false);
    assert.equal(event.defaultPrevented, false);
  });

  it('listens in the capture phase, and stops when the header buttons are removed', () => {
    const types = ['pointerdown', 'mousedown', 'click', 'dblclick', 'focusin', 'focusout'];
    openOverPlayer(hooks);
    for (const type of types) {
      assert.deepEqual((hooks.listeners[type] || []).map(entry => entry.options), [true], type);
    }

    OWP.ui.removeHeaderButtons();

    for (const type of types) {
      assert.equal((hooks.listeners[type] || []).length, 0, type);
    }
    assert.ok(hooks.observers.every(observer => observer.disconnected));
  });
});

describe('panel fade styles', () => {
  it('fades the panel with the controls and keeps it out of the way while faded', () => {
    OWP.ui.injectStyles();
    const css = document.getElementById(STYLE_ID).textContent;

    assert.match(css, new RegExp(`#${PANEL_ID}\\.${PANEL_CONTROLS_HIDDEN_CLASS} \\{ opacity: 0; pointer-events: none; \\}`));
    assert.match(css, new RegExp(`#${PANEL_ID} \\{ transition: opacity 0\\.3s ease-out; \\}`));
    assert.match(css, new RegExp(`@media \\(prefers-reduced-motion: reduce\\) \\{\\s*#${PANEL_ID} \\{ transition: none; \\}`));
  });
});
