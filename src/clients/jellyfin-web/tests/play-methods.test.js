const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let playbackManager;
let toasts;
OWP.utils.getPlaybackManager = () => playbackManager;
OWP.ui = { showToast: message => toasts.push(message) };
require('../playback/play.js');

describe('Jellyfin playback API fallbacks', () => {
  beforeEach(() => {
    playbackManager = null;
    toasts = [];
  });

  it('waits for asynchronous rejection before trying the next signature', async () => {
    const calls = [];
    playbackManager = {
      play: options => {
        calls.push(options);
        if (options.items) return Promise.reject(new Error('items unsupported'));
        return Promise.resolve();
      }
    };

    const result = await OWP.playback.tryPlayMethods(playbackManager, { Id: 'item' });

    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].items);
    assert.ok(calls[1].item);
    assert.equal(result.errors[0].method, 'play({ items })');
  });

  it('falls back through synchronous throws to the ids signature', async () => {
    const calls = [];
    playbackManager = {
      play: options => {
        calls.push(options);
        if (!options.ids) throw new Error('unsupported');
      }
    };

    const result = await OWP.playback.tryPlayMethods(playbackManager, { Id: 'item' });

    assert.equal(result.success, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].ids, ['item']);
  });

  it('awaits playItems after every play signature rejects', async () => {
    let playItemsResolved = false;
    playbackManager = {
      play: () => Promise.reject(new Error('unsupported')),
      playItems: async () => {
        await new Promise(resolve => setImmediate(resolve));
        playItemsResolved = true;
      }
    };

    const result = await OWP.playback.tryPlayMethods(playbackManager, { Id: 'item' });

    assert.equal(result.success, true);
    assert.equal(playItemsResolved, true);
  });

  it('reports final asynchronous failure through playItem', async () => {
    playbackManager = {
      play: () => Promise.reject(new Error('unsupported')),
      playItems: () => Promise.reject(new Error('also unsupported'))
    };

    const success = await OWP.playback.playItem({ Id: 'item' });

    assert.equal(success, false);
    assert.equal(toasts.length, 1);
  });

  it('returns false when PlaybackManager is unavailable', async () => {
    assert.equal(await OWP.playback.playItem({ Id: 'item' }), false);
  });

  it('uses the official Jellyfin play button when PlaybackManager is unavailable', async () => {
    let clicked = 0;
    OWP.state.inRoom = true;
    OWP.utils.getVideo = () => null;
    document.querySelector = selector => selector === '.btnPlay:not(.hide)'
      ? { click: () => { clicked++; } }
      : null;

    assert.equal(await OWP.playback.playItem({ Id: 'item-fallback' }), true);
    assert.match(window.location.hash, /details\?id=item-fallback/);
    assert.equal(clicked, 1);
    OWP.state.inRoom = false;
  });

  it('does not continue fallbacks after request invalidation', async () => {
    let rejectFirst;
    let current = true;
    const calls = [];
    playbackManager = {
      play: options => {
        calls.push(options);
        return new Promise((resolve, reject) => { rejectFirst = reject; });
      },
      playItems: () => { calls.push('playItems'); }
    };
    const pending = OWP.playback.tryPlayMethods(playbackManager, { Id: 'item' }, () => current);
    current = false;
    rejectFirst(new Error('first signature failed'));

    const result = await pending;

    assert.equal(result.cancelled, true);
    assert.equal(calls.length, 1);
  });

  it('suppresses intermediate failure toast while retry remains', async () => {
    playbackManager = {
      play: () => Promise.reject(new Error('unsupported'))
    };

    assert.equal(await OWP.playback.playItem({ Id: 'item' }, { silent: true }), false);
    assert.equal(toasts.length, 0);
  });
});
