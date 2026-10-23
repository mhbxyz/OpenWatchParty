const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
OWP.chat = { messages: [], unreadCount: 0 };
OWP.utils.getVideo = () => null;
OWP.utils.log = () => {};
require('../ui/indicators.js');
require('../ui/cards.js');
require('../chat/messages.js');
require('../chat/input.js');
require('../ui/toasts.js');
require('../ui/home.js');
require('./load-panel-views.js');
let sent = [];
OWP.actions = { send: (type, payload) => sent.push({ type, payload }), schedulePing: () => {} };
require('../app/start.js');

const { PANEL_ID } = OWP.constants;
const panel = () => document.getElementById(PANEL_ID);
const bar = () => panel().querySelector('.owp-room-bar');
const label = () => bar().querySelector('.owp-start-label');
const name = () => bar().querySelector('.owp-room-name');
const float = () => document.getElementById('owp-start-float');
const member = (name, reason) => ({ name, reason, since: Date.now() });

const renderRoom = (fields = {}) => {
  Object.assign(OWP.state, {
    inRoom: true,
    roomId: 'room-1',
    roomName: "Host's room",
    clientId: 'client-1',
    isHost: true,
    sharedPlaybackControl: false,
    participantCount: 3,
    participants: [],
    serverFeatures: ['start_when_ready'],
    syncStatus: 'synced',
    startPhase: 'idle',
    startWaiting: {},
    ...fields
  });
  OWP.ui.render(true);
};

describe('start label in the room bar', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    const element = document.createElement('div');
    element.id = PANEL_ID;
    document.body.appendChild(element);
    sent = [];
  });

  it('shows nothing while nothing waits', () => {
    renderRoom();
    assert.equal(label(), null);
    assert.equal(name().hidden, undefined);
    assert.equal(float(), null);
  });

  it('says who the room waits for in place of the name, and starts it when selected', () => {
    renderRoom({ startPhase: 'waiting', startWaiting: { c2: member('Ana', 'transcoding') } });
    assert.equal(name().hidden, true);
    assert.equal(label().textContent, 'Waiting for Ana');
    assert.equal(label().querySelector('.owp-icon-hourglass') !== null, true);
    assert.equal(label().title, 'Ana: the server is converting the video\nSelect to start without waiting');
    assert.equal(label().getAttribute('aria-disabled'), 'false');
    label().click();
    assert.deepEqual(sent, [{ type: 'start_now', payload: {} }]);
  });

  it('names two members, and counts more', () => {
    renderRoom({ startPhase: 'waiting', startWaiting: { c2: member('Ana', 'loading'), c3: member('Pablo', 'buffering') } });
    assert.equal(label().textContent, 'Waiting for Ana and Pablo');
    renderRoom({
      startPhase: 'waiting',
      startWaiting: { c2: member('Ana', 'loading'), c3: member('Pablo', 'buffering'), c4: member('Eva', 'loading') }
    });
    assert.equal(label().textContent, 'Waiting for 3 people');
  });

  it('is not an action for a guest without the shared controls', () => {
    renderRoom({ isHost: false, startPhase: 'waiting', startWaiting: { c2: member('Ana', 'loading') } });
    assert.equal(label().getAttribute('aria-disabled'), 'true');
    assert.equal(label().title, 'Ana: loading the video');
    label().click();
    assert.deepEqual(sent, []);
  });

  it('counts down in the same place', () => {
    renderRoom({ startPhase: 'starting', startTarget: OWP.utils.getServerNow() + 2500 });
    assert.equal(label().textContent, 'Starting in 3');
    assert.equal(label().querySelector('.owp-start-num').textContent, '3');
    assert.equal(label().querySelector('.owp-icon-play') !== null, true);
    assert.equal(label().title, '');
  });

  it('shows on its own while the panel is closed, and goes away with the wait', () => {
    renderRoom({ startPhase: 'waiting', startWaiting: { c2: member('Ana', 'loading') } });
    panel().classList.add('hide');
    OWP.ui.updateStartLabel();
    assert.equal(label(), null);
    assert.equal(name().hidden, false);
    assert.equal(float().textContent, 'Waiting for Ana');
    float().click();
    assert.equal(sent.length, 1);

    panel().classList.remove('hide');
    OWP.ui.updateStartLabel();
    assert.equal(float(), null);
    assert.equal(label().textContent, 'Waiting for Ana');

    OWP.state.startPhase = 'idle';
    OWP.ui.updateStartLabel();
    assert.equal(label(), null);
    assert.equal(name().hidden, false);
    assert.equal(float(), null);
  });

  it('leaves no label behind on leaving the room', () => {
    renderRoom({ startPhase: 'waiting', startWaiting: { c2: member('Ana', 'loading') } });
    panel().classList.add('hide');
    OWP.ui.updateStartLabel();
    assert.ok(float());
    OWP.state.inRoom = false;
    OWP.ui.render(true);
    assert.equal(float(), null);
  });
});
