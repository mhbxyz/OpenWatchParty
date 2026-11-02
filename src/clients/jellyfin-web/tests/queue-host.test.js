const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

let sent = [];
let playing = '';
let itemRequests = 0;
let segments = {};
let segmentRequests = 0;
let failItem = false;
let libraryGate = null; // While set, the library answers once it resolves
OWP.actions = { send: (type, payload) => sent.push({ type, payload }) };
OWP.utils.log = () => {};
OWP.utils.getPlayingItemId = () => playing;
let hostVideo = null;
OWP.utils.getVideo = () => hostVideo;

// A series of nine episodes, the fourth missing from the library, and a movie.
const series = Array.from({ length: 9 }, (_, i) => ({
  Id: `e${i + 1}`,
  Name: `Ep ${i + 1}`,
  Type: 'Episode',
  SeriesId: 'show',
  ParentIndexNumber: 1,
  IndexNumber: i + 1,
  LocationType: i === 3 ? 'Virtual' : 'FileSystem'
}));
const library = Object.fromEntries([...series, { Id: 'm1', Name: 'Movie', Type: 'Movie' }].map(item => [item.Id, item]));

globalThis.ApiClient = {
  getCurrentUserId: () => 'user',
  getItem: async (userId, id) => {
    itemRequests++;
    await libraryGate;
    if (failItem) {
      failItem = false;
      throw new Error('offline');
    }
    return library[id];
  },
  getUrl: (path, params) => ({ path, params }),
  getJSON: async ({ path, params }) => {
    if (path === 'Shows/show/Episodes') {
      const start = series.findIndex(episode => episode.Id === params.startItemId);
      return { Items: series.slice(start, start + params.limit) };
    }
    segmentRequests++;
    return { Items: segments[path.replace('MediaSegments/', '')] || [] };
  }
};
OWP.ui = { render: () => {}, showToast: () => {} };
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');
require('../app/queue.js');

const h = OWP._wsHandlers;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const item = id => ({ id, title: `S1:E${id.slice(1)} · Ep ${id.slice(1)}` });
const ids = message => message.payload.items.map(entry => entry.id);
const countdowns = () => sent.filter(message => message.type === 'queue_countdown').map(message => message.payload.start);
const video = (currentTime, { paused = false, ended = false, duration = NaN } = {}) => ({ currentTime, paused, ended, duration });

let room = 0;
const enterRoom = (fields = {}) => {
  room++;
  Object.assign(OWP.state, {
    clientId: 'host',
    inRoom: true,
    isHost: true,
    serverFeatures: ['media_queue'],
    roomId: `room-${room}`,
    roomMediaId: 'e1',
    queueItems: [],
    queueCurrent: null,
    queueCountdownUntil: 0,
    queueLastAdded: null,
    queueReceived: true
  }, fields);
};

// What the server sends, for the tests that go through the message handlers.
const roomState = (room, mediaId, hostId = 'host') => ({
  type: 'room_state',
  room,
  client: 'host',
  server_ts: Date.now(),
  payload: {
    name: 'Room',
    host_id: hostId,
    participant_count: 2,
    media_id: mediaId,
    state_server_ts: Date.now(),
    target_server_ts: null,
    state: { position: 0, play_state: 'paused' }
  }
});
const queueState = (room, queued, lastAdded) => ({
  type: 'queue_state',
  room,
  payload: { items: queued.map(item), current: null, last_added: lastAdded, countdown_until: null }
});
// A new page: this module and the room state start over.
const reloadPage = () => {
  delete require.cache[require.resolve('../app/queue.js')];
  require('../app/queue.js');
  Object.assign(OWP.state, OWP.stateFactories.createRoomState(), { clientId: 'host' });
};

describe('host queue', () => {
  beforeEach(() => {
    sent = [];
    playing = '';
    itemRequests = 0;
    failItem = false;
    segments = {};
    segmentRequests = 0;
    hostVideo = null;
    libraryGate = null;
  });

  // Holds the library's answers until the returned function is called.
  const holdLibrary = () => {
    let release;
    libraryGate = new Promise(resolve => { release = resolve; });
    return async () => {
      libraryGate = null;
      release();
      await settle();
    };
  };

  it('fills an empty queue with the room episode and the next five in the library', async () => {
    // Not before the server sent the room's queue.
    enterRoom({ queueReceived: false });
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 0);
    Object.assign(OWP.state, { queueReceived: true });
    OWP.queue.refresh();
    await settle();
    const adds = sent.filter(message => message.type === 'queue_add');
    assert.equal(adds.length, 1);
    assert.deepEqual(adds[0].payload.items, ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item));
  });

  it('names each episode series to a server with start_when_ready', async () => {
    const HEX = 'abcdefabcdefabcdefabcdefabcdef12';
    const getJSON = globalThis.ApiClient.getJSON;
    series.forEach(episode => { episode.SeriesId = HEX; });
    globalThis.ApiClient.getJSON = ({ path, params }) => getJSON({ path: path.replace(HEX, 'show'), params });
    const added = () => sent.filter(message => message.type === 'queue_add').at(-1).payload.items;
    try {
      enterRoom({ serverFeatures: ['media_queue', 'start_when_ready'] });
      OWP.queue.refresh();
      await settle();
      assert.ok(added().length > 0);
      assert.ok(added().every(entry => entry.series === HEX));
      // An older server would reject the field.
      enterRoom();
      OWP.queue.refresh();
      await settle();
      assert.ok(added().every(entry => !('series' in entry)));
      // Only a Jellyfin id goes.
      series.forEach(episode => { episode.SeriesId = 'show'; });
      globalThis.ApiClient.getJSON = getJSON;
      enterRoom({ serverFeatures: ['media_queue', 'start_when_ready'] });
      OWP.queue.refresh();
      await settle();
      assert.ok(added().every(entry => !('series' in entry)));
    } finally {
      series.forEach(episode => { episode.SeriesId = 'show'; });
      globalThis.ApiClient.getJSON = getJSON;
    }
  });

  it('tops up only when the room moves on, from the episode the room added last', async () => {
    enterRoom();
    OWP.queue.refresh();
    await settle();
    sent = [];
    // The host removed e7: the queue stays one short until the room moves on.
    Object.assign(OWP.state, { queueItems: ['e1', 'e2', 'e3', 'e5', 'e6'].map(item), queueLastAdded: 'e7' });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent, []);
    Object.assign(OWP.state, { roomMediaId: 'e2' });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent.map(ids), [['e8', 'e9']]);
  });

  it('leaves the queue it inherits as host alone until the room moves on', async () => {
    enterRoom({ queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 0);
    assert.deepEqual(sent, []);
    Object.assign(OWP.state, { roomMediaId: 'e2' });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent.map(ids), [['e5', 'e6', 'e7', 'e8']]);
  });

  it('keeps an episode the host removed out after the host reloads the page', async () => {
    enterRoom();
    const { roomId } = OWP.state;
    // Before the reload, the host's page filled e1 to e7 and the host removed
    // e3. The new page gets room_state first, then the queue.
    reloadPage();
    h.handleRoomState(roomState(roomId, 'e1'), null);
    await settle();
    h.handleQueueState(queueState(roomId, ['e1', 'e2', 'e5', 'e6', 'e7'], 'e7'));
    await settle();
    assert.equal(itemRequests, 0);
    assert.deepEqual(sent, []);
    h.handleRoomState(roomState(roomId, 'e2'), null);
    await settle();
    assert.deepEqual(sent.map(ids), [['e8', 'e9']]);
  });

  it('keeps an episode the previous host removed out after taking over the room', async () => {
    // The previous host filled e1 to e7 and removed e7.
    enterRoom({ isHost: false, roomHostId: 'old-host' });
    const { roomId } = OWP.state;
    h.handleQueueState(queueState(roomId, ['e1', 'e2', 'e3', 'e5', 'e6'], 'e7'));
    h.handleHostChanged({ room: roomId, payload: { host_id: 'host', host_name: 'Host' } });
    await settle();
    assert.deepEqual(sent, []);
    h.handleRoomState(roomState(roomId, 'e2'), null);
    await settle();
    assert.deepEqual(sent.map(ids), [['e8', 'e9']]);
  });

  it('waits for the queue after reconnecting before topping it up', async () => {
    enterRoom();
    OWP.queue.refresh();
    await settle();
    sent = [];
    // The room moved on to e2 while the connection was down: room_state comes
    // before the queue, which then shows four episodes ahead.
    Object.assign(OWP.state, { roomMediaId: 'e2', queueItems: [], queueLastAdded: null, queueReceived: false });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent, []);
    Object.assign(OWP.state, {
      queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item), queueLastAdded: 'e7', queueReceived: true
    });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent.map(ids), [['e8']]);
  });

  it('drops a top-up the queue changed under while the library answered, and tops up again', async () => {
    enterRoom({ queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    OWP.queue.refresh();
    await settle();
    const release = holdLibrary();
    Object.assign(OWP.state, { roomMediaId: 'e2' });
    OWP.queue.refresh();
    // Meanwhile a newer queue: e5 was added and the host removed it.
    Object.assign(OWP.state, { queueLastAdded: 'e5' });
    OWP.queue.refresh();
    await release();
    assert.deepEqual(sent, []);
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent.map(ids), [['e6', 'e7', 'e8', 'e9']]);
  });

  it('drops a top-up for an item the room left while the library answered', async () => {
    enterRoom({ queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    OWP.queue.refresh();
    await settle();
    const release = holdLibrary();
    Object.assign(OWP.state, { roomMediaId: 'e2' });
    OWP.queue.refresh();
    // The host goes back to the previous episode at once.
    Object.assign(OWP.state, { roomMediaId: 'e1' });
    OWP.queue.refresh();
    await release();
    assert.deepEqual(sent, []);
  });

  it('fills the queue after the connection drops during the first fill', async () => {
    enterRoom();
    const { roomId } = OWP.state;
    const disconnect = () => Object.assign(OWP.state, { inRoom: false, roomId: '', isHost: false },
      OWP.stateFactories.createQueueState());
    let release = holdLibrary();
    OWP.queue.refresh();
    // The library answers while the client is away...
    disconnect();
    await release();
    h.handleRoomState(roomState(roomId, 'e1'), null);
    // ...and, on the next try, once it is back but before the queue came.
    release = holdLibrary();
    h.handleQueueState(queueState(roomId, [], null));
    disconnect();
    h.handleRoomState(roomState(roomId, 'e1'), null);
    await release();
    assert.deepEqual(sent, []);
    h.handleQueueState(queueState(roomId, [], null));
    await settle();
    assert.deepEqual(sent.map(ids), [['e1', 'e2', 'e3', 'e5', 'e6', 'e7']]);
  });

  it('drops a top-up on losing the host role, even when the role comes back before the library answers', async () => {
    enterRoom({ roomHostId: 'host', queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    const { roomId } = OWP.state;
    OWP.queue.refresh();
    await settle();
    const release = holdLibrary();
    h.handleRoomState(roomState(roomId, 'e2'), null);
    h.handleHostChanged({ room: roomId, payload: { host_id: 'other', host_name: 'Other' } });
    h.handleHostChanged({ room: roomId, payload: { host_id: 'host', host_name: 'Host' } });
    await release();
    assert.equal(itemRequests, 1);
    assert.deepEqual(sent, []);
  });

  it('leaves the queue alone on becoming the host again after the room moved on', async () => {
    enterRoom({ roomHostId: 'host', queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    const { roomId } = OWP.state;
    OWP.queue.refresh();
    await settle();
    h.handleHostChanged({ room: roomId, payload: { host_id: 'other', host_name: 'Other' } });
    h.handleRoomState(roomState(roomId, 'e2', 'other'), null);
    h.handleHostChanged({ room: roomId, payload: { host_id: 'host', host_name: 'Host' } });
    await settle();
    assert.equal(itemRequests, 0);
    assert.deepEqual(sent, []);
  });

  it('retries the room item after five seconds without a new room message', async (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    enterRoom();
    failItem = true;
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent, []);
    now += 4999;
    OWP.queue.retryFill();
    await settle();
    assert.equal(itemRequests, 1);
    now++;
    OWP.queue.retryFill();
    await settle();
    assert.deepEqual(sent.map(ids), [['e1', 'e2', 'e3', 'e5', 'e6', 'e7']]);
  });

  it('stops after three retries and gives a new room item its own budget', async (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    enterRoom();
    for (let attempt = 0; attempt < 7; attempt++) {
      failItem = true;
      OWP.queue.refresh();
      await settle();
      now += 5000;
    }
    assert.equal(itemRequests, 4);
    failItem = false;
    OWP.state.roomMediaId = 'e2';
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 5);
    assert.equal(sent[0].payload.items[0].id, 'e2');
  });

  it('retries a failed episode-list request once and stops after success', async (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    const getJSON = globalThis.ApiClient.getJSON;
    let episodeRequests = 0;
    t.mock.method(globalThis.ApiClient, 'getJSON', async request => {
      if (request.path === 'Shows/show/Episodes' && ++episodeRequests === 1) throw new Error('offline');
      return getJSON(request);
    });
    enterRoom();
    OWP.queue.refresh();
    await settle();
    now += 5000;
    OWP.queue.retryFill();
    await settle();
    assert.equal(episodeRequests, 2);
    assert.equal(sent.filter(message => message.type === 'queue_add').length, 1);
    now += 5000;
    OWP.queue.retryFill();
    await settle();
    assert.equal(episodeRequests, 2);
  });

  it('drops a failed fill when the room changes before its retry', async (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    enterRoom();
    failItem = true;
    OWP.queue.refresh();
    await settle();
    enterRoom({ roomMediaId: 'e8' });
    OWP.queue.refresh();
    await settle();
    now += 5000;
    OWP.queue.retryFill();
    await settle();
    assert.equal(itemRequests, 2);
    assert.deepEqual(sent.map(ids), [['e8', 'e9']]);
  });

  it('uses the current fill cursor when it changes during a retry wait', async (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    enterRoom({ queueItems: ['e1', 'e2', 'e3'].map(item), queueLastAdded: 'e3' });
    OWP.queue.refresh();
    await settle();
    OWP.state.roomMediaId = 'e2';
    failItem = true;
    OWP.queue.refresh();
    await settle();
    OWP.state.queueLastAdded = 'e5';
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 2);
    assert.deepEqual(sent.map(ids), [['e6', 'e7', 'e8', 'e9']]);
    now += 5000;
    OWP.queue.retryFill();
    await settle();
    assert.deepEqual(sent.map(ids), [['e6', 'e7', 'e8', 'e9']]);
  });

  for (const fields of [{ inRoom: false }, { isHost: false }, { queueReceived: false }]) {
    it(`drops a pending retry when ${Object.keys(fields)[0]} is lost`, async (t) => {
      let now = 10000;
      t.mock.method(Date, 'now', () => now);
      enterRoom();
      failItem = true;
      OWP.queue.refresh();
      await settle();
      Object.assign(OWP.state, fields);
      OWP.queue.refresh();
      now += 5000;
      OWP.queue.retryFill();
      await settle();
      assert.equal(itemRequests, 1);
      assert.deepEqual(sent, []);
    });
  }

  it('asks the library once per starting point', async () => {
    enterRoom({ roomMediaId: 'e9' });
    OWP.queue.refresh();
    await settle();
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 1);
    assert.deepEqual(sent.map(ids), [['e9']]);
  });

  it('leaves a queue with five episodes ahead alone', async () => {
    enterRoom({ queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item) });
    OWP.queue.refresh();
    await settle();
    assert.equal(itemRequests, 0);
    assert.deepEqual(sent, []);
  });

  it('does nothing for a movie, a guest or a server without the queue', async () => {
    enterRoom({ roomMediaId: 'm1' });
    OWP.queue.refresh();
    enterRoom({ isHost: false });
    OWP.queue.refresh();
    enterRoom({ serverFeatures: [] });
    OWP.queue.refresh();
    enterRoom({ queueItems: [item('e5')] });
    OWP.queue.refresh();
    await settle();
    assert.deepEqual(sent, []);
  });

  // Credits are remembered per item, so each test below plays its own.
  it('counts down from the credits and stops when the room pauses or goes back', async () => {
    segments = { e3: [{ Type: 'Intro', StartTicks: 0 }, { Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e3', queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item) });
    playing = 'e3';
    OWP.queue.refresh();
    OWP.queue.refresh();
    await settle();
    assert.equal(segmentRequests, 1);

    OWP.queue.onVideoTime(video(1199));
    OWP.queue.onVideoTime(video(1200));
    OWP.queue.onVideoTime(video(1201));
    assert.deepEqual(countdowns(), [true]);

    // The server's queue_state answers each request.
    Object.assign(OWP.state, { queueCountdownUntil: 1 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1202, { paused: true }));
    Object.assign(OWP.state, { queueCountdownUntil: 0 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1202, { paused: true }));
    OWP.queue.onVideoTime(video(1203));
    Object.assign(OWP.state, { queueCountdownUntil: 1 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(900));
    assert.deepEqual(countdowns(), [true, false, true, false]);
  });

  it('counts down again when a new next item replaces a removed one', async () => {
    segments = { e7: [{ Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e7', queueItems: ['e6', 'e7', 'e8'].map(item) });
    playing = 'e7';
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1250));
    // The host removes e8, which ends the countdown, and e9 is queued after.
    Object.assign(OWP.state, { queueItems: ['e6', 'e7'].map(item), queueCountdownUntil: 0 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1251));
    Object.assign(OWP.state, { queueItems: ['e6', 'e7', 'e9'].map(item) });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1252));
    assert.deepEqual(countdowns(), [true, true]);
  });

  it('stops a countdown the room paused before the server confirmed it', async () => {
    segments = { e2: [{ Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e2', queueItems: ['e1', 'e2', 'e3'].map(item) });
    playing = 'e2';
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1201));
    // The host pauses; then the server's queue_state confirms the countdown.
    hostVideo = video(1202, { paused: true });
    OWP.queue.onVideoTime(hostVideo);
    Object.assign(OWP.state, { queueCountdownUntil: 1 });
    OWP.queue.onQueueState();
    assert.deepEqual(countdowns(), [true, false]);
  });

  it('counts down again in another room after a cancel', async () => {
    segments = { e1: [{ Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e1', queueItems: ['e1', 'e2'].map(item), queueCountdownUntil: 1 });
    playing = 'e1';
    OWP.queue.cancelCountdown();
    enterRoom({ roomMediaId: 'e1', queueItems: ['e1', 'e2'].map(item) });
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1250));
    assert.deepEqual(countdowns(), [false, true]);
  });

  it('does not count down again on an item whose countdown the host cancelled', async () => {
    segments = { e5: [{ Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e5', queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item), queueCountdownUntil: 1 });
    playing = 'e5';
    OWP.queue.refresh();
    await settle();
    OWP.queue.cancelCountdown();
    Object.assign(OWP.state, { queueCountdownUntil: 0 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1250));
    assert.deepEqual(countdowns(), [false]);
  });

  // Jellyfin closes the player at the end, so the room must move on before it.
  it('counts down 15 seconds before the end of an item without credits, and only toward a next item', async () => {
    enterRoom({ roomMediaId: 'e6', queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item) });
    playing = 'e6';
    OWP.queue.refresh();
    await settle();
    // Nothing to go by until the video knows its duration.
    OWP.queue.onVideoTime(video(1385));
    assert.deepEqual(countdowns(), []);
    OWP.queue.onVideoTime(video(1384, { duration: 1400 }));
    OWP.queue.onVideoTime(video(1385, { duration: 1400 }));
    assert.deepEqual(countdowns(), [true]);

    // By the end the room has moved on; the browser's pause there stops a
    // countdown like any other.
    Object.assign(OWP.state, { queueCountdownUntil: 1 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1400, { duration: 1400, paused: true, ended: true }));
    assert.deepEqual(countdowns(), [true, false]);

    sent = [];
    enterRoom({ roomMediaId: 'e9', queueItems: ['e8', 'e9'].map(item) });
    playing = 'e9';
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1390, { duration: 1400 }));
    assert.deepEqual(countdowns(), []);
  });

  it('counts down before credits shorter than the countdown', async () => {
    segments = { e8: [{ Type: 'Outro', StartTicks: 1395 * 10000000 }] };
    enterRoom({ roomMediaId: 'e8', queueItems: ['e7', 'e8', 'e9'].map(item) });
    playing = 'e8';
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1384, { duration: 1400 }));
    OWP.queue.onVideoTime(video(1385, { duration: 1400 }));
    assert.deepEqual(countdowns(), [true]);
  });

  it('waits for a room pause on its way to the host player before counting down again', async () => {
    segments = { e3: [{ Type: 'Outro', StartTicks: 1200 * 10000000 }] };
    enterRoom({ roomMediaId: 'e3', queueItems: ['e2', 'e3', 'e5'].map(item), queueCountdownUntil: 1 });
    playing = 'e3';
    OWP.queue.refresh();
    await settle();
    // A guest paused: the server ended the countdown, and the host's player
    // applies the pause in a moment.
    hostVideo = video(1250);
    Object.assign(OWP.state, { pendingPlayUntil: OWP.utils.getServerNow() + 300, queueCountdownUntil: 0 });
    OWP.queue.onQueueState();
    OWP.queue.onVideoTime(video(1250.1));
    assert.deepEqual(countdowns(), []);
    // Once its moment has passed, the room playing on in the credits counts
    // down again.
    Object.assign(OWP.state, { pendingPlayUntil: OWP.utils.getServerNow() - 1 });
    OWP.queue.onVideoTime(video(1260));
    assert.deepEqual(countdowns(), [true]);
  });

  it('waits for the room item to play before counting down', async () => {
    enterRoom({ roomMediaId: 'e2', queueItems: ['e1', 'e2', 'e3', 'e5', 'e6', 'e7'].map(item) });
    playing = 'e1';
    OWP.queue.refresh();
    await settle();
    OWP.queue.onVideoTime(video(1390, { duration: 1400 }));
    assert.deepEqual(countdowns(), []);
  });
});
