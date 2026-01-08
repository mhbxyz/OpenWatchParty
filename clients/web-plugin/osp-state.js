(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.state) return;

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

  OSP.constants = {
    PANEL_ID: 'osp-panel',
    BTN_ID: 'osp-osd-btn',
    STYLE_ID: 'osp-style',
    HOME_SECTION_ID: 'osp-home-section',
    protocol,
    host,
    DEFAULT_WS_URL: `${protocol}//${host}:3000/ws`,
    SUPPRESS_MS: 2000,
    SEEK_THRESHOLD: 2.5,
    STATE_UPDATE_MS: 2000,        // Increased from 1000ms - less aggressive state updates
    SYNC_LEAD_MS: 300,            // Compensates processing + initial HLS buffer
    DRIFT_DEADZONE_SEC: 0.04,
    DRIFT_SOFT_MAX_SEC: 8.0,      // Only seek beyond 8s drift
    PLAYBACK_RATE_MIN: 0.90,      // Allow slowdown if ahead
    PLAYBACK_RATE_MAX: 1.20,      // More aggressive catch-up (imperceptible with pitch correction)
    DRIFT_GAIN: 0.15,             // For sqrt curve: 0.15 * sqrt(2s) ≈ 0.21 → 1.21x
    // Interval timings (P2 optimization)
    UI_CHECK_MS: 2000,            // UI button injection check
    PING_MS: 10000,               // Ping interval (increased from 3s)
    HOME_REFRESH_MS: 5000,        // Home watch parties refresh (increased from 2s)
    SYNC_LOOP_MS: 500             // Sync loop for playback rate correction
  };

  OSP.state = {
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
    serverOffsetMs: 0,
    lastSeekSentAt: 0,
    lastStateSentAt: 0,
    lastSentPosition: 0,
    hasTimeSync: false,
    pendingActionTimer: null,
    homeRoomCache: new LRUCache(50),
    lastParticipantCount: 0,
    joiningItemId: '',
    roomName: '',
    participantCount: 0,
    lastSyncServerTs: 0,
    lastSyncPosition: 0,
    lastSyncPlayState: '',
    readyRoomId: '',
    isBuffering: false,
    wantsToPlay: false,
    isSyncing: false,
    // Authentication
    authToken: null,
    authEnabled: false,
    userId: '',
    userName: '',
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
