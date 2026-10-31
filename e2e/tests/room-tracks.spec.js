const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

// "Wing It!" in the dev library has one English audio track and no
// subtitles; Jellyfin reports both to each member's own session.
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
  await hostContext?.close();
  await guestContext?.close();
});

const reportedTracks = page => page.evaluate(() => window.OpenWatchParty.state.participants
  .filter(participant => participant.tracks).length);

test('each person shows the audio and subtitles they play, behind an arrow', async () => {
  await helpers.startPlayback(host, await helpers.findMovieId(host, MOVIE));
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  await helpers.joinRoomFromHomeCard(guest, room.roomId);
  await helpers.expectParticipants(guest, 2);
  await expect.poll(() => reportedTracks(host), { timeout: 20_000 }).toBe(2);

  await helpers.clickRoomBar(host, '#owp-btn-people');
  const guestRow = host.locator('.owp-participant', { hasText: helpers.GUEST_USER });
  await expect(host.locator('.owp-tracks')).toHaveCount(0);
  const guestFold = guestRow.locator('.owp-tracks-fold');
  await helpers.clickRoomBar(host, guestFold);
  await expect(guestRow.locator('.owp-tracks-value')).toHaveText(['English', 'Off']);
  // The list redraws on the click; the focus stays on the arrow.
  await expect(guestFold).toBeFocused();

  // A press elsewhere in the panel closes it.
  const hostName = host.locator('.owp-participant', { hasText: helpers.HOST_USER }).locator('.owp-participant-name');
  await helpers.clickRoomBar(host, hostName);
  await expect(host.locator('.owp-tracks')).toHaveCount(0);

  await helpers.leaveIfInRoom(guest);
  await helpers.leaveIfInRoom(host);
});
