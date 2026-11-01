const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');
let contexts;
let host;
let guest;
let roomId;

test.beforeEach(async ({ browser }) => {
  contexts = [await browser.newContext(), await browser.newContext()];
  host = await contexts[0].newPage();
  guest = await contexts[1].newPage();
  await helpers.login(host, helpers.HOST_USER);
  await helpers.login(guest, helpers.GUEST_USER);
  await helpers.startPlayback(host, await helpers.findMovieId(host, 'Wing It!'));
  await helpers.waitForSettled(host);
  await helpers.openPanelFromOsd(host);
  await helpers.clickRoomBar(host, host.getByRole('switch', { name: 'Ask to join', exact: true }));
  await helpers.clickRoomBar(host, '#owp-btn-create');
  await helpers.waitInRoom(host, true);
  roomId = (await helpers.owpState(host)).roomId;
});

test.afterEach(async () => {
  try {
    await helpers.leaveIfInRoom(guest);
    await helpers.leaveIfInRoom(host);
  } finally {
    for (const context of contexts) await context.close();
  }
});

async function requestJoin() {
  await guest.goto('/#/home');
  const card = guest.locator(`.owp-room-card[data-room-id="${roomId}"]`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Ask to join' }).click();
  await expect(guest.locator('#owp-room-list')).toContainText('Waiting for');
  await expect(host.locator('#owp-request-card')).toContainText(helpers.GUEST_USER);
}

test('the host admits a guest who asks from the home card', async () => {
  await requestJoin();
  await helpers.clickRoomBar(host, host.locator('#owp-request-card').getByRole('button', { name: 'Let in' }));
  await helpers.waitInRoom(guest, true);
  await helpers.expectParticipants(host, 2);
  await helpers.expectParticipants(guest, 2);
});

test('rejected guests stay outside the room and see the outcome', async () => {
  await requestJoin();
  await helpers.clickRoomBar(host, host.locator('#owp-request-card').getByRole('button', { name: 'Reject' }));
  await expect(guest.locator('#owp-room-list')).toContainText("didn't let you in");
  expect((await helpers.owpState(guest)).inRoom).toBe(false);
});

test('unlisted rooms disappear from discovery but remain joinable by id without approval', async () => {
  await guest.goto('/#/home');
  await expect(guest.locator(`.owp-room-card[data-room-id="${roomId}"]`)).toBeVisible({ timeout: 30_000 });
  await helpers.clickRoomBar(host, '#owp-btn-people');
  await helpers.clickRoomBar(host, host.getByRole('switch', { name: 'Hide from the room list' }));
  await expect(guest.locator(`.owp-room-card[data-room-id="${roomId}"]`)).toHaveCount(0);
  await helpers.openPanelFromHeader(guest);
  await expect(guest.locator(`.owp-room-item button[data-room-id="${roomId}"]`)).toHaveCount(0);

  await helpers.clickRoomBar(host, host.getByRole('switch', { name: 'Ask to join', exact: true }));
  await expect(host.getByRole('switch', { name: 'Ask to join', exact: true })).toHaveAttribute('aria-checked', 'false');
  await guest.evaluate(id => window.OpenWatchParty.actions.joinRoom(id), roomId);
  await helpers.waitInRoom(guest, true);
  await helpers.expectParticipants(host, 2);
});
