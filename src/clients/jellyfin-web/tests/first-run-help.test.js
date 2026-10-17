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

const {
  PANEL_ID,
  MODERN_HEADER_BTN_ID,
  LEGACY_HEADER_BTN_ID,
  PANEL_HEADER_CLASS,
  PANEL_BUBBLE_CLASS,
  ROOM_MODE_CLASS
} = OWP.constants;

const FakeElement = Object.getPrototypeOf(document.createElement('div'));
// Layout for the fake DOM: an element is shown unless a test hides it, and
// has the box a test gives it.
FakeElement.getClientRects = function getClientRects() {
  return this.hiddenForTest ? [] : [{}];
};
FakeElement.getBoundingClientRect = function getBoundingClientRect() {
  return this.boxForTest || { left: 0, width: 0, bottom: 0 };
};
let focused = null;
FakeElement.focus = function focus() {
  focused = this;
};
Object.defineProperty(FakeDocument.prototype, 'activeElement', { configurable: true, get: () => focused });

// header.js keeps whether it already looked at the first-run help for the
// page, so each test loads a fresh copy, as a page load would.
const loadHeaderModule = () => {
  delete require.cache[require.resolve('../ui/header.js')];
  require('../ui/header.js');
};

const byId = id => document.getElementById(id);
const panel = () => byId(PANEL_ID);
const helpButton = () => byId('owp-btn-help');
const help = () => byId('owp-help');

// Jellyfin 12's MUI app bar, 48 px high, with the Cast button that the Watch
// Party button goes next to.
const modernHeader = () => {
  const header = document.createElement('header');
  header.className = 'MuiAppBar-root';
  const box = document.createElement('div');
  const cast = document.createElement('button');
  cast.setAttribute('aria-controls', 'app-remote-play-menu');
  box.appendChild(cast);
  header.appendChild(box);
  header.boxForTest = { bottom: 48 };
  document.body.appendChild(header);
  return header;
};

// Places the injected header button: 46 px wide, centred at x = 1082 of a
// 1280 px window, like the real one.
const placeHeaderButton = (center = 1082) => {
  byId(MODERN_HEADER_BTN_ID).boxForTest = { left: center - 23, width: 46, bottom: 47 };
};

let storage;
let token;
let timeouts;
const realSetTimeout = OWP.timers.setTimeout;
const runTimeouts = () => timeouts.splice(0).forEach(callback => callback());
const announcer = () => byId('owp-announcer');

const openLobbyFromHeader = () => {
  OWP.ui.injectHeaderButtons();
  placeHeaderButton();
  byId(MODERN_HEADER_BTN_ID).click();
};

describe('lobby help and first run', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const element = document.createElement('div');
    element.id = PANEL_ID;
    element.className = 'hide';
    element.boxForTest = { width: 360 };
    document.body.appendChild(element);
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 800;
    focused = null;
    timeouts = [];
    OWP.timers.setTimeout = (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    };
    storage = new Map();
    window.localStorage = {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value))
    };
    token = 'jellyfin-token';
    OWP.actions = { getJellyfinAccessToken: () => token };
    Object.assign(OWP.state, { inRoom: false, rejoinPending: false, pendingJoinRoomId: '', rooms: [], lobbyHelpOpen: false });
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    loadHeaderModule();
  });

  afterEach(() => {
    OWP.ui.removeHeaderButtons();
    OWP.timers.setTimeout = realSetTimeout;
    delete window.localStorage;
  });

  describe('the "?" in the lobby', () => {
    beforeEach(() => {
      storage.set('owp-help-seen', '1');
      modernHeader();
    });

    it('sits between the connection status and the close button, with the help closed', () => {
      openLobbyFromHeader();
      const actions = panel().querySelector('.owp-header-actions').children;
      assert.deepEqual(actions.map(child => child.id || child.className), ['owp-ws-indicator', 'owp-btn-help', 'owp-close-btn owp-bar-btn']);
      assert.equal(helpButton().getAttribute('aria-controls'), 'owp-help');
      assert.equal(helpButton().getAttribute('aria-expanded'), 'false');
      assert.equal(helpButton().getAttribute('aria-label'), 'Help');
      assert.equal(help().hidden, true);
      assert.equal(panel().children[1], help());
    });

    it('opens and closes the help', () => {
      openLobbyFromHeader();
      helpButton().click();
      assert.equal(help().hidden, false);
      assert.equal(helpButton().getAttribute('aria-expanded'), 'true');
      assert.match(help().textContent, /^Watch movies and shows together, in sync\./);

      helpButton().click();
      assert.equal(help().hidden, true);
      assert.equal(helpButton().getAttribute('aria-expanded'), 'false');
    });

    it('closes the help with "Got it" or Escape and gives focus back to the "?"', () => {
      openLobbyFromHeader();
      helpButton().click();
      help().querySelector('.owp-help-ok').click();
      assert.equal(help().hidden, true);
      assert.equal(focused, helpButton());

      helpButton().click();
      focused = null;
      let prevented = false;
      help().dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => { prevented = true; } });
      assert.equal(help().hidden, true);
      assert.equal(prevented, true);
      assert.equal(focused, helpButton());

      help().dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => assert.fail('Enter is not handled') });
    });

    it('stays open across a redraw, and closed when the panel is opened again', () => {
      openLobbyFromHeader();
      helpButton().click();
      OWP.ui.render(true);
      assert.equal(help().hidden, false);

      byId(MODERN_HEADER_BTN_ID).click();
      byId(MODERN_HEADER_BTN_ID).click();
      assert.equal(help().hidden, true);
    });

    it('keeps keyboard focus off its own controls when the panel opens from the keyboard', () => {
      const getPlayingItemId = OWP.utils.getPlayingItemId;
      OWP.utils.getPlayingItemId = () => 'item-1';
      try {
        openLobbyFromHeader();
        helpButton().click();
        OWP.ui.focusPanelStart(panel());
        assert.equal(focused.id, 'owp-btn-create');
      } finally {
        OWP.utils.getPlayingItemId = getPlayingItemId;
      }
    });
  });

  describe('the lobby as a bubble below the header button', () => {
    beforeEach(() => {
      storage.set('owp-help-seen', '1');
      modernHeader();
    });

    it('centres the lobby on the button, with the arrow on it', () => {
      openLobbyFromHeader();
      assert.ok(panel().classList.contains(PANEL_HEADER_CLASS));
      assert.ok(panel().classList.contains(PANEL_BUBBLE_CLASS));
      assert.equal(panel().style.top, '56px');
      assert.equal(panel().style.left, '902px');
      assert.equal(panel().style['--owp-arrow-left'], '180px');
    });

    it('keeps the lobby inside the window and moves the arrow instead', () => {
      OWP.ui.injectHeaderButtons();
      placeHeaderButton(1250);
      byId(MODERN_HEADER_BTN_ID).click();
      assert.equal(panel().style.left, '912px');
      assert.equal(panel().style['--owp-arrow-left'], '338px');
    });

    it('keeps the arrow clear of the rounded corners', () => {
      OWP.ui.injectHeaderButtons();
      placeHeaderButton(1279);
      byId(MODERN_HEADER_BTN_ID).click();
      assert.equal(panel().style['--owp-arrow-left'], '344px');

      byId(MODERN_HEADER_BTN_ID).click();
      placeHeaderButton(0);
      byId(MODERN_HEADER_BTN_ID).click();
      assert.equal(panel().style.left, '8px');
      assert.equal(panel().style['--owp-arrow-left'], '16px');
    });

    it('follows the button when the window or the header changes', () => {
      openLobbyFromHeader();
      globalThis.innerWidth = 1000;
      placeHeaderButton(802);
      OWP.ui.injectHeaderButtons();
      assert.equal(panel().style.left, '622px');
      assert.equal(panel().style['--owp-arrow-left'], '180px');
    });

    it('hangs from the legacy header button too', () => {
      document.querySelector('header').remove();
      const header = document.createElement('div');
      header.className = 'skinHeader';
      const right = document.createElement('div');
      right.className = 'headerRight';
      header.appendChild(right);
      header.boxForTest = { bottom: 60 };
      document.body.appendChild(header);
      OWP.ui.injectHeaderButtons();
      byId(LEGACY_HEADER_BTN_ID).boxForTest = { left: 1059, width: 46, bottom: 59 };
      byId(LEGACY_HEADER_BTN_ID).click();
      assert.ok(panel().classList.contains(PANEL_BUBBLE_CLASS));
      assert.equal(panel().style.top, '68px');
      assert.equal(panel().style.left, '902px');
      assert.equal(panel().style['--owp-arrow-left'], '180px');
    });

    it('fits a narrow window', () => {
      globalThis.innerWidth = 375;
      panel().boxForTest = { width: 359 };
      OWP.ui.injectHeaderButtons();
      placeHeaderButton(300);
      byId(MODERN_HEADER_BTN_ID).click();
      assert.equal(panel().style.left, '8px');
      assert.equal(panel().style['--owp-arrow-left'], '292px');
    });

    it('leaves the room bar on the right, and follows the panel between both', () => {
      openLobbyFromHeader();
      OWP.state.inRoom = true;
      OWP.state.participants = [];
      OWP.ui.render(true);
      assert.ok(panel().classList.contains(ROOM_MODE_CLASS));
      assert.equal(panel().classList.contains(PANEL_BUBBLE_CLASS), false);
      assert.equal(panel().style.left, '');
      assert.equal(panel().style['--owp-arrow-left'], undefined);
      assert.equal(panel().style.top, '56px');

      OWP.state.inRoom = false;
      OWP.ui.render(true);
      assert.ok(panel().classList.contains(PANEL_BUBBLE_CLASS));
      assert.equal(panel().style.left, '902px');
    });

  });

  describe('first run', () => {
    it('opens the lobby from the header with the help, once, without taking focus', () => {
      modernHeader();
      OWP.ui.injectHeaderButtons();
      assert.equal(panel().classList.contains('hide'), false);
      assert.equal(help().hidden, false);
      assert.equal(helpButton().getAttribute('aria-expanded'), 'true');
      assert.equal(byId(MODERN_HEADER_BTN_ID).getAttribute('aria-expanded'), 'true');
      assert.ok(panel().classList.contains(PANEL_HEADER_CLASS));
      assert.equal(storage.get('owp-help-seen'), '1');
      assert.equal(focused, null);
      assert.equal(announcer().getAttribute('role'), 'status');
      assert.equal(announcer().getAttribute('aria-live'), 'polite');
      assert.ok(announcer().classList.contains('owp-visually-hidden'));
      assert.equal(announcer().textContent, '');
      runTimeouts();
      assert.match(announcer().textContent, /^Watch Party: Watch movies and shows together, in sync\./);

      byId(MODERN_HEADER_BTN_ID).click();
      OWP.ui.injectHeaderButtons();
      assert.ok(panel().classList.contains('hide'));
    });

    it('is not shown again in this browser, nor read out when the "?" opens it', () => {
      storage.set('owp-help-seen', '1');
      modernHeader();
      OWP.ui.injectHeaderButtons();
      assert.ok(panel().classList.contains('hide'));

      openLobbyFromHeader();
      helpButton().click();
      runTimeouts();
      assert.equal(announcer(), null);
    });

    it('waits for a Jellyfin login and for the header button', () => {
      token = '';
      modernHeader();
      OWP.ui.injectHeaderButtons();
      assert.ok(panel().classList.contains('hide'));
      assert.equal(storage.has('owp-help-seen'), false);

      token = 'jellyfin-token';
      byId(MODERN_HEADER_BTN_ID).hiddenForTest = true;
      OWP.ui.injectHeaderButtons();
      assert.ok(panel().classList.contains('hide'));
      assert.equal(storage.has('owp-help-seen'), false);

      byId(MODERN_HEADER_BTN_ID).hiddenForTest = false;
      OWP.ui.injectHeaderButtons();
      assert.equal(panel().classList.contains('hide'), false);
      assert.equal(help().hidden, false);
    });

    it('is skipped for people already in a watch party', () => {
      for (const busy of [{ inRoom: true }, { rejoinPending: true }, { pendingJoinRoomId: 'room-1' }]) {
        loadHeaderModule();
        storage.clear();
        Object.assign(OWP.state, { inRoom: false, rejoinPending: false, pendingJoinRoomId: '' }, busy);
        globalThis.document = new FakeDocument();
        const element = document.createElement('div');
        element.id = PANEL_ID;
        element.className = 'hide';
        document.body.appendChild(element);
        modernHeader();
        OWP.ui.injectHeaderButtons();
        assert.ok(panel().classList.contains('hide'), JSON.stringify(busy));
        assert.equal(storage.get('owp-help-seen'), '1', JSON.stringify(busy));
        assert.equal(announcer(), null, JSON.stringify(busy));
      }
    });

    it('opens the help in a lobby that is already open', () => {
      storage.set('owp-help-seen', '1');
      modernHeader();
      openLobbyFromHeader();
      storage.clear();
      loadHeaderModule();
      OWP.ui.injectHeaderButtons();
      assert.equal(panel().classList.contains('hide'), false);
      assert.equal(help().hidden, false);
      assert.equal(storage.get('owp-help-seen'), '1');
      runTimeouts();
      assert.match(announcer().textContent, /^Watch Party: /);
    });

    it('is shown once per page when the browser keeps no storage', () => {
      window.localStorage = {
        getItem: () => { throw new Error('storage disabled'); },
        setItem: () => { throw new Error('storage disabled'); }
      };
      modernHeader();
      OWP.ui.injectHeaderButtons();
      assert.equal(panel().classList.contains('hide'), false);

      byId(MODERN_HEADER_BTN_ID).click();
      OWP.ui.injectHeaderButtons();
      assert.ok(panel().classList.contains('hide'));
    });
  });
});
