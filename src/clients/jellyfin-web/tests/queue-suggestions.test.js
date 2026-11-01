const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');

const IDS = {
  current: '11111111111111111111111111111111',
  movie: '22222222222222222222222222222222',
  series: '33333333333333333333333333333333',
  episode: '44444444444444444444444444444444',
  first: '55555555555555555555555555555555',
  missing: '66666666666666666666666666666666',
  unknown: '77777777777777777777777777777777'
};
const episode = {
  Id: IDS.episode, Name: 'A Very Long Day', Type: 'Episode', SeriesId: IDS.series,
  SeriesName: 'OWP Test Show', ParentIndexNumber: 1, IndexNumber: 2, LocationType: 'FileSystem'
};
const current = { ...episode, Id: IDS.current, Name: 'Pilot', IndexNumber: 1 };
const movie = { Id: IDS.movie, Name: 'Sprite Fright', Type: 'Movie', ProductionYear: 2021 };
const series = { Id: IDS.series, Name: 'OWP Test Show', Type: 'Series' };

let sent;
let toasts;
let getItem;
let getJSON;
let currentUser;
let timer;
let cleared;
const originalSetTimeout = OWP.timers.setTimeout;
const originalClear = OWP.timers.clear;

OWP.actions = { send: (type, payload) => sent.push({ type, payload }) };
OWP.ui = { showToast: message => toasts.push(message) };
OWP.utils.log = () => {};
OWP.utils.getVideo = () => null;
OWP.utils.getPlayingItemId = () => '';
globalThis.ApiClient = {
  getCurrentUserId: () => currentUser,
  getItem: (...args) => getItem(...args),
  getUrl: (path, params) => ({ path, params }),
  getJSON: (...args) => getJSON(...args)
};
require('../app/queue.js');
require('../ws/send.js');
require('../ws/connection.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
// The search asks for titles and for episodes apart; each answer holds its own kind.
const libraryAnswer = (request, items) => ({
  Items: items.filter(item => (item.Type === 'Episode') === (request.params.IncludeItemTypes === 'Episode'))
});
const enterRoom = (fields = {}) => Object.assign(OWP.state, OWP.stateFactories.createRoomState(), {
  inRoom: true,
  roomId: 'room-1',
  clientId: 'client-1',
  isHost: false,
  serverFeatures: ['media_queue', 'start_when_ready', 'queue_suggestions'],
  roomMediaId: IDS.current,
  queueReceived: false,
  ...fields
});

describe('collaborative queue behavior', () => {
  beforeEach(() => {
    sent = [];
    currentUser = 'user-1';
    toasts = [];
    OWP.actions.send = (type, payload) => sent.push({ type, payload });
    OWP.ui.render = () => {};
    OWP.ui.hidePanel = () => {};
    timer = null;
    cleared = [];
    getItem = async (userId, id) => ({ ...movie, Id: id });
    getJSON = async () => ({ Items: [] });
    OWP.timers.setTimeout = (callback, delay, scope) => {
      timer = { callback, delay, scope };
      return timer;
    };
    OWP.timers.clear = handle => { cleared.push(handle); return true; };
    enterRoom();
  });

  afterEach(() => {
    OWP.timers.setTimeout = originalSetTimeout;
    OWP.timers.clear = originalClear;
  });

  it('debounces library search, requires two characters and sends the exact query', async () => {
    const calls = [];
    getJSON = async request => { calls.push(request); return { Items: [movie] }; };
    const answers = [];
    OWP.queue.search('s', (results, searched) => answers.push({ results, searched }));
    assert.equal(timer, null);
    assert.deepEqual(answers, [{ results: [], searched: false }]);
    OWP.queue.search('sp', (results, searched) => answers.push({ results, searched }));
    const firstTimer = timer;
    OWP.queue.search('sprite', (results, searched) => answers.push({ results, searched }));
    assert.deepEqual(cleared, [firstTimer]);
    assert.equal(timer.delay, 300);
    assert.equal(timer.scope, 'room');
    await timer.callback();
    assert.equal(calls.length, 2);
    for (const [call, types] of [[calls[0], 'Movie,Series,Video,MusicVideo'], [calls[1], 'Episode']]) {
      assert.equal(call.path, 'Users/user-1/Items');
      assert.deepEqual(call.params, {
        searchTerm: 'sprite',
        IncludeItemTypes: types,
        Recursive: true,
        Limit: 8,
        Fields: 'ProductionYear'
      });
    }
    assert.equal(answers.at(-1).results[0].item.title, 'Sprite Fright');
    assert.equal(answers.at(-1).results[0].kind, 'Movie');
    assert.equal(answers.at(-1).results[0].detail, '2021');
  });

  it('lists titles before episodes and keeps eight results', async () => {
    const episodes = Array.from({ length: 8 }, (_, index) => ({
      ...episode, Id: String(index).repeat(32), IndexNumber: index + 1
    }));
    getJSON = async request => ({
      Items: request.params.IncludeItemTypes === 'Episode' ? episodes : [movie]
    });
    let results;
    OWP.queue.search('owp', (answer) => { results = answer; });
    await timer.callback();
    assert.equal(results.length, 8);
    assert.equal(results[0].item.id, IDS.movie, 'a title comes before the episodes that match it');
    assert.deepEqual(results.slice(1).map(result => result.item.id), episodes.slice(0, 7).map(item => item.Id));
  });

  it('drops a stale search answer', async () => {
    let release;
    const old = new Promise(resolve => { release = resolve; });
    getJSON = request => request.params?.searchTerm === 'old' ? old : Promise.resolve({ Items: [movie] });
    const answers = [];
    OWP.queue.search('old', results => { if (results) answers.push(['old', results]); });
    const oldTimer = timer;
    const oldWork = oldTimer.callback();
    OWP.queue.search('new', results => { if (results) answers.push(['new', results]); });
    await timer.callback();
    release({ Items: [{ ...movie, Name: 'Old result' }] });
    await oldWork;
    assert.deepEqual(answers.map(([name]) => name), ['new']);
  });

  it('resolves a series through NextUp, then its first episode, and omits one without episodes', async () => {
    const paths = [];
    getJSON = async request => {
      paths.push(request.path);
      if (request.path.startsWith('Users/')) return libraryAnswer(request, [series]);
      if (request.path === 'Shows/NextUp') return { Items: [] };
      return { Items: [episode] };
    };
    let results;
    OWP.queue.search('show', value => { if (value) results = value; });
    await timer.callback();
    assert.deepEqual(paths, ['Users/user-1/Items', 'Users/user-1/Items', 'Shows/NextUp', `Shows/${IDS.series}/Episodes`]);
    assert.deepEqual(results[0], {
      item: { id: IDS.episode, title: 'OWP Test Show · S1:E2 · A Very Long Day', series: IDS.series },
      label: 'OWP Test Show',
      kind: 'Series',
      detail: 'continues with S1:E2'
    });
    getJSON = async request => request.path.startsWith('Users/') ? libraryAnswer(request, [series]) : { Items: [] };
    OWP.queue.search('empty', value => { if (value) results = value; });
    await timer.callback();
    assert.deepEqual(results, []);
  });

  it('uses NextUp without requesting the first episode and formats direct episode titles', async () => {
    const paths = [];
    getJSON = async request => {
      paths.push(request.path);
      if (request.path.startsWith('Users/')) return libraryAnswer(request, [series, episode]);
      return { Items: [episode] };
    };
    let results;
    OWP.queue.search('test', value => { if (value) results = value; });
    await timer.callback();
    assert.equal(paths.includes(`Shows/${IDS.series}/Episodes`), false);
    assert.equal(results[1].item.title, 'OWP Test Show · S1:E2 · A Very Long Day');
    assert.equal(results[1].detail, 'OWP Test Show');
    const long = { ...episode, SeriesName: 'S'.repeat(90), Name: 'N'.repeat(90) };
    getJSON = async request => request.path.startsWith('Users/') ? libraryAnswer(request, [long]) : { Items: [] };
    OWP.queue.search('long', value => { if (value) results = value; });
    await timer.callback();
    assert.equal(Array.from(results[0].item.title).length, 100);
  });

  it('includes a searched episode series only with start_when_ready', async () => {
    getJSON = async request => request.path.startsWith('Users/') ? libraryAnswer(request, [episode]) : { Items: [] };
    let results;
    enterRoom({ serverFeatures: ['media_queue', 'queue_suggestions'] });
    OWP.queue.search('episode', value => { if (value) results = value; });
    await timer.callback();
    assert.deepEqual(results[0].item, {
      id: IDS.episode,
      title: 'OWP Test Show · S1:E2 · A Very Long Day'
    });

    enterRoom();
    OWP.queue.search('episode', value => { if (value) results = value; });
    await timer.callback();
    assert.equal(results[0].item.series, IDS.series);
  });

  it('sends the exact NextUp query for a series', async () => {
    const calls = [];
    getJSON = async request => {
      calls.push(request);
      return request.path.startsWith('Users/') ? libraryAnswer(request, [series]) : { Items: [episode] };
    };
    OWP.queue.search('show', () => {});
    await timer.callback();
    assert.deepEqual(calls.find(call => call.path === 'Shows/NextUp'), {
      path: 'Shows/NextUp',
      params: { seriesId: IDS.series, userId: 'user-1', limit: 1, disableFirstEpisode: false }
    });
  });

  it('falls back when NextUp returns only a virtual episode', async () => {
    const virtual = { ...episode, Id: IDS.unknown, LocationType: 'Virtual' };
    getJSON = async request => {
      if (request.path.startsWith('Users/')) return libraryAnswer(request, [series]);
      if (request.path === 'Shows/NextUp') return { Items: [virtual] };
      return { Items: [episode] };
    };
    let results;
    OWP.queue.search('show', value => { if (value) results = value; });
    await timer.callback();
    assert.equal(results[0].item.id, IDS.episode);
  });

  it('keeps movie results when a series lookup fails', async () => {
    getJSON = async request => {
      if (request.path.startsWith('Users/')) return libraryAnswer(request, [movie, series]);
      throw new Error('NextUp unavailable');
    };
    let results;
    OWP.queue.search('mixed', value => { if (value) results = value; });
    await timer.callback();
    assert.deepEqual(results.map(result => result.item.id), [IDS.movie]);
  });

  it('adds the room item first, falls back to the selected item, and does not prepend an item already queued', async () => {
    OWP.state.isHost = true;
    getItem = async (userId, id) => id === IDS.movie ? movie : current;
    await OWP.queue.add({ id: IDS.movie, title: 'Sprite Fright' });
    assert.deepEqual(sent.pop(), { type: 'queue_add', payload: { items: [
      { id: IDS.current, title: 'OWP Test Show · S1:E1 · Pilot', series: IDS.series },
      { id: IDS.movie, title: 'Sprite Fright' }
    ] } });
    getItem = async (userId, id) => {
      if (id === IDS.movie) return movie;
      throw new Error('offline');
    };
    await OWP.queue.add({ id: IDS.movie, title: 'Sprite Fright' });
    assert.deepEqual(sent.pop().payload.items, [{ id: IDS.movie, title: 'Sprite Fright' }]);
    OWP.state.queueItems = [{ id: IDS.current, title: 'Pilot' }];
    await OWP.queue.add({ id: IDS.movie, title: 'Sprite Fright' });
    assert.deepEqual(sent.pop().payload.items, [{ id: IDS.movie, title: 'Sprite Fright' }]);
  });

  it('accepts suggestions using the host library title and series instead of guest metadata', async () => {
    enterRoom({ isHost: true, queueItems: [{ id: IDS.current, title: 'Pilot' }] });
    getItem = async (userId, id) => {
      assert.equal(userId, 'user-1');
      assert.equal(id, IDS.episode);
      return episode;
    };

    await OWP.queue.accept({ id: IDS.episode, title: 'Guest title', series: IDS.unknown });

    assert.deepEqual(sent, [{ type: 'queue_add', payload: { items: [{
      id: IDS.episode,
      title: 'OWP Test Show · S1:E2 · A Very Long Day',
      series: IDS.series
    }] } }]);
  });

  it('does not add a suggestion when the host cannot load its library item', async () => {
    enterRoom({ isHost: true, queueItems: [{ id: IDS.current, title: 'Pilot' }] });
    getItem = async () => { throw new Error('Not available to this host'); };

    await OWP.queue.accept({ id: IDS.movie, title: 'Guest title', series: IDS.series });

    assert.deepEqual(sent, []);
  });

  it('sends guest suggestion, dismiss, withdraw and accept payloads', async () => {
    const selected = { id: IDS.movie, title: 'Sprite Fright' };
    OWP.queue.suggest(selected);
    OWP.queue.dismiss(IDS.movie);
    OWP.queue.withdraw(IDS.movie);
    OWP.state.queueItems = [{ id: IDS.current, title: 'Pilot' }];
    OWP.state.isHost = true;
    await OWP.queue.accept({ ...selected, by: 'Ana', mine: false });
    assert.deepEqual(sent, [
      { type: 'queue_suggest', payload: selected },
      { type: 'queue_dismiss', payload: { id: IDS.movie } },
      { type: 'queue_dismiss', payload: { id: IDS.movie } },
      { type: 'queue_add', payload: { items: [selected] } }
    ]);
  });

  it('drops a pending add when its room, connection, user, media or host context changes', async () => {
    const changes = [
      ['room', () => enterRoom({ roomId: 'room-2', isHost: true })],
      ['leave', () => { OWP.state.inRoom = false; }],
      ['rejoin', () => { OWP.queue.resetRoom(); enterRoom({ isHost: true }); }],
      ['connection', () => { OWP.state.clientId = 'client-2'; }],
      ['user', () => { currentUser = 'user-2'; }],
      ['media', () => { OWP.state.roomMediaId = IDS.episode; }],
      ['host', () => { OWP.state.isHost = false; }],
      ['feature', () => { OWP.state.serverFeatures = []; }]
    ];
    for (const stage of ['selected', 'current']) for (const [label, change] of changes) {
      sent = [];
      currentUser = 'user-1';
      enterRoom({ isHost: true });
      let resolve;
      getItem = (userId, id) => stage === 'current' && id === IDS.movie
        ? Promise.resolve(movie)
        : new Promise(done => { resolve = done; });
      const pending = OWP.queue.add({ id: IDS.movie, title: 'Sprite Fright' });
      await settle();
      change();
      resolve(stage === 'selected' ? movie : current);
      await pending;
      assert.deepEqual(sent, [], `${stage}: ${label}`);
    }
  });

  it('keeps newer availability when an old same-room lookup settles after rejoining', async () => {
    for (const oldMissing of [true, false]) {
      sent = [];
      OWP.queue.resetRoom();
      enterRoom({ queueItems: [{ id: IDS.movie, title: 'Movie' }] });
      let resolve;
      let reject;
      getItem = () => new Promise((done, fail) => { resolve = done; reject = fail; });
      OWP.queue.onQueueState();
      OWP.queue.resetRoom();
      enterRoom({ clientId: 'client-2', queueItems: [{ id: IDS.movie, title: 'Movie' }] });
      getItem = async () => {
        if (!oldMissing) throw Object.assign(new Error('missing'), { status: 404 });
        return movie;
      };
      OWP.queue.onQueueState();
      await settle();
      const newerReports = [...sent];
      if (oldMissing) reject(Object.assign(new Error('old missing'), { status: 404 }));
      else resolve(movie);
      await settle();
      assert.deepEqual(sent, newerReports, 'an older answer must not replace the newer report');
    }
  });

  it('checks availability again when the Jellyfin user changes', async () => {
    enterRoom({ queueItems: [{ id: IDS.movie, title: 'Movie' }] });
    getItem = async userId => {
      if (userId === 'user-2') throw Object.assign(new Error('missing'), { status: 404 });
      return movie;
    };
    OWP.queue.onQueueState();
    await settle();
    currentUser = 'user-2';
    OWP.queue.onQueueState();
    await settle();
    assert.deepEqual(sent, [{ type: 'queue_availability', payload: { missing: [IDS.movie] } }]);
  });

  it('reports only 404 as missing, retries unknown failures, caches by room and reports changes', async () => {
    let unknownCalls = 0;
    getItem = async (userId, id) => {
      if (id === IDS.missing) throw Object.assign(new Error('missing'), { status: 404 });
      if (id === IDS.unknown) {
        unknownCalls++;
        throw Object.assign(new Error('offline'), { status: 503 });
      }
      return movie;
    };
    OWP.state.queueItems = [IDS.movie, IDS.missing, IDS.unknown].map(id => ({ id, title: id }));
    OWP.queue.onQueueState();
    await settle();
    assert.deepEqual(sent, [{ type: 'queue_availability', payload: { missing: [IDS.missing] } }]);
    OWP.queue.onQueueState();
    await settle();
    assert.equal(unknownCalls, 2);
    assert.equal(sent.length, 1);
    OWP.state.queueItems = [{ id: IDS.movie, title: 'Movie' }];
    OWP.queue.onQueueState();
    assert.deepEqual(sent.at(-1), { type: 'queue_availability', payload: { missing: [] } });
    enterRoom({ roomId: 'room-2', queueItems: [{ id: IDS.missing, title: 'Missing' }] });
    OWP.queue.onQueueState();
    await settle();
    assert.equal(sent.filter(message => message.payload.missing?.includes(IDS.missing)).length, 2);
  });

  it('checks and reports missing items again after the client id changes', async () => {
    let calls = 0;
    getItem = async () => {
      calls++;
      throw Object.assign(new Error('missing'), { status: 404 });
    };
    OWP.state.queueItems = [{ id: IDS.missing, title: 'Missing' }];
    OWP.queue.onQueueState();
    await settle();
    OWP.state.clientId = 'client-2';
    OWP.queue.onQueueState();
    await settle();

    assert.equal(calls, 2);
    assert.equal(sent.filter(message => message.payload.missing?.includes(IDS.missing)).length, 2);
  });

  it('leaving resets availability and notices before rejoining the same room', async () => {
    getItem = async (userId, id) => {
      if (id === IDS.missing) throw Object.assign(new Error('missing'), { status: 404 });
      return movie;
    };
    enterRoom({
      isHost: true,
      queueItems: [{ id: IDS.missing, title: 'Missing' }],
      queueSuggestions: [{ id: IDS.movie, title: 'Before', by: 'Ana', mine: false }]
    });
    OWP.queue.onQueueDetails();
    await settle();
    OWP.actions.leaveRoom();
    OWP.actions.joinRoom('room-1');
    enterRoom({
      isHost: true,
      queueItems: [{ id: IDS.missing, title: 'Missing' }],
      queueSuggestions: [{ id: IDS.episode, title: 'While away', by: 'Bea', mine: false }]
    });
    OWP.queue.onQueueDetails();
    await settle();

    assert.equal(sent.filter(message => message.payload.missing?.includes(IDS.missing)).length, 2);
    assert.deepEqual(toasts, []);
  });

  it('cancels a pending search when the connection drops', async () => {
    const originalWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      constructor() { this.readyState = 0; }
      close() { this.readyState = FakeWebSocket.CLOSED; }
    }
    globalThis.WebSocket = FakeWebSocket;
    try {
      OWP.queue.search('pending', () => {});
      const pendingSearch = timer;
      OWP.actions.fetchAuthToken = async () => ({ mode: 'insecure' });
      OWP.state.ws = null;
      OWP.state.isConnecting = false;
      OWP.state.authToken = '';
      await OWP.actions.connect();
      const socket = OWP.state.ws;
      socket.onclose({ code: 1006, reason: 'lost', wasClean: false });
      assert.equal(cleared.includes(pendingSearch), true);
      OWP.state.autoReconnect = false;
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('does not send an initially empty report or check without the negotiated feature', async () => {
    OWP.state.queueItems = [{ id: IDS.movie, title: 'Movie' }];
    OWP.queue.onQueueState();
    await settle();
    assert.deepEqual(sent, []);
    let calls = 0;
    getItem = async () => { calls++; return movie; };
    enterRoom({ serverFeatures: ['media_queue'], queueItems: [{ id: IDS.missing, title: 'Missing' }] });
    OWP.queue.onQueueState();
    await settle();
    assert.equal(calls, 0);
  });

  it('notifies a host only about later non-own suggestions, not those seen as a guest', () => {
    enterRoom({ isHost: true });
    OWP.state.queueSuggestions = [{ id: IDS.movie, title: 'Sprite Fright', by: 'Ana', mine: false }];
    OWP.queue.onQueueDetails();
    assert.deepEqual(toasts, []);
    OWP.state.queueSuggestions.push({ id: IDS.episode, title: 'Pilot', by: 'Bea', mine: false });
    OWP.queue.onQueueDetails();
    assert.deepEqual(toasts, ['Bea suggested “Pilot”']);
    OWP.state.queueSuggestions.push({ id: IDS.first, title: 'Mine', by: 'Host', mine: true });
    OWP.queue.onQueueDetails();
    assert.equal(toasts.length, 1);
    OWP.state.isHost = false;
    OWP.state.queueSuggestions.push({ id: IDS.missing, title: 'Waiting', by: 'Ana', mine: false });
    OWP.queue.onQueueDetails();
    assert.equal(toasts.length, 1, 'a guest gets no notice');
    OWP.state.isHost = true;
    OWP.queue.onQueueDetails();
    assert.equal(toasts.length, 1, 'becoming host does not replay what it saw as a guest');
  });
});
