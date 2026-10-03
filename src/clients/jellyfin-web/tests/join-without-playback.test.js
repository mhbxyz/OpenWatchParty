const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('../ui/render.js');
require('../ws/send.js');
require('../playback/play.js');

const { PANEL_ID } = OWP.constants;
const ITEM = '0123456789abcdef0123456789abcdef';
const VIDEO = { currentTime: 12 };

let toasts = [];
let sent = [];
let joined = [];
let getItemCalls = [];

// What is playing: no video by default, as on the home or a details page.
// `itemId` is what getCurrentItemId reports (on a details page, the URL id);
// `playingItemId` is what the player plays, by default that item while there
// is a video.
const playing = ({ video = null, itemId = null, playingItemId = video ? itemId : null } = {}) => {
  OWP.utils.getVideo = () => video;
  OWP.utils.getCurrentItemId = () => itemId;
  OWP.utils.getPlayingItemId = () => playingItemId;
};

const openLobby = () => {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  document.body.appendChild(panel);
  OWP.ui.render(true);
  return panel;
};

describe('joining and creating rooms without playback', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    toasts = [];
    sent = [];
    joined = [];
    getItemCalls = [];
    playing();
    Object.assign(OWP.state, {
      inRoom: false,
      roomId: '',
      rooms: [],
      joiningItemId: '',
      playbackRequestAttempt: 0,
      desiredRoomId: 'pending-rejoin'
    });
    OWP.state.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
    OWP.ui.showToast = message => toasts.push(message);
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.actions.joinRoom = roomId => joined.push(roomId);
    globalThis.ApiClient = {
      getCurrentUserId: () => 'user',
      // Never resolves: the tests only check that playback was requested.
      getItem: (userId, itemId) => {
        getItemCalls.push(itemId);
        return new Promise(() => {});
      }
    };
  });

  describe('room media playback', () => {
    it('starts the room media from the details page of the same item', async () => {
      // On a details page the current item id comes from the URL.
      playing({ video: null, itemId: ITEM });
      OWP.state.inRoom = true;

      const result = await Promise.race([
        OWP.playback.ensurePlayback(ITEM),
        new Promise(resolve => setImmediate(() => resolve('pending')))
      ]);

      assert.equal(result, 'pending');
      assert.deepEqual(getItemCalls, [ITEM]);
      assert.equal(OWP.state.joiningItemId, ITEM);
    });

    it('does not restart media that is already playing', async () => {
      playing({ video: VIDEO, itemId: ITEM });
      OWP.state.inRoom = true;

      assert.equal(await OWP.playback.ensurePlayback(ITEM), true);
      assert.deepEqual(getItemCalls, []);
    });

    it('requests the room media once while a request is pending', async () => {
      OWP.state.inRoom = true;

      OWP.playback.ensurePlayback(ITEM);
      OWP.playback.ensurePlayback(ITEM);
      await new Promise(resolve => setImmediate(resolve));

      assert.deepEqual(getItemCalls, [ITEM]);
    });
  });

  describe('room list', () => {
    it('marks rooms without media and explains instead of joining when nothing plays', () => {
      OWP.state.rooms = [{ id: 'no-media', name: 'Chat only', count: 1, media_id: '' }];
      const panel = openLobby();
      const item = panel.querySelector('.owp-room-item');

      assert.equal(item.querySelector('.owp-room-note').textContent, 'No media');
      item.click();

      assert.deepEqual(joined, []);
      assert.deepEqual(toasts, ['This room has no media. Start playing something, then join it from the player.']);
    });

    it('does not take a video that is not the player for playback', () => {
      playing({ video: VIDEO, itemId: ITEM, playingItemId: null });
      OWP.state.rooms = [{ id: 'no-media', name: 'Chat only', count: 1, media_id: '' }];
      openLobby().querySelector('.owp-room-item').click();

      assert.deepEqual(joined, []);
      assert.equal(toasts.length, 1);
    });

    it('still joins a room without media from the player', () => {
      playing({ video: VIDEO, itemId: ITEM });
      OWP.state.rooms = [{ id: 'no-media', name: 'Chat only', count: 1, media_id: '' }];
      openLobby().querySelector('.owp-room-item').click();

      assert.deepEqual(joined, ['no-media']);
      assert.deepEqual(toasts, []);
    });

    it('joins a room with media while nothing plays, and shows no note', () => {
      OWP.state.rooms = [{ id: 'movie', name: 'Movie night', count: 2, media_id: ITEM }];
      const item = openLobby().querySelector('.owp-room-item');

      assert.equal(item.querySelector('.owp-room-note'), null);
      item.click();

      assert.deepEqual(joined, ['movie']);
    });
  });

  describe('Create Room', () => {
    it('is disabled with a hint while nothing plays', () => {
      const panel = openLobby();
      const button = panel.querySelector('#owp-btn-create');
      const hint = panel.querySelector('#owp-create-hint');

      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute('aria-describedby'), 'owp-create-hint');
      assert.equal(hint.hidden, false);
      assert.equal(hint.textContent, 'Start playing something to create a room.');
    });

    it('stays disabled on a details page and with a video that is not the player', () => {
      playing({ video: null, itemId: ITEM });
      assert.equal(openLobby().querySelector('#owp-btn-create').disabled, true);

      globalThis.document = new FakeDocument();
      playing({ video: VIDEO, itemId: ITEM, playingItemId: null });
      assert.equal(openLobby().querySelector('#owp-btn-create').disabled, true);
    });

    it('is enabled, without the hint, while something plays', () => {
      playing({ video: VIDEO, itemId: ITEM });
      const panel = openLobby();

      assert.equal(panel.querySelector('#owp-btn-create').disabled, false);
      assert.equal(panel.querySelector('#owp-create-hint').hidden, true);
    });

    it('follows playback starting and stopping while the lobby stays open', () => {
      const panel = openLobby();
      const button = panel.querySelector('#owp-btn-create');

      // A partial render (room list or status update) re-evaluates it...
      playing({ video: VIDEO, itemId: ITEM });
      OWP.ui.render();
      assert.equal(button.disabled, false);

      // ...and so does the lifecycle interval.
      playing();
      OWP.ui.updateCreateRoomButton();
      assert.equal(button.disabled, true);
      assert.equal(panel.querySelector('#owp-create-hint').hidden, false);
    });

    it('refuses to create an empty room, without touching a pending rejoin', () => {
      let rejoinCancelled = false;
      OWP.actions.cancelRoomRejoin = () => { rejoinCancelled = true; };
      playing({ video: null, itemId: ITEM });

      OWP.actions.createRoom();

      assert.deepEqual(sent, []);
      assert.deepEqual(toasts, ['Start playing something to create a room.']);
      assert.equal(rejoinCancelled, false);
      assert.equal(OWP.state.desiredRoomId, 'pending-rejoin');
    });

    it('refuses to create a room when a video plays but no playing item is known', () => {
      let rejoinCancelled = false;
      OWP.actions.cancelRoomRejoin = () => { rejoinCancelled = true; };
      // A backdrop or theme video on a details page: the page names an item,
      // but no player item is behind the video.
      playing({ video: VIDEO, itemId: ITEM, playingItemId: null });

      OWP.actions.createRoom();

      assert.deepEqual(sent, []);
      assert.deepEqual(toasts, ['Start playing something to create a room.']);
      assert.equal(rejoinCancelled, false);
      assert.equal(OWP.state.desiredRoomId, 'pending-rejoin');
    });

    it('creates the room for what is playing', () => {
      playing({ video: VIDEO, itemId: ITEM });
      OWP.state.userName = 'Host';

      OWP.actions.createRoom();

      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'create_room');
      assert.deepEqual(sent[0].payload, { start_pos: 12, media_id: ITEM, user_name: 'Host' });
    });
  });
});
