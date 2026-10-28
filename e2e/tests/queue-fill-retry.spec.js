const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test('a failed episode lookup fills the queue on a lifecycle retry without a room event', async ({ page }) => {
  await helpers.login(page, helpers.HOST_USER);
  // CI has movies only. Give two real playable items episode metadata at the
  // library API boundary; no extra media or provisioned test series is needed.
  const firstId = await helpers.findMovieId(page, 'Wing It!');
  const secondId = await helpers.findMovieId(page, 'Sprite Fright');
  await helpers.startPlayback(page, firstId);
  await helpers.waitForSettled(page);
  await page.evaluate(async ([first, second]) => {
    const api = window.ApiClient;
    const user = api.getCurrentUserId();
    const media = await Promise.all([api.getItem(user, first), api.getItem(user, second)]);
    const seriesId = 'abcdefabcdefabcdefabcdefabcdef12';
    const episodes = media.map((item, index) => ({
      ...item, Type: 'Episode', SeriesId: seriesId, ParentIndexNumber: 1, IndexNumber: index + 1
    }));
    window.__queueLookups = [];
    window.__originalGetItem = api.getItem;
    window.__originalGetJSON = api.getJSON;
    api.getItem = function(userId, id, ...args) {
      if (id === first && window.OpenWatchParty.state.inRoom) return Promise.resolve(episodes[0]);
      return window.__originalGetItem.call(this, userId, id, ...args);
    };
    api.getJSON = function(url, ...args) {
      if (String(url).includes(`/Shows/${seriesId}/Episodes`)) {
        window.__queueLookups.push(Date.now());
        if (window.__queueLookups.length === 1) return Promise.reject(new Error('simulated temporary outage'));
        return Promise.resolve({ Items: episodes });
      }
      return window.__originalGetJSON.call(this, url, ...args);
    };
  }, [firstId, secondId]);
  try {
    await helpers.createRoom(page);
    await expect.poll(() => page.evaluate(() => window.__queueLookups.length)).toBe(1);
    expect(await page.evaluate(() => window.OpenWatchParty.state.queueItems)).toHaveLength(0);
    await expect.poll(() => page.evaluate(() => window.OpenWatchParty.state.queueItems.length), { timeout: 12_000 }).toBeGreaterThan(1);
    const times = await page.evaluate(() => window.__queueLookups);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(5000);
    await page.waitForTimeout(6000);
    expect(await page.evaluate(() => window.__queueLookups.length)).toBe(2);
  } finally {
    await page.evaluate(() => {
      window.ApiClient.getItem = window.__originalGetItem;
      window.ApiClient.getJSON = window.__originalGetJSON;
    });
    await helpers.leaveIfInRoom(page);
  }
});
