const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

const MOVIE = 'Wing It!';

let hostContext;
let guestContext;
let host;
let guest;

test.beforeAll(async ({ browser }) => {
  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
});

test.afterAll(async () => {
  await helpers.leaveIfInRoom(guest);
  await helpers.leaveIfInRoom(host);
  await hostContext?.close();
  await guestContext?.close();
});

// The server ignores a playback command within 2 s of the previous one.
const afterCommand = () => host.waitForTimeout(2_200);

// The label in the room bar, or on its own while the panel is closed.
const startLabel = page => page.locator('.owp-start-label').first();

const serverLines = page => page.evaluate(() => window.OpenWatchParty.chat.messages
  .filter(message => message.system)
  .map(message => ({ text: message.text, error: message.isError })));

// When each page's video started playing for good, from now on: the host's
// own click plays for a moment before the room holds it for the countdown.
async function watchPlaying(page) {
  await page.evaluate(() => {
    window.__playingAt = [];
    window.__watchFrom = performance.now();
    const video = window.OpenWatchParty.utils.getVideo();
    video.addEventListener('playing', () => window.__playingAt.push(performance.now() - window.__watchFrom));
  });
}
const startedAfter = page => page.evaluate(() => window.__playingAt.at(-1));

// The guest says it isn't ready (as a client does while it buffers), or is again.
const guestReadiness = (payload) => guest.evaluate(p => window.OpenWatchParty.actions.send('readiness', p), payload);

async function guestReadyToPlay() {
  await expect
    .poll(() => guest.evaluate(() => {
      const video = window.OpenWatchParty.utils.getVideo();
      return Boolean(video && video.readyState >= 2 && !video.seeking);
    }), { timeout: 30_000 })
    .toBe(true);
}

test('the first play of a room created paused counts down for everyone, then both start together', async () => {
  const movieId = await helpers.findMovieId(host, MOVIE);
  await helpers.startPlayback(host, movieId);
  await helpers.waitForSettled(host);
  await helpers.togglePlayback(host);
  await helpers.waitForPaused(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);

  // By id: rooms other specs left open have the same name.
  await guest.goto('/#/home');
  await helpers.openPanelFromHeader(guest);
  await guest.locator(`.owp-room-item .owp-btn[data-room-id="${room.roomId}"]`).click();
  await helpers.waitInRoom(guest, true);
  await helpers.expectParticipants(host, 2);
  await helpers.waitForSettled(guest);
  // The guest's player starts the movie; the room's paused state stops it.
  await helpers.waitForPaused(guest);
  await guestReadyToPlay();

  await watchPlaying(host);
  await watchPlaying(guest);
  await helpers.togglePlayback(host);

  for (const page of [host, guest]) {
    await expect(startLabel(page)).toContainText(/Starting in [1-3]/);
  }
  await helpers.waitForPlaying(host);
  await helpers.waitForPlaying(guest);
  const [hostStart, guestStart] = [await startedAfter(host), await startedAfter(guest)];
  // Three seconds of countdown, then both at once.
  expect(hostStart).toBeGreaterThan(2_400);
  expect(guestStart).toBeGreaterThan(2_400);
  expect(Math.abs(hostStart - guestStart)).toBeLessThan(800);
  await expect(startLabel(host)).toHaveCount(0);
  await afterCommand();
});

test('a later play waits for a guest that is not ready, says why, and starts when it is', async () => {
  await helpers.togglePlayback(host);
  await helpers.waitForPaused(host);
  await helpers.waitForPaused(guest);
  await afterCommand();
  await guestReady();
  await guestReadiness({ ready: false, reason: 'buffering' });

  await helpers.togglePlayback(host);
  await expect(startLabel(host)).toContainText(`Waiting for ${helpers.GUEST_USER}`);
  // Longer than the old 2 s wait, and the host's video waits too.
  await host.waitForTimeout(3_000);
  expect(await helpers.isPlaying(host)).toBe(false);
  expect(await helpers.isPlaying(guest)).toBe(false);
  expect(await serverLines(host)).toContainEqual({ text: `Waiting for ${helpers.GUEST_USER}: filling the buffer`, error: false });

  await watchPlaying(host);
  await watchPlaying(guest);
  await guestReadiness({ ready: true });
  await helpers.waitForPlaying(host);
  await helpers.waitForPlaying(guest);
  // No countdown this time: the item had started.
  expect(await startedAfter(host)).toBeLessThan(2_400);
  expect(Math.abs((await startedAfter(host)) - (await startedAfter(guest)))).toBeLessThan(800);
  await expect
    .poll(() => serverLines(host), { timeout: 5_000 })
    .toContainEqual({ text: expect.stringMatching(new RegExp(`^${helpers.GUEST_USER} is ready \\(\\d+ s\\)$`)), error: false });
  expect((await serverLines(host)).some(line => line.error)).toBe(false);
  await afterCommand();
});

test('selecting the waiting label starts without the guest, and says so as an error', async () => {
  await helpers.togglePlayback(host);
  await helpers.waitForPaused(host);
  await helpers.waitForPaused(guest);
  await afterCommand();
  await guestReadiness({ ready: false, reason: 'loading' });

  await helpers.togglePlayback(host);
  await expect(startLabel(host)).toContainText(`Waiting for ${helpers.GUEST_USER}`);
  await helpers.ensureRoomBarVisible(host);
  await startLabel(host).click();

  await helpers.waitForPlaying(host);
  await helpers.waitForPlaying(guest);
  await expect
    .poll(() => serverLines(host), { timeout: 5_000 })
    .toContainEqual({ text: `Started without ${helpers.GUEST_USER} (still loading)`, error: true });
  await guestReadiness({ ready: true });
  await afterCommand();
});

// The guest's own readiness, as its client reports it: ready again.
async function guestReady() {
  await guestReadyToPlay();
  await guestReadiness({ ready: true });
}
