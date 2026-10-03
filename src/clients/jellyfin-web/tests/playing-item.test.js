const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
require('../utils/media.js');

const CURRENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREVIOUS = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAGE = 'cccccccccccccccccccccccccccccccc';

// Jellyfin's player page, as measured in Jellyfin 12.1: the OSD rating button
// carries the item id, and leaving the player keeps the page as `.page.hide`.
const playerPage = (itemId, { hidden = false } = {}) => {
  const element = (className) => {
    const node = document.createElement('div');
    node.className = className;
    return node;
  };
  const page = element(`page libraryPage mainAnimatedPage${hidden ? ' hide' : ''}`);
  const bottom = element('videoOsdBottom videoOsdBottom-maincontrols');
  const controls = element('osdControls');
  const buttons = element('buttons focuscontainer-x');
  const rating = document.createElement('button');
  rating.className = 'btnUserRating autoSize paper-icon-button-light';
  rating.setAttribute('data-id', itemId);
  rating.dataset.id = itemId;
  buttons.appendChild(rating);
  controls.appendChild(buttons);
  bottom.appendChild(controls);
  page.appendChild(bottom);
  document.body.appendChild(page);
};

describe('playing item detection', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    window.location.hash = `#/details?id=${PAGE}`;
    delete window.NowPlayingItem;
    OWP.utils.getPlaybackManager = () => null;
    OWP.utils.getVideo = () => ({});
  });

  it('reports nothing without a video, whatever the page or a hidden player says', () => {
    OWP.utils.getVideo = () => null;
    playerPage(PREVIOUS, { hidden: true });

    assert.equal(OWP.utils.getPlayingItemId(), null);
  });

  it('reports nothing while the player page has no video yet', () => {
    OWP.utils.getVideo = () => null;
    playerPage(CURRENT);

    assert.equal(OWP.utils.getPlayingItemId(), null);
  });

  it('leaves the navigation fallbacks of getCurrentItemId alone', () => {
    OWP.utils.getVideo = () => null;

    assert.equal(OWP.utils.getCurrentItemId(), PAGE);
    assert.equal(OWP.utils.getPlayingItemId(), null);
  });

  it('reads the item from the visible player OSD', () => {
    playerPage(CURRENT);

    assert.equal(OWP.utils.getPlayingItemId(), CURRENT);
  });

  it('skips a hidden player page left from the previous item', () => {
    playerPage(PREVIOUS, { hidden: true });
    playerPage(CURRENT);

    assert.equal(OWP.utils.getPlayingItemId(), CURRENT);
  });

  it('does not take the page id or a hidden player page for the playing item', () => {
    // A video that is not the player, such as a backdrop.
    playerPage(PREVIOUS, { hidden: true });

    assert.equal(OWP.utils.getPlayingItemId(), null);
  });

  it('prefers the playback state when Jellyfin exposes it', () => {
    playerPage(PREVIOUS);
    window.NowPlayingItem = { Id: CURRENT };

    assert.equal(OWP.utils.getPlayingItemId(), CURRENT);
  });
});
