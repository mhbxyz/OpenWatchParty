const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const OWP = require('./setup.js');
let resolveItem;
let playCalls = 0;
let getItemCalls = 0;
let getItemImpl = () => new Promise(resolve => { resolveItem = resolve; });

OWP.state.inRoom = true;
OWP.state.joiningItemId = '';
OWP.state.playbackRequestAttempt = 0;
OWP.utils.getCurrentItemId = () => '';
OWP.utils.getVideo = () => null;
OWP.utils.getPlaybackManager = () => ({
  play: () => { playCalls++; }
});
globalThis.ApiClient = {
  getCurrentUserId: () => 'user',
  getItem: (...args) => {
    getItemCalls++;
    return getItemImpl(...args);
  }
};

require('../ws/send.js');
require('../playback/play.js');

describe('playback request invalidation', () => {
  it('does not start media after room state was reset', async () => {
    OWP.playback.ensurePlayback('item-a');
    assert.equal(OWP.state.joiningItemId, 'item-a');

    OWP.actions.resetRoomState();
    resolveItem({ Id: 'item-a' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(playCalls, 0);
    assert.equal(OWP.state.inRoom, false);
    assert.equal(OWP.state.joiningItemId, '');
  });

  it('invalidates a scheduled retry before entering another room', async () => {
    OWP.state.inRoom = true;
    OWP.state.joiningItemId = '';
    OWP.state.playbackRequestAttempt = 0;
    getItemCalls = 0;
    getItemImpl = () => Promise.reject(new Error('temporary failure'));
    let scheduledRetry;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => {
      scheduledRetry = callback;
      return 1;
    };

    try {
      OWP.playback.ensurePlayback('old-item');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof scheduledRetry, 'function');
      assert.equal(getItemCalls, 1);

      OWP.actions.resetRoomState();
      OWP.state.inRoom = true;
      scheduledRetry();

      assert.equal(getItemCalls, 1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
