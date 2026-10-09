const { expect } = require('@playwright/test');

const PASSWORD = process.env.OWP_DEV_PASSWORD || 'owp-dev-test';
const HOST_USER = 'testhost';
const GUEST_USER = 'testclient1';

async function login(page, username) {
  await page.goto('/#/login');
  await page.locator('#txtManualName').waitFor({ state: 'visible' });
  await page.fill('#txtManualName', username);
  await page.fill('#txtManualPassword', PASSWORD);
  await page.locator('#txtManualPassword').press('Enter');
  await page.waitForURL(/#\/home/);
  await waitForClient(page);
}

async function waitForClient(page) {
  await expect
    .poll(() => page.evaluate(() => {
      const state = window.OpenWatchParty && window.OpenWatchParty.state;
      return state && state.ws ? state.ws.readyState : 0;
    }), { timeout: 30_000 })
    .toBe(1);
}

async function findMovieId(page, name) {
  const id = await page.evaluate(async (movieName) => {
    const api = window.ApiClient;
    const result = await api.getItems(api.getCurrentUserId(), {
      searchTerm: movieName,
      includeItemTypes: 'Movie',
      recursive: true,
    });
    const match = (result.Items || []).find((item) => item.Name === movieName);
    return match ? match.Id : null;
  }, name);
  if (!id) throw new Error(`Movie not found in the dev library: ${name}`);
  return id;
}

async function owpState(page) {
  return page.evaluate(() => {
    const state = window.OpenWatchParty.state;
    return {
      inRoom: state.inRoom,
      roomId: state.roomId,
      roomName: state.roomName,
      isHost: state.isHost,
      participants: state.participants,
      syncStatus: state.syncStatus,
      wsState: state.ws ? state.ws.readyState : 0,
    };
  });
}

async function waitInRoom(page, expected = true) {
  await expect.poll(async () => (await owpState(page)).inRoom, { timeout: 30_000 }).toBe(expected);
}

async function videoState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    return video
      ? { paused: video.paused, time: video.currentTime, readyState: video.readyState }
      : null;
  });
}

async function waitForPlaying(page) {
  await expect
    .poll(async () => {
      const video = await videoState(page);
      return Boolean(video && !video.paused && video.readyState >= 2);
    }, { timeout: 30_000 })
    .toBe(true);
}

async function waitForPaused(page) {
  await expect
    .poll(async () => Boolean((await videoState(page))?.paused), { timeout: 15_000 })
    .toBe(true);
}

// OWP ignores the player's own events while it moves the video itself, as in
// the initial sync after joining: wait until a user's play or pause counts.
async function waitForSettled(page) {
  await expect
    .poll(() => page.evaluate(() => {
      const owp = window.OpenWatchParty;
      return !owp.state.isInitialSync && owp.utils.shouldSend();
    }), { timeout: 30_000 })
    .toBe(true);
}

async function isPlaying(page) {
  const video = await videoState(page);
  return Boolean(video && !video.paused);
}

async function startPlayback(page, itemId) {
  await page.goto(`/#/details?id=${itemId}`);
  const playButton = page.locator('.mainDetailButtons .btnPlay').first();
  await playButton.waitFor({ state: 'visible' });
  await playButton.click();
  await waitForPlaying(page);
}

async function togglePlayback(page) {
  await page.evaluate(() => {
    const button = document.querySelector('.videoOsdBottom .btnPause, .videoOsdBottom .btnPlay')
      || document.querySelector('.btnPause, .btnPlay');
    if (button) button.click();
  });
}

async function revealOsd(page) {
  const size = page.viewportSize();
  await page.mouse.move(size.width / 2, size.height / 2);
  await page.locator('#owp-osd-btn').waitFor({ state: 'visible', timeout: 10_000 });
}

async function panelHidden(page) {
  return page.locator('#owp-panel').evaluate((panel) => panel.classList.contains('hide'));
}

async function openPanelFromOsd(page) {
  await revealOsd(page);
  await page.locator('#owp-osd-btn').click();
  await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
}

async function openPanelFromHeader(page) {
  const modern = page.locator('#owp-header-btn-modern');
  const legacy = page.locator('#owp-header-btn-legacy');
  await expect
    .poll(async () => (await modern.isVisible().catch(() => false)) || (await legacy.isVisible().catch(() => false)), { timeout: 15_000 })
    .toBe(true);
  const button = (await modern.isVisible().catch(() => false)) ? modern : legacy;
  await button.click();
  await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
}

async function ensureRoomBarVisible(page) {
  if (await panelHidden(page)) {
    const osd = page.locator('#owp-osd-btn');
    if (await osd.isVisible().catch(() => false)) {
      await osd.click();
    } else {
      await openPanelFromHeader(page);
    }
    await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
  }
}

async function createRoom(page) {
  await openPanelFromOsd(page);
  await page.locator('#owp-btn-create').click();
  await waitInRoom(page, true);
}

async function joinRoomFromHeader(page, roomName) {
  await page.goto('/#/home');
  await openPanelFromHeader(page);
  const row = page.locator('.owp-room-item', { hasText: roomName }).first();
  await row.locator('.owp-btn').click();
  await waitForPlaying(page);
  await waitInRoom(page, true);
}

async function joinRoomFromHomeCard(page, roomId) {
  await page.goto('/#/home');
  const card = page.locator(`.owp-room-card[data-room-id="${roomId}"]`).first();
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.locator('.owp-join-btn').click();
  await waitForPlaying(page);
  await waitInRoom(page, true);
}

async function leaveRoom(page) {
  await ensureRoomBarVisible(page);
  await page.locator('#owp-btn-leave').click();
  await page.locator('#owp-btn-confirm-leave').click();
  await waitInRoom(page, false);
}

async function leaveIfInRoom(page) {
  try {
    if ((await owpState(page)).inRoom) await leaveRoom(page);
  } catch {
    // The page may be mid-navigation; the caller's assertions will surface any real problem.
  }
}

async function expectParticipants(page, count) {
  await expect.poll(async () => (await owpState(page)).participants.length, { timeout: 20_000 }).toBe(count);
}

module.exports = {
  PASSWORD,
  HOST_USER,
  GUEST_USER,
  login,
  waitForClient,
  findMovieId,
  owpState,
  waitInRoom,
  videoState,
  waitForPlaying,
  waitForPaused,
  waitForSettled,
  isPlaying,
  startPlayback,
  togglePlayback,
  revealOsd,
  openPanelFromOsd,
  openPanelFromHeader,
  ensureRoomBarVisible,
  createRoom,
  joinRoomFromHeader,
  joinRoomFromHomeCard,
  leaveRoom,
  leaveIfInRoom,
  expectParticipants,
};
