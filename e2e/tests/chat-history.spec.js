const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

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

const chatTexts = page => page.evaluate(() => window.OpenWatchParty.chat.messages.map(message => message.text));

test('a guest who joins later sees the room\'s earlier messages, none unread', async () => {
  const movieId = await helpers.findMovieId(host, 'Wing It!');
  await helpers.startPlayback(host, movieId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  for (const text of ['first one', 'second one']) {
    await host.evaluate(value => window.OpenWatchParty.chat.send(value), text);
  }
  await expect.poll(() => chatTexts(host)).toEqual(['first one', 'second one']);

  // By id: rooms other specs left open have the same name.
  await guest.goto('/#/home');
  await helpers.openPanelFromHeader(guest);
  await guest.locator(`.owp-room-item .owp-btn[data-room-id="${room.roomId}"]`).click();
  await helpers.waitInRoom(guest, true);

  await expect.poll(() => chatTexts(guest)).toEqual(['first one', 'second one']);
  expect(await guest.evaluate(() => window.OpenWatchParty.chat.unreadCount)).toBe(0);
  await helpers.ensureRoomBarVisible(guest);
  await guest.locator('#owp-btn-chat').click();
  await expect(guest.locator('#owp-chat-messages .owp-chat-message')).toHaveCount(2);

  // New messages arrive after the earlier ones.
  await host.evaluate(() => window.OpenWatchParty.chat.send('third one'));
  await expect.poll(() => chatTexts(guest)).toEqual(['first one', 'second one', 'third one']);
});
