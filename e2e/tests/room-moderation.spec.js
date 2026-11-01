const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

let hostContext;
let guestContext;
let host;
let guest;
let movieId;

test.beforeAll(async ({ browser }) => {
  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
  movieId = await helpers.findMovieId(host, 'Wing It!');
});

test.afterAll(async () => {
  await hostContext?.close();
  await guestContext?.close();
});

test.beforeEach(async () => {
  await helpers.leaveIfInRoom(host);
  await helpers.leaveIfInRoom(guest);
  if (!(await helpers.isPlaying(host))) await helpers.startPlayback(host, movieId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  await helpers.joinRoomFromHomeCard(guest, room.roomId);
  await helpers.expectParticipants(host, 2);
  await helpers.expectParticipants(guest, 2);
  const people = host.locator('#owp-btn-people');
  if ((await people.getAttribute('aria-expanded')) !== 'true') await helpers.clickRoomBar(host, people);
  await helpers.clickRoomBar(host, host.getByRole('switch', { name: 'Ask to join', exact: true }));
  await expect(host.getByRole('switch', { name: 'Ask to join', exact: true })).toHaveAttribute('aria-checked', 'true');
});

async function moderateGuest(action) {
  await helpers.ensureRoomBarVisible(host);
  const people = host.locator('#owp-btn-people');
  if ((await people.getAttribute('aria-expanded')) !== 'true') await helpers.clickRoomBar(host, people);
  const row = host.locator('.owp-participant', { hasText: helpers.GUEST_USER });
  await helpers.clickRoomBar(host, row.locator('.owp-mod-more'));
  await helpers.clickRoomBar(host, row.locator(action));
}

test('a removed guest can rejoin an approval room using their previous admission', async () => {
  const room = await helpers.owpState(host);
  await moderateGuest('.owp-mod-remove');

  // The host's notice is short, the removed guest's stays 6 s.
  await expect(host.locator('.owp-toast-system', { hasText: `${helpers.GUEST_USER} was removed from the room` })).toBeVisible();
  await helpers.waitInRoom(guest, false);
  await expect(guest.locator('.owp-toast-system', { hasText: 'The host removed you from the room' })).toBeVisible();
  await helpers.expectParticipants(host, 1);

  await helpers.joinRoomFromHeader(guest, room.roomId);
  await helpers.expectParticipants(host, 2);
  await helpers.expectParticipants(guest, 2);
});

test('a blocked guest cannot reuse an admission or request approval again', async () => {
  const room = await helpers.owpState(host);
  await moderateGuest('.owp-mod-block');

  // The host's notice is short, the removed guest's stays 6 s.
  await expect(host.locator('.owp-toast-system', { hasText: `${helpers.GUEST_USER} was blocked from this room` })).toBeVisible();
  await helpers.waitInRoom(guest, false);
  await expect(guest.locator('.owp-toast-system', { hasText: 'The host removed you from the room and blocked you from rejoining' })).toBeVisible();
  await helpers.expectParticipants(host, 1);

  await guest.goto('/#/home');
  await helpers.openPanelFromHeader(guest);
  await expect.poll(() => guest.evaluate(id =>
    window.OpenWatchParty.state.rooms.some(candidate => candidate.id === id), room.roomId)).toBe(false);
  await expect(guest.locator(`.owp-room-item button[data-room-id="${room.roomId}"]`)).toHaveCount(0);

  await guest.evaluate(id => window.OpenWatchParty.actions.joinRoom(id), room.roomId);
  await expect.poll(async () => {
    const state = await helpers.owpState(guest);
    return { inRoom: state.inRoom, roomId: state.roomId };
  }).toEqual({ inRoom: false, roomId: '' });
  await expect(guest.locator('.owp-toast-system', { hasText: 'The host blocked you from this room' })).toBeVisible();
  expect(await guest.evaluate(() => window.OpenWatchParty.state.pendingJoin)).toBeNull();
  expect(await host.evaluate(() => window.OpenWatchParty.state.joinRequests)).toEqual([]);
});
