(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const t = OWP.i18n.t;
  const { PROTOCOL_VERSION, CLIENT_FEATURES } = OWP.constants;
  const TOKEN_REQUEST_TIMEOUT_MS = 10000;
  const TOKEN_REFRESH_RETRY_MS = 30000;
  // Jellyfin out of reach for a moment, not a refusal: a renewal that fails
  // like this is retried, and the session goes on with the token it has.
  const TRANSIENT_REFRESH_ERRORS = new Set([
    'network_error', 'timeout', 'aborted', 'server_error', 'server_unavailable', 'rate_limited', 'invalid_json'
  ]);

  const getJellyfinUsername = () => {
    try {
      const apiClient = window.ApiClient;
      if (apiClient) {
        if (apiClient._currentUser?.Name) return apiClient._currentUser.Name;
        if (apiClient.currentUser?.()?.Name) return apiClient.currentUser().Name;
      }
      const creds = localStorage.getItem('jellyfin_credentials') || sessionStorage.getItem('jellyfin_credentials');
      if (creds) {
        const parsed = JSON.parse(creds);
        const server = parsed?.Servers?.[0];
        if (server?.Users?.[0]?.Name) return server.Users[0].Name;
      }
      const serverCreds = JSON.parse(localStorage.getItem('_deviceId2') || '{}');
      if (serverCreds?.Servers?.[0]?.Users?.[0]?.Name) return serverCreds.Servers[0].Users[0].Name;
    } catch (e) {
      console.warn('[OpenWatchParty] Could not get username from Jellyfin:', e);
    }
    return '';
  };

  const getApiAccessToken = () => {
    const apiClient = window.ApiClient;
    if (!apiClient || typeof apiClient.accessToken !== 'function') return null;
    const accessToken = apiClient.accessToken();
    if (!accessToken) return null;
    const serverAddress = typeof apiClient.serverAddress === 'function' ? apiClient.serverAddress() : '';
    return { apiClient, accessToken, serverAddress };
  };

  // The raw access token, without the ApiClient/address wrapper. Used by the
  // connection retry watchdog to detect a Jellyfin login that happened after a
  // blocked authentication attempt.
  const getJellyfinAccessToken = () => {
    const apiClient = window.ApiClient;
    if (!apiClient) return '';
    if (typeof apiClient.accessToken === 'function') return apiClient.accessToken() || '';
    return apiClient._accessToken || apiClient._serverInfo?.AccessToken || '';
  };

  // Jellyfin 12 rejects the legacy `X-Emby-Token` header (legacy authorization
  // is disabled by the `DisableLegacyAuthorization` migration), so every plugin
  // request must carry the modern `Authorization: MediaBrowser Token="..."`.
  // Jellyfin 10.11 accepts the same header, so there is no compatibility split.
  // The token-only form is deliberate: the server backfills Client/Device from
  // the stored session, so it cannot overwrite the user's real client info.
  const buildAuthHeaders = (accessToken) => {
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (/["\\\u0000-\u001f]/.test(accessToken)) return null;
    return { Authorization: `MediaBrowser Token="${accessToken}"` };
  };

  const waitForApiClient = (isCurrent = () => true, maxWaitMs = 10000, intervalMs = 250) => {
    return new Promise((resolve) => {
      let elapsed = 0;
      const check = () => {
        if (!isCurrent()) return resolve(null);
        const result = getApiAccessToken();
        if (result) return resolve(result);
        elapsed += intervalMs;
        if (elapsed >= maxWaitMs) return resolve(null);
        OWP.timers.setTimeout(check, intervalMs, 'auth');
      };
      check();
    });
  };

  const scheduleRefresh = (delayMs) => {
    if (state.tokenRefreshTimer) {
      OWP.timers.clear(state.tokenRefreshTimer);
      state.tokenRefreshTimer = null;
    }
    const authRequestAttempt = state.authRequestAttempt;
    state.tokenRefreshTimer = OWP.timers.setTimeout(async () => {
      state.tokenRefreshTimer = null;
      if (authRequestAttempt !== state.authRequestAttempt) return;
      await refreshToken();
    }, delayMs, 'auth');
  };

  const scheduleTokenRefresh = (expiresInSec) => {
    if (state.tokenRefreshTimer) {
      OWP.timers.clear(state.tokenRefreshTimer);
      state.tokenRefreshTimer = null;
    }
    const refreshBeforeMs = Math.min(5 * 60 * 1000, expiresInSec * 1000 * 0.2);
    const refreshInMs = Math.max(0, (expiresInSec * 1000) - refreshBeforeMs);
    if (refreshInMs > 0) {
      console.log('[OpenWatchParty] Token refresh scheduled in', Math.round(refreshInMs / 1000), 's');
      scheduleRefresh(refreshInMs);
    }
  };

  // A renewal that failed for a moment leaves the session and the room as
  // they were: the token in use still works, and the renewal is retried while
  // there is time. If it expires first, the session server closes the socket
  // and the client reconnects into the room as after any other drop.
  const keepSessionAfterRefreshError = (kept) => {
    state.authBlocked = false;
    state.authError = '';
    state.authEnabled = kept.enabled;
    setNativeSyncPlayHidden(kept.hideNativeSyncPlay);
    if (!kept.token || kept.expiresAt <= Date.now()) return;
    state.authToken = kept.token;
    state.tokenExpiresAt = kept.expiresAt;
    if (kept.expiresAt - Date.now() > TOKEN_REFRESH_RETRY_MS + TOKEN_REQUEST_TIMEOUT_MS) {
      scheduleRefresh(TOKEN_REFRESH_RETRY_MS);
    }
  };

  const refreshToken = async () => {
    console.log('[OpenWatchParty] Refreshing auth token...');
    const refreshSocket = state.ws;
    const kept = {
      token: state.authToken,
      expiresAt: state.tokenExpiresAt,
      enabled: state.authEnabled,
      hideNativeSyncPlay: state.hideNativeSyncPlayButton
    };
    state.authToken = null;
    const result = await fetchAuthToken();
    if (refreshSocket !== state.ws) return;
    if (result.mode === 'authenticated' && refreshSocket && refreshSocket.readyState === WebSocket.OPEN) {
      refreshSocket.send(JSON.stringify({
        type: 'auth',
        payload: {
          token: result.token,
          user_name: state.userName,
          user_id: state.userId,
          protocol_version: PROTOCOL_VERSION,
          features: CLIENT_FEATURES
        },
        ts: utils.nowMs()
      }));
      console.log('[OpenWatchParty] Token refreshed and re-authenticated');
    } else if (result.mode === 'error' && state.ws) {
      if (TRANSIENT_REFRESH_ERRORS.has(result.code)) {
        console.warn('[OpenWatchParty] Token refresh failed, keeping the session:', result.code);
        keepSessionAfterRefreshError(kept);
        return;
      }
      if (actions.disconnect) actions.disconnect();
      else {
        state.autoReconnect = false;
        state.ws.close(4003, 'OpenWatchParty authentication failed');
        state.ws = null;
      }
    }
  };

  const ensureTokenRefresh = () => {
    if (!state.authEnabled || !state.authToken || !state.tokenExpiresAt) return false;
    const remainingSeconds = Math.ceil((state.tokenExpiresAt - Date.now()) / 1000);
    if (remainingSeconds <= 0) {
      state.authToken = null;
      state.tokenExpiresAt = 0;
      return false;
    }
    scheduleTokenRefresh(remainingSeconds);
    return true;
  };

  const setNativeSyncPlayHidden = (hidden) => {
    state.hideNativeSyncPlayButton = hidden;
    if (OWP.ui?.applyNativeSyncPlayVisibility) OWP.ui.applyNativeSyncPlayVisibility();
  };

  // The room bar is drawn again if the setting changes while in a room.
  const setSyncNudgeShown = (shown) => {
    if (state.showSyncNudge === shown) return;
    state.showSyncNudge = shown;
    state.outOfSyncSince = 0;
    if (state.inRoom && OWP.ui?.render) OWP.ui.render(true);
  };

  // The look of the room bar, its drop-downs, the lobby and the toasts.
  const setAppearance = (data) => {
    state.appearanceOpacity = data.appearance_opacity;
    state.appearanceTextSize = data.appearance_text_size;
    state.appearancePreset = data.appearance_preset;
    if (OWP.ui?.applyAppearance) OWP.ui.applyAppearance();
  };

  // The plugin tells the client how long host invite links should live. The
  // session server clamps it again, so a bad value only falls back to an hour.
  const applyInviteTtl = (data) => {
    const ttl = Number(data?.invite_ttl_seconds);
    state.inviteTtlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 3600;
  };

  const authError = (code, message, isCurrentRequest) => {
    if (isCurrentRequest()) {
      state.authToken = null;
      state.authEnabled = false;
      state.authBlocked = true;
      state.authError = message;
      state.tokenExpiresAt = 0;
      // Without a working Watch Party connection, keep Jellyfin's SyncPlay available.
      setNativeSyncPlayHidden(false);
    }
    return { mode: 'error', code, message };
  };

  // Apply only a response whose request generation was checked after JSON decoding.
  const applyTokenResponse = (data, isCurrentRequest) => {
    if (!Object.prototype.hasOwnProperty.call(data, 'session_server_url')
        || typeof data.session_server_url !== 'string') {
      return authError(
        'invalid_response',
        t('authMissingUrl'),
        isCurrentRequest
      );
    }
    const sessionServerUrl = utils.normalizeSessionServerUrl(data.session_server_url);
    if (!sessionServerUrl.valid) {
      return authError(
        'invalid_response',
        t('authBadUrl', { error: sessionServerUrl.error }),
        isCurrentRequest
      );
    }
    if (data.auth_enabled === true && typeof data.token === 'string' && data.token) {
      state.authBlocked = false;
      state.authError = '';
      state.userId = data.user_id || '';
      state.userName = data.user_name || getJellyfinUsername() || '';
      state.wsUrl = sessionServerUrl.url;
      state.authEnabled = true;
      state.authToken = data.token;
      setNativeSyncPlayHidden(data.hide_native_syncplay_button === true);
      setSyncNudgeShown(data.show_sync_nudge_button === true);
      setAppearance(data);
      applyInviteTtl(data);
      const expiresIn = data.expires_in || 3600;
      state.tokenExpiresAt = Date.now() + (expiresIn * 1000);
      scheduleTokenRefresh(expiresIn);
      console.log('[OpenWatchParty] Auth token obtained for user:', state.userName, 'expires in', expiresIn, 's');
      return { mode: 'authenticated', token: data.token, expiresIn };
    }
    if (data.auth_enabled === false && data.insecure_mode === true) {
      state.authBlocked = false;
      state.authError = '';
      state.userId = data.user_id || '';
      state.userName = data.user_name || getJellyfinUsername() || '';
      state.wsUrl = sessionServerUrl.url;
      state.authEnabled = false;
      state.authToken = null;
      state.tokenExpiresAt = 0;
      setNativeSyncPlayHidden(data.hide_native_syncplay_button === true);
      setSyncNudgeShown(data.show_sync_nudge_button === true);
      setAppearance(data);
      applyInviteTtl(data);
      console.log('[OpenWatchParty] Explicit insecure mode enabled, connecting without token');
      return { mode: 'insecure', token: null };
    }
    return authError(
      'invalid_response',
      t('authBadResponse'),
      isCurrentRequest
    );
  };

  const fetchAuthToken = async () => {
    const authRequestAttempt = ++state.authRequestAttempt;
    const isCurrentRequest = () => authRequestAttempt === state.authRequestAttempt;
    let requestTimeout = null;
    let timedOut = false;
    if (state.tokenRefreshTimer) {
      OWP.timers.clear(state.tokenRefreshTimer);
      state.tokenRefreshTimer = null;
    }
    try {
      let apiAccess = getApiAccessToken();
      if (!apiAccess) {
        console.log('[OpenWatchParty] Waiting for ApiClient...');
        apiAccess = await waitForApiClient(isCurrentRequest);
      }
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: t('authInvalidated') };
      }
      if (!apiAccess) {
        console.warn('[OpenWatchParty] ApiClient not available after waiting');
        return authError('api_client_unavailable', t('authUnavailable'), isCurrentRequest);
      }
      const { accessToken, serverAddress } = apiAccess;
      const authHeaders = buildAuthHeaders(accessToken);
      if (!authHeaders) {
        console.warn('[OpenWatchParty] Jellyfin returned an unusable access token');
        return authError('invalid_token', t('authInvalidToken'), isCurrentRequest);
      }
      const tokenUrl = `${serverAddress}/OpenWatchParty/Token`;
      const controller = new AbortController();
      requestTimeout = OWP.timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, TOKEN_REQUEST_TIMEOUT_MS, 'auth');
      const response = await fetch(tokenUrl, {
        headers: authHeaders,
        signal: controller.signal
      });
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: t('authInvalidated') };
      }
      if (!response.ok) {
        const errors = {
          401: ['unauthorized', t('authRejected')],
          408: ['timeout', t('authTimeout')],
          429: ['rate_limited', t('authRateLimited')],
          500: ['server_error', t('authServerError')],
          503: ['server_unavailable', t('authNotConfigured')]
        };
        const fallback = response.status >= 500
          ? ['server_error', t('authServerError')]
          : ['http_error', t('authHttp', { status: response.status })];
        const [code, message] = errors[response.status] || fallback;
        console.warn('[OpenWatchParty] Failed to fetch auth token:', response.status);
        return authError(code, message, isCurrentRequest);
      }
      let data;
      try {
        data = await response.json();
      } catch (err) {
        if (!isCurrentRequest()) {
          return { mode: 'error', code: 'request_invalidated', message: t('authInvalidated') };
        }
        console.warn('[OpenWatchParty] Invalid token endpoint JSON:', err);
        return authError('invalid_json', t('authInvalidJson'), isCurrentRequest);
      }
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: t('authInvalidated') };
      }
      return applyTokenResponse(data, isCurrentRequest);
    } catch (err) {
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: t('authInvalidated') };
      }
      console.warn('[OpenWatchParty] Error fetching auth token:', err);
      if (timedOut) {
        return authError('timeout', t('authTimeout'), isCurrentRequest);
      }
      if (err?.name === 'AbortError') {
        return authError('aborted', t('authAborted'), isCurrentRequest);
      }
      return authError('network_error', t('authUnreachable'), isCurrentRequest);
    } finally {
      if (requestTimeout !== null) OWP.timers.clear(requestTimeout);
    }
  };

  Object.assign(actions, { fetchAuthToken, ensureTokenRefresh, getJellyfinAccessToken, buildAuthHeaders });
})();
