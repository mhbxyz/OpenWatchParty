const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

// Keep each scenario's sessions and rooms independent of the existing suite.
let contexts;
let pages;
let host;
let hostEvents;
let guest;
let room;

function recordHostEvents(page) {
  const events = [];
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws') return;
    socket.on('framereceived', ({ payload }) => {
      let message;
      try { message = JSON.parse(String(payload)); } catch { return; }
      if (!['client_left', 'host_changed'].includes(message.type)) return;
      events.push({
        type: message.type,
        room: message.room,
        client: message.client,
        hostId: message.payload?.host_id,
        at: performance.now(),
      });
    });
  });
  return events;
}

async function addParticipant(browser, username) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  pages.push(page);
  const events = recordHostEvents(page);
  await helpers.login(page, username);
  return { page, events };
}

// names[0] is the expected host; sort only the membership comparison.
async function expectMembership(page, hostId, isHost, names, timeout = 20_000) {
  await expect.poll(async () => {
    const state = await helpers.owpState(page);
    return {
      connected: state.wsState === 1 && Boolean(state.clientId),
      roomId: state.roomId,
      inRoom: state.inRoom,
      hostId: state.roomHostId,
      isHost: state.isHost,
      names: state.participants.map(member => member.name).sort(),
      hosts: state.participants.filter(member => member.isHost).map(member => member.name),
    };
  }, { timeout }).toEqual({
    connected: true,
    roomId: room.roomId,
    inRoom: true,
    hostId,
    isHost,
    names: [...names].sort(),
    hosts: [names[0]],
  });
}

async function expectSharedControls(authority, followers) {
  await helpers.waitForPlaying(authority);
  await helpers.waitForSettled(authority);
  await helpers.togglePlayback(authority);
  for (const page of followers) await helpers.waitForPaused(page);
  await helpers.waitForPaused(authority);
  await helpers.waitForSettled(authority);
  await helpers.togglePlayback(authority);
  for (const page of followers) await helpers.waitForPlaying(page);
  await helpers.waitForPlaying(authority);
}

test.beforeEach(async ({ browser }) => {
  contexts = [];
  pages = [];
  const hostSession = await addParticipant(browser, helpers.HOST_USER);
  host = hostSession.page;
  hostEvents = hostSession.events;
  guest = await addParticipant(browser, helpers.GUEST_USER);
  const authEnabled = await host.evaluate(async () => {
    const result = await window.ApiClient.getJSON(window.ApiClient.getUrl('OpenWatchParty/Token'));
    return result.auth_enabled;
  });
  expect(authEnabled, 'Run this suite with JWT_SECRET and matching dev plugin configuration').toBe(true);
  const movieId = await helpers.findMovieId(host, 'Wing It!');
  await helpers.startPlayback(host, movieId);
  await helpers.waitForSettled(host);
  await helpers.createRoom(host);
  room = await helpers.owpState(host);
  await helpers.joinRoomFromHomeCard(guest.page, room.roomId);
  await expectMembership(host, room.clientId, true, [helpers.HOST_USER, helpers.GUEST_USER]);
  await expectMembership(guest.page, room.clientId, false, [helpers.HOST_USER, helpers.GUEST_USER]);
});

test.afterEach(async () => {
  try {
    // The current host may be a former guest after transfer. Close through
    // that client's public action before disposing its browser context.
    for (const page of pages) {
      if (page.isClosed()) continue;
      await page.evaluate(() => {
        const owp = window.OpenWatchParty;
        if (owp?.state.inRoom && owp.state.isHost) owp.actions.closeRoom();
      });
    }
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('the authenticated host reconnects within grace and retains the room and role', async () => {
  const oldId = room.clientId;
  await host.evaluate(() => window.OpenWatchParty.state.ws.close());
  await expect.poll(async () => {
    const state = await helpers.owpState(host);
    return state.inRoom && state.clientId !== oldId && state.isHost;
  }, { timeout: 9_000 }).toBe(true);
  const recoveredId = (await helpers.owpState(host)).clientId;
  expect(recoveredId).toBeTruthy();
  await expectMembership(host, recoveredId, true, [helpers.HOST_USER, helpers.GUEST_USER]);
  await expectMembership(guest.page, recoveredId, false, [helpers.HOST_USER, helpers.GUEST_USER]);
  expect(guest.events.filter(event => event.type === 'client_left' && event.client === oldId)).toHaveLength(1);
  expect(guest.events.filter(event => event.type === 'host_changed').map(event => event.hostId)).toEqual([recoveredId]);
  await expectSharedControls(host, [guest.page]);
});

test('grace expiry promotes the first guest and the returning host rejoins as a guest', async ({ browser }) => {
  const third = await addParticipant(browser, helpers.THIRD_USER);
  await helpers.joinRoomFromHomeCard(third.page, room.roomId);
  await helpers.expectParticipants(host, 3);
  const nextHostId = (await helpers.owpState(guest.page)).clientId;
  await host.evaluate(() => {
    window.OpenWatchParty.state.autoReconnect = false;
    window.OpenWatchParty.state.ws.close();
  });
  await helpers.expectParticipants(guest.page, 2);
  expect((await helpers.owpState(guest.page)).isHost).toBe(false);
  await expectMembership(guest.page, nextHostId, true, [helpers.GUEST_USER, helpers.THIRD_USER]);
  await expectMembership(third.page, nextHostId, false, [helpers.GUEST_USER, helpers.THIRD_USER]);
  const left = guest.events.find(event => event.type === 'client_left' && event.client === room.clientId);
  const changed = guest.events.find(event => event.type === 'host_changed');
  expect(left).toBeTruthy();
  expect(changed).toBeTruthy();
  expect(changed.hostId).toBe(nextHostId);
  expect(changed.at - left.at, 'Transfer waits for the real 10-second grace, with 1s delivery tolerance').toBeGreaterThanOrEqual(9_000);
  await host.evaluate(() => window.OpenWatchParty.actions.connect());
  const names = [helpers.GUEST_USER, helpers.THIRD_USER, helpers.HOST_USER];
  await expectMembership(host, nextHostId, false, names);
  await expectMembership(guest.page, nextHostId, true, names);
  await expectMembership(third.page, nextHostId, false, names);
  expect((await helpers.owpState(host)).clientId).not.toBe(room.clientId);
  expect(guest.events.filter(event => event.type === 'host_changed')).toHaveLength(1);
  await expectSharedControls(guest.page, [host, third.page]);
});

test('explicit host Leave transfers the room instead of closing it', async () => {
  const guestId = (await helpers.owpState(guest.page)).clientId;
  await helpers.leaveRoomKeepingRoom(host);
  await expectMembership(guest.page, guestId, true, [helpers.GUEST_USER], 5_000);
  expect((await helpers.owpState(host)).inRoom).toBe(false);
  expect(guest.events.filter(event => event.type === 'host_changed').map(event => event.hostId)).toEqual([guestId]);
  await helpers.waitForPlaying(guest.page);
});

test('a third guest leaving and a second host tab closing preserve the original host', async ({ browser }) => {
  const third = await addParticipant(browser, helpers.THIRD_USER);
  await helpers.joinRoomFromHomeCard(third.page, room.roomId);
  await helpers.expectParticipants(host, 3);
  const thirdId = (await helpers.owpState(third.page)).clientId;
  const tab = await host.context().newPage();
  pages.push(tab);
  await tab.goto('/#/home');
  await helpers.waitForClient(tab);
  await expect.poll(async () => (await helpers.owpState(tab)).clientId).not.toBe('');
  const tabState = await helpers.owpState(tab);
  expect(tabState.clientId).not.toBe(room.clientId);
  expect(tabState.inRoom).toBe(false);
  expect(await tab.evaluate(() => window.OpenWatchParty.state.userName)).toBe(helpers.HOST_USER);
  await helpers.leaveRoom(third.page);
  await tab.close();
  await expectMembership(host, room.clientId, true, [helpers.HOST_USER, helpers.GUEST_USER]);
  await expectMembership(guest.page, room.clientId, false, [helpers.HOST_USER, helpers.GUEST_USER]);
  await expectSharedControls(host, [guest.page]);
  expect(guest.events.filter(event => event.type === 'client_left').map(event => event.client)).toEqual([thirdId]);
  expect(guest.events.filter(event => event.type === 'host_changed')).toEqual([]);
});

test('a guest Leave and another guest transport loss leave the host alone in the same room', async ({ browser }) => {
  const third = await addParticipant(browser, helpers.THIRD_USER);
  await helpers.joinRoomFromHomeCard(third.page, room.roomId);
  await helpers.expectParticipants(host, 3);
  const departingIds = [
    (await helpers.owpState(guest.page)).clientId,
    (await helpers.owpState(third.page)).clientId,
  ].sort();
  await helpers.clickRoomBar(guest.page, '#owp-btn-leave');
  await Promise.all([
    helpers.clickRoomBar(guest.page, '#owp-btn-confirm-leave'),
    third.page.evaluate(() => {
      window.OpenWatchParty.state.autoReconnect = false;
      window.OpenWatchParty.state.ws.close();
    }),
  ]);
  await helpers.waitInRoom(guest.page, false);
  await expectMembership(host, room.clientId, true, [helpers.HOST_USER]);
  await helpers.waitForPlaying(host);
  expect(hostEvents.filter(event => event.type === 'client_left').map(event => event.client).sort()).toEqual(departingIds);
  expect(hostEvents.filter(event => event.type === 'host_changed')).toEqual([]);
});
