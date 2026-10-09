const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

const MOVIE = 'Wing It!';

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

async function ensureHostPlaying() {
  if (!(await helpers.isPlaying(host))) {
    await helpers.startPlayback(host, movieId);
  }
}

async function openRoomWithGuest(joinMethod) {
  await ensureHostPlaying();
  await helpers.createRoom(host);
  const room = await helpers.owpState(host);
  expect(room.roomName).toContain(helpers.HOST_USER);

  if (joinMethod === 'card') {
    await helpers.joinRoomFromHomeCard(guest, room.roomId);
  } else {
    await helpers.joinRoomFromHeader(guest, room.roomName);
  }

  await helpers.expectParticipants(guest, 2);
  const guestState = await helpers.owpState(guest);
  expect(guestState.roomId).toBe(room.roomId);
  expect(guestState.isHost).toBe(false);
  return room;
}

test('host creates a room and the guest joins from the home card', async () => {
  await openRoomWithGuest('card');
});

test('the guest joins from the header button', async () => {
  await openRoomWithGuest('header');
});

test('pause, play and seek propagate to the guest', async () => {
  await openRoomWithGuest('header');

  await helpers.togglePlayback(host);
  await helpers.waitForPaused(guest);

  await helpers.togglePlayback(host);
  await helpers.waitForPlaying(guest);

  await host.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime += 30;
  });
  await expect
    .poll(async () => {
      const hostVideo = await helpers.videoState(host);
      const guestVideo = await helpers.videoState(guest);
      if (!hostVideo || !guestVideo) return 999;
      return Math.abs(hostVideo.time - guestVideo.time);
    }, { timeout: 20_000 })
    .toBeLessThan(3);
});

test('a guest pause pauses the host, and the host play resumes the guest', async () => {
  await openRoomWithGuest('header');
  await helpers.waitForSettled(guest);

  await helpers.togglePlayback(guest);
  await helpers.waitForPaused(host);
  await expect(host.locator('.owp-toast-system', { hasText: 'A guest paused playback' })).toHaveCount(1);

  await helpers.togglePlayback(host);
  await helpers.waitForPlaying(guest);
});

test('a guest play resumes the paused room', async () => {
  await openRoomWithGuest('header');

  await helpers.togglePlayback(host);
  await helpers.waitForPaused(guest);
  await helpers.waitForSettled(guest);

  await helpers.togglePlayback(guest);
  await helpers.waitForPlaying(host);
  await expect(host.locator('.owp-toast-system', { hasText: 'A guest resumed playback' })).toHaveCount(1);
});

test('the host leaving closes the room for the guest', async () => {
  await openRoomWithGuest('header');

  await helpers.leaveRoom(host);
  await helpers.waitInRoom(guest, false);
});

test('the guest leaving keeps the room open for the host', async () => {
  await openRoomWithGuest('header');

  await helpers.leaveRoom(guest);
  await helpers.waitInRoom(guest, false);
  expect((await helpers.owpState(host)).inRoom).toBe(true);
  await helpers.expectParticipants(host, 1);
});

test('the guest reconnects and rejoins the room', async () => {
  await openRoomWithGuest('header');

  await guest.evaluate(() => window.OpenWatchParty.state.ws.close());

  await expect
    .poll(async () => (await helpers.owpState(guest)).wsState, { timeout: 30_000 })
    .toBe(1);
  await helpers.waitInRoom(guest, true);
  await helpers.expectParticipants(guest, 2);
});

test('the home card disappears when the host closes the room', async () => {
  const room = await openRoomWithGuest('card');

  await guest.goto('/#/home');
  await expect(guest.locator(`.owp-room-card[data-room-id="${room.roomId}"]`)).toHaveCount(1);

  await helpers.leaveRoom(host);
  await helpers.waitInRoom(guest, false);

  await expect(guest.locator(`.owp-room-card[data-room-id="${room.roomId}"]`)).toHaveCount(0, {
    timeout: 30_000,
  });
});
