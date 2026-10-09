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
require('../ui/render.js');
require('../ui/styles.js');
require('../ui/header.js');

const {
  PANEL_ID,
  BTN_ID,
  STYLE_ID,
  HEADER_BTN_CLASS,
  LEGACY_HEADER_BTN_ID,
  MODERN_HEADER_BTN_ID,
  PANEL_HEADER_CLASS
} = OWP.constants;

// Layout boxes for the fake DOM: an element is shown unless a test hides it.
Object.getPrototypeOf(document.createElement('div')).getClientRects = function getClientRects() {
  return this.hiddenForTest ? [] : [{}];
};
let focused = null;
Object.getPrototypeOf(document.createElement('div')).focus = function focus() {
  focused = this;
};
Object.getPrototypeOf(document.createElement('div')).blur = function blur() {
  if (focused === this) focused = null;
  this.blurredForTest = true;
};
// The element the focus stubs above last focused.
Object.defineProperty(FakeDocument.prototype, 'activeElement', { configurable: true, get: () => focused });

const element = (tag, className = '', attributes = {}) => {
  const node = document.createElement(tag);
  node.className = className;
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
};

// Jellyfin 12 legacy header: .skinHeader > .headerRight, SyncPlay first.
const legacyHeader = () => {
  const header = element('div', 'skinHeader');
  const right = element('div', 'headerRight');
  right.append(
    element('button', 'headerSyncButton syncButton headerButton headerButtonRight paper-icon-button-light'),
    element('button', 'headerButton headerButtonRight headerSearchButton paper-icon-button-light')
  );
  header.appendChild(right);
  header.getBoundingClientRect = () => ({ bottom: 60 });
  document.body.appendChild(header);
  return { header, right };
};

// Jellyfin 12 MUI app bar: header.MuiAppBar-root > .MuiToolbar-root > a box
// with the SyncPlay, Cast and Search icon buttons.
const ICON_BUTTON = 'MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeLarge css-icon';
const modernHeader = ({ syncPlay = true } = {}) => {
  const header = element('header', 'MuiPaper-root MuiAppBar-root');
  const toolbar = element('div', 'MuiToolbar-root');
  const box = element('div', 'MuiBox-root css-actions');
  if (syncPlay) box.appendChild(element('button', `${ICON_BUTTON} Mui-focusVisible`, { 'aria-controls': 'app-sync-play-menu' }));
  box.appendChild(element('button', ICON_BUTTON, { 'aria-controls': 'app-remote-play-menu' }));
  box.appendChild(element('a', ICON_BUTTON, { href: '#/search' }));
  toolbar.appendChild(box);
  header.appendChild(toolbar);
  header.getBoundingClientRect = () => ({ bottom: 48 });
  document.body.appendChild(header);
  return { header, box };
};

const panel = () => document.getElementById(PANEL_ID);
const headerButtons = () => document.querySelectorAll(`.${HEADER_BTN_CLASS}`);

// Browser hooks the page observers use: MutationObserver, requestAnimationFrame
// and the window resize listener, recorded so tests can fire them.
const installPageHooks = () => {
  const hooks = { observers: [], frames: [], resize: null };
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
  window.requestAnimationFrame = callback => hooks.frames.push(callback);
  window.cancelAnimationFrame = () => {};
  window.addEventListener = (type, listener) => { if (type === 'resize') hooks.resize = listener; };
  window.removeEventListener = (type, listener) => { if (type === 'resize' && hooks.resize === listener) hooks.resize = null; };
  hooks.pageObserver = () => hooks.observers.find(observer => observer.target === document.body);
  hooks.panelObserver = () => hooks.observers.find(observer => observer.target === panel());
  hooks.runFrame = () => hooks.frames.shift()();
  return hooks;
};

describe('header Watch Party button', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const panelElement = element('div', 'hide');
    panelElement.id = PANEL_ID;
    document.body.appendChild(panelElement);
    globalThis.innerHeight = 800;
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.removeHeaderButtons();
  });

  afterEach(() => {
    OWP.ui.removeHeaderButtons();
    delete window.MutationObserver;
    delete window.requestAnimationFrame;
    delete window.cancelAnimationFrame;
    delete window.addEventListener;
    delete window.removeEventListener;
    delete window.visualViewport;
  });

  it('adds one button to the legacy header, before SyncPlay', () => {
    const { right } = legacyHeader();

    OWP.ui.injectHeaderButtons();
    OWP.ui.injectHeaderButtons();

    const buttons = headerButtons();
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].id, LEGACY_HEADER_BTN_ID);
    assert.equal(right.children[0], buttons[0]);
    assert.ok(buttons[0].classList.contains('headerButton'));
    assert.ok(buttons[0].classList.contains('paper-icon-button-light'));
    assert.equal(buttons[0].getAttribute('aria-label'), 'Watch Party');
    assert.equal(buttons[0].getAttribute('aria-controls'), PANEL_ID);
    const icon = buttons[0].querySelector('.material-icons.owp-watch-party-icon');
    assert.ok(icon);
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.querySelector('svg').getAttribute('viewBox'), '0 0 24 24');
    assert.equal(buttons[0].querySelector('.theaters'), null);
  });

  it('adds one button to the MUI app bar with the native icon button classes', () => {
    const { box } = modernHeader();

    OWP.ui.injectHeaderButtons();
    OWP.ui.injectHeaderButtons();

    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    assert.equal(headerButtons().length, 1);
    assert.equal(box.children[0], button);
    assert.ok(button.classList.contains('MuiIconButton-root'));
    assert.ok(button.classList.contains('css-icon'));
    assert.equal(button.classList.contains('Mui-focusVisible'), false);
  });

  it('finds the MUI action box when SyncPlay is not shown', () => {
    const { box } = modernHeader({ syncPlay: false });

    OWP.ui.injectHeaderButtons();

    assert.equal(box.children[0].id, MODERN_HEADER_BTN_ID);
  });

  it('ignores toolbars outside the app bar', () => {
    const pageToolbar = element('div', 'MuiToolbar-root');
    pageToolbar.appendChild(element('button', ICON_BUTTON, { 'aria-controls': 'app-sync-play-menu' }));
    document.body.appendChild(pageToolbar);

    OWP.ui.injectHeaderButtons();

    assert.equal(headerButtons().length, 0);
  });

  it('adds a button to each header when both are rendered', () => {
    legacyHeader();
    modernHeader();

    OWP.ui.injectHeaderButtons();

    assert.deepEqual(headerButtons().map(button => button.id).sort(), [LEGACY_HEADER_BTN_ID, MODERN_HEADER_BTN_ID]);
  });

  it('puts the button back after Jellyfin rebuilds the app bar', () => {
    const first = modernHeader();
    OWP.ui.injectHeaderButtons();
    first.header.remove();

    const second = modernHeader();
    OWP.ui.injectHeaderButtons();

    assert.equal(headerButtons().length, 1);
    assert.equal(second.box.children[0].id, MODERN_HEADER_BTN_ID);
  });

  it('removes the buttons on cleanup and adds them back only once', () => {
    legacyHeader();
    modernHeader();
    OWP.ui.injectHeaderButtons();

    OWP.ui.removeHeaderButtons();
    assert.equal(headerButtons().length, 0);

    OWP.ui.injectHeaderButtons();
    OWP.ui.injectHeaderButtons();
    assert.equal(headerButtons().length, 2);
  });

  it('reinjects on page changes once per frame, and stops observing on cleanup', () => {
    const hooks = installPageHooks();
    const first = modernHeader();
    OWP.ui.injectHeaderButtons();
    first.header.remove();
    const second = modernHeader();

    const rebuilt = [{ target: document.body, addedNodes: [second.header], removedNodes: [first.header] }];
    hooks.pageObserver().callback(rebuilt);
    hooks.pageObserver().callback(rebuilt);
    assert.equal(hooks.frames.length, 1);
    hooks.runFrame();

    assert.equal(second.box.children[0].id, MODERN_HEADER_BTN_ID);
    assert.ok(hooks.resize);
    OWP.ui.removeHeaderButtons();
    assert.ok(hooks.observers.every(observer => observer.disconnected));
    assert.equal(hooks.resize, null);
  });

  it('adds the button once a header appears after start', () => {
    const hooks = installPageHooks();
    OWP.ui.injectHeaderButtons();
    assert.equal(headerButtons().length, 0);

    const { box, header } = modernHeader();
    hooks.pageObserver().callback([{ target: document.body, addedNodes: [header], removedNodes: [] }]);
    hooks.runFrame();

    assert.equal(box.children[0].id, MODERN_HEADER_BTN_ID);
  });

  it('adds the button when the whole layout, header included, is mounted again', () => {
    const hooks = installPageHooks();
    OWP.ui.injectHeaderButtons();
    const { header, box } = modernHeader();
    const layout = element('div', 'reactRoot');
    layout.appendChild(header);
    document.body.appendChild(layout);

    hooks.pageObserver().callback([{ target: document.body, addedNodes: [layout], removedNodes: [] }]);
    hooks.runFrame();

    assert.equal(box.children[0].id, MODERN_HEADER_BTN_ID);
  });

  it('ignores page changes outside the headers while the panel is closed', () => {
    const hooks = installPageHooks();
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const page = element('div', 'page itemDetailPage');
    const card = element('div', 'card');
    page.appendChild(card);
    document.body.appendChild(page);

    hooks.pageObserver().callback([
      { target: document.body, addedNodes: [page], removedNodes: [] },
      { target: page, addedNodes: [document.createTextNode('0:42')], removedNodes: [] }
    ]);

    assert.equal(hooks.frames.length, 0);
  });

  it('reacts to a change inside a header', () => {
    const hooks = installPageHooks();
    const { box } = modernHeader();
    OWP.ui.injectHeaderButtons();
    box.children[0].remove();

    hooks.pageObserver().callback([{ target: box, addedNodes: [], removedNodes: [] }]);
    hooks.runFrame();

    assert.equal(box.children[0].id, MODERN_HEADER_BTN_ID);
  });

  it('follows every page change only while the panel opened from the header is open', () => {
    const hooks = installPageHooks();
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    const playerChange = [{ target: document.body, addedNodes: [element('div', 'page videoOsdPage')], removedNodes: [] }];

    button.click();
    hooks.pageObserver().callback(playerChange);
    assert.equal(hooks.frames.length, 1);
    hooks.runFrame();

    button.click();
    hooks.pageObserver().callback(playerChange);
    assert.equal(hooks.frames.length, 0);
  });

  it('opens the panel below the header and closes it on the next click', () => {
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);

    button.click();

    assert.equal(panel().classList.contains('hide'), false);
    assert.ok(panel().classList.contains(PANEL_HEADER_CLASS));
    assert.equal(panel().style.top, '56px');
    assert.equal(panel().style.maxHeight, '450px');
    assert.ok(panel().querySelector('#owp-btn-create'));

    button.click();

    assert.ok(panel().classList.contains('hide'));
  });

  it('moves focus into the panel only when the header button is used from the keyboard', () => {
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    const click = detail => button.dispatchEvent({ type: 'click', detail, preventDefault() {}, stopPropagation() {} });

    focused = null;
    click(1);
    assert.equal(panel().classList.contains('hide'), false);
    assert.equal(focused, null);
    click(1);

    // Nothing plays, so Create Room is disabled and the close button takes focus.
    click(0);
    assert.ok(panel().querySelectorAll('button').includes(focused));
    assert.ok(focused.classList.contains('owp-close-btn'));
  });

  it('keeps the player button expanded state in step with the panel', () => {
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const osdButton = element('button', 'btnWatchParty', { 'aria-expanded': 'false' });
    osdButton.id = BTN_ID;
    document.body.appendChild(osdButton);

    document.getElementById(MODERN_HEADER_BTN_ID).click();
    assert.equal(osdButton.getAttribute('aria-expanded'), 'true');

    document.getElementById(MODERN_HEADER_BTN_ID).click();
    assert.equal(osdButton.getAttribute('aria-expanded'), 'false');
  });

  it('places the panel below the legacy header too', () => {
    legacyHeader();
    OWP.ui.injectHeaderButtons();

    document.getElementById(LEGACY_HEADER_BTN_ID).click();

    assert.equal(panel().style.top, '68px');
  });

  it('limits the panel height to the space below the header', () => {
    globalThis.innerHeight = 300;
    modernHeader();
    OWP.ui.injectHeaderButtons();

    document.getElementById(MODERN_HEADER_BTN_ID).click();

    assert.equal(panel().style.maxHeight, '236px');
  });

  it('keeps the open panel below the header when the window or the header changes size', () => {
    const hooks = installPageHooks();
    const { header } = modernHeader();
    OWP.ui.injectHeaderButtons();
    document.getElementById(MODERN_HEADER_BTN_ID).click();

    header.getBoundingClientRect = () => ({ bottom: 100 });
    globalThis.innerHeight = 400;
    hooks.resize();
    hooks.runFrame();

    assert.equal(panel().style.top, '108px');
    assert.equal(panel().style.maxHeight, '284px');
  });

  it('moves the open panel to the usual place once no header button is shown', () => {
    const hooks = installPageHooks();
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    button.click();

    // The player hides the header buttons (.osdHeader) or the whole app bar.
    button.hiddenForTest = true;
    hooks.pageObserver().callback([]);
    hooks.runFrame();

    assert.equal(panel().classList.contains('hide'), false);
    assert.equal(panel().classList.contains(PANEL_HEADER_CLASS), false);
    assert.equal(panel().style.top, '');
    assert.equal(panel().style.maxHeight, '');
  });

  it('goes back below the header when it returns while the panel is still open', () => {
    const hooks = installPageHooks();
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    button.click();
    button.hiddenForTest = true;
    hooks.pageObserver().callback([]);
    hooks.runFrame();
    assert.equal(panel().classList.contains(PANEL_HEADER_CLASS), false);

    button.hiddenForTest = false;
    hooks.pageObserver().callback([]);
    hooks.runFrame();

    assert.ok(panel().classList.contains(PANEL_HEADER_CLASS));
    assert.equal(panel().style.top, '56px');
  });

  it('rechecks the placement on the periodic injection too', () => {
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const button = document.getElementById(MODERN_HEADER_BTN_ID);
    button.click();

    // A class or style change hides the header without a childList mutation.
    button.hiddenForTest = true;
    OWP.ui.injectHeaderButtons();

    assert.equal(panel().classList.contains(PANEL_HEADER_CLASS), false);
    assert.equal(panel().style.top, '');
  });

  it('fits the panel above an on-screen keyboard with the visual viewport', () => {
    const hooks = installPageHooks();
    let viewportListener = null;
    window.visualViewport = {
      height: 300,
      addEventListener: (type, listener) => { if (type === 'resize') viewportListener = listener; },
      removeEventListener: (type, listener) => { if (viewportListener === listener) viewportListener = null; }
    };
    modernHeader();
    OWP.ui.injectHeaderButtons();

    document.getElementById(MODERN_HEADER_BTN_ID).click();
    assert.equal(panel().style.maxHeight, '236px');

    window.visualViewport.height = 200;
    viewportListener();
    hooks.runFrame();
    assert.equal(panel().style.maxHeight, '136px');

    OWP.ui.removeHeaderButtons();
    assert.equal(viewportListener, null);
  });

  it('returns the panel to its usual place when opened from the player', () => {
    modernHeader();
    const osd = element('div', 'videoOsdBottom');
    osd.appendChild(element('div', 'buttons'));
    document.body.appendChild(osd);
    OWP.ui.injectHeaderButtons();
    OWP.ui.injectOsdButton();
    const headerButton = document.getElementById(MODERN_HEADER_BTN_ID);
    headerButton.click();
    headerButton.click();

    document.getElementById(BTN_ID).click();
    // The next periodic injection must not take it back below the header.
    OWP.ui.injectHeaderButtons();

    assert.equal(panel().classList.contains('hide'), false);
    assert.equal(panel().classList.contains(PANEL_HEADER_CLASS), false);
    assert.equal(panel().style.top, '');
    assert.equal(panel().style.maxHeight, '');
  });

  it('moves the player button to a new player page, never to a hidden one', () => {
    const playerPage = () => {
      const page = element('div', 'page');
      const osd = element('div', 'videoOsdBottom');
      const buttons = element('div', 'buttons');
      osd.appendChild(buttons);
      page.appendChild(osd);
      document.body.appendChild(page);
      return { page, buttons };
    };
    const first = playerPage();
    OWP.ui.injectOsdButton();
    assert.equal(document.getElementById(BTN_ID).parentNode, first.buttons);

    // Jellyfin hides the previous player page and opens a new one.
    first.page.classList.add('hide');
    const second = playerPage();
    OWP.ui.injectOsdButton();
    OWP.ui.injectOsdButton();

    const buttons = document.querySelectorAll(`#${BTN_ID}`);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].parentNode, second.buttons);

    // While Jellyfin swaps pages both can be shown: the button follows the
    // first shown player, and moves once that one is hidden.
    const third = playerPage();
    OWP.ui.injectOsdButton();
    assert.equal(document.getElementById(BTN_ID).parentNode, second.buttons);
    second.page.classList.add('hide');
    OWP.ui.injectOsdButton();
    assert.equal(document.getElementById(BTN_ID).parentNode, third.buttons);
    assert.equal(document.querySelectorAll(`#${BTN_ID}`).length, 1);

    // Jellyfin shows the cached second page again, before the third one in
    // the document: the button follows it even before the third is hidden.
    second.page.classList.remove('hide');
    OWP.ui.injectOsdButton();
    assert.equal(document.getElementById(BTN_ID).parentNode, second.buttons);

    // Only hidden players left: no button is added to them.
    second.page.remove();
    third.page.remove();
    OWP.ui.injectOsdButton();
    assert.equal(document.getElementById(BTN_ID), null);
  });

  it('closes the panel from its X button, in the lobby and in a room', () => {
    modernHeader();
    OWP.ui.injectHeaderButtons();
    OWP.ui.stopPlayerCapture = () => {};
    OWP.chat.markRead = () => {};
    OWP.chat.renderAllMessages = () => {};
    const button = document.getElementById(MODERN_HEADER_BTN_ID);

    button.click();
    const lobbyClose = panel().querySelector('.owp-close-btn');
    assert.equal(lobbyClose.getAttribute('aria-label'), 'Close panel');
    assert.ok(lobbyClose.querySelector('.owp-icon-x'));
    // Clicking a button focuses it, as in a browser.
    lobbyClose.focus();
    lobbyClose.click();
    assert.ok(panel().classList.contains('hide'));
    assert.equal(focused, button);

    OWP.state.inRoom = true;
    OWP.state.isHost = true;
    OWP.state.roomName = 'Movie night';
    try {
      button.click();
      // The host's button ends the room for everyone; the X only hides the panel.
      assert.equal(panel().querySelector('#owp-btn-leave').getAttribute('aria-label'), 'Close room');
      panel().querySelector('.owp-close-btn').click();

      assert.ok(panel().classList.contains('hide'));
      assert.equal(OWP.state.inRoom, true);
    } finally {
      OWP.state.inRoom = false;
      OWP.state.isHost = false;
      OWP.state.roomName = '';
    }
  });

  it('returns focus to the player button, and leaves it alone when the opener is hidden', () => {
    modernHeader();
    const osd = element('div', 'videoOsdBottom');
    osd.appendChild(element('div', 'buttons'));
    document.body.appendChild(osd);
    OWP.ui.injectHeaderButtons();
    OWP.ui.injectOsdButton();
    const osdButton = document.getElementById(BTN_ID);

    osdButton.click();
    const firstClose = panel().querySelector('.owp-close-btn');
    firstClose.focus();
    firstClose.click();
    assert.equal(focused, osdButton);

    const headerButton = document.getElementById(MODERN_HEADER_BTN_ID);
    headerButton.click();
    headerButton.hiddenForTest = true;
    const close = panel().querySelector('.owp-close-btn');
    close.focus();
    close.click();
    // Focus does not stay on the X inside the hidden panel.
    assert.equal(focused, null);
    assert.equal(close.blurredForTest, true);
  });

  it('reports whether the panel is open with aria-expanded, however it closes', () => {
    const hooks = installPageHooks();
    legacyHeader();
    modernHeader();
    OWP.ui.injectHeaderButtons();
    const expanded = () => headerButtons().map(button => button.getAttribute('aria-expanded'));
    assert.deepEqual(expanded(), ['false', 'false']);

    document.getElementById(MODERN_HEADER_BTN_ID).click();
    assert.deepEqual(expanded(), ['true', 'true']);

    // Closed elsewhere, for example by leaving the room.
    panel().classList.add('hide');
    hooks.panelObserver().callback([]);
    assert.deepEqual(expanded(), ['false', 'false']);
    assert.deepEqual(hooks.panelObserver().options.attributeFilter, ['class']);
  });

  it('styles the header placement and hides the header button inside the player', () => {
    OWP.ui.injectStyles();

    const css = document.getElementById(STYLE_ID).textContent;
    assert.match(css, new RegExp(`#${PANEL_ID}\\.${PANEL_HEADER_CLASS} \\{ bottom: auto; \\}`));
    assert.match(css, new RegExp(`@media \\(max-width: 600px\\) \\{\\s*#${PANEL_ID}\\.${PANEL_HEADER_CLASS} \\{ left: 8px; right: 8px; width: auto; \\}`));
    assert.match(css, new RegExp(`\\.osdHeader \\.${HEADER_BTN_CLASS} \\{ display: none !important; \\}`));
    assert.match(css, new RegExp(`#${MODERN_HEADER_BTN_ID} \\.material-icons \\{ font-size: 1\\.5rem; width: 1em; height: 1em; line-height: 1; \\}`));
  });
});
