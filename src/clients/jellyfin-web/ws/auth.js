(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const actions = OWP.actions = OWP.actions || {};
  const state = OWP.state;
  const utils = OWP.utils;
  const TOKEN_REQUEST_TIMEOUT_MS = 10000;

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

  const scheduleTokenRefresh = (expiresInSec) => {
    if (state.tokenRefreshTimer) {
      OWP.timers.clear(state.tokenRefreshTimer);
      state.tokenRefreshTimer = null;
    }
    const refreshBeforeMs = Math.min(5 * 60 * 1000, expiresInSec * 1000 * 0.2);
    const refreshInMs = Math.max(0, (expiresInSec * 1000) - refreshBeforeMs);
    if (refreshInMs > 0) {
      console.log('[OpenWatchParty] Token refresh scheduled in', Math.round(refreshInMs / 1000), 's');
      const authRequestAttempt = state.authRequestAttempt;
      state.tokenRefreshTimer = OWP.timers.setTimeout(async () => {
        state.tokenRefreshTimer = null;
        if (authRequestAttempt !== state.authRequestAttempt) return;
        console.log('[OpenWatchParty] Refreshing auth token...');
        const refreshSocket = state.ws;
        state.authToken = null;
        const result = await fetchAuthToken();
        if (refreshSocket !== state.ws) return;
        if (result.mode === 'authenticated' && refreshSocket && refreshSocket.readyState === WebSocket.OPEN) {
          refreshSocket.send(JSON.stringify({
            type: 'auth',
            payload: { token: result.token, user_name: state.userName, user_id: state.userId },
            ts: utils.nowMs()
          }));
          console.log('[OpenWatchParty] Token refreshed and re-authenticated');
        } else if (result.mode === 'error' && state.ws) {
          if (actions.disconnect) actions.disconnect();
          else {
            state.autoReconnect = false;
            state.ws.close(4003, 'OpenWatchParty authentication failed');
            state.ws = null;
          }
        }
      }, refreshInMs, 'auth');
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

  const authError = (code, message, isCurrentRequest) => {
    if (isCurrentRequest()) {
      state.authToken = null;
      state.authEnabled = false;
      state.authBlocked = true;
      state.authError = message;
      state.tokenExpiresAt = 0;
    }
    return { mode: 'error', code, message };
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
        return { mode: 'error', code: 'request_invalidated', message: 'Authentication request was invalidated' };
      }
      if (!apiAccess) {
        console.warn('[OpenWatchParty] ApiClient not available after waiting');
        return authError('api_client_unavailable', 'Jellyfin authentication is not available', isCurrentRequest);
      }
      const { accessToken, serverAddress } = apiAccess;
      const tokenUrl = `${serverAddress}/OpenWatchParty/Token`;
      const controller = new AbortController();
      requestTimeout = OWP.timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, TOKEN_REQUEST_TIMEOUT_MS, 'auth');
      const response = await fetch(tokenUrl, {
        headers: { 'X-Emby-Token': accessToken },
        signal: controller.signal
      });
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: 'Authentication request was invalidated' };
      }
      if (!response.ok) {
        const errors = {
          401: ['unauthorized', 'Jellyfin rejected the OpenWatchParty token request (HTTP 401)'],
          429: ['rate_limited', 'Too many OpenWatchParty token requests (HTTP 429)'],
          500: ['server_error', 'The OpenWatchParty token endpoint failed (HTTP 500)'],
          503: ['server_unavailable', 'JWT authentication is not configured or unavailable in the OpenWatchParty plugin (HTTP 503)']
        };
        const [code, message] = errors[response.status] || [
          'http_error',
          `Could not obtain an OpenWatchParty token (HTTP ${response.status})`
        ];
        console.warn('[OpenWatchParty] Failed to fetch auth token:', response.status);
        return authError(code, message, isCurrentRequest);
      }
      let data;
      try {
        data = await response.json();
      } catch (err) {
        if (!isCurrentRequest()) {
          return { mode: 'error', code: 'request_invalidated', message: 'Authentication request was invalidated' };
        }
        console.warn('[OpenWatchParty] Invalid token endpoint JSON:', err);
        return authError('invalid_json', 'OpenWatchParty token endpoint returned invalid JSON', isCurrentRequest);
      }
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: 'Authentication request was invalidated' };
      }
      if (data.auth_enabled === true && typeof data.token === 'string' && data.token) {
        state.authBlocked = false;
        state.authError = '';
        state.userId = data.user_id || '';
        state.userName = data.user_name || getJellyfinUsername() || '';
        state.wsUrl = data.session_server_url || '';
        state.authEnabled = true;
        state.authToken = data.token;
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
        state.wsUrl = data.session_server_url || '';
        state.authEnabled = false;
        state.authToken = null;
        state.tokenExpiresAt = 0;
        console.log('[OpenWatchParty] Explicit insecure mode enabled, connecting without token');
        return { mode: 'insecure', token: null };
      }
      return authError(
        'invalid_response',
        'OpenWatchParty token endpoint returned an invalid authentication response',
        isCurrentRequest
      );
    } catch (err) {
      if (!isCurrentRequest()) {
        return { mode: 'error', code: 'request_invalidated', message: 'Authentication request was invalidated' };
      }
      console.warn('[OpenWatchParty] Error fetching auth token:', err);
      if (timedOut) {
        return authError('timeout', 'OpenWatchParty token request timed out', isCurrentRequest);
      }
      if (err?.name === 'AbortError') {
        return authError('aborted', 'OpenWatchParty token request was aborted', isCurrentRequest);
      }
      return authError('network_error', 'Could not reach the OpenWatchParty token endpoint', isCurrentRequest);
    } finally {
      if (requestTimeout !== null) OWP.timers.clear(requestTimeout);
    }
  };

  Object.assign(actions, { fetchAuthToken, ensureTokenRefresh });
})();
