(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  if (OWP.state) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;

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

  OWP.constants = {
    PANEL_ID: 'owp-panel',
    BTN_ID: 'owp-osd-btn',
    STYLE_ID: 'owp-style',
    HOME_SECTION_ID: 'owp-home-section',
    protocol,
    host,
    DEFAULT_WS_URL: `${protocol}//${host}:3000/ws`,
    SUPPRESS_MS: 2000,
    SEEK_THRESHOLD: 1.0,          // Reduced from 2.5s - smaller seeks now broadcast (UX-P2)
    STATE_UPDATE_MS: 1000,        // Reduced from 2000ms - more responsive state updates (UX-P1)
    SYNC_LEAD_MS: 300,            // Compensates processing + initial HLS buffer
    DRIFT_DEADZONE_SEC: 0.04,
    DRIFT_SOFT_MAX_SEC: 2.0,      // Seek to correct if drift > 2s
    PLAYBACK_RATE_MIN: 0.85,      // Allow slowdown if ahead
    PLAYBACK_RATE_MAX: 2.0,       // Aggressive catch-up (browser pitch correction preserves audio)
    DRIFT_GAIN: 0.50,             // For sqrt curve: 0.50 * sqrt(1s) = 0.50 → 1.50x at 1s drift
    // Interval timings (P2 optimization)
    UI_CHECK_MS: 2000,            // UI button injection check
    PING_MS: 10000,               // Ping interval (increased from 3s)
    HOME_REFRESH_MS: 5000,        // Home watch parties refresh (increased from 2s)
    SYNC_LOOP_MS: 500,            // Sync loop for playback rate correction
    RECONNECT_BASE_MS: 1000,      // Base reconnect delay (1s)
    RECONNECT_MAX_MS: 30000,      // Max reconnect delay (30s)
    INITIAL_SYNC_COOLDOWN_MS: 8000, // Cooldown after join to let playback rate catch up (not HARD_SEEK)
    INITIAL_SYNC_MAX_MS: 30000,   // Max time for initial sync before allowing HARD_SEEK
    INITIAL_SYNC_DRIFT_THRESHOLD: 0.5, // Drift threshold to exit initial sync early
    INITIAL_SYNC_MAX_DRIFT: 10   // Max drift (seconds) before forcing HARD_SEEK during initial sync
  };

  OWP.state = {
    ws: null,
    roomId: '',
    clientId: '',
    name: '',
    isHost: false,
    followHost: true,
    suppressUntil: 0,
    rooms: [],
    inRoom: false,
    bound: false,
    autoReconnect: true,
    isConnecting: false,
    reconnectAttempts: 0,        // For exponential backoff
    initialized: false,
    // Log buffering (for logs sent before WS connected)
    logBuffer: [],
    logBufferMax: 100,
    serverOffsetMs: 0,
    lastSeekSentAt: 0,
    lastStateSentAt: 0,
    lastSentPosition: 0,
    hasTimeSync: false,
    pendingActionTimer: null,
    homeRoomCache: new LRUCache(50),
    lastParticipantCount: 0,
    joiningItemId: '',
    pendingJoinRoomId: '',  // Room to join after navigating to video player
    roomName: '',
    participantCount: 0,
    lastSyncServerTs: 0,
    lastSyncPosition: 0,
    lastSyncPlayState: '',
    readyRoomId: '',
    isBuffering: false,
    wantsToPlay: false,
    isSyncing: false,
    syncCooldownUntil: 0,  // Timestamp until which position updates are ignored (after resume)
    isInitialSync: false,  // True during initial catch-up after joining (disables HARD_SEEK)
    initialSyncUntil: 0,   // Timestamp when initial sync phase ends (max duration)
    initialSyncTargetPos: 0, // Target position when joining - used to detect/fix Jellyfin resume jumps
    syncStatus: 'synced',  // 'synced' | 'syncing' | 'pending_play' - for UX indicator (UX-P3)
    currentDrift: 0,       // Current playback drift in seconds (positive = behind host)
    pendingPlayUntil: 0,   // Timestamp when pending play ends (for spinner) (UX-P3)
    // Authentication
    authToken: null,
    authEnabled: false,
    userId: '',
    userName: '',
    tokenExpiresAt: 0,           // Timestamp when token expires
    tokenRefreshTimer: null,     // Timer for token refresh
    // Interval tracking (P4 - memory leak prevention)
    intervals: {
      ui: null,
      ping: null,
      home: null,
      sync: null,
      stateUpdate: null
    },
    // Video event listener cleanup
    videoListeners: null,
    currentVideoElement: null
  };
})();
