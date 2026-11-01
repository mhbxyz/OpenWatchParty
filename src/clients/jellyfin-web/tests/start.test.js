const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

let sent = [];
let toasts = [];
OWP.actions = { send: (type, payload) => sent.push({ type, payload }) };
globalThis.document.getElementById = () => null;
OWP.utils.log = () => {};
OWP.utils.startSyncing = () => {};
let played = [];
OWP.playback = { safePlay: (target, reason) => { played.push(reason); target.paused = false; return Promise.resolve(true); } };
let roomToasts = [];
OWP.ui = { showChatToast: (name, text) => toasts.push({ name, text }), updateParticipantList: () => {}, showToast: message => roomToasts.push(message) };
let video = null;
OWP.utils.getVideo = () => video;
require('../chat/messages.js');
let chatVisible = false;
OWP.chat.isChatVisible = () => chatVisible;
OWP.chat.updateBadge = () => {};
require('../app/start.js');
require('../ws/handlers/room.js');
require('../ws/handlers/playback.js');

const h = OWP._wsHandlers;
const start = OWP.start;

// A video element: the fields the readiness looks at, and its listeners.
const makeVideo = (fields = {}) => {
  const listeners = {};
  return {
    readyState: 4,
    seeking: false,
    paused: true,
    currentTime: 30,
    currentSrc: 'http://jellyfin/Videos/abc/stream.mp4?static=true',
    pauses: 0,
    pause() { this.paused = true; this.pauses++; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter(l => l !== listener); },
    fire(type) { (listeners[type] || []).forEach(listener => listener({ type })); },
    listeners,
    ...fields
  };
};

const lines = () => OWP.chat.messages.filter(message => message.system).map(message => [message.text, message.isError]);
const readinessSent = () => sent.filter(message => message.type === 'readiness').map(message => message.payload);
const member = (client, name, reason) => ({ client, name, reason });
const waiting = (members, extra = {}) => ({ state: 'waiting', position: 30, waiting_for: members, deadline_server_ts: Date.now() + 20000, ...extra });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('start when ready', () => {
  beforeEach(() => {
    sent = [];
    toasts = [];
    roomToasts = [];
    played = [];
    chatVisible = false;
    OWP.chat.messages = [];
    OWP.chat.unreadCount = 0;
    video = makeVideo();
    Object.assign(OWP.state, OWP.stateFactories.createRoomState(), OWP.stateFactories.createRoomPlaybackState(), {
      inRoom: true,
      roomId: 'room-1',
      clientId: 'client-1',
      isHost: true,
      serverFeatures: ['start_when_ready'],
      ws: { readyState: 1 },
      currentVideoElement: video,
      pendingMediaId: '',
      syncStatus: 'synced',
      isBuffering: false,
      suppressUntil: 0
    });
  });
  afterEach(() => {
    start.onStartState({ state: 'idle' });
    OWP.timers.clearScope('room');
  });

  describe('why this client is not ready', () => {
    it('is ready once the video can play on', () => {
      assert.equal(start.ownReason(), null);
    });

    it('is loading until the room media shows, or converting when the server streams it', () => {
      video.readyState = 1;
      assert.equal(start.ownReason(), 'loading');
      video.currentSrc = 'blob:http://jellyfin/1234';
      assert.equal(start.ownReason(), 'transcoding');
      video.currentSrc = 'http://jellyfin/videos/abc/master.m3u8?DeviceId=1';
      assert.equal(start.ownReason(), 'transcoding');
      video.readyState = 4;
      OWP.state.pendingMediaId = 'next';
      assert.equal(start.ownReason(), 'transcoding');
      OWP.state.currentVideoElement = null;
      video = null;
      assert.equal(start.ownReason(), 'loading');
    });

    it('is blocked when the browser stopped its play, and buffering while it stalls or seeks', () => {
      OWP.state.syncStatus = 'blocked';
      assert.equal(start.ownReason(), 'autoplay_blocked');
      OWP.state.syncStatus = 'synced';
      // A paused video keeps only its frame: that is ready.
      video.readyState = 2;
      assert.equal(start.ownReason(), null);
      video.seeking = true;
      assert.equal(start.ownReason(), 'buffering');
      video.seeking = false;
      OWP.state.isBuffering = true;
      assert.equal(start.ownReason(), 'buffering');
    });
  });

  describe('readiness', () => {
    it('is sent when it changes, to a server with the feature only', () => {
      start.report();
      start.report();
      assert.deepEqual(readinessSent(), [{ ready: true }]);
      video.seeking = true;
      start.report();
      assert.deepEqual(readinessSent().at(-1), { ready: false, reason: 'buffering' });
      // A new connection (client id) sends it again.
      OWP.state.clientId = 'client-2';
      start.report();
      assert.equal(readinessSent().length, 3);

      sent = [];
      OWP.state.serverFeatures = ['media_queue'];
      video.seeking = false;
      start.report();
      OWP.state.serverFeatures = ['start_when_ready'];
      OWP.state.inRoom = false;
      start.report();
      OWP.state.inRoom = true;
      OWP.state.ws = { readyState: 3 };
      start.report();
      assert.deepEqual(readinessSent(), []);
    });

    it('is sent again for another item, as the server forgets the previous one', () => {
      OWP.state.roomMediaId = 'a';
      OWP.state.syncStatus = 'blocked';
      start.report();
      OWP.state.roomMediaId = 'b';
      start.report();
      assert.deepEqual(readinessSent(), [
        { ready: false, reason: 'autoplay_blocked' },
        { ready: false, reason: 'autoplay_blocked' }
      ]);
    });

    it('lets go of a wait the server can no longer end', () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      OWP.state.serverFeatures = ['media_queue'];
      start.report();
      assert.equal(OWP.state.startPhase, 'idle');
      assert.equal(OWP.state.pendingPlayUntil, 0);
    });

    it('follows the video events at once', () => {
      start.report();
      OWP.state.isBuffering = true;
      video.fire('waiting');
      assert.deepEqual(readinessSent().at(-1), { ready: false, reason: 'buffering' });
      OWP.state.isBuffering = false;
      video.fire('canplay');
      assert.deepEqual(readinessSent().at(-1), { ready: true });
      // A new video element is watched instead of the old one.
      const old = video;
      video = makeVideo({ readyState: 1 });
      OWP.state.currentVideoElement = video;
      start.report();
      assert.equal(old.listeners.waiting.length, 0);
      assert.equal(video.listeners.waiting.length, 1);
    });
  });

  describe('the room waiting', () => {
    it('holds a playing video where the play waits, without sending anything', () => {
      video.paused = false;
      video.currentTime = 33;
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      assert.equal(OWP.state.startPhase, 'waiting');
      assert.equal(video.paused, true);
      assert.equal(video.currentTime, 30);
      assert.equal(OWP.utils.shouldSend(), false);
      assert.ok(OWP.state.pendingPlayUntil >= OWP.state.startDeadline);
      assert.deepEqual(sent.filter(message => message.type === 'player_event'), []);
    });

    it('says in the chat who it waits for and why, once per member and reason', () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading'), member('c3', 'Pablo', 'buffering')]));
      start.onStartState(waiting([member('c2', 'Ana', 'loading'), member('c3', 'Pablo', 'buffering')]));
      start.onStartState(waiting([member('c2', 'Ana', 'transcoding'), member('c3', 'Pablo', 'buffering')]));
      assert.deepEqual(lines(), [
        ['Waiting for Ana: loading the video', false],
        ['Waiting for Pablo: filling the buffer', false],
        ['Waiting for Ana: the server is converting the video', false]
      ]);
      // Info lines are not unread.
      assert.equal(OWP.chat.unreadCount, 0);
      assert.deepEqual(toasts, []);
    });

    it('says who got ready, a moment later unless they left the room', async () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading'), member('c3', 'Pablo', 'loading')]));
      start.onStartState(waiting([]));
      h.handleClientLeft({ type: 'client_left', room: 'room-1', client: 'c3', payload: { participant_count: 2 } });
      await wait(400);
      assert.deepEqual(lines().slice(2), [['Ana is ready (0 s)', false]]);
    });

    it('names, as an error, who the room started without', async () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      start.onStartState({ state: 'starting', target_server_ts: Date.now() + 1000, countdown: false, without: [member('c2', 'Ana', 'loading')] });
      await wait(400);
      assert.deepEqual(lines().slice(1), [['Started without Ana (still loading)', true]]);
      assert.equal(OWP.chat.unreadCount, 1);
      assert.deepEqual(toasts, [{ name: 'SERVER', text: 'Started without Ana (still loading)' }]);
      assert.equal(OWP.state.startPhase, 'idle');
    });

    it('says a pause cancelled the start, and lets go of the hold', () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      start.onStartState({ state: 'idle' });
      assert.deepEqual(lines().at(-1), ['Start cancelled', false]);
      assert.equal(OWP.state.startPhase, 'idle');
      assert.equal(OWP.state.pendingPlayUntil, 0);
      // Idle when nothing waited says nothing.
      start.onStartState({ state: 'idle' });
      assert.equal(lines().length, 2);
    });

    it('starts at once on a second play, and keeps the video waiting meanwhile', () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      OWP.state.suppressUntil = 0;
      video.paused = false;
      video.fire('play');
      assert.deepEqual(sent.filter(message => message.type === 'start_now'), [{ type: 'start_now', payload: {} }]);
      assert.equal(video.paused, true);
      // OWP's own play (suppressed) is not the user's.
      video.paused = false;
      OWP.utils.suppress();
      video.fire('play');
      assert.equal(sent.filter(message => message.type === 'start_now').length, 1);
    });

    it('lets only those who may play start it', () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      OWP.state.isHost = false;
      OWP.state.sharedPlaybackControl = false;
      start.startNow();
      assert.equal(start.canStart(), false);
      OWP.state.sharedPlaybackControl = true;
      start.startNow();
      assert.equal(sent.filter(message => message.type === 'start_now').length, 1);
      start.onStartState({ state: 'idle' });
      start.startNow();
      assert.equal(sent.filter(message => message.type === 'start_now').length, 1);
    });
  });

  describe('the start', () => {
    it('plays the held video at the start, though the room command may not', async () => {
      video.paused = false;
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      assert.equal(video.paused, true);
      const target = OWP.utils.getServerNow() + 100;
      start.onStartState({ state: 'starting', target_server_ts: target, countdown: false, without: [] });
      // Held until the start, not until the end of the wait.
      assert.equal(OWP.state.pendingPlayUntil, target);
      await wait(250);
      assert.deepEqual(played, ['room start']);
      assert.equal(video.paused, false);
    });

    // The room's play, which the server sends right after `starting`, for the same time.
    const roomPlay = (client, target) => ({
      type: 'player_event',
      room: 'room-1',
      client,
      server_ts: target,
      payload: { action: 'play', position: 30, play_state: 'playing', target_server_ts: target }
    });

    // A guest's play the room waited for, on the host. `applyCommand` is when
    // the room's play comes due: before or after this module's own start.
    const guestPlayAfterWait = async (applyCommand) => {
      const scheduleAt = OWP.utils.scheduleAt;
      let command = null;
      OWP.utils.scheduleAt = (target, callback) => { command = callback; };
      try {
        video.paused = false;
        OWP.state.roomHostId = 'client-1';
        start.onStartState(waiting([member('c2', 'Ana', 'buffering')]));
        const target = OWP.utils.getServerNow() + 50;
        start.onStartState({ state: 'starting', target_server_ts: target, countdown: false, without: [] });
        h.handlePlayerEvent(roomPlay('c2', target), video);
        if (applyCommand === 'first') command();
        await wait(150);
        if (applyCommand === 'after') command();
        return target;
      } finally {
        OWP.utils.scheduleAt = scheduleAt;
      }
    };

    it('tells the host a guest play resumed the room, though this module played the video first', async () => {
      await guestPlayAfterWait('after');
      assert.deepEqual(played, ['room start']);
      assert.equal(video.paused, false);
      assert.deepEqual(roomToasts, ['A guest resumed playback']);
    });

    it('tells no guest pause that changes nothing, even one for the start\'s time', async () => {
      const target = await guestPlayAfterWait('after');
      video.paused = true;
      const pause = roomPlay('c2', target);
      pause.payload = { action: 'pause', position: 30, play_state: 'paused', target_server_ts: target };
      h.handlePlayerEvent(pause, video);
      assert.deepEqual(roomToasts, ['A guest resumed playback']);
    });

    it('tells it once when the guest play comes first', async () => {
      await guestPlayAfterWait('first');
      assert.deepEqual(played, ['guest play command']);
      assert.equal(video.paused, false);
      assert.deepEqual(roomToasts, ['A guest resumed playback']);
    });

    it('plays the held video for the host\'s own play, and no guest play that changes nothing is told', async () => {
      video.paused = false;
      OWP.state.roomHostId = 'client-1';
      OWP.state.hostControlAcks = ['play'];
      start.onStartState(waiting([member('c2', 'Ana', 'buffering')]));
      const target = OWP.utils.getServerNow() + 50;
      start.onStartState({ state: 'starting', target_server_ts: target, countdown: false, without: [] });
      h.handlePlayerEvent(roomPlay('client-1', target), video);
      await wait(150);
      assert.deepEqual(played, ['room start']);
      assert.equal(video.paused, false);
      // A later guest play, for another time, finds the room playing.
      h.handlePlayerEvent(roomPlay('c2', OWP.utils.getServerNow() + 20), video);
      await wait(100);
      assert.deepEqual(played, ['room start']);
      assert.deepEqual(roomToasts, []);
    });

    it('leaves alone a video it did not hold, or one already playing', async () => {
      start.onStartState({ state: 'starting', target_server_ts: OWP.utils.getServerNow() + 50, countdown: false, without: [] });
      await wait(150);
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      start.onStartState({ state: 'starting', target_server_ts: OWP.utils.getServerNow() + 50, countdown: false, without: [] });
      video.paused = false;
      await wait(150);
      assert.deepEqual(played, []);
    });

    it('lets go when the wait ends without a start', async () => {
      start.onStartState(waiting([member('c2', 'Ana', 'loading')]));
      start.onStartState({ state: 'idle' });
      assert.equal(OWP.state.pendingPlayUntil, 0);
      await wait(100);
      assert.deepEqual(played, []);
      // Another module's hold stays.
      OWP.state.pendingPlayUntil = OWP.utils.getServerNow() + 60000;
      start.onStartState(waiting([member('c2', 'Ana', 'loading')], { deadline_server_ts: OWP.utils.getServerNow() + 1000 }));
      start.onStartState({ state: 'idle' });
      assert.ok(OWP.state.pendingPlayUntil > OWP.utils.getServerNow() + 50000);
    });
  });

  describe('the countdown', () => {
    it('holds the video until the start, then goes idle', async () => {
      video.paused = false;
      start.onStartState({ state: 'starting', target_server_ts: OWP.utils.getServerNow() + 300, countdown: true, without: [] });
      assert.equal(OWP.state.startPhase, 'starting');
      assert.equal(video.paused, true);
      assert.ok(OWP.state.pendingPlayUntil >= OWP.state.startTarget);
      // A play during the countdown only keeps waiting.
      OWP.state.suppressUntil = 0;
      video.paused = false;
      video.fire('play');
      assert.equal(video.paused, true);
      assert.deepEqual(sent.filter(message => message.type === 'start_now'), []);
      // OWP's own play (it holds its events back) goes through.
      OWP.state.suppressUntil = 0;
      OWP.state.isSyncing = true;
      video.paused = false;
      video.fire('play');
      assert.equal(video.paused, false);
      OWP.state.isSyncing = false;
      await wait(700);
      assert.equal(OWP.state.startPhase, 'idle');
    });

    it('lets the start at its time go through', () => {
      start.onStartState({ state: 'starting', target_server_ts: OWP.utils.getServerNow() + 100, countdown: true, without: [] });
      OWP.state.suppressUntil = 0;
      video.paused = false;
      video.fire('play');
      assert.equal(video.paused, false);
    });
  });

  describe('messages', () => {
    it('go to this room only', () => {
      h.handleStartState({ type: 'start_state', room: 'other', payload: waiting([member('c2', 'Ana', 'loading')]) });
      assert.equal(OWP.state.startPhase, 'idle');
      h.handleStartState({ type: 'start_state', room: 'room-1', payload: waiting([member('c2', 'Ana', 'loading')]) });
      assert.equal(OWP.state.startPhase, 'waiting');
    });

    it('draw SERVER lines apart from people', () => {
      const container = { children: [], scrollTop: 0, scrollHeight: 0, appendChild(node) { this.children.push(node); } };
      const realDocument = globalThis.document;
      globalThis.document = {
        ...realDocument,
        getElementById: id => (id === 'owp-chat-messages' ? container : null),
        createElement: () => ({ className: '', title: '', textContent: '', append() {} })
      };
      try {
        OWP.chat.system('Start cancelled');
        OWP.chat.system('Started without Ana (still loading)', true);
      } finally {
        globalThis.document = realDocument;
      }
      assert.deepEqual(container.children.map(node => node.className), [
        'owp-chat-message owp-chat-system',
        'owp-chat-message owp-chat-system owp-chat-error'
      ]);
    });
  });
});
