const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

// The dev library has movies only, so the host queues them by hand: the
// automatic filling is for episodes and is covered by the client tests.
const FIRST = 'Wing It!';
const SECOND = 'Sprite Fright';

let hostContext;
let guestContext;
let host;
let guest;
let firstId;
let secondId;

test.beforeAll(async ({ browser }) => {
  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
  firstId = await helpers.findMovieId(host, FIRST);
  secondId = await helpers.findMovieId(host, SECOND);
});

test.afterAll(async () => {
  await hostContext?.close();
  await guestContext?.close();
});

test.beforeEach(async () => {
  await helpers.leaveIfInRoom(host);
  await helpers.leaveIfInRoom(guest);
});

const queueOf = page => page.evaluate(() => window.OpenWatchParty.state.queueItems.map(item => item.id));
const playingItem = page => page.evaluate(() => window.OpenWatchParty.utils.getPlayingItemId());
// Without credits marked, the host's client starts the countdown 15 seconds
// before the end, so the room moves on before Jellyfin closes the player.
const seekNearEnd = page => page.evaluate(() => {
  const video = document.querySelector('video');
  video.currentTime = video.duration - 14;
});

async function openQueuedRoom() {
  await helpers.startPlayback(host, firstId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  await helpers.joinRoomFromHeader(guest, room.roomId);
  await helpers.expectParticipants(guest, 2);
  await helpers.waitForSettled(guest);

  await host.evaluate(([first, second]) => {
    window.OpenWatchParty.actions.send('queue_add', {
      items: [{ id: first, title: 'First' }, { id: second, title: 'Second' }]
    });
  }, [firstId, secondId]);
  await expect.poll(() => queueOf(guest), { timeout: 10_000 }).toEqual([firstId, secondId]);
}

test('the host moves the room to the next item and the guest follows it from the start', async () => {
  await openQueuedRoom();
  await expect(guest.locator('#owp-btn-queue')).toHaveCount(1);

  await host.evaluate(id => window.OpenWatchParty.queue.advance(id), secondId);

  for (const page of [host, guest]) {
    await expect.poll(() => playingItem(page), { timeout: 60_000 }).toBe(secondId);
    await helpers.waitForPlaying(page);
    // From the start: not the seconds spent loading it.
    expect((await helpers.videoState(page)).time).toBeLessThan(2.5);
  }
  await expect
    .poll(async () => {
      const hostVideo = await helpers.videoState(host);
      const guestVideo = await helpers.videoState(guest);
      if (!hostVideo || !guestVideo) return 999;
      return Math.abs(hostVideo.time - guestVideo.time);
    }, { timeout: 20_000 })
    .toBeLessThan(3);
});

test('the up-next countdown moves the room to the next item before the end', async () => {
  await openQueuedRoom();

  await seekNearEnd(host);
  await expect(guest.locator('#owp-queue-next')).toContainText('Second');
  await expect(guest.locator('#owp-queue-next button')).toHaveCount(0);

  for (const page of [host, guest]) {
    await expect.poll(() => playingItem(page), { timeout: 60_000 }).toBe(secondId);
    await helpers.waitForPlaying(page);
  }
  expect((await helpers.owpState(guest)).inRoom).toBe(true);
});

test('a cancelled up-next countdown keeps the room on its item', async () => {
  await openQueuedRoom();

  await seekNearEnd(host);
  await expect(guest.locator('#owp-queue-next')).toContainText('Second');
  await host.locator('#owp-queue-next button', { hasText: 'Cancel' }).click();
  await expect(guest.locator('#owp-queue-next')).toHaveCount(0);

  // Back from the end, and past the 10-second countdown: still the first item.
  await host.evaluate(() => { document.querySelector('video').currentTime = 30; });
  await guest.waitForTimeout(11_000);
  expect(await playingItem(host)).toBe(firstId);
  expect(await playingItem(guest)).toBe(firstId);
});

test('a guest pause during the up-next countdown keeps the room on its item', async () => {
  await openQueuedRoom();

  // Five seconds before the countdown, so the guest has followed the seek
  // when it starts.
  await host.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = video.duration - 20;
  });
  await expect
    .poll(async () => {
      const hostVideo = await helpers.videoState(host);
      const guestVideo = await helpers.videoState(guest);
      return Math.abs(hostVideo.time - guestVideo.time);
    }, { timeout: 10_000 })
    .toBeLessThan(3);
  await helpers.waitForSettled(guest);
  await expect(guest.locator('#owp-queue-next')).toContainText('Second');
  // The host's page doesn't stop the countdown itself here, as when its own
  // cancel comes too late: the server ends it with the guest's pause.
  await host.evaluate(() => {
    const queue = window.OpenWatchParty.queue;
    queue.keptOnVideoTime = queue.onVideoTime;
    queue.onVideoTime = () => {};
  });
  try {
    await helpers.togglePlayback(guest);
    await expect(host.locator('.owp-toast-system', { hasText: 'A guest paused playback' })).toHaveCount(1);
    await helpers.waitForPaused(host);
    await expect(guest.locator('#owp-queue-next')).toHaveCount(0);

    // Past the 10-second countdown: still the first item, paused.
    await guest.waitForTimeout(11_000);
    expect(await playingItem(host)).toBe(firstId);
    expect(await playingItem(guest)).toBe(firstId);
    expect((await helpers.videoState(host)).paused).toBe(true);
  } finally {
    await host.evaluate(() => {
      const queue = window.OpenWatchParty.queue;
      queue.onVideoTime = queue.keptOnVideoTime;
    });
  }
});
