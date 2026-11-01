const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

const CURRENT = 'Wing It!';

let hostContext;
let guestContext;
let host;
let guest;
let currentId;

test.beforeAll(async ({ browser }) => {
  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
  currentId = await helpers.findMovieId(host, CURRENT);
});

test.afterAll(async () => {
  await hostContext?.close();
  await guestContext?.close();
});

test.beforeEach(async () => {
  await helpers.leaveIfInRoom(host);
  await helpers.leaveIfInRoom(guest);
  await helpers.startPlayback(host, currentId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  // By id: rooms from earlier tests can still carry the same name.
  await helpers.joinRoomFromHomeCard(guest, room.roomId);
  await helpers.expectParticipants(host, 2);
  await helpers.expectParticipants(guest, 2);
  await helpers.waitForSettled(guest);
});

async function openQueue(page) {
  await helpers.ensureRoomBarVisible(page);
  const button = page.locator('#owp-btn-queue');
  await button.waitFor({ state: 'visible' });
  const section = page.locator('#owp-queue-section');
  if (!await section.isVisible()) await helpers.clickRoomBar(page, button);
  await expect(section).toBeVisible();
}

async function search(page, text) {
  await openQueue(page);
  await helpers.clickRoomBar(page, '#owp-queue-add');
  const input = page.locator('.owp-queue-search-box input');
  await input.fill(text);
  await expect(page.locator('.owp-queue-result').first()).toBeVisible({ timeout: 15_000 });
}

const queueTitles = page => page.locator('#owp-queue-section .owp-queue-list .owp-queue-name');

test('the host searches the library and adds a movie after the room item', async () => {
  await search(host, 'Sprite');
  const result = host.locator('.owp-queue-result', { hasText: 'Sprite Fright' });
  await helpers.clickRoomBar(host, result.getByRole('button', { name: 'Add' }));
  await helpers.clickRoomBar(host, host.getByRole('button', { name: 'Close search' }));

  for (const page of [host, guest]) {
    await openQueue(page);
    await expect(queueTitles(page)).toHaveText([CURRENT, 'Sprite Fright'], { timeout: 15_000 });
  }
});

test('a guest suggests a series episode and the host accepts it', async () => {
  await search(guest, 'OWP Test Show');
  const result = guest.locator('.owp-queue-result', {
    hasText: 'OWP Test Show',
    has: guest.locator('.owp-queue-sub', { hasText: /^Series/ })
  }).first();
  await helpers.clickRoomBar(guest, result.getByRole('button', { name: 'Suggest' }));
  await helpers.clickRoomBar(guest, guest.getByRole('button', { name: 'Close search' }));

  await expect(host.locator('.owp-toast-system', { hasText: /suggested “/ })).toBeVisible({ timeout: 15_000 });
  await expect(host.locator('#owp-btn-queue .owp-queue-badge')).toHaveText('1');
  await openQueue(host);
  const suggestion = host.locator('.owp-queue-suggestion', { hasText: 'OWP Test Show' });
  await helpers.clickRoomBar(host, suggestion.getByRole('button', { name: 'Add to the queue' }));

  for (const page of [host, guest]) {
    await openQueue(page);
    await expect(queueTitles(page)).toHaveCount(2, { timeout: 15_000 });
    await expect(queueTitles(page).nth(1)).toContainText('OWP Test Show');
    await expect(page.locator('.owp-queue-suggestion')).toHaveCount(0);
  }
});

test('accepting a suggestion replaces guest metadata with the host library item', async () => {
  const id = await helpers.findMovieId(guest, 'Sprite Fright');
  await guest.evaluate(itemId => window.OpenWatchParty.queue.suggest({
    id: itemId, title: 'Guest supplied title', series: 'f'.repeat(32)
  }), id);
  await openQueue(host);
  const suggestion = host.locator('.owp-queue-suggestion', { hasText: 'Guest supplied title' });
  await expect(suggestion).toBeVisible();
  await helpers.clickRoomBar(host, suggestion.getByRole('button', { name: 'Add to the queue' }));

  for (const page of [host, guest]) {
    await openQueue(page);
    await expect(queueTitles(page)).toHaveText([CURRENT, 'Sprite Fright']);
    const queued = await page.evaluate(itemId => window.OpenWatchParty.state.queueItems.find(item => item.id === itemId), id);
    expect(queued.series).toBeUndefined();
    await expect(page.locator('.owp-queue-suggestion')).toHaveCount(0);
  }
});

test('a guest withdraws one suggestion and the host dismisses another', async () => {
  await search(guest, 'Sprite');
  await helpers.clickRoomBar(guest, guest.locator('.owp-queue-result', { hasText: 'Sprite Fright' }).getByRole('button', { name: 'Suggest' }));
  await helpers.clickRoomBar(guest, guest.getByRole('button', { name: 'Close search' }));
  await expect(guest.locator('.owp-queue-suggestion', { hasText: 'Sprite Fright' })).toBeVisible();
  await helpers.clickRoomBar(guest, guest.locator('.owp-queue-suggestion', { hasText: 'Sprite Fright' })
    .getByRole('button', { name: 'Withdraw my suggestion' }));
  await expect(guest.locator('.owp-queue-suggestion')).toHaveCount(0);

  await search(guest, 'OWP Ready Lab');
  await helpers.clickRoomBar(guest, guest.locator('.owp-queue-result', { hasText: 'OWP Ready Lab' }).first()
    .getByRole('button', { name: 'Suggest' }));
  await helpers.clickRoomBar(guest, guest.getByRole('button', { name: 'Close search' }));
  await openQueue(host);
  const suggestion = host.locator('.owp-queue-suggestion', { hasText: 'OWP Ready Lab' });
  await helpers.clickRoomBar(host, suggestion.getByRole('button', { name: 'Dismiss' }));
  await expect(host.locator('.owp-queue-suggestion')).toHaveCount(0);
  await expect(guest.locator('.owp-queue-suggestion')).toHaveCount(0);
});
