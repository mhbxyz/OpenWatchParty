// Record two real Jellyfin Web sessions for the project landing page.
// Run with the demo stack available: node e2e/capture-site-demo.js
const { chromium } = require('playwright');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const h = require('./tests/helpers');

const output = path.resolve(__dirname, '../docs/public/assets/video');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewport = { width: 1280, height: 800 };

async function recordPage(context, page, name, directory, start) {
  const session = await context.newCDPSession(page);
  const frames = [];
  const pending = [];
  await session.send('Page.enable');
  session.on('Page.screencastFrame', event => {
    const at = (performance.now() - start) / 1000;
    const filename = path.join(directory, `${name}-${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ at, filename });
    pending.push(fs.writeFile(filename, Buffer.from(event.data, 'base64')));
    session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  return async duration => {
    await session.send('Page.stopScreencast');
    await Promise.all(pending);
    if (frames.length < 10) throw new Error(`${name}: not enough browser frames`);
    const manifest = [];
    frames.forEach((frame, index) => {
      const next = frames[index + 1]?.at ?? duration;
      const from = index === 0 ? 0 : frame.at;
      manifest.push(`file '${frame.filename}'`, `duration ${Math.max(.001, next - from).toFixed(6)}`);
    });
    manifest.push(`file '${frames.at(-1).filename}'`);
    const list = path.join(directory, `${name}.txt`);
    await fs.writeFile(list, manifest.join('\n'));
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-t', duration.toFixed(3), '-vf', 'fps=25,scale=1024:640', '-c:v', 'libx264', '-preset', 'slow', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(output, `${name}.mp4`)], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
    console.log(`${name}: ${frames.length} real browser frames`);
  };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'owp-browser-recording-'));
  const browser = await chromium.launch({
    executablePath: process.env.OWP_BROWSER_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-dev-shm-usage',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  let host;
  let guest;
  try {
    const options = { baseURL: process.env.OWP_WEB_URL || 'http://localhost:8096/web/', viewport, locale: 'en-US' };
    const hostContext = await browser.newContext(options);
    const guestContext = await browser.newContext(options);
    host = await hostContext.newPage();
    guest = await guestContext.newPage();
    await Promise.all([h.login(host, h.HOST_USER), h.login(guest, h.GUEST_USER)]);
    const movie = await h.findMovieId(host, 'Wing It!');
    await h.startPlayback(host, movie);
    await h.waitForSettled(host);
    // Choose the excerpt before recording; the recorded room actions use the UI.
    await host.evaluate(() => { document.querySelector('video').currentTime = 103; });
    await sleep(1500);
    await h.togglePlayback(host);
    await h.waitForPaused(host);
    await h.ensureRoomBarVisible(guest);
    // Dismiss the normal first-run help if shown, before the take begins.
    for (const page of [host, guest]) {
      const help = page.locator('.owp-help-ok');
      if (await help.isVisible()) await help.click();
    }
    const start = performance.now();
    const events = [{ at: 0, label: 'Two browsers. One movie night.' }];
    const mark = label => { const at = +((performance.now() - start) / 1000).toFixed(2); events.push({ at, label }); console.log(at, label); };
    const stopHost = await recordPage(hostContext, host, 'watch-party-host', temporary, start);
    const stopGuest = await recordPage(guestContext, guest, 'watch-party-guest', temporary, start);
    await sleep(1500);
    mark('The host creates a room');
    await h.createRoom(host);
    const room = await h.owpState(host);
    await sleep(2000);
    mark('A friend joins from Jellyfin');
    const row = guest.locator('.owp-room-item', { hasText: room.roomName }).first();
    await row.locator('.owp-btn').click();
    await h.waitInRoom(guest);
    await h.expectParticipants(host, 2);
    await h.waitForSettled(guest);
    await Promise.all([h.ensureRoomBarVisible(host), h.ensureRoomBarVisible(guest)]);
    await Promise.all([host.locator('#owp-btn-people').click(), guest.locator('#owp-btn-people').click()]);
    await sleep(2500);
    mark('Press play. Both screens follow.');
    if ((await h.videoState(host)).paused) await h.togglePlayback(host);
    await h.waitForPlaying(guest);
    await sleep(4000);
    mark('Chat without leaving the film');
    await Promise.all([host.locator('#owp-btn-chat').click(), guest.locator('#owp-btn-chat').click()]);
    await host.locator('#owp-chat-input').pressSequentially('Popcorn ready?', { delay: 85 });
    await host.locator('#owp-chat-send').click();
    await sleep(1500);
    await guest.locator('#owp-chat-input').pressSequentially('Ready. Let\'s watch!', { delay: 75 });
    await guest.locator('#owp-chat-send').click();
    await sleep(3000);
    mark('A guest pauses for everyone');
    await h.waitForSettled(guest);
    await h.togglePlayback(guest);
    await h.waitForPaused(host);
    await sleep(3000);
    mark('The host resumes the room');
    await h.togglePlayback(host);
    await h.waitForPlaying(guest);
    await Promise.all([host.locator('#owp-btn-people').click(), guest.locator('#owp-btn-people').click()]);
    await sleep(6000);
    const duration = (performance.now() - start) / 1000;
    await Promise.all([stopHost(duration), stopGuest(duration)]);
    await host.screenshot({ path: path.join(output, 'watch-party-host.jpg'), type: 'jpeg', quality: 85 });
    await guest.screenshot({ path: path.join(output, 'watch-party-guest.jpg'), type: 'jpeg', quality: 85 });
    await fs.writeFile(path.join(output, 'watch-party-demo.json'), JSON.stringify({ duration: +duration.toFixed(3), events }, null, 2) + '\n');
    console.log('Saved paired recording:', duration.toFixed(2), 'seconds');
    await fs.rm(temporary, { recursive: true });
  } catch (error) {
    if (host) console.error('Player controls:', await host.locator('[id^="owp-header"], [id="owp-panel"]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, class: node.className, visible: !!node.getClientRects().length }))));
    if (host) await host.screenshot({ path: path.join(temporary, 'host-failure.png') }).catch(() => {});
    if (guest) await guest.screenshot({ path: path.join(temporary, 'guest-failure.png') }).catch(() => {});
    console.error('Capture diagnostics:', temporary);
    throw error;
  } finally {
    if (host) await h.leaveIfInRoom(host);
    if (guest) await h.leaveIfInRoom(guest);
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
