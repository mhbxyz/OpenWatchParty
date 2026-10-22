(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.state && OWP.stateFactories && OWP.stateLifecycle) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;

  const deferredOperations = new Map();
  const clearDeferred = (handle) => {
    const operation = deferredOperations.get(handle);
    if (!operation) return false;
    deferredOperations.delete(handle);
    operation.clear(handle);
    return true;
  };
  const createDeferred = (kind, callback, delay, scope, args) => {
    let handle;
    let completed = false;
    const run = (...callbackArgs) => {
      if (kind === 'timeout') {
        completed = true;
        deferredOperations.delete(handle);
      }
      callback(...callbackArgs);
    };
    const schedule = (kind === 'timeout' ? window.setTimeout : window.setInterval).bind(window);
    const clear = (kind === 'timeout' ? window.clearTimeout : window.clearInterval).bind(window);
    handle = schedule(run, delay, ...args);
    if (!completed) deferredOperations.set(handle, { kind, scope, clear });
    return handle;
  };

  OWP.timers = OWP.timers || {
    setTimeout(callback, delay, scope = 'lifecycle', ...args) {
      return createDeferred('timeout', callback, delay, scope, args);
    },
    setInterval(callback, delay, scope = 'lifecycle', ...args) {
      return createDeferred('interval', callback, delay, scope, args);
    },
    clear: clearDeferred,
    clearScope(scope) {
      for (const [handle, operation] of [...deferredOperations]) {
        if (operation.scope === scope) clearDeferred(handle);
      }
    },
    clearAll() {
      for (const handle of [...deferredOperations.keys()]) clearDeferred(handle);
    },
    count(scope) {
      if (scope === undefined) return deferredOperations.size;
      let count = 0;
      for (const operation of deferredOperations.values()) {
        if (operation.scope === scope) count++;
      }
      return count;
    }
  };

  // LRU Cache implementation for image URLs
  class LRUCache {
    constructor(maxSize = 50) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }

    get(key) {
      if (!this.cache.has(key)) return undefined;
      // Move to end (most recently used)
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }

    set(key, value) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        // Remove oldest (first) entry
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }

    has(key) {
      return this.cache.has(key);
    }

    clear() {
      this.cache.clear();
    }
  }

  OWP.constants = OWP.constants || {
    PANEL_ID: 'owp-panel',
    HEADER_BTN_CLASS: 'owp-header-btn',
    LEGACY_HEADER_BTN_ID: 'owp-header-btn-legacy',
    MODERN_HEADER_BTN_ID: 'owp-header-btn-modern',
    PANEL_HEADER_CLASS: 'owp-panel-header',
    PANEL_BUBBLE_CLASS: 'owp-panel-bubble',
    ROOM_MODE_CLASS: 'owp-room-mode',
    STYLE_ID: 'owp-style',
    SYNCPLAY_HIDE_STYLE_ID: 'owp-hide-native-syncplay',
    APPEARANCE_STYLE_ID: 'owp-appearance',
    // Appearance of the room bar, its drop-downs, the lobby and the toasts:
    // the same ranges as the plugin settings.
    APPEARANCE: {
      baseTextSize: 12,
      opacity: { min: 40, max: 100, step: 5, default: 55 },
      textSize: { min: 12, max: 18, step: 1, default: 14 }
    },
    HOME_SECTION_ID: 'owp-home-section',
    PROTOCOL_VERSION: 1,          // WebSocket protocol version declared in the auth message
    CLIENT_FEATURES: ['host_transfer', 'participant_status', 'shared_playback_control', 'media_queue'],
    protocol,
    host,
    DEFAULT_WS_URL: `${protocol}//${host}:3000/ws`,
    SUPPRESS_MS: 2000,
    SEEK_THRESHOLD: 1.0,          // Minimum position change for broadcasting a seek or correcting received playback
    QUEUE_COUNTDOWN_MS: 10000,    // How long the server shows "up next" before the room moves to the next queue item
    OWN_COMMAND_HOLD_MS: 1500,    // A guest's own play or pause holds against room updates already on their way
    STATE_UPDATE_MS: 1000,        // Playback status cadence; the sender also throttles updates to this interval
    SYNC_LEAD_MS: 300,            // Compensates processing + initial HLS buffer
    DRIFT_DEADZONE_SEC: 0.04,
    DRIFT_SOFT_MAX_SEC: 2.0,      // Seek to correct if drift > 2s
    PLAYBACK_RATE_MIN: 0.90,      // Slowdown when ahead
    PLAYBACK_RATE_MAX: 1.15,      // Catch-up when behind, gentle enough that voices stay natural
    DRIFT_GAIN: 0.15,             // For sqrt curve: 0.15 * sqrt(1s) = 0.15 → 1.15x at 1s drift
    // Manual sync adjustment (the room bar's nudge, for guests)
    NUDGE_STEP_SEC: 0.5,          // Largest move toward the host per nudge
    NUDGE_MIN_DRIFT_SEC: 0.15,    // Closer than this counts as in sync: nothing to nudge
    NUDGE_MIN_MOVE_SEC: 0.05,     // A smaller move is not worth a seek
    NUDGE_BUFFER_MARGIN_SEC: 0.1, // Kept inside the buffered range, so a nudge never waits for a segment
    DRIFT_TRACK_GAP_MS: 2000,     // A longer pause in drift tracking starts a new out-of-sync count
    // Interval timings (P2 optimization)
    UI_CHECK_MS: 2000,            // UI button injection check
    PING_INIT_MS: 2000,            // Fast ping interval (clock convergence)
    PING_STABLE_MS: 30000,         // Stable ping interval (after convergence)
    PING_STABLE_AFTER: 5,          // Pongs before switching to stable interval
    HOME_REFRESH_MS: 5000,        // Home watch parties refresh (increased from 2s)
    SYNC_LOOP_MS: 500,            // Sync loop for playback rate correction
    PARTICIPANT_STATUS_HOLD_MS: 1000, // A status must hold this long before it is sent to the room
    RECONNECT_BASE_MS: 1000,      // Base reconnect delay (1s)
    RECONNECT_MAX_MS: 30000,      // Max reconnect delay (30s)
    AUTH_RETRY_BASE_MS: 5000,     // First retry delay after a blocked authentication (5s)
    AUTH_RETRY_MAX_MS: 300000,    // Max retry delay after a blocked authentication (5min)
    AUTH_TOAST_SUPPRESS_MS: 30000, // Do not repeat the same auth error toast (30s)
    ROOM_REJOIN_TIMEOUT_MS: 5000,
    MEDIA_READY_POLL_MS: 100,
    MEDIA_READY_TIMEOUT_MS: 15000,
    MEDIA_SWITCH_GRACE_MS: 20000, // Player closed by OWP to open the room media (> MEDIA_READY_TIMEOUT_MS)
    STREAM_RELOAD_MAX_MS: 30000,  // Longest the room waits for the host's stream to reload (track change)
    VIDEO_ACTION_RETRY_MS: 50,
    VIDEO_ACTION_MAX_WAIT_MS: 2000,
    INITIAL_SYNC_COOLDOWN_MS: 8000, // Cooldown after join to let playback rate catch up (not HARD_SEEK)
    INITIAL_SYNC_MAX_MS: 30000,   // Max time for initial sync before allowing HARD_SEEK
    INITIAL_SYNC_DRIFT_THRESHOLD: 0.5, // Drift threshold to exit initial sync early
    INITIAL_SYNC_MAX_DRIFT: 10,  // Max drift (seconds) before forcing HARD_SEEK during initial sync
    // Time sync (hybrid min-delay + EMA)
    TIME_SYNC_MAX_SAMPLES: 8,    // Number of samples in circular buffer
    TIME_SYNC_EMA_ALPHA: 0.4     // EMA smoothing coefficient
  };

  // Factories are the sole defaults for each domain; resets never copy credentials
  // or reset monotonic attempt counters from a whole-state snapshot.

  // The room's queue, from queue_state when the server has media_queue.
  const createQueueState = () => ({
    queueItems: [],         // [{ id, title }]
    queueCurrent: null,     // Index of the room's item in queueItems, or null
    queueCountdownUntil: 0, // Server time the room moves to the next item, 0 without a countdown
    queueLastAdded: null,   // The item the room's queue_add appended last, where filling goes on
    queueReceived: false,   // Whether queue_state came since entering the room or reconnecting
  });

  const createRoomState = () => ({
    roomId: '',
    isHost: false,
    inRoom: false,
    roomName: '',
    participantCount: 0,
    participants: [],      // [{ name, isHost, status }] from participant_list and participant_statuses
    lastParticipantCount: 0,
    statusesRoomId: '',    // The room whose server sent participant_statuses: it accepts participant_status
    statusCandidate: '',   // This client's status, and since when, until it holds long enough to send
    statusCandidateSince: 0,
    statusSentKey: '',     // room|client|status last sent, so a status is sent once per room and connection
    lastSyncServerTs: 0,
    lastSyncPosition: 0,
    lastSyncPlayState: '',
    roomWaiting: false,
    roomHostId: '',
    roomMediaId: '',       // The room's item, from room_state: a change is a queue advance
    sharedPlaybackControl: false,
    readyRoomId: '',
    ...createQueueState(),
  });

  const createRoomPlaybackState = () => ({
    suppressUntil: 0,
    pendingActionTimer: null,
    playbackBlocked: false,
    playbackFailureNotified: false,
    joiningItemId: '',
    pendingMediaId: '',
    mediaSwitchUntil: 0,   // Until then, a closed player is OWP opening the room media
    pendingMediaUntil: 0,
    pendingJoinRoomId: '',  // Room to join after navigating to video player
    guestPaused: false,
    ownCommandUntil: 0,
    ownCommandPlayState: '',
    hostAppliedPlayState: '', // Filters play/pause events generated by an applied room command
    hostPendingPlayState: '', // Lets a newer local control supersede a scheduled room command
    hostControlAcks: [], // Bounded local host controls awaiting a server confirmation
    isBuffering: false,
    wantsToPlay: false,
    streamReloadUntil: 0,  // While the host's stream reloads in place (audio or subtitle track change)
    lastPlayedPosition: 0, // Where the video last played, and whether it was playing, before a reload empties it
    lastPlayedPlaying: false,
    streamReloadResume: false, // Whether the room was playing when the reload started
    reloadGuestCommand: null, // A guest's play or pause that came during the host's stream reload
    isSyncing: false,
    syncCooldownUntil: 0,  // Timestamp until which position updates are ignored (after resume)
    isInitialSync: false,  // True during initial catch-up after joining (disables HARD_SEEK)
    initialSyncUntil: 0,   // Timestamp when initial sync phase ends (max duration)
    initialSyncTargetPos: null, // Target position when joining; null means no pending target
    syncStatus: 'synced',  // 'synced' | 'syncing' | 'pending_play' - displayed by the sync indicator
    currentDrift: 0,       // Current playback drift in seconds (positive = behind host)
    outOfSyncSince: 0,     // Since when this guest is out of sync, shown by the sync adjustment
    driftCheckedAt: 0,     // Last time trackDrift ran; a longer gap restarts the count
    pendingPlayUntil: 0,   // Server-clock deadline for pending playback; sync correction waits until it passes
  });

  const createConnectionSessionState = () => ({
    clientId: '',
    isConnecting: false,
    connectionPhase: 'disconnected', // disconnected | connecting | authenticating | authenticated
    successfulPings: 0,
    timeSyncSamples: [],         // Circular buffer of { rtt, offset, ts } for hybrid time sync
    lastRttMs: null,             // Latest ping round trip, shown in the room bar; null until the first pong
  });

  const createConnectionState = () => ({
    ws: null,
    ...createConnectionSessionState(),
    autoReconnect: true,
    wsUrl: '',
    reconnectAttempts: 0,        // For exponential backoff
    reconnectTimer: null,
    connectionAttempt: 0,
    serverFeatures: [],
    desiredRoomId: '',
    rejoinPending: false,
    rejectedRejoinRoomIds: [],
    roomRejoinTimer: null,
    serverOffsetMs: 0,
    hasTimeSync: false,
  });

  const createPlaybackState = () => ({
    ...createRoomPlaybackState(),
    bound: false,
    lastSeekSentAt: 0,
    lastStateSentAt: 0,
    lastSentPosition: 0,
    playbackActionAttempt: 0,
    playbackRequestAttempt: 0,
    autoJoinAttempt: 0,
    cardPollAttempt: 0,
    mediaSyncAttempt: 0,
    mediaReadyCleanup: null,
    videoListeners: null,
    currentVideoElement: null,
  });

  const createAuthenticationState = () => ({
    authToken: null,
    authEnabled: false,
    authBlocked: false,
    authError: '',
    authRequestAttempt: 0,
    authFailedToken: '',         // Jellyfin token that was rejected when auth got blocked
    authRetryAttempts: 0,        // Consecutive retries of the same blocked token
    authRetryAt: 0,              // Timestamp before which no retry may happen
    lastAuthToastMessage: '',    // Last auth error shown, for toast de-duplication
    lastAuthToastAt: 0,
    userId: '',
    userName: '',
    tokenExpiresAt: 0,           // Timestamp when token expires
    tokenRefreshTimer: null,     // Timer for token refresh
  });

  const createRoomUIState = () => ({
    roomBarSection: '',    // Drop-down open under the room bar: 'people', 'chat', 'leave' or ''
  });

  const createUIState = () => ({
    ...createRoomUIState(),
    name: '',
    rooms: [],
    initialized: false,
    logBuffer: [],
    logBufferMax: 100,
    homeRoomCache: new LRUCache(50),
    lobbyHelpOpen: false,  // The help at the top of the lobby, opened with its "?" button
    intervals: {
      ui: null,
      ping: null,
      home: null,
      sync: null,
      stateUpdate: null
    },
  });

  const createInviteWorkState = () => ({
    pendingInviteTicket: '',     // Ticket parsed from the page URL, consumed after authentication
    inviteJoinPending: false,    // True while joining a room through an invite link
  });

  const createPreferencesState = () => ({
    followHost: true,
    hideNativeSyncPlayButton: false,
    showSyncNudge: false,       // The plugin offers guests the sync adjustment in the room bar
    appearanceOpacity: OWP.constants.APPEARANCE.opacity.default,   // Surface opacity in percent
    appearanceTextSize: OWP.constants.APPEARANCE.textSize.default, // Base text size in px
    inviteTtlSeconds: 3600,      // Lifetime requested for new invite tickets
  });

  const createState = () => ({
    ...createConnectionState(),
    ...createRoomState(),
    ...createPlaybackState(),
    ...createAuthenticationState(),
    ...createUIState(),
    ...createInviteWorkState(),
    ...createPreferencesState()
  });

  OWP.stateFactories = {
    createState, createRoomState, createQueueState, createRoomPlaybackState, createConnectionSessionState,
    createRoomUIState, createInviteWorkState
  };
  // A loader retry can encounter state from an already loaded module. Install
  // missing helpers without replacing the live state or its timer registry.
  OWP.state = OWP.state || createState();
  OWP.stateLifecycle = {
    releaseVideoBinding() {
      const state = OWP.state;
      // Release callbacks before discarding their handles or replacing a video.
      if (state.currentVideoElement && state.videoListeners) {
        for (const [event, listener] of Object.entries(state.videoListeners)) {
          if (listener) state.currentVideoElement.removeEventListener(event, listener);
        }
      }
      OWP.timers.clearScope('video');
      if (state.intervals.stateUpdate) OWP.timers.clear(state.intervals.stateUpdate);
      state.intervals.stateUpdate = null;
      state.videoListeners = null;
      state.currentVideoElement = null;
      state.bound = false;
    }
  };
})();
