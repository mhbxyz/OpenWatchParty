const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

// The host's People section switches what guests may do; each test checks
// a guest can use what the host allowed, and only that.
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

const permissionsOf = page => page.evaluate(() => window.OpenWatchParty.state.roomPermissions);
const playingItem = page => page.evaluate(() => window.OpenWatchParty.utils.getPlayingItemId());

async function openRoom() {
  await helpers.startPlayback(host, firstId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  await helpers.joinRoomFromHeader(guest, room.roomId);
  await helpers.expectParticipants(guest, 2);
  await helpers.waitForSettled(guest);
}

async function openPeople(page) {
  await helpers.ensureRoomBarVisible(page);
  const button = page.locator('#owp-btn-people');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await helpers.clickRoomBar(page, button);
  await expect(page.locator('#owp-room-permissions')).toBeVisible();
}

async function switchPermission(key, on) {
  await openPeople(host);
  const toggle = host.locator(`#owp-room-permissions [data-permission="${key}"]`);
  await expect(toggle).toHaveAttribute('aria-checked', String(!on));
  await helpers.clickRoomBar(host, toggle);
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await expect.poll(async () => (await permissionsOf(guest))[key], { timeout: 10_000 }).toBe(on);
}

test('a guest seeks the room only while the host allows it', async () => {
  await openRoom();
  await openPeople(guest);
  await expect(guest.locator('#owp-room-permissions')).toContainText('What guests can do');
  await expect(guest.locator('html.owp-guest-locked')).toHaveCount(1);

  await switchPermission('seek', true);
  await expect(guest.locator('.owp-toast-system', { hasText: 'The host now lets guests seek' })).toHaveCount(1);
  await expect(guest.locator('html.owp-guest-locked')).toHaveCount(0);

  // The guest's own seek moves everyone, the host included. Just after
  // joining, a seek is taken for the client's own sync, as the host's are.
  await guest.waitForFunction(() => !window.OpenWatchParty.state.isSyncing);
  const target = (await helpers.videoState(host)).time + 60;
  await guest.evaluate((time) => { document.querySelector('video').currentTime = time; }, target);
  await expect
    .poll(async () => (await helpers.videoState(host)).time, { timeout: 15_000 })
    .toBeGreaterThan(target - 5);
  await helpers.waitForPlaying(host);
  await expect
    .poll(async () => (await helpers.videoState(guest)).time, { timeout: 15_000 })
    .toBeGreaterThan(target - 5);

  // Taken back: the lock returns and a guest's seek is pulled back to the room.
  await switchPermission('seek', false);
  await expect(guest.locator('html.owp-guest-locked')).toHaveCount(1);
  const room = (await helpers.videoState(host)).time;
  await guest.evaluate((time) => { document.querySelector('video').currentTime = time; }, room + 120);
  await guest.waitForTimeout(5_000);
  expect(Math.abs((await helpers.videoState(host)).time - room)).toBeLessThan(15);
  await expect
    .poll(async () => {
      const hostVideo = await helpers.videoState(host);
      const guestVideo = await helpers.videoState(guest);
      return Math.abs(hostVideo.time - guestVideo.time);
    }, { timeout: 20_000 })
    .toBeLessThan(3);
});

test('a guest allowed to change what is playing moves the room to the next item', async () => {
  await openRoom();
  await host.evaluate(([first, second]) => {
    window.OpenWatchParty.actions.send('queue_add', {
      items: [{ id: first, title: 'First' }, { id: second, title: 'Second' }]
    });
  }, [firstId, secondId]);
  await expect(guest.locator('#owp-btn-queue')).toHaveCount(1);

  await helpers.clickRoomBar(guest, '#owp-btn-queue');
  const section = guest.locator('#owp-queue-section');
  await expect(section.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await expect(section).toContainText('Only the host can change the queue.');

  await switchPermission('change_media', true);
  await helpers.clickRoomBar(guest, section.getByRole('button', { name: 'Next' }));

  for (const page of [host, guest]) {
    await expect.poll(() => playingItem(page), { timeout: 60_000 }).toBe(secondId);
    await helpers.waitForPlaying(page);
  }
  expect((await helpers.owpState(guest)).inRoom).toBe(true);
});
