const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

// The dev library has no segment provider such as Intro Skipper, so both
// browsers get the answer one would give: an intro from 0:05 to 0:30.
const MOVIE = 'Wing It!';
const INTRO_START = 5;
const INTRO_END = 30;
const TICKS = 10_000_000;

let hostContext;
let guestContext;
let host;
let guest;
let movieId;

async function markIntro(page) {
  // Jellyfin asks for the segments of a media source that says it has some.
  await page.route(/\/Items\/[0-9a-f]{32}\/PlaybackInfo/i, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const source of json.MediaSources || []) source.HasSegments = true;
    await route.fulfill({ response, json });
  });
  await page.route(/\/MediaSegments\/[0-9a-f]{32}/i, (route) => {
    const itemId = new URL(route.request().url()).pathname.split('/').pop();
    const items = [{ Id: `intro-${itemId}`, ItemId: itemId, Type: 'Intro', StartTicks: INTRO_START * TICKS, EndTicks: INTRO_END * TICKS }];
    route.fulfill({ json: { Items: items, TotalRecordCount: items.length, StartIndex: 0 } });
  });
}

const position = page => page.evaluate(() => window.OpenWatchParty.utils.getVideo()?.currentTime ?? 0);
// Jellyfin's own Skip Intro prompt, as a press on it.
const pressSkip = page => page.evaluate(() => document.querySelector('.skip-button').click());

async function openRoomInIntro({ prompt = true } = {}) {
  await helpers.startPlayback(host, movieId);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  await helpers.joinRoomFromHomeCard(guest, room.roomId);
  await helpers.expectParticipants(guest, 2);
  await expect.poll(() => position(host), { timeout: 20_000 }).toBeGreaterThan(INTRO_START + 1);
  if (prompt) await expect(guest.locator('.skip-button')).toHaveCount(1);
}

test.beforeAll(async ({ browser }) => {
  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await markIntro(host);
  await markIntro(guest);
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
  movieId = await helpers.findMovieId(host, MOVIE);
});

test.afterAll(async () => {
  await hostContext?.close();
  await guestContext?.close();
});

test.beforeEach(async () => {
  await helpers.leaveIfInRoom(host);
  await helpers.leaveIfInRoom(guest);
});

test("a guest's Skip Intro does not take them away from the room", async () => {
  await openRoomInIntro();
  await pressSkip(guest);
  await expect(guest.locator('.owp-toast-system', { hasText: 'Only the host can seek' })).toHaveCount(1);
  await guest.waitForTimeout(1000);
  expect(await position(guest)).toBeLessThan(INTRO_END - 5);
  expect(Math.abs(await position(guest) - await position(host))).toBeLessThan(2);
});

test("the host's Skip Intro takes the room past it and tells the guest", async () => {
  await openRoomInIntro();
  await pressSkip(host);
  await expect(guest.locator('.owp-toast-system', { hasText: 'The host skipped the intro' })).toHaveCount(1);
  await expect.poll(() => position(guest), { timeout: 10_000 }).toBeGreaterThan(INTRO_END - 1);
});

test('a guest whose Jellyfin skips intros by itself comes back to the room at once', async () => {
  await guest.evaluate(() => {
    localStorage.setItem(`${window.ApiClient.getCurrentUserId()}-segmentTypeAction__Intro`, 'Skip');
  });
  try {
    await guest.reload();
    await helpers.waitForClient(guest);
    await openRoomInIntro({ prompt: false });
    // Jellyfin skipped the guest at 0:05; three seconds later it plays with
    // the room again, not 25 seconds ahead.
    await expect.poll(() => position(host), { timeout: 20_000 }).toBeGreaterThan(INTRO_START + 3);
    expect(Math.abs(await position(guest) - await position(host))).toBeLessThan(2);
  } finally {
    await guest.evaluate(() => {
      localStorage.removeItem(`${window.ApiClient.getCurrentUserId()}-segmentTypeAction__Intro`);
    });
  }
});
