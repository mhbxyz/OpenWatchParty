const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test.describe.configure({ mode: 'serial' });

let context;
let host;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  host = await context.newPage();
  await helpers.login(host, helpers.HOST_USER);
  const movieId = await helpers.findMovieId(host, 'Sprite Fright');
  await helpers.startPlayback(host, movieId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  await helpers.waitForPlaying(host);
});

test.afterAll(async () => {
  await helpers.leaveIfInRoom(host);
  await context?.close();
});

const panel = () => host.locator('#owp-panel');
const controlsHidden = () => host.evaluate(() => Boolean(document.querySelector('.osdHeader.osdHeader-hidden')));

// The server ignores a playback command within 2 s of the previous one.
const afterCommand = () => host.waitForTimeout(2_200);

// Away from the panel and from the player's bottom controls.
const VIDEO_SPOT = { x: 400, y: 360 };

async function openPanel() {
  if (await panel().evaluate(element => element.classList.contains('hide'))) {
    await helpers.ensureRoomBarVisible(host);
  }
  await helpers.revealOsd(host);
  await expect(panel()).not.toHaveClass(/hide|owp-controls-hidden/);
}

test('the panel hides with the player controls and comes back as it was', async () => {
  await openPanel();
  await host.locator('#owp-btn-chat').click();
  await expect(host.locator('#owp-chat-input')).toBeVisible();
  await host.locator('#owp-chat-input').blur();

  await host.mouse.move(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await expect.poll(controlsHidden, { timeout: 15_000 }).toBe(true);
  await expect(panel()).toHaveClass(/owp-controls-hidden/);
  await expect.poll(() => panel().evaluate(element => getComputedStyle(element).opacity)).toBe('0');
  await expect(panel()).not.toHaveClass(/hide/);

  await host.mouse.move(VIDEO_SPOT.x + 30, VIDEO_SPOT.y + 30);
  await expect.poll(controlsHidden).toBe(false);
  await expect(panel()).not.toHaveClass(/owp-controls-hidden/);
  // The chat is still the open drop-down.
  await expect(host.locator('#owp-chat-input')).toBeVisible();
});

test('the panel hides with the controls even with the pointer resting on it', async () => {
  await openPanel();
  const box = await host.locator('.owp-room-bar').boundingBox();
  await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await expect.poll(controlsHidden, { timeout: 15_000 }).toBe(true);
  await expect(panel()).toHaveClass(/owp-controls-hidden/);
});

test('the panel stays while the host types in the chat', async () => {
  await openPanel();
  const input = host.locator('#owp-chat-input');
  if (!(await input.isVisible())) await host.locator('#owp-btn-chat').click();
  await input.click();
  await input.type('hello');
  await host.mouse.move(VIDEO_SPOT.x, VIDEO_SPOT.y);

  await expect.poll(controlsHidden, { timeout: 15_000 }).toBe(true);
  await expect(panel()).not.toHaveClass(/owp-controls-hidden/);
  await input.fill('');
  await input.blur();
  await expect(panel()).toHaveClass(/owp-controls-hidden/);
});

test('a click on the video closes the open panel without pausing the room', async () => {
  await openPanel();
  await helpers.waitForPlaying(host);

  await host.mouse.click(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await expect(panel()).toHaveClass(/hide/);
  // Past the player's 300 ms single-click delay.
  await host.waitForTimeout(800);
  expect(await helpers.isPlaying(host)).toBe(true);

  // With the panel closed, the same click is the player's play/pause again.
  await host.mouse.click(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await helpers.waitForPaused(host);
  await afterCommand();
  await helpers.togglePlayback(host);
  await helpers.waitForPlaying(host);
  await afterCommand();
});

test('a double click on the video closes the open panel without pausing or going full screen', async () => {
  await openPanel();
  await helpers.waitForPlaying(host);

  await host.mouse.dblclick(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await expect(panel()).toHaveClass(/hide/);
  await host.waitForTimeout(800);
  expect(await helpers.isPlaying(host)).toBe(true);
  expect(await host.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  // Past the gesture, the next press is the player's again.
  await host.waitForTimeout(500);
});

test('a slow double click, as with a longer system setting, does not pause either', async () => {
  await openPanel();
  await helpers.waitForPlaying(host);

  await host.mouse.move(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await host.mouse.down({ clickCount: 1 });
  await host.mouse.up({ clickCount: 1 });
  await expect(panel()).toHaveClass(/hide/);
  await host.waitForTimeout(1000);
  await host.mouse.down({ clickCount: 2 });
  await host.mouse.up({ clickCount: 2 });
  await host.waitForTimeout(800);
  expect(await helpers.isPlaying(host)).toBe(true);
  expect(await host.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  // A new single click afterwards is the player's play/pause again.
  await host.mouse.click(VIDEO_SPOT.x, VIDEO_SPOT.y);
  await helpers.waitForPaused(host);
  await afterCommand();
  await helpers.togglePlayback(host);
  await helpers.waitForPlaying(host);
  await afterCommand();
});

test('a click on the player controls closes the panel and still works', async () => {
  await openPanel();
  await helpers.waitForPlaying(host);
  await host.locator('.videoOsdBottom .btnPause:not(.hide)').first().click();

  await expect(panel()).toHaveClass(/hide/);
  await helpers.waitForPaused(host);
  await afterCommand();
  await helpers.togglePlayback(host);
  await helpers.waitForPlaying(host);
});
