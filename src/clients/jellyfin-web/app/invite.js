(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const ui = OWP.ui;
  const t = OWP.i18n.t;
  const { DEFAULT_WS_URL } = OWP.constants;

  const INVITE_PARAM = utils.INVITE_PARAM || 'owp_invite';
  const INVITE_REQUEST_TIMEOUT_MS = 10000;

  // The room in the URL's ticket is only a hint; the session server verifies
  // the signature and the room scope before joining.
  const decodeInviteRoom = (ticket) => {
    try {
      const payload = String(ticket).split('.')[1];
      if (!payload) return '';
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      const claims = JSON.parse(atob(padded));
      return typeof claims?.room === 'string' ? claims.room : '';
    } catch (err) {
      return '';
    }
  };

  // The ticket endpoint lives beside the WebSocket path on the session server.
  const inviteEndpoint = (sessionServerUrl) => {
    try {
      const url = new URL(sessionServerUrl);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = `${url.pathname.replace(/\/ws$/, '')}/invite`;
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (err) {
      return '';
    }
  };

  const removeInviteParam = () => {
    const history = window.history;
    if (!history || typeof history.replaceState !== 'function' || !window.location?.href) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(INVITE_PARAM)) return;
    url.searchParams.delete(INVITE_PARAM);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  // Read the ticket out of the page URL on load. It is consumed only once the
  // connection is authenticated, so a login round-trip does not lose the link.
  const captureInviteLink = (href = window.location?.href) => {
    const ticket = utils.parseInviteTicket(href);
    if (!ticket) return false;
    state.pendingInviteTicket = ticket;
    return true;
  };

  const consumePendingInvite = () => {
    const ticket = state.pendingInviteTicket;
    if (!ticket) return false;
    state.pendingInviteTicket = '';
    removeInviteParam();
    const roomId = decodeInviteRoom(ticket);
    if (!roomId) {
      ui.showToast(t('inviteInvalid'));
      return false;
    }
    state.inviteJoinPending = true;
    actions.joinRoom(roomId, false, ticket);
    return true;
  };

  const copyToClipboard = async (text) => {
    const clipboard = window.navigator?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  };

  const inviteRequest = async (endpoint, roomId, ttlSeconds) => {
    const controller = new AbortController();
    const timeout = OWP.timers.setTimeout(
      () => controller.abort(),
      INVITE_REQUEST_TIMEOUT_MS,
      'invite'
    );
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.authToken}`
        },
        body: JSON.stringify({ room_id: roomId, ttl_seconds: ttlSeconds }),
        signal: controller.signal
      });
    } finally {
      OWP.timers.clear(timeout);
    }
  };

  // Host-only: asks the session server for a room-scoped ticket, turns it into
  // a link to the Jellyfin Web root and copies it to the clipboard.
  const copyInviteLink = async () => {
    if (!state.inRoom || !state.isHost) return false;
    if (!state.authToken) {
      ui.showToast(t('inviteAuthRequired'));
      return false;
    }
    const sessionServerUrl = utils.normalizeSessionServerUrl(state.wsUrl || DEFAULT_WS_URL);
    if (!sessionServerUrl.valid) {
      ui.showToast(sessionServerUrl.error);
      return false;
    }
    const endpoint = inviteEndpoint(sessionServerUrl.url);
    if (!endpoint) {
      ui.showToast(t('serverUrlInvalid'));
      return false;
    }
    let response;
    try {
      response = await inviteRequest(endpoint, state.roomId, state.inviteTtlSeconds);
    } catch (err) {
      ui.showToast(t('serverUnreachable'));
      return false;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok || typeof data?.ticket !== 'string' || !data.ticket) {
      // The session server's error text is English: show the known statuses
      // in the viewer's language, the others with their HTTP status. A 404
      // that did not come from the session server means the proxy does not
      // route /invite.
      const fromSessionServer = typeof data?.error === 'string';
      const key = response.status === 404 && !fromSessionServer
        ? 'inviteUnreachable'
        : { 403: 'inviteHostOnly', 404: 'errorRoomNotFound', 429: 'errorRateLimited', 503: 'inviteAuthRequired' }[response.status];
      if (data?.error) console.warn('[OpenWatchParty] Invite link not created:', data.error);
      ui.showToast(key ? t(key) : t('inviteCreateHttp', { status: response.status }));
      return false;
    }
    const link = utils.buildInviteUrl(data.ticket);
    if (!link) {
      ui.showToast(t('inviteCreateFailed'));
      return false;
    }
    const copied = await copyToClipboard(link);
    ui.showToast(copied ? t('inviteCopied') : t('inviteLink', { link }));
    return true;
  };

  Object.assign(actions, {
    captureInviteLink,
    consumePendingInvite,
    copyInviteLink,
    decodeInviteRoom
  });
})();
