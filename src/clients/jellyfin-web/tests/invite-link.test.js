const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const OWP = require('./setup.js');
const { FakeDocument } = require('./fake-dom.js');

globalThis.document = new FakeDocument();
OWP.ui = {};
require('../ui/toasts.js');
require('../ws/send.js');
require('../app/invite.js');
require('../ws/handlers/room.js');
require('../ws/handlers/sync.js');

const encodeTicket = (claims) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const locationFor = (href) => {
  const url = new URL(href);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    href: url.href
  };
};

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body
});

let toasts;
let sent;
let copied;
let replaced;
let fetchCalls;
let fetchResponse;

const inviteHref = (ticket) => `https://media.example:8096/web/?owp_invite=${ticket}`;

describe('room invite links', () => {
  beforeEach(() => {
    globalThis.document = new FakeDocument();
    toasts = [];
    sent = [];
    copied = [];
    replaced = null;
    fetchCalls = [];
    fetchResponse = jsonResponse({ ticket: 'ticket.jwt.value', expires_at: 123 });
    window.location = locationFor(inviteHref(encodeTicket({ room: 'room-1' })));
    window.history = {
      replaceState: (state, title, url) => {
        replaced = url;
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (text) => copied.push(text) } },
      configurable: true
    });
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchResponse;
    };
    Object.assign(OWP.state, {
      inRoom: true,
      isHost: true,
      roomId: 'room-1',
      roomName: 'Room',
      clientId: 'client-host',
      wsUrl: 'wss://session.example/ws',
      authToken: 'session-jwt',
      authEnabled: true,
      inviteTtlSeconds: 3600,
      pendingInviteTicket: '',
      inviteJoinPending: false,
      rejoinPending: false,
      desiredRoomId: '',
      rejectedRejoinRoomIds: [],
      hasTimeSync: true
    });
    OWP.state.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    OWP.state.participants = [];
    OWP.ui.showToast = (message) => toasts.push(message);
    OWP.ui.render = () => {};
    OWP.ui.updateSyncIndicator = () => {};
    OWP.actions.cancelRoomRejoin = () => {};
    OWP.utils.getVideo = () => null;
    OWP.timers.setTimeout = () => 1;
  });

  describe('capture and join', () => {
    it('captures the ticket, joins with it and removes it from the URL', () => {
      const ticket = encodeTicket({ room: 'room-1' });

      assert.equal(OWP.actions.captureInviteLink(), true);
      assert.equal(OWP.state.pendingInviteTicket, ticket);

      assert.equal(OWP.actions.consumePendingInvite(), true);

      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'join_room');
      assert.equal(sent[0].room, 'room-1');
      assert.equal(sent[0].payload.invite_ticket, ticket);
      assert.equal(sent[0].payload.user_name, 'Anonymous');
      assert.equal(OWP.state.inviteJoinPending, true);
      assert.equal(OWP.state.pendingInviteTicket, '');
      assert.equal(replaced, '/web/');
    });

    it('consumes a pending ticket only once', () => {
      OWP.actions.captureInviteLink();

      assert.equal(OWP.actions.consumePendingInvite(), true);
      assert.equal(OWP.actions.consumePendingInvite(), false);
      assert.equal(sent.length, 1);
    });

    it('shows a toast and falls back without joining on an invalid ticket', () => {
      window.location = locationFor(inviteHref('not-a-jwt'));

      assert.equal(OWP.actions.captureInviteLink(), true);
      assert.equal(OWP.actions.consumePendingInvite(), false);

      assert.deepEqual(sent, []);
      assert.deepEqual(toasts, ['This invite link is invalid']);
      assert.equal(OWP.state.inviteJoinPending, false);
      assert.equal(replaced, '/web/');
    });

    it('ignores URLs without a ticket', () => {
      window.location = locationFor('https://media.example:8096/web/');

      assert.equal(OWP.actions.captureInviteLink(), false);
      assert.equal(OWP.state.pendingInviteTicket, '');
    });

    it('clears the pending state when a room_state confirms the join', () => {
      OWP.state.inviteJoinPending = true;

      OWP._wsHandlers.handleRoomState({
        room: 'room-1',
        client: 'client-host',
        server_ts: 1000,
        payload: {
          name: 'Room',
          host_id: 'client-host',
          participant_count: 2,
          state: { position: 12, play_state: 'paused' },
          state_server_ts: 1000
        }
      });

      assert.equal(OWP.state.inviteJoinPending, false);
      assert.equal(OWP.state.inRoom, true);
    });

    it('resets to the lobby and toasts when the invite join fails', () => {
      OWP.state.inviteJoinPending = true;
      let reset = 0;
      OWP.actions.resetRoomState = () => {
        reset++;
        OWP.state.inviteJoinPending = false;
      };

      OWP._wsHandlers.handleError({
        payload: { code: 'AUTHENTICATION_EXPIRED', message: 'Invite ticket has expired' }
      });

      assert.equal(reset, 1);
      assert.equal(OWP.state.inviteJoinPending, false);
      assert.deepEqual(toasts, ['Invite ticket has expired']);
    });

    it('shows a known server error in the Jellyfin language', () => {
      document.documentElement = { lang: 'es' };
      OWP.state.inviteJoinPending = true;
      OWP.actions.resetRoomState = () => { OWP.state.inviteJoinPending = false; };

      OWP._wsHandlers.handleError({
        payload: { code: 'AUTHENTICATION_EXPIRED', message: 'Invite ticket has expired' }
      });
      OWP._wsHandlers.handleError({ payload: { code: 'INVALID_JSON', message: 'Invalid JSON' } });

      assert.deepEqual(toasts, ['El enlace de invitación expiró', 'Invalid JSON']);
    });
  });

  describe('copy invite link', () => {
    it('requests a ticket for the current room, builds the link and copies it', async () => {
      assert.equal(await OWP.actions.copyInviteLink(), true);

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, 'https://session.example/invite');
      assert.equal(fetchCalls[0].options.method, 'POST');
      assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer session-jwt');
      assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
        room_id: 'room-1',
        ttl_seconds: 3600
      });
      assert.deepEqual(copied, ['https://media.example:8096/web/?owp_invite=ticket.jwt.value']);
      assert.deepEqual(toasts, ['Invite link copied to the clipboard']);
    });

    it('keeps the WebSocket path prefix when building the ticket endpoint', async () => {
      OWP.state.wsUrl = 'wss://session.example/party/ws';

      await OWP.actions.copyInviteLink();

      assert.equal(fetchCalls[0].url, 'https://session.example/party/invite');
    });

    it('does nothing for guests or clients outside a room', async () => {
      OWP.state.isHost = false;
      await OWP.actions.copyInviteLink();
      OWP.state.isHost = true;
      OWP.state.inRoom = false;
      await OWP.actions.copyInviteLink();

      assert.deepEqual(fetchCalls, []);
      assert.deepEqual(toasts, []);
    });

    it('asks for authentication when there is no session token', async () => {
      OWP.state.authToken = '';

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(fetchCalls, []);
      assert.deepEqual(toasts, ['Invite links require an authenticated watch party']);
    });

    it('shows the server error when the ticket request is rejected', async () => {
      fetchResponse = jsonResponse(
        { error: 'Only the room host can create invite links' },
        { ok: false, status: 403 }
      );

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(copied, []);
      assert.deepEqual(toasts, ['Only the room host can create invite links']);
    });

    it('shows the rejection in the Jellyfin language, or with its HTTP status', async () => {
      document.documentElement = { lang: 'es' };
      fetchResponse = jsonResponse(
        { error: 'Only the room host can create invite links' },
        { ok: false, status: 403 }
      );
      assert.equal(await OWP.actions.copyInviteLink(), false);
      fetchResponse = jsonResponse({ error: 'Bad gateway' }, { ok: false, status: 502 });
      assert.equal(await OWP.actions.copyInviteLink(), false);

      assert.deepEqual(toasts, [
        'Solo el anfitrión puede crear enlaces de invitación',
        'No se pudo crear el enlace (HTTP 502)'
      ]);
    });

    it('shows the session server error for a JSON 404 response', async () => {
      fetchResponse = jsonResponse({ error: 'Room not found' }, { ok: false, status: 404 });

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(toasts, ['Room not found']);
    });

    it('explains the proxy route for a non-JSON 404 response', async () => {
      fetchResponse = {
        ok: false,
        status: 404,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        }
      };

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(toasts, [
        'Could not reach the invite service. Check that your reverse proxy sends /invite to the session server.'
      ]);
    });

    it('keeps the existing fallback for other non-JSON errors', async () => {
      fetchResponse = {
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        }
      };

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(toasts, ['Could not create the invite link (HTTP 502)']);
    });

    it('shows the link when the clipboard is unavailable', async () => {
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
      fetchResponse = jsonResponse({ ticket: 'ticket.jwt.value' });

      assert.equal(await OWP.actions.copyInviteLink(), true);
      assert.deepEqual(toasts, [
        'Invite link: https://media.example:8096/web/?owp_invite=ticket.jwt.value'
      ]);
    });

    it('reports an unreachable session server', async () => {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      assert.equal(await OWP.actions.copyInviteLink(), false);
      assert.deepEqual(toasts, ['Could not reach the watch party server']);
    });
  });
});
