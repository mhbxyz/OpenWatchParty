const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
const { UI_CHECK_MS } = OWP.constants;
const ITEM_ID = 'a'.repeat(32);

let video = null;
let leaves = 0;
const intervals = [];
const elements = new Map();
globalThis.document.getElementById = id => elements.get(id) || null;
globalThis.document.createElement = () => ({
  id: '',
  className: '',
  classList: { add() {} },
  setAttribute() {},
  addEventListener: () => {}
});
globalThis.document.body = { appendChild: element => { elements.set(element.id, element); } };
globalThis.document.querySelectorAll = () => [];
globalThis.document.visibilityState = 'visible';

OWP.ui = {
  injectStyles: () => {},
  injectOsdButton: () => {},
  injectHeaderButtons: () => {},
  renderHomeWatchParties: () => {}
};
OWP.actions = { connect: () => {}, leaveRoom: () => { leaves++; } };
OWP.utils.getVideo = () => video;
OWP.utils.getPlayingItemId = () => null;
OWP.utils.isHomeView = () => false;
require('../playback/play.js');
OWP.playback.bindVideo = () => {};
OWP.playback.syncLoop = () => {};
OWP.playback.cleanupVideoListeners = () => {};

// Capture the lifecycle intervals instead of running them on a clock.
OWP.timers.setInterval = (callback, delay) => {
  intervals.push({ callback, delay });
  return intervals.length;
};
require('../app/lifecycle.js');
OWP.app.init();
const uiCheck = intervals.find(interval => interval.delay === UI_CHECK_MS).callback;

describe('player closed while OWP opens the room media', () => {
  beforeEach(() => {
    leaves = 0;
    video = { readyState: 4 };
    window.location.hash = '#/video';
    Object.assign(OWP.state, { inRoom: true, roomId: 'room-a', isHost: false, mediaSwitchUntil: 0 });
    uiCheck();
  });

  afterEach(() => {
    OWP.timers.clearScope('media');
    OWP._lifecycle.hadVideoElement = false;
  });

  it('stays in the room while the details page opens the room media', () => {
    OWP.playback.launchViaDetailsPage({ Id: ITEM_ID });
    assert.equal(window.location.hash, `#/details?id=${ITEM_ID}`);

    // Jellyfin closed the player; the room media has not started yet.
    video = null;
    uiCheck();
    assert.equal(leaves, 0);

    video = { readyState: 4 };
    uiCheck();
    assert.equal(leaves, 0);
  });

  it('leaves at once when the user closes the player after the room media is ready', () => {
    OWP.playback.launchViaDetailsPage({ Id: ITEM_ID });
    video = null;
    uiCheck();
    video = { readyState: 4 };
    uiCheck();
    // watchReady clears the grace once the room media plays (media-ready tests).
    OWP.state.mediaSwitchUntil = 0;

    video = null;
    uiCheck();
    assert.equal(leaves, 1);
  });

  it('leaves the room when the room media never starts', () => {
    OWP.playback.launchViaDetailsPage({ Id: ITEM_ID });
    video = null;
    uiCheck();
    assert.equal(leaves, 0);

    OWP.state.mediaSwitchUntil = Date.now() - 1;
    uiCheck();
    assert.equal(leaves, 1);
  });

  it('still leaves the room when the user closes the player', () => {
    video = null;
    uiCheck();
    assert.equal(leaves, 1);
  });

  it('keeps the usual exit when the details page is already shown', () => {
    window.location.hash = `#/details?id=${ITEM_ID}`;
    OWP.playback.launchViaDetailsPage({ Id: ITEM_ID });
    assert.equal(OWP.state.mediaSwitchUntil, 0);
  });
});
