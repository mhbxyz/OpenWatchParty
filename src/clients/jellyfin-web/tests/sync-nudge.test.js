const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = { updateSyncIndicator: () => {} };
OWP.chat = { messages: [], unreadCount: 0 };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../playback/sync.js');

const { PANEL_ID } = OWP.constants;
let focused = null;
Object.getPrototypeOf(document.createElement('div')).focus = function focus() {
  focused = this;
};
const playback = OWP.playback;
const nudgeState = playback.nudgeState;
const nudge = playback.nudge;

let serverNow;
let localNow;
let video;
let sent;
OWP.utils.getServerNow = () => serverNow;
OWP.utils.nowMs = () => localNow;
OWP.utils.isVideoReady = () => true;
OWP.utils.getVideo = () => video;
OWP.utils.log = () => {};

// TimeRanges stand-in: pairs of [start, end].
const ranges = (...pairs) => ({ length: pairs.length, start: i => pairs[i][0], end: i => pairs[i][1] });

// The host is at `hostAt` now; this guest's video is at `at`.
const guestAt = (at, hostAt) => {
  video.currentTime = at;
  OWP.state.lastSyncPosition = hostAt;
  OWP.state.lastSyncServerTs = serverNow;
};

const resetRoom = () => {
  serverNow = 100000;
  localNow = 50000;
  sent = [];
  video = { currentTime: 0, playbackRate: 1, paused: false, seeking: false, readyState: 4, buffered: ranges([0, 600]) };
  OWP.actions = { send: (...args) => sent.push(args) };
  Object.assign(OWP.state, {
    inRoom: true,
    isHost: false,
    roomId: 'room-1',
    currentVideoElement: video,
    pendingMediaId: '',
    isBuffering: false,
    lastSyncServerTs: serverNow,
    lastSyncPosition: 0,
    lastSyncPlayState: 'playing',
    isSyncing: false,
    pendingActionTimer: null,
    pendingPlayUntil: 0,
    isInitialSync: false,
    syncCooldownUntil: 0,
    outOfSyncSince: 0,
    driftCheckedAt: 0
  });
};

// One sync loop tick (500 ms) later.
const tick = () => {
  localNow += 500;
  serverNow += 500;
};

describe('sync adjustment: the nudge', () => {
  beforeEach(resetRoom);

  it('moves a guest who is behind one step ahead, toward the host', () => {
    guestAt(100, 101.2);
    const before = nudgeState();
    assert.equal(before.kind, 'behind');
    assert.ok(Math.abs(before.drift - 1.2) < 1e-9);
    assert.equal(before.step, 0.5);
    const result = nudge();
    assert.equal(result.moved, 0.5);
    assert.equal(video.currentTime, 100.5);
  });

  it('moves a guest who is ahead one step back', () => {
    guestAt(100, 99.2);
    const result = nudge();
    assert.equal(result.kind, 'ahead');
    assert.equal(result.moved, -0.5);
    assert.equal(video.currentTime, 99.5);
  });

  it('never moves past the host', () => {
    guestAt(100, 100.3);
    nudge();
    assert.equal(video.currentTime, 100.3);

    guestAt(100, 99.75);
    nudge();
    assert.equal(video.currentTime, 99.75);
  });

  it('counts a small drift as in sync and leaves the video alone', () => {
    guestAt(100, 100.1);
    assert.equal(nudgeState().kind, 'synced');
    assert.equal(nudge().moved, 0);
    assert.equal(video.currentTime, 100);
  });

  it('stays inside the buffered range, so it never waits for a new segment', () => {
    video.buffered = ranges([90, 100.3]);
    guestAt(100, 101.2);
    nudge();
    assert.equal(Math.round(video.currentTime * 1000) / 1000, 100.2);

    video.buffered = ranges([99.8, 130]);
    guestAt(100, 99);
    nudge();
    assert.equal(Math.round(video.currentTime * 1000) / 1000, 99.9);
  });

  it('moves in whole steps of 0.05 s, the same the button shows', () => {
    guestAt(100, 100.15);
    assert.equal(nudgeState().step, 0.15);
    nudge();
    assert.equal(video.currentTime, 100.15);

    video.buffered = ranges([90, 100.16]);
    guestAt(100, 101.2);
    assert.equal(nudgeState().step, 0.05);
    nudge();
    assert.equal(video.currentTime, 100.05);

    video.buffered = ranges([0, 600]);
    guestAt(100, 100.37);
    assert.equal(nudgeState().step, 0.35);
  });

  it('uses only the buffered range that holds the video, never a gap', () => {
    video.buffered = ranges([0, 10], [20, 30]);
    guestAt(25, 26.2);
    nudge();
    assert.equal(video.currentTime, 25.5);

    for (const [at, hostAt] of [[15, 16.2], [30, 31.2], [10, 11.2], [20, 19]]) {
      guestAt(at, hostAt);
      assert.equal(nudgeState().kind, 'loading', `${at} -> ${hostAt}`);
      assert.equal(nudge().moved, 0);
      assert.equal(video.currentTime, at);
    }
  });

  it('does not move past the end of the loaded video', () => {
    guestAt(599.95, 601);
    assert.equal(nudgeState().kind, 'loading');
    assert.equal(nudge().moved, 0);
  });

  it('waits when there is no room left in the buffered range', () => {
    for (const buffered of [ranges([90, 100.12]), ranges([100.5, 130]), ranges(), undefined]) {
      video.buffered = buffered;
      guestAt(100, 101.2);
      assert.equal(nudgeState().kind, 'loading');
      assert.equal(nudge().moved, 0);
      assert.equal(video.currentTime, 100);
    }
  });

  it('is ignored while a room command is being applied', () => {
    const busy = [
      { isSyncing: true },
      { pendingActionTimer: 7 },
      { pendingPlayUntil: 100500 },
      { isInitialSync: true },
      { syncCooldownUntil: 51000 }
    ];
    for (const command of busy) {
      resetRoom();
      Object.assign(OWP.state, command);
      guestAt(100, 101.2);
      assert.equal(nudgeState().kind, 'busy', JSON.stringify(command));
      assert.equal(nudge().moved, 0, JSON.stringify(command));
      assert.equal(video.currentTime, 100, JSON.stringify(command));
    }
    resetRoom();
    video.seeking = true;
    guestAt(100, 101.2);
    assert.equal(nudge().moved, 0);
  });

  it('works again once a past start time or an expired cooldown is left behind', () => {
    Object.assign(OWP.state, { pendingPlayUntil: 99000, syncCooldownUntil: 49000 });
    guestAt(100, 101.2);
    assert.equal(nudge().moved, 0.5);
  });

  it('needs live room playback, like the automatic correction', () => {
    const cases = [
      [{ isHost: true }, 'unavailable'],
      [{ inRoom: false }, 'unavailable'],
      [{ pendingMediaId: 'item' }, 'loading'],
      [{ isBuffering: true }, 'loading'],
      [{ lastSyncPlayState: 'paused' }, 'paused']
    ];
    for (const [change, kind] of cases) {
      resetRoom();
      guestAt(100, 101.2);
      Object.assign(OWP.state, change);
      assert.equal(nudgeState().kind, kind, JSON.stringify(change));
      assert.equal(nudge().moved, 0, JSON.stringify(change));
      assert.equal(video.currentTime, 100, JSON.stringify(change));
    }
    resetRoom();
    guestAt(100, 101.2);
    video.paused = true;
    assert.equal(nudgeState().kind, 'paused');
  });

  it('only moves the local video: nothing is sent to the room', () => {
    guestAt(100, 101.2);
    nudge();
    assert.deepEqual(sent, []);
  });

  it('follows the host while the room plays', () => {
    guestAt(100, 100);
    serverNow += 1200;
    assert.equal(nudgeState().kind, 'behind');
    nudge();
    assert.equal(video.currentTime, 100.5);
  });

  it('keeps since when the guest is out of sync, until in sync again', () => {
    guestAt(100, 101.2);
    playback.trackDrift();
    assert.equal(OWP.state.outOfSyncSince, 50000);
    for (let i = 0; i < 16; i++) {
      tick();
      guestAt(100, 101.2);
      playback.trackDrift();
    }
    assert.equal(localNow, 58000);
    assert.equal(OWP.state.outOfSyncSince, 50000);
    tick();
    guestAt(100, 100);
    playback.trackDrift();
    assert.equal(OWP.state.outOfSyncSince, 0);
  });

  it('keeps counting through buffering, seeks, room commands and a full buffer', () => {
    guestAt(100, 101.2);
    playback.trackDrift();
    const transient = [
      () => { OWP.utils.isVideoReady = () => false; },
      () => { OWP.state.isBuffering = true; },
      () => { video.seeking = true; },
      () => { OWP.state.isSyncing = true; },
      () => { video.buffered = ranges([90, 100.05]); }
    ];
    try {
      for (const change of transient) {
        tick();
        change();
        guestAt(100, 101.2);
        playback.trackDrift();
        assert.equal(OWP.state.outOfSyncSince, 50000, change.toString());
        OWP.utils.isVideoReady = () => true;
        Object.assign(OWP.state, { isBuffering: false, isSyncing: false });
        video.seeking = false;
        video.buffered = ranges([0, 600]);
      }
    } finally {
      OWP.utils.isVideoReady = () => true;
    }
  });

  it('ends the count when the room stops playing for this guest', () => {
    for (const change of [{ lastSyncPlayState: 'paused' }, { isHost: true }, { inRoom: false }]) {
      resetRoom();
      guestAt(100, 101.2);
      playback.trackDrift();
      tick();
      Object.assign(OWP.state, change);
      playback.trackDrift();
      assert.equal(OWP.state.outOfSyncSince, 0, JSON.stringify(change));
    }
  });

  it('starts over when the guest leaves and rejoins within one tick', () => {
    guestAt(100, 101.2);
    playback.trackDrift();
    tick();
    OWP.state.inRoom = false;
    playback.trackDrift();
    tick();
    OWP.state.inRoom = true;
    guestAt(100, 101.2);
    playback.trackDrift();
    assert.equal(OWP.state.outOfSyncSince, 51000);
  });

  it('starts a new count after a gap in tracking (the setting off, say)', () => {
    guestAt(100, 101.2);
    playback.trackDrift();
    localNow += 3000;
    serverNow += 3000;
    guestAt(100, 101.2);
    playback.trackDrift();
    assert.equal(OWP.state.outOfSyncSince, 53000);
  });

  it('leaves the automatic correction as it was', () => {
    guestAt(100, 101);
    playback.syncLoop();
    assert.equal(video.playbackRate, 1.15);
    assert.equal(video.currentTime, 100);

    guestAt(100, 103);
    playback.syncLoop();
    assert.equal(video.currentTime, 103);
    assert.equal(video.playbackRate, 1);
  });
});

describe('sync adjustment: the room bar', () => {
  let nudges;
  let current;
  const byId = id => document.getElementById(id);
  const renderRoom = (overrides = {}) => {
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: false,
      showSyncNudge: true,
      roomBarSection: '',
      participants: [],
      participantCount: 2,
      ...overrides
    });
    OWP.ui.render(true);
  };

  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    resetRoom();
    nudges = 0;
    current = { kind: 'behind', drift: 1.2, step: 0.5 };
    OWP.timers.setTimeout = () => 1;
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.chat.messages = [];
    OWP.playback = {
      ...playback,
      nudgeState: () => current,
      nudge: () => {
        nudges++;
        current = { kind: 'synced', drift: 0.1 };
      }
    };
    OWP.state.outOfSyncSince = 0;
  });

  it('offers guests a button after the chat when the plugin enables it', () => {
    renderRoom();
    const button = byId('owp-btn-sync');
    const buttons = document.querySelector('.owp-room-bar').children.map(child => child.id);
    assert.ok(buttons.indexOf('owp-btn-sync') === buttons.indexOf('owp-btn-chat') + 1);
    assert.equal(button.getAttribute('aria-label'), 'Sync adjustment');
    assert.equal(button.getAttribute('aria-controls'), 'owp-sync-section');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(byId('owp-sync-section').hidden, true);
  });

  it('is withdrawn and offered again when the host role passes on', () => {
    renderRoom();
    assert.ok(byId('owp-btn-sync'));
    assert.ok(byId('owp-sync-section'));

    // A promoted guest: updateRoomRoleControls alone, as handleHostChanged does
    // (the short-circuited render never redraws the room bar).
    OWP.state.isHost = true;
    OWP.ui.updateRoomRoleControls();
    assert.equal(byId('owp-btn-sync'), null);
    assert.equal(byId('owp-sync-section'), null);
    assert.equal(OWP.state.roomBarSection, '');

    OWP.state.isHost = false;
    OWP.ui.updateRoomRoleControls();
    assert.ok(byId('owp-btn-sync'));
    assert.ok(byId('owp-sync-section'));
  });

  it('is not offered when the plugin disables it, nor to the host', () => {
    renderRoom({ showSyncNudge: false });
    assert.equal(byId('owp-btn-sync'), null);
    assert.equal(byId('owp-sync-section'), null);

    renderRoom({ isHost: true });
    assert.equal(byId('owp-btn-sync'), null);
    assert.equal(byId('owp-sync-section'), null);
  });

  it('shows where the guest is, what the automatic correction does, and the nudge', () => {
    OWP.state.outOfSyncSince = Date.now() - 8000;
    video.playbackRate = 1.15;
    renderRoom();
    byId('owp-btn-sync').click();
    assert.equal(byId('owp-btn-sync').getAttribute('aria-expanded'), 'true');
    assert.equal(byId('owp-sync-section').hidden, false);
    assert.equal(byId('owp-nudge-text').textContent, '1.2 s behind the host');
    assert.ok(document.querySelector('.owp-nudge-state .owp-sync-dot').classList.contains('syncing'));
    assert.equal(byId('owp-nudge-auto').hidden, false);
    assert.equal(byId('owp-nudge-auto').textContent, 'Automatic correction: 1.15× speed for 8 s.');
    assert.equal(byId('owp-btn-nudge').textContent, 'Move ahead 0.5 s');
    assert.equal(byId('owp-btn-nudge').getAttribute('aria-disabled'), 'false');
    assert.match(byId('owp-sync-section').textContent, /Only moves your video; the host stays in control\./);
  });

  it('names the direction and the actual step', () => {
    current = { kind: 'ahead', drift: -0.3, step: 0.3 };
    renderRoom({ roomBarSection: 'sync' });
    assert.equal(byId('owp-nudge-text').textContent, '0.3 s ahead of the host');
    assert.equal(byId('owp-btn-nudge').textContent, 'Move back 0.3 s');
    assert.equal(byId('owp-nudge-auto').textContent, 'Automatic correction: starting.');

    OWP.state.outOfSyncSince = Date.now() - 5000;
    OWP.ui.updateSyncSection();
    assert.equal(byId('owp-nudge-auto').textContent, 'Automatic correction: out of sync for 5 s.');

    video.playbackRate = 0.90;
    OWP.state.outOfSyncSince = Date.now();
    OWP.ui.updateSyncSection();
    assert.equal(byId('owp-nudge-auto').textContent, 'Automatic correction: 0.90× speed.');
  });

  it('nudges, then shows the new state, keeping the button focusable', () => {
    renderRoom({ roomBarSection: 'sync' });
    const button = byId('owp-btn-nudge');
    button.click();
    assert.equal(nudges, 1);
    assert.equal(byId('owp-btn-nudge'), button);
    assert.equal(byId('owp-nudge-text').textContent, 'In sync with the host');
    assert.ok(document.querySelector('.owp-nudge-state .owp-sync-dot').classList.contains('synced'));
    assert.equal(byId('owp-nudge-auto').hidden, true);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.disabled, undefined);
  });

  it('does not nudge from a disabled button, even if the drift changed since', () => {
    current = { kind: 'synced', drift: 0.1 };
    renderRoom({ roomBarSection: 'sync' });
    assert.equal(byId('owp-btn-nudge').getAttribute('aria-disabled'), 'true');
    current = { kind: 'behind', drift: 1.2, step: 0.5 };
    byId('owp-btn-nudge').click();
    assert.equal(nudges, 0);
    assert.equal(byId('owp-btn-nudge').getAttribute('aria-disabled'), 'false');
    assert.equal(byId('owp-nudge-text').textContent, '1.2 s behind the host');
  });

  it('shows the exact step', () => {
    current = { kind: 'behind', drift: 0.2, step: 0.15 };
    renderRoom({ roomBarSection: 'sync' });
    assert.equal(byId('owp-btn-nudge').textContent, 'Move ahead 0.15 s');
    current = { kind: 'ahead', drift: -1, step: 0.05 };
    OWP.ui.updateSyncSection();
    assert.equal(byId('owp-btn-nudge').textContent, 'Move back 0.05 s');
  });

  it('explains why there is nothing to nudge', () => {
    const texts = {
      busy: 'Following the host...',
      paused: 'The room is paused',
      loading: 'Waiting for the video'
    };
    for (const [kind, text] of Object.entries(texts)) {
      current = { kind };
      renderRoom({ roomBarSection: 'sync' });
      assert.equal(byId('owp-nudge-text').textContent, text, kind);
      assert.equal(byId('owp-btn-nudge').getAttribute('aria-disabled'), 'true', kind);
      assert.ok(document.querySelector('.owp-nudge-state .owp-sync-dot').classList.contains('idle'), kind);
    }
  });

  it('refreshes only while the drop-down is open', () => {
    renderRoom();
    current = { kind: 'ahead', drift: -2, step: 0.5 };
    OWP.ui.updateSyncSection();
    assert.equal(byId('owp-nudge-text').textContent, '');

    byId('owp-btn-sync').click();
    current = { kind: 'behind', drift: 0.9, step: 0.5 };
    OWP.ui.updateSyncSection();
    assert.equal(byId('owp-nudge-text').textContent, '0.9 s behind the host');
  });

  it('closes with Escape, like the other drop-downs', () => {
    renderRoom();
    byId('owp-btn-sync').click();
    byId('owp-sync-section').parentNode.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(byId('owp-sync-section').hidden, true);
    assert.equal(byId('owp-btn-sync').getAttribute('aria-expanded'), 'false');
    assert.equal(focused, byId('owp-btn-sync'));
  });

  it('does not leave an empty drop-down open once the button is gone', () => {
    renderRoom({ roomBarSection: 'sync' });
    renderRoom({ roomBarSection: 'sync', showSyncNudge: false });
    assert.equal(OWP.state.roomBarSection, '');
    assert.equal(byId('owp-room-drop').hidden, true);
  });
});
