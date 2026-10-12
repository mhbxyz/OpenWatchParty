const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
require('../playback/sync.js');

const h = OWP._wsHandlers;
const validate = message => OWP.wsValidation.validateMessage(message);
const { PANEL_ID, PARTICIPANT_STATUS_HOLD_MS } = OWP.constants;

const message = (type, payload, extra = {}) => ({
  type,
  room: 'room-1',
  payload,
  ts: 1_700_000_000_000,
  server_ts: 1_700_000_000_001,
  ...extra
});
const statusesMessage = (statuses, room = 'room-1') => message('participant_statuses', { statuses }, { room });
const listMessage = participants => message('participant_list', { participants });

let video;
let sent;
let now;
OWP.utils.getVideo = () => video;
OWP.utils.isVideoReady = () => video && video.readyState >= 3;
OWP.utils.nowMs = () => now;

const byId = id => document.getElementById(id);
const rows = () => byId('owp-participants-list').querySelectorAll('.owp-participant');

const enterRoom = () => {
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-1',
    clientId: 'client-a',
    isHost: false,
    guestPaused: false,
    participants: [],
    statusesRoomId: '',
    serverFeatures: [],
    statusCandidate: '',
    statusCandidateSince: 0,
    statusSentKey: '',
    pendingMediaId: '',
    isBuffering: false,
    syncStatus: 'synced',
    currentVideoElement: null,
    ws: { readyState: 1 }
  });
};

describe('participant statuses', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    video = { paused: false, readyState: 4 };
    sent = [];
    now = 10_000;
    OWP.actions = { completeRoomRejoin: () => {}, send: (type, payload) => sent.push([type, payload]) };
    OWP.ui.updateStatusIndicator = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.ui.renderHomeWatchParties = () => {};
    OWP.ui.updateRoomListUI = () => {};
    OWP.ui.stopPlayerCapture = () => {};
    enterRoom();
  });

  describe('the participant_statuses message', () => {
    it('accepts known statuses and nulls, one per participant', () => {
      assert.equal(validate(statusesMessage(['playing', null, 'in_sync', 'catching_up', 'buffering', 'loading', 'blocked', 'not_watching', 'paused'])).valid, true);
      assert.equal(validate(statusesMessage([])).valid, true);
    });

    it('rejects unknown statuses, other shapes, extra fields and a missing room', () => {
      for (const bad of [
        statusesMessage(['dancing']),
        statusesMessage([1]),
        statusesMessage('playing'),
        statusesMessage(Array(21).fill(null)),
        message('participant_statuses', { statuses: [], extra: true }),
        message('participant_statuses', { statuses: [] }, { room: undefined })
      ]) {
        assert.equal(validate(bad).valid, false, JSON.stringify(bad));
      }
    });

    it('applies the statuses to the list in order', () => {
      h.handleParticipantList(listMessage([{ name: 'Franco', is_host: true }, { name: 'Ana', is_host: false }]));
      h.handleParticipantStatuses(statusesMessage(['playing', 'blocked']));
      assert.deepEqual(OWP.state.participants.map(p => p.status), ['playing', 'blocked']);
      assert.equal(OWP.state.statusesRoomId, 'room-1');
    });

    it('ignores statuses for another list or another room', () => {
      h.handleParticipantList(listMessage([{ name: 'Franco', is_host: true }, { name: 'Ana', is_host: false }]));
      h.handleParticipantStatuses(statusesMessage(['playing']));
      h.handleParticipantStatuses(statusesMessage(['playing', 'blocked'], 'room-2'));
      assert.deepEqual(OWP.state.participants.map(p => p.status), [null, null]);
    });

    it('clears the statuses when a new list arrives, until its statuses follow', () => {
      h.handleParticipantList(listMessage([{ name: 'Franco', is_host: true }]));
      h.handleParticipantStatuses(statusesMessage(['playing']));
      h.handleParticipantList(listMessage([{ name: 'Franco', is_host: true }, { name: 'Ana', is_host: false }]));
      assert.deepEqual(OWP.state.participants.map(p => p.status), [null, null]);
    });
  });

  describe('this client\'s status', () => {
    const statusWith = (changes, videoChanges = {}) => {
      enterRoom();
      Object.assign(OWP.state, changes);
      video = { paused: false, readyState: 4, ...videoChanges };
      return OWP.playback.ownStatus();
    };

    it('maps the host and the sync engine to a status', () => {
      assert.equal(statusWith({ isHost: true }), 'playing');
      assert.equal(statusWith({ isHost: true }, { paused: true }), 'paused');
      assert.equal(statusWith({}), 'in_sync');
      assert.equal(statusWith({ syncStatus: 'syncing' }), 'catching_up');
      assert.equal(statusWith({ syncStatus: 'blocked' }), 'blocked');
      assert.equal(statusWith({ syncStatus: 'pending_play' }), 'loading');
      assert.equal(statusWith({ pendingMediaId: 'item' }), 'loading');
      assert.equal(statusWith({}, { readyState: 2 }), 'loading');
      assert.equal(statusWith({ isBuffering: true }), 'buffering');
      assert.equal(statusWith({ isHost: true, isBuffering: true }), 'buffering');
      enterRoom();
      video = null;
      assert.equal(OWP.playback.ownStatus(), 'not_watching');
    });

    it('is sent once it has held for a second, and only once', () => {
      OWP.state.statusesRoomId = 'room-1';
      OWP.playback.reportStatus();
      assert.deepEqual(sent, []);
      now += PARTICIPANT_STATUS_HOLD_MS - 1;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, []);
      now += 1;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, [['participant_status', { status: 'in_sync' }]]);
      now += 5000;
      OWP.playback.reportStatus();
      assert.equal(sent.length, 1);
    });

    it('reports a private guest pause instead of stale sync-engine status', () => {
      for (const syncStatus of ['synced', 'syncing']) {
        assert.equal(statusWith({ guestPaused: true, syncStatus }, { paused: true }), 'paused');
      }
      OWP.state.serverFeatures = ['participant_status'];
      OWP.playback.reportStatus();
      now += PARTICIPANT_STATUS_HOLD_MS;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, [['participant_status', { status: 'paused' }]]);
      OWP.state.guestPaused = false;
      video.paused = false;
      OWP.playback.reportStatus();
      now += PARTICIPANT_STATUS_HOLD_MS;
      OWP.playback.reportStatus();
      assert.deepEqual(sent.at(-1), ['participant_status', { status: 'catching_up' }]);
    });

    it('waits again whenever the status changes before it held', () => {
      OWP.state.statusesRoomId = 'room-1';
      OWP.playback.reportStatus();
      now += 600;
      OWP.state.syncStatus = 'syncing';
      OWP.playback.reportStatus();
      now += 600;
      OWP.state.syncStatus = 'synced';
      OWP.playback.reportStatus();
      now += 600;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, []);
      now += 400;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, [['participant_status', { status: 'in_sync' }]]);
    });

    it('is not sent to a server that has not shown it accepts statuses', () => {
      for (const statusesRoomId of ['', 'room-2']) {
        enterRoom();
        OWP.state.statusesRoomId = statusesRoomId;
        OWP.playback.reportStatus();
        now += PARTICIPANT_STATUS_HOLD_MS;
        OWP.playback.reportStatus();
      }
      assert.deepEqual(sent, []);
    });

    it('is not sent outside a room or while disconnected', () => {
      for (const changes of [{ inRoom: false }, { ws: null }, { ws: { readyState: 3 } }]) {
        enterRoom();
        Object.assign(OWP.state, { statusesRoomId: 'room-1' }, changes);
        OWP.playback.reportStatus();
        now += PARTICIPANT_STATUS_HOLD_MS;
        OWP.playback.reportStatus();
      }
      assert.deepEqual(sent, []);
    });

    it('is sent to a server that declared participant_status, even before one sent statuses', () => {
      OWP.state.serverFeatures = ['participant_status'];
      OWP.playback.reportStatus();
      now += PARTICIPANT_STATUS_HOLD_MS;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, [['participant_status', { status: 'in_sync' }]]);
    });

    it('is not sent to a server that neither declared the feature nor sent statuses', () => {
      OWP.state.serverFeatures = ['host_transfer'];
      OWP.playback.reportStatus();
      now += PARTICIPANT_STATUS_HOLD_MS;
      OWP.playback.reportStatus();
      assert.deepEqual(sent, []);
    });

    it('is sent again after a reconnection, which gives a new client id', () => {
      OWP.state.statusesRoomId = 'room-1';
      OWP.playback.reportStatus();
      now += PARTICIPANT_STATUS_HOLD_MS;
      OWP.playback.reportStatus();
      OWP.state.clientId = 'client-b';
      now += 500;
      OWP.playback.reportStatus();
      assert.equal(sent.length, 2);
    });
  });

  describe('the participants drop-down', () => {
    const renderPeople = (participants) => {
      Object.assign(OWP.state, { participants, participantCount: participants.length, roomBarSection: 'people' });
      OWP.ui.render(true);
    };

    it('shows each status under the name, with its color', () => {
      renderPeople([
        { name: 'Franco', isHost: true, status: 'playing' },
        { name: 'Ana', isHost: false, status: 'blocked' },
        { name: 'Bruno', isHost: false, status: 'catching_up' }
      ]);
      const [host, ana, bruno] = rows();
      assert.ok(host.classList.contains('owp-has-status'));
      assert.equal(host.querySelector('.owp-participant-line .owp-participant-name').textContent, 'Franco');
      assert.equal(host.querySelector('.owp-participant-line .owp-host-badge').textContent, 'Host');
      assert.equal(host.querySelector('.owp-participant-status').textContent, 'Playing');
      assert.ok(host.querySelector('.owp-participant-status').classList.contains('good'));
      assert.equal(ana.querySelector('.owp-participant-status').textContent, 'Needs to press Play');
      assert.ok(ana.querySelector('.owp-participant-status').classList.contains('bad'));
      assert.equal(bruno.querySelector('.owp-participant-status').textContent, 'Catching up');
      assert.ok(bruno.querySelector('.owp-participant-status').classList.contains('warn'));
    });

    it('labels every status', () => {
      const labels = {
        playing: 'Playing', paused: 'Paused', in_sync: 'In sync', catching_up: 'Catching up',
        buffering: 'Buffering', loading: 'Loading', blocked: 'Needs to press Play', not_watching: 'Not watching'
      };
      renderPeople(Object.keys(labels).map(status => ({ name: status, isHost: false, status })));
      assert.deepEqual(rows().map(row => row.querySelector('.owp-participant-status').textContent), Object.values(labels));
    });

    it('keeps the row as before for someone without a status', () => {
      renderPeople([{ name: 'Franco', isHost: true, status: null }]);
      const [row] = rows();
      assert.equal(row.classList.contains('owp-has-status'), false);
      assert.deepEqual(row.children.map(child => child.className), ['owp-participant-avatar', 'owp-participant-name', 'owp-host-badge']);
      assert.equal(row.querySelector('.owp-participant-status'), null);
    });

    it('shows the Host badge capitalized', () => {
      const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'styles.js'), 'utf8');
      const badgeRule = css.slice(css.indexOf('.owp-host-badge {'), css.indexOf('}', css.indexOf('.owp-host-badge {')));
      assert.equal(badgeRule.includes('text-transform'), false);
    });
  });
});
