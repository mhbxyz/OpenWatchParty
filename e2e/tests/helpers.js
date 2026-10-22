const { expect } = require('@playwright/test');

const PASSWORD = process.env.OWP_DEV_PASSWORD || 'owp-dev-test';
const HOST_USER = 'testhost';
const GUEST_USER = 'testclient1';
const THIRD_USER = 'testclient2';

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
      clientId: state.clientId,
      roomHostId: state.roomHostId,
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

// Sync can settle before the 2-second UI tick binds the new video. Wait for
// that video's listeners too, so the tested user action actually reaches OWP.
async function waitForSettled(page) {
  await expect
    .poll(() => page.evaluate(() => {
      const owp = window.OpenWatchParty;
      const video = owp.utils.getVideo();
      return Boolean(video
        && owp.state.bound
        && owp.state.currentVideoElement === video
        && typeof owp.state.videoListeners?.pause === 'function'
        && !owp.state.isInitialSync
        && owp.utils.shouldSend());
    }), { timeout: 30_000 })
    .toBe(true);
}

async function isPlaying(page) {
  const video = await videoState(page);
  return Boolean(video && !video.paused);
}

async function startPlayback(page, itemId) {
  await page.goto(`/#/details?id=${itemId}`);
  // Jellyfin retains hidden pages; wait for this item's active details controls.
  const details = page.locator('.page:not(.hide)').filter({
    has: page.locator(`.mainDetailButtons [data-id="${itemId}"]`),
  });
  const playButton = details.locator('.mainDetailButtons .btnPlay:not(.hide)').first();
  await playButton.waitFor({ state: 'visible' });
  await playButton.click();
  await waitForPlaying(page);
}

async function togglePlayback(page) {
  await page.evaluate(() => {
    // A cached player's button must not receive the action intended for this video.
    const button = [...document.querySelectorAll('.videoOsdBottom .btnPause:not(.hide), .videoOsdBottom .btnPlay:not(.hide)')]
      .find(control => !control.closest('.page.hide'));
    if (!button) throw new Error('The active player control is not available');
    button.click();
  });
}

async function revealOsd(page) {
  await page.bringToFront();
  const size = page.viewportSize();
  await page.mouse.move(size.width / 2 - 20, size.height / 2 - 20);
  await page.mouse.move(size.width / 2, size.height / 2);
  await visibleHeaderButton(page);
}

async function panelHidden(page) {
  return page.locator('#owp-panel').evaluate((panel) => panel.classList.contains('hide'));
}

// The header button: in the app bar, or in the player's own header.
async function visibleHeaderButton(page) {
  const modern = page.locator('#owp-header-btn-modern');
  const legacy = page.locator('#owp-header-btn-legacy');
  await expect
    .poll(async () => (await modern.isVisible().catch(() => false)) || (await legacy.isVisible().catch(() => false)), { timeout: 15_000 })
    .toBe(true);
  return (await modern.isVisible().catch(() => false)) ? modern : legacy;
}

async function openPanelFromOsd(page) {
  await revealOsd(page);
  await (await visibleHeaderButton(page)).click();
  await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
}

async function openPanelFromHeader(page) {
  await (await visibleHeaderButton(page)).click();
  await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
}

async function ensureRoomBarVisible(page) {
  if (await panelHidden(page)) {
    // During playback the app header is hidden and the OSD auto-hides.
    // Reveal the player controls before choosing that entry point.
    if (await page.evaluate(() => Boolean(window.OpenWatchParty.utils.getVideo()))) {
      await revealOsd(page);
      await (await visibleHeaderButton(page)).click();
    } else {
      await openPanelFromHeader(page);
    }
    await expect(page.locator('#owp-panel')).not.toHaveClass(/hide/);
  }
  // Over the player the open panel fades out with the player's controls,
  // and a click on it would not get through: bring the controls back first.
  if (await page.locator('#owp-panel').evaluate(panel => panel.classList.contains('owp-controls-hidden'))) {
    await revealOsd(page);
  }
  await expect(page.locator('#owp-panel')).not.toHaveClass(/owp-controls-hidden/);
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

// Unlike leaveRoom's existing host behavior (Close for everyone), this
// clicks the host's separate Leave action and preserves the room for guests.
async function leaveRoomKeepingRoom(page) {
  await ensureRoomBarVisible(page);
  await page.locator('#owp-btn-leave').click();
  await page.locator('#owp-btn-leave-room').click();
  await waitInRoom(page, false);
}

async function expectParticipants(page, count) {
  await expect.poll(async () => (await owpState(page)).participants.length, { timeout: 20_000 }).toBe(count);
}

module.exports = {
  PASSWORD,
  HOST_USER,
  GUEST_USER,
  THIRD_USER,
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
  leaveRoomKeepingRoom,
  leaveIfInRoom,
  expectParticipants,
};
