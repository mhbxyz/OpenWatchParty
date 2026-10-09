const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeDocument, FakeWindow } = require('./fake-dom.js');

const CLIENT_ROOT = path.join(__dirname, '..');
const SEEK_BUTTONS = [
  'btnPreviousTrack',
  'btnNextTrack',
  'btnPreviousChapter',
  'btnNextChapter',
  'btnRewind',
  'btnFastForward'
];

const runModule = (context, relativePath) => {
  const source = fs.readFileSync(path.join(CLIENT_ROOT, relativePath), 'utf8');
  vm.runInContext(source, context, { filename: relativePath });
};

const createHarness = () => {
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  window.window = window;
  window.location = { protocol: 'https:', hostname: 'localhost' };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = setInterval;
  window.clearInterval = clearInterval;
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout, setInterval, clearInterval });
  runModule(context, 'state.js');
  const OWP = window.OpenWatchParty;

  const player = document.createElement('div');
  player.className = 'videoPlayerContainer';
  const video = document.createElement('video');
  video.paused = true;
  video.currentTime = 10;
  video.readyState = 4;
  video.pause = () => { video.paused = true; };
  video.play = () => {
    video.paused = false;
    return Promise.resolve();
  };
  const osd = document.createElement('div');
  osd.className = 'videoOsdBottom';
  const controls = document.createElement('div');
  controls.className = 'osdControls';
  const buttons = {};
  for (const className of [...SEEK_BUTTONS, 'btnPause', 'btnSubtitles']) {
    const button = document.createElement('button');
    button.className = className;
    controls.appendChild(button);
    buttons[className] = button;
  }
  const sliderRow = document.createElement('div');
  sliderRow.className = 'osdPositionRow';
  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'sliderContainer';
  const slider = document.createElement('div');
  slider.className = 'osdPositionSlider';
  sliderContainer.appendChild(slider);
  sliderRow.appendChild(sliderContainer);
  osd.append(controls, sliderRow);
  player.append(video, osd);
  document.body.appendChild(player);

  let currentVideo = video;
  const toasts = [];
  OWP.utils = {
    getVideo: () => currentVideo,
    nowMs: () => 1000,
    getServerNow: () => 1000,
    adjustedPosition: position => position,
    startSyncing: () => {},
    isVideoReady: () => true,
    log: () => {},
    scheduleAt: (target, callback) => callback()
  };
  OWP.ui = {
    showToast: message => toasts.push(message),
    updateSyncIndicator: () => {},
    render: () => {}
  };
  OWP.playback = {
    safePlay: target => target.play()
  };
  OWP.chat = { clear: () => {} };
  runModule(context, 'ui/guest-controls.js');

  const dispatch = (type, target, values = {}) => {
    const event = { type, target, ...values };
    window.dispatchEvent(event);
    return event;
  };
  const setGuest = ({ paused = true, playState = 'paused', waiting = false } = {}) => {
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: false,
      roomId: 'room-a',
      lastSyncPlayState: playState,
      roomWaiting: waiting
    });
    video.paused = paused;
    currentVideo = video;
    OWP.ui.updateGuestControls();
  };

  return {
    context,
    document,
    window,
    OWP,
    player,
    video,
    osd,
    sliderRow,
    buttons,
    toasts,
    dispatch,
    setGuest,
    setVideo: value => { currentVideo = value; }
  };
};

describe('guest playback controls', () => {
  let h;

  beforeEach(() => {
    h = createHarness();
  });

  it('locks only a guest with a video and unlocks after role, room, or player changes', () => {
    h.setGuest();
    assert.equal(h.document.documentElement.classList.contains('owp-guest-locked'), true);
    assert.equal(h.document.documentElement.classList.contains('owp-guest-play-locked'), true);

    h.OWP.state.isHost = true;
    h.OWP.ui.updateGuestControls();
    assert.equal(h.document.documentElement.classList.contains('owp-guest-locked'), false);
    assert.equal(h.document.getElementById('owp-guest-lock-label'), null);

    h.OWP.state.isHost = false;
    h.OWP.state.inRoom = false;
    h.OWP.ui.updateGuestControls();
    assert.equal(h.document.documentElement.classList.contains('owp-guest-locked'), false);

    h.OWP.state.inRoom = true;
    h.setVideo(null);
    h.OWP.ui.updateGuestControls();
    assert.equal(h.document.documentElement.classList.contains('owp-guest-locked'), false);
    assert.equal(h.document.documentElement.classList.contains('owp-guest-play-locked'), false);
  });

  it('inserts, updates, restores, and removes the label', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    let label = h.document.getElementById('owp-guest-lock-label');
    assert.equal(label.previousSibling, h.sliderRow);
    assert.equal(label.querySelector('.owp-guest-lock-icon').textContent, 'lock');
    assert.equal(label.querySelector('.owp-guest-lock-text').textContent, 'The host controls playback');

    h.setGuest({ paused: true, playState: 'paused' });
    label = h.document.getElementById('owp-guest-lock-label');
    assert.equal(label.querySelector('.owp-guest-lock-text').textContent, 'The host controls playback');

    h.OWP.state.roomWaiting = true;
    h.OWP.ui.updateGuestControls();
    label = h.document.getElementById('owp-guest-lock-label');
    assert.equal(label.querySelector('.owp-guest-lock-icon').textContent, 'hourglass_empty');
    assert.equal(label.querySelector('.owp-guest-lock-text').textContent, 'Waiting for the host…');

    label.remove();
    h.OWP.ui.updateGuestControls();
    assert.ok(h.document.getElementById('owp-guest-lock-label'));

    h.OWP.state.isHost = true;
    h.OWP.ui.updateGuestControls();
    assert.equal(h.document.getElementById('owp-guest-lock-label'), null);
  });

  it('draws the label under the slider when Jellyfin stacks the rows in reverse', () => {
    h.window.getComputedStyle = element => ({ flexDirection: element === h.osd ? 'column-reverse' : 'row' });
    h.setGuest({ paused: false, playState: 'playing' });
    assert.equal(h.document.getElementById('owp-guest-lock-label').nextSibling, h.sliderRow);

    h.OWP.ui.updateGuestControls();
    assert.equal(h.document.getElementById('owp-guest-lock-label').nextSibling, h.sliderRow);
  });

  it('marks only the position slider for dimming, not the volume slider', () => {
    const volume = h.document.createElement('div');
    volume.className = 'sliderContainer';
    h.osd.appendChild(volume);

    h.setGuest({ paused: false, playState: 'playing' });

    assert.ok(h.sliderRow.children[0].classList.contains('owp-position-slider-container'));
    assert.equal(volume.classList.contains('owp-position-slider-container'), false);
  });

  it('installs one capture listener of each kind', () => {
    runModule(h.context, 'ui/guest-controls.js');
    assert.equal(h.window.listeners.click.length, 1);
    assert.equal(h.window.listeners.click[0].capture, true);
    assert.equal(h.window.listeners.keydown.length, 1);
    assert.equal(h.window.listeners.keydown[0].capture, true);
  });

  it('blocks every seek button and lets unrelated OSD buttons pass', () => {
    h.setGuest();
    for (const className of SEEK_BUTTONS) {
      const event = h.dispatch('click', h.buttons[className]);
      assert.equal(event.defaultPrevented, true, className);
      assert.equal(event.immediatePropagationStopped, true, className);
    }
    const subtitles = h.dispatch('click', h.buttons.btnSubtitles);
    assert.equal(Boolean(subtitles.defaultPrevented), false);
    assert.deepEqual(h.toasts, ['Only the host can control playback']);
  });

  it('allows pause while playing and blocks play from the button or video surface', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    assert.equal(Boolean(h.dispatch('click', h.buttons.btnPause).defaultPrevented), false);
    assert.equal(Boolean(h.dispatch('click', h.video).defaultPrevented), false);

    h.setGuest({ paused: true, playState: 'paused' });
    assert.equal(h.dispatch('click', h.buttons.btnPause).defaultPrevented, true);
    assert.equal(h.dispatch('click', h.video).defaultPrevented, true);
    assert.equal(h.dispatch('click', h.player).defaultPrevented, true);
  });

  it('always lets a playing guest pause, even when the room is paused or waiting', () => {
    for (const waiting of [false, true]) {
      h.setGuest({ paused: false, playState: 'paused', waiting });
      assert.equal(h.document.documentElement.classList.contains('owp-guest-play-locked'), false);
      assert.equal(Boolean(h.dispatch('click', h.buttons.btnPause).defaultPrevented), false);
      assert.equal(Boolean(h.dispatch('click', h.video).defaultPrevented), false);
      assert.equal(Boolean(h.dispatch('keydown', h.document.body, { key: ' ', code: 'Space', keyCode: 32 }).defaultPrevented), false);
      assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'KeyK' }).defaultPrevented), false);
    }
  });

  it('blocks Jellyfin seek keys and leaves other player keys alone', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    const blocked = [
      { code: 'KeyJ' }, { code: 'KeyL' }, { code: 'ArrowLeft' }, { key: 'Left' },
      { code: 'ArrowRight' }, { key: 'Right' }, { code: 'Comma', shiftKey: true },
      { code: 'Period' }, { code: 'Home' }, { code: 'End' }, { code: 'PageUp' },
      { code: 'PageDown' }, { code: 'Digit0' }, { code: 'Digit9' },
      { code: 'Numpad0' }, { code: 'Numpad9' }, { code: 'KeyP', shiftKey: true },
      { code: 'KeyN', shiftKey: true }
    ];
    for (const key of blocked) {
      assert.equal(h.dispatch('keydown', h.document.body, key).defaultPrevented, true, JSON.stringify(key));
    }
    for (const code of ['ArrowUp', 'ArrowDown', 'KeyF', 'KeyM', 'KeyC', 'Escape', 'KeyP', 'KeyN']) {
      assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code }).defaultPrevented), false, code);
    }
  });

  it('blocks Space and K only for a paused guest while the room is not playing', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    assert.equal(Boolean(h.dispatch('keydown', h.document.body, { key: ' ', code: 'Space', keyCode: 32 }).defaultPrevented), false);
    assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'KeyK' }).defaultPrevented), false);

    h.setGuest({ paused: true, playState: 'paused' });
    assert.equal(h.dispatch('keydown', h.document.body, { key: ' ', keyCode: 32 }).defaultPrevented, true);
    assert.equal(h.dispatch('keydown', h.document.body, { code: 'KeyK' }).defaultPrevented, true);

    h.setGuest({ paused: true, playState: 'playing' });
    assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'KeyK' }).defaultPrevented), false);
  });

  it('allows shortcuts with modifiers and from editable targets', () => {
    h.setGuest();
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'KeyJ', [modifier]: true }).defaultPrevented), false);
    }
    for (const tag of ['input', 'textarea', 'select']) {
      const target = h.document.createElement(tag);
      h.document.body.appendChild(target);
      assert.equal(Boolean(h.dispatch('keydown', target, { code: 'KeyL' }).defaultPrevented), false, tag);
    }
    const editable = h.document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    h.document.body.appendChild(editable);
    assert.equal(Boolean(h.dispatch('keydown', editable, { code: 'ArrowRight' }).defaultPrevented), false);
  });

  it('blocks seek keys on the focused position slider, in the TV layout too', () => {
    const range = h.document.createElement('input');
    range.className = 'osdPositionSlider';
    range.setAttribute('type', 'range');
    h.sliderRow.children[0].appendChild(range);
    h.setGuest({ paused: false, playState: 'playing' });
    for (const code of ['ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'PageUp']) {
      assert.equal(h.dispatch('keydown', range, { code }).defaultPrevented, true, code);
    }
    assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'ArrowUp' }).defaultPrevented), false);

    h.document.documentElement.classList.add('layout-tv');
    assert.equal(h.dispatch('keydown', range, { code: 'ArrowLeft' }).defaultPrevented, true);
    assert.equal(h.dispatch('keydown', range, { key: 'Down' }).defaultPrevented, true);
    assert.equal(Boolean(h.dispatch('keydown', h.document.body, { code: 'ArrowLeft' }).defaultPrevented), false);
  });

  it('blocks a press on the slider before the next tick has dimmed it', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    h.document.documentElement.classList.remove('owp-guest-locked');
    const slider = h.sliderRow.children[0].children[0];
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      assert.equal(h.dispatch(type, slider).defaultPrevented, true, type);
    }

    h.OWP.state.isHost = true;
    assert.equal(Boolean(h.dispatch('pointerdown', slider).defaultPrevented), false);
  });

  it('lets Space press another focused control while play is locked, without Jellyfin playing', () => {
    h.setGuest({ paused: true, playState: 'paused' });

    const onSubtitles = h.dispatch('keydown', h.buttons.btnSubtitles, { key: ' ', code: 'Space', keyCode: 32 });
    assert.equal(Boolean(onSubtitles.defaultPrevented), false);
    assert.equal(onSubtitles.immediatePropagationStopped, true);

    const onPlay = h.dispatch('keydown', h.buttons.btnPause, { key: ' ', code: 'Space', keyCode: 32 });
    assert.equal(onPlay.defaultPrevented, true);
    assert.equal(h.dispatch('keydown', h.buttons.btnSubtitles, { code: 'KeyK' }).defaultPrevented, true);
  });

  it('drops an old slider marker while no position slider is shown', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    const container = h.sliderRow.children[0];
    container.children[0].remove();

    h.OWP.ui.updateGuestControls();

    assert.equal(container.classList.contains('owp-position-slider-container'), false);
  });

  it('keeps the slider marker on the current position slider only', () => {
    const old = h.document.createElement('div');
    old.className = 'sliderContainer owp-position-slider-container';
    h.osd.appendChild(old);

    h.setGuest({ paused: false, playState: 'playing' });

    assert.equal(old.classList.contains('owp-position-slider-container'), false);
    assert.ok(h.sliderRow.children[0].classList.contains('owp-position-slider-container'));
  });

  it('preserves TV navigation keys but still blocks non-navigation seeking', () => {
    h.setGuest({ paused: false, playState: 'playing' });
    h.document.documentElement.classList.add('layout-tv');
    for (const key of [
      { code: 'ArrowLeft' },
      { key: 'Right' },
      { code: 'NavigationLeft' },
      { code: 'GamepadDPadRight' }
    ]) {
      assert.equal(Boolean(h.dispatch('keydown', h.document.body, key).defaultPrevented), false, JSON.stringify(key));
    }
    assert.equal(h.dispatch('keydown', h.document.body, { code: 'KeyJ' }).defaultPrevented, true);
    assert.equal(h.dispatch('keydown', h.document.body, { code: 'Digit5' }).defaultPrevented, true);
  });
});

describe('room waiting state', () => {
  let h;

  beforeEach(() => {
    h = createHarness();
    h.setGuest();
    runModule(h.context, 'ws/send.js');
    runModule(h.context, 'ws/handlers/sync.js');
    runModule(h.context, 'ws/handlers/playback.js');
  });

  const playerEvent = action => ({
    room: 'room-a',
    server_ts: 1000,
    payload: { action, position: 10, play_state: action === 'play' ? 'playing' : 'paused' }
  });

  it('sets waiting on buffering and clears it on play, pause, or seek', () => {
    h.OWP._wsHandlers.handlePlayerEvent(playerEvent('buffering'), h.video);
    assert.equal(h.OWP.state.roomWaiting, true);
    for (const action of ['play', 'pause', 'seek']) {
      h.OWP.state.roomWaiting = true;
      h.OWP._wsHandlers.handlePlayerEvent(playerEvent(action), h.video);
      assert.equal(h.OWP.state.roomWaiting, false, action);
    }
  });

  it('clears waiting when a state update or joined room is playing', () => {
    h.OWP.state.roomWaiting = true;
    h.OWP._wsHandlers.handleStateUpdate({ server_ts: 1000, payload: { play_state: 'playing', position: 10 } }, h.video);
    assert.equal(h.OWP.state.roomWaiting, false);

    h.OWP.state.roomWaiting = true;
    h.OWP._wsHandlers.handleRoomState({
      room: 'room-a',
      client: 'guest',
      server_ts: 1000,
      payload: {
        name: 'Room',
        participant_count: 2,
        host_id: 'host',
        state: { position: 10, play_state: 'playing' }
      }
    }, h.video);
    assert.equal(h.OWP.state.roomWaiting, false);
  });

  it('resets waiting when room state is cleared', () => {
    h.OWP.state.roomWaiting = true;
    h.OWP.actions.resetRoomState();
    assert.equal(h.OWP.state.roomWaiting, false);
  });
});
