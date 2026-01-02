(() => {
  const OSP = window.OpenSyncParty = window.OpenSyncParty || {};
  if (OSP.state) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;

  OSP.constants = {
    PANEL_ID: 'osp-panel',
    BTN_ID: 'osp-osd-btn',
    STYLE_ID: 'osp-style',
    HOME_SECTION_ID: 'osp-home-section',
    protocol,
    host,
    DEFAULT_WS_URL: `${protocol}//${host}:3000/ws`,
    SUPPRESS_MS: 1000,
    SEEK_THRESHOLD: 0.5,
    STATE_UPDATE_MS: 1000,
    SYNC_LEAD_MS: 120,
    DRIFT_DEADZONE_SEC: 0.04,
    DRIFT_SOFT_MAX_SEC: 1.0,
    PLAYBACK_RATE_MIN: 0.95,
    PLAYBACK_RATE_MAX: 1.05,
    DRIFT_GAIN: 0.5
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
    homeRoomCache: new Map(),
    lastParticipantCount: 0,
    joiningItemId: '',
    roomName: '',
    participantCount: 0,
    lastSyncServerTs: 0,
    lastSyncPosition: 0,
    lastSyncPlayState: '',
    readyRoomId: ''
  };
})();
