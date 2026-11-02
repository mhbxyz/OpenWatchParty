const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

test('a guest waits for user play after autoplay is blocked, while tracking the room', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await helpers.login(host, helpers.HOST_USER);
    await helpers.login(guest, helpers.GUEST_USER);
    const movieId = await helpers.findMovieId(host, 'Wing It!');
    await helpers.startPlayback(host, movieId);
    await helpers.waitForSettled(host);
    await helpers.createRoom(host);
    const room = await helpers.owpState(host);
    await helpers.joinRoomFromHeader(guest, room.roomId);
    await helpers.waitForSettled(guest);

    await guest.evaluate(async () => {
      const owp = window.OpenWatchParty;
      const video = owp.utils.getVideo();
      const originalPlay = video.play;
      const probe = { attempts: 0, updates: 0 };
      const onMessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state_update' && (!msg.room || msg.room === owp.state.roomId)) probe.updates++;
      };
      owp.state.ws.addEventListener('message', onMessage);
      // Model the browser boundary, keeping the actual safePlay, handlers,
      // server updates and play-event recovery in use.
      video.play = () => {
        probe.attempts++;
        return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
      };
      // This is a local browser failure, not a guest asking the room to pause.
      owp.utils.suppress();
      video.pause();
      await owp.playback.safePlay(video, 'autoplay regression');
      probe.restore = () => {
        video.play = originalPlay;
        owp.state.ws.removeEventListener('message', onMessage);
      };
      window.autoplayProbe = probe;
    });

    await expect.poll(() => guest.evaluate(() => window.autoplayProbe.updates), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    const blocked = await guest.evaluate(() => ({
      attempts: window.autoplayProbe.attempts,
      blocked: window.OpenWatchParty.state.playbackBlocked,
      status: window.OpenWatchParty.state.syncStatus,
      guestPaused: window.OpenWatchParty.state.guestPaused,
      roomPosition: window.OpenWatchParty.state.lastSyncPosition,
      videoPosition: window.OpenWatchParty.utils.getVideo().currentTime
    }));
    expect(blocked.attempts).toBe(1);
    expect(blocked.blocked).toBe(true);
    expect(blocked.status).toBe('blocked');
    expect(blocked.guestPaused).toBe(false);
    expect(blocked.roomPosition).toBeGreaterThan(blocked.videoPosition);

    await guest.evaluate(async () => {
      window.autoplayProbe.restore();
      await window.OpenWatchParty.utils.getVideo().play();
    });
    await helpers.waitForPlaying(guest);
    await expect.poll(() => guest.evaluate(() => window.OpenWatchParty.state.playbackBlocked)).toBe(false);
    await helpers.waitForSettled(guest);
    await helpers.leaveRoom(host);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
