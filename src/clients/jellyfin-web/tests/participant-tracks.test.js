const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0, markRead: () => {}, renderAllMessages: () => {} };
OWP.utils.log = () => {};
OWP.actions = { completeRoomRejoin: () => {} };
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
require('../ws/validation.js');
require('../ws/handlers/room.js');
require('../app/tracks.js');

const h = OWP._wsHandlers;
const validate = message => OWP.wsValidation.validateMessage(message);
const { PANEL_ID } = OWP.constants;
const MEDIA = '09a5f21d9ff1211e52063842163eb2e0';
const OTHER = 'ffffffffffffffffffffffffffffffff';

const message = (type, payload, extra = {}) => ({
  type,
  room: 'room-1',
  payload,
  ts: 1_700_000_000_000,
  server_ts: 1_700_000_000_001,
  ...extra
});
const tracksMessage = (tracks, room = 'room-1') => message('participant_tracks', { tracks }, { room });
const report = (audio, subtitle, media = MEDIA) => ({ media_id: media, audio, subtitle });

let sent;
let now;
let session;
let sessionReads;
OWP.utils.nowMs = () => now;
globalThis.ApiClient = {
  deviceId: () => 'device-a',
  getSessions: async ({ deviceId }) => {
    sessionReads++;
    assert.equal(deviceId, 'device-a');
    return session ? [session] : [];
  }
};

const byId = id => document.getElementById(id);
const rows = () => byId('owp-participants-list').querySelectorAll('.owp-participant');
const settle = () => new Promise(resolve => setImmediate(resolve));

// A Jellyfin session playing the room's item, with these tracks selected.
const playing = (audioIndex, subtitleIndex, itemId = MEDIA) => ({
  NowPlayingItem: {
    Id: itemId,
    MediaStreams: [
      { Index: 0, Type: 'Video' },
      { Index: 1, Type: 'Audio', Language: 'eng', Title: 'English' },
      { Index: 2, Type: 'Audio', Language: 'spa', Title: 'Español (doblaje)' },
      { Index: 3, Type: 'Subtitle', Language: 'eng' },
      { Index: 4, Type: 'Subtitle', Language: 'spa', IsForced: true },
      { Index: 5, Type: 'Subtitle', Language: 'jpn', Title: `  ${'x'.repeat(120)}\n` },
      { Index: 6, Type: 'Audio', Language: 'spa', Title: 'Latino\tDolby', IsForced: true }
    ]
  },
  PlayState: { AudioStreamIndex: audioIndex, SubtitleStreamIndex: subtitleIndex }
});

const enterRoom = () => {
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-1',
    roomMediaId: MEDIA,
    clientId: 'client-a',
    isHost: false,
    participants: [],
    participantCount: 0,
    serverFeatures: ['participant_tracks'],
    tracksSentKey: '',
    ws: { readyState: 1 }
  });
};

describe('participant tracks', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    sent = [];
    now = 10_000;
    session = null;
    sessionReads = 0;
    OWP.actions = { completeRoomRejoin: () => {}, send: (type, payload) => sent.push([type, payload]) };
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    OWP.tracks.reset();
    enterRoom();
  });

  describe('the participant_tracks message', () => {
    it('accepts a report or null per participant', () => {
      const full = report({ title: 'English', language: 'eng' }, { language: 'spa', forced: true });
      assert.equal(validate(tracksMessage([full, null, report({}, null)])).valid, true);
      assert.equal(validate(tracksMessage([])).valid, true);
    });

    it('rejects other shapes, unknown fields and a missing room', () => {
      for (const bad of [
        tracksMessage('x'),
        tracksMessage([1]),
        tracksMessage(Array(21).fill(null)),
        tracksMessage([{ media_id: MEDIA, audio: null }]),
        tracksMessage([{ ...report(null, null), extra: 1 }]),
        tracksMessage([report(null, null, 'abc')]),
        tracksMessage([report({ codec: 'aac' }, null)]),
        tracksMessage([report({ title: '' }, null)]),
        tracksMessage([report({ title: 'x'.repeat(101) }, null)]),
        tracksMessage([report({ language: 'e n' }, null)]),
        tracksMessage([report(null, { forced: 'yes' })]),
        message('participant_tracks', { tracks: [], extra: true }),
        { ...tracksMessage([]), room: undefined }
      ]) {
        assert.equal(validate(bad).valid, false, JSON.stringify(bad.payload));
      }
    });

    it('keeps each report with its participant, and none for another list or room', () => {
      h.handleParticipantList(message('participant_list', { participants: [{ name: 'Franco', is_host: true }, { name: 'Ana', is_host: false }] }));
      const ana = report({ title: 'English' }, null);
      h.handleParticipantTracks(tracksMessage([null, ana]));
      assert.deepEqual(OWP.state.participants.map(p => p.tracks), [null, ana]);
      h.handleParticipantTracks(tracksMessage([ana]));
      h.handleParticipantTracks(tracksMessage([ana, ana], 'room-2'));
      assert.deepEqual(OWP.state.participants.map(p => p.tracks), [null, ana]);
      // A new list forgets them until the next report.
      h.handleParticipantList(message('participant_list', { participants: [{ name: 'Franco', is_host: true }, { name: 'Ana', is_host: false }] }));
      assert.deepEqual(OWP.state.participants.map(p => p.tracks), [null, null]);
    });
  });

  describe("this client's tracks", () => {
    it('reads them from its own Jellyfin session and sends them once', async () => {
      session = playing(2, 4);
      OWP.tracks.report();
      await settle();
      assert.deepEqual(sent, [['participant_tracks', report(
        { title: 'Español (doblaje)', language: 'spa' },
        { language: 'spa', forced: true }
      )]]);
      // Read again later; the same tracks are not sent again.
      now += 5_000;
      OWP.tracks.report();
      await settle();
      assert.equal(sessionReads, 2);
      assert.equal(sent.length, 1);
    });

    it('reads every few seconds at most, and at once for a new item', async () => {
      session = playing(1, -1);
      OWP.tracks.report();
      await settle();
      now += 4_999;
      OWP.tracks.report();
      await settle();
      assert.equal(sessionReads, 1);
      OWP.state.roomMediaId = OTHER;
      session = playing(1, -1, OTHER);
      OWP.tracks.report();
      await settle();
      assert.equal(sessionReads, 2);
      assert.deepEqual(sent.map(([, payload]) => payload.media_id), [MEDIA, OTHER]);
    });

    it('sends a change, with no subtitles as null and a long title cut', async () => {
      session = playing(1, -1);
      OWP.tracks.report();
      await settle();
      now += 5_000;
      session = playing(1, 5);
      OWP.tracks.report();
      await settle();
      assert.deepEqual(sent.map(([, payload]) => payload), [
        report({ title: 'English', language: 'eng' }, null),
        report({ title: 'English', language: 'eng' }, { title: 'x'.repeat(100), language: 'jpn' })
      ]);
    });

    it('turns control characters in a title into spaces, and marks only subtitles as forced', async () => {
      session = playing(6, -1);
      OWP.tracks.report();
      await settle();
      assert.deepEqual(sent, [['participant_tracks', report({ title: 'Latino Dolby', language: 'spa' }, null)]]);
    });

    it('takes playing nothing as no tracks, not as a failed read', async () => {
      const logged = [];
      OWP.utils.log = (...args) => logged.push(args);
      try {
        OWP.tracks.report();
        await settle();
      } finally {
        OWP.utils.log = () => {};
      }
      assert.equal(sessionReads, 1);
      assert.deepEqual(sent, []);
      assert.deepEqual(logged, []);
    });

    it('sends nothing for another item, outside a room, or to a server without the feature', async () => {
      session = playing(1, 3, OTHER);
      OWP.tracks.report();
      await settle();
      now += 5_000;
      session = playing(1, 3);
      OWP.state.serverFeatures = [];
      OWP.tracks.report();
      OWP.state.serverFeatures = ['participant_tracks'];
      OWP.state.inRoom = false;
      OWP.tracks.report();
      OWP.state.inRoom = true;
      OWP.state.ws = { readyState: 0 };
      OWP.tracks.report();
      await settle();
      assert.deepEqual(sent, []);
      assert.equal(sessionReads, 1);
    });

    it('sends them again on a new connection or in another room', async () => {
      session = playing(1, 3);
      OWP.tracks.report();
      await settle();
      OWP.state.clientId = 'client-b';
      now += 5_000;
      OWP.tracks.report();
      await settle();
      OWP.state.roomId = 'room-2';
      now += 5_000;
      OWP.tracks.report();
      await settle();
      assert.equal(sent.length, 3);
    });

    it('does not read twice at the same time, and survives a failed read', async () => {
      let release;
      globalThis.ApiClient.getSessions = () => {
        sessionReads++;
        return new Promise((resolve, reject) => { release = reject; });
      };
      OWP.tracks.report();
      now += 10_000;
      OWP.tracks.report();
      assert.equal(sessionReads, 1);
      release(new Error('offline'));
      await settle();
      globalThis.ApiClient.getSessions = async () => { sessionReads++; return [playing(1, 3)]; };
      OWP.tracks.report();
      await settle();
      assert.equal(sent.length, 1);
    });
  });

  describe('the participants drop-down', () => {
    const renderPeople = (participants) => {
      Object.assign(OWP.state, { participants, participantCount: participants.length, roomBarSection: 'people' });
      OWP.ui.render(true);
    };
    const folds = () => byId('owp-participants-list').querySelectorAll('.owp-tracks-fold');
    const boxes = () => byId('owp-participants-list').querySelectorAll('.owp-tracks');
    const values = box => box.querySelectorAll('.owp-tracks-value').map(value => value.textContent);
    const people = () => [
      { name: 'Franco', isHost: true, status: 'playing', tracks: report({ title: 'Español (doblaje)', language: 'spa' }, { language: 'spa', forced: true }) },
      { name: 'Ana', isHost: false, status: 'in_sync', tracks: report({ language: 'eng' }, null) },
      { name: 'Bruno', isHost: false, status: 'in_sync', tracks: report({}, { title: 'Commentary' }, OTHER) },
      { name: 'Ceci', isHost: false, status: 'loading', tracks: null }
    ];

    it("shows an arrow for whoever reported tracks for the room's item, closed", () => {
      renderPeople(people());
      assert.deepEqual(rows().map(row => Boolean(row.querySelector('.owp-tracks-fold'))), [true, true, false, false]);
      assert.deepEqual(folds().map(fold => fold.getAttribute('aria-expanded')), ['false', 'false']);
      assert.equal(folds()[0].getAttribute('aria-label'), 'Audio and subtitles of Franco');
      assert.deepEqual(boxes(), []);
    });

    it("opens one person's audio and subtitles at a time, and closes with the arrow again", () => {
      renderPeople(people());
      folds()[0].click();
      assert.deepEqual(folds().map(fold => fold.getAttribute('aria-expanded')), ['true', 'false']);
      assert.equal(boxes().length, 1);
      assert.deepEqual(values(boxes()[0]), ['Español (doblaje)', 'Spanish (forced)']);
      assert.equal(boxes()[0].id, folds()[0].getAttribute('aria-controls'));
      folds()[1].click();
      assert.deepEqual(folds().map(fold => fold.getAttribute('aria-expanded')), ['false', 'true']);
      assert.deepEqual(values(boxes()[0]), ['English', 'Off']);
      folds()[1].click();
      assert.deepEqual(boxes(), []);
    });

    it('puts the focus back on the redrawn arrow, as with a browser NodeList', () => {
      renderPeople(people());
      const fold = folds()[1];
      // A browser's querySelectorAll returns a NodeList, which has no find().
      const list = byId('owp-participants-list');
      const select = list.querySelectorAll.bind(list);
      let focused = null;
      list.querySelectorAll = (selector) => {
        const found = select(selector);
        for (const element of found) element.focus = () => { focused = element; };
        return { length: found.length, item: index => found[index], [Symbol.iterator]: () => found[Symbol.iterator]() };
      };
      fold.click();
      assert.equal(boxes().length, 1);
      assert.notEqual(focused, null);
      assert.notEqual(focused, fold);
      assert.equal(focused.dataset.tracksKey, fold.dataset.tracksKey);
      assert.equal(focused.getAttribute('aria-expanded'), 'true');
    });

    it('closes on a press in the panel outside the box, and stays open on one inside it', () => {
      renderPeople(people());
      folds()[0].click();
      boxes()[0].querySelector('.owp-tracks-value').dispatchEvent({ type: 'pointerdown' });
      assert.equal(boxes().length, 1);
      rows()[3].dispatchEvent({ type: 'pointerdown' });
      assert.deepEqual(boxes(), []);
      assert.deepEqual(folds().map(fold => fold.getAttribute('aria-expanded')), ['false', 'false']);
    });

    it('keeps the box open while the list redraws, and closes it in another room', () => {
      renderPeople(people());
      folds()[0].click();
      OWP.state.roomId = 'room-2';
      OWP.ui.updateParticipantList();
      assert.deepEqual(boxes(), []);
    });

    it('keeps the box open while the list redraws, and closes it when the person leaves', () => {
      renderPeople(people());
      folds()[1].click();
      OWP.ui.updateParticipantList();
      assert.deepEqual(values(boxes()[0]), ['English', 'Off']);
      renderPeople(people().filter(person => person.name !== 'Ana'));
      assert.deepEqual(boxes(), []);
      // Back in the same place, the box stays closed.
      renderPeople(people());
      assert.deepEqual(boxes(), []);
    });

    it('names a track by its title, else by its language, and says when it is unknown', () => {
      const tracks = report({}, { forced: true });
      renderPeople([{ name: 'Dani', isHost: false, status: 'playing', tracks }]);
      folds()[0].click();
      assert.deepEqual(values(boxes()[0]), ['Unknown', 'Unknown (forced)']);
      // Still open: the same person.
      renderPeople([{ name: 'Dani', isHost: false, status: 'playing', tracks: report(null, { language: 'und' }) }]);
      assert.deepEqual(values(boxes()[0]), ['None', 'Unknown']);
    });

    it('marks a forced track with a title too, unless the title already says so', () => {
      renderPeople([{ name: 'Gus', isHost: false, status: 'playing', tracks: report({ title: 'Latino' }, { title: 'Spanish', forced: true }) }]);
      folds()[0].click();
      assert.deepEqual(values(boxes()[0]), ['Latino', 'Spanish (forced)']);
      renderPeople([{ name: 'Gus', isHost: false, status: 'playing', tracks: report(null, { title: 'English FORCED', forced: true }) }]);
      assert.deepEqual(values(boxes()[0]), ['None', 'English FORCED']);
    });

    it('writes the language in the interface language', () => {
      document.documentElement.lang = 'es';
      try {
        renderPeople([{ name: 'Eva', isHost: false, status: 'playing', tracks: report({ language: 'eng' }, { language: 'spa', forced: true }) }]);
        folds()[0].click();
        assert.deepEqual(values(boxes()[0]), ['Inglés', 'Español (forzados)']);
        // The title already says it in this language.
        renderPeople([{ name: 'Eva', isHost: false, status: 'playing', tracks: report(null, { title: 'Español (Forzados)', forced: true }) }]);
        assert.deepEqual(values(boxes()[0]), ['Ninguno', 'Español (Forzados)']);
      } finally {
        document.documentElement.lang = 'en';
      }
    });
  });
});
