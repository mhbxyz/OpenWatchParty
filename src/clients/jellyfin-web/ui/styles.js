(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const {
    PANEL_ID,
    STYLE_ID,
    SYNCPLAY_HIDE_STYLE_ID,
    HEADER_BTN_CLASS,
    MODERN_HEADER_BTN_ID,
    PANEL_HEADER_CLASS,
    PANEL_BUBBLE_CLASS,
    ROOM_MODE_CLASS
  } = OWP.constants;

  // Jellyfin's built-in SyncPlay button: `.headerSyncButton` in the legacy
  // header, and the MUI toolbar button that opens the `app-sync-play-menu`.
  const NATIVE_SYNCPLAY_CSS =
    '.headerSyncButton, button[aria-controls="app-sync-play-menu"] { display: none !important; }';

  const CSS_STYLES = `
    html.owp-guest-locked .videoOsdBottom .btnPreviousTrack,
    html.owp-guest-locked .videoOsdBottom .btnNextTrack,
    html.owp-guest-locked .videoOsdBottom .btnPreviousChapter,
    html.owp-guest-locked .videoOsdBottom .btnNextChapter,
    html.owp-guest-locked .videoOsdBottom .btnRewind,
    html.owp-guest-locked .videoOsdBottom .btnFastForward {
      opacity: 0.3 !important; cursor: not-allowed !important;
    }
    html.owp-guest-locked .videoOsdBottom .owp-position-slider-container {
      opacity: 0.45 !important; pointer-events: none !important;
    }
    html.owp-guest-locked .videoOsdBottom .osdPositionSlider {
      pointer-events: none !important;
    }
    html.owp-guest-play-locked .videoOsdBottom .btnPause {
      opacity: 0.3 !important; cursor: not-allowed !important;
    }
    #owp-guest-lock-label {
      display: flex; align-items: center; gap: 0.35em; margin: 0.6em 0 0.2em 0.5em;
      font-size: 0.85em; color: rgba(255,255,255,0.75); pointer-events: none;
    }
    #owp-guest-lock-label .owp-guest-lock-icon { font-size: 1.15em; }
    /* Same look as the room bar: dark grey, soft border, Jellyfin's font */
    #${PANEL_ID} {
      position: fixed; top: 72px; right: 20px; width: 360px; max-width: calc(100vw - 40px); max-height: min(450px, calc(100vh - 88px));
      padding: 10px 12px; border-radius: 12px; background: rgba(38, 38, 36, 0.97);
      color: #ecebe6; font-family: inherit; font-size: 12px; z-index: 20000;
      border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      display: flex; flex-direction: column; box-sizing: border-box;
    }
    #${PANEL_ID}.hide { display: none; }
    /* Opened from the header: placed below it (top is set when it opens) */
    #${PANEL_ID}.${PANEL_HEADER_CLASS} { bottom: auto; }
    @media (max-width: 600px) {
      #${PANEL_ID}.${PANEL_HEADER_CLASS} { left: 8px; right: 8px; width: auto; }
    }
    /* The lobby opened from the header hangs from its button like a speech
       bubble: left and the arrow position are set when it is placed */
    #${PANEL_ID}.${PANEL_HEADER_CLASS}.${PANEL_BUBBLE_CLASS} { right: auto; width: 360px; max-width: calc(100vw - 16px); }
    #${PANEL_ID}.${PANEL_BUBBLE_CLASS}::before {
      content: ''; position: absolute; top: -6px; left: var(--owp-arrow-left, 50%); margin-left: -6px;
      width: 10px; height: 10px; transform: rotate(45deg); background: rgb(38, 38, 36);
      border-left: 1px solid rgba(255,255,255,0.14); border-top: 1px solid rgba(255,255,255,0.14);
    }
    /* The player has its own Watch Party button */
    .osdHeader .${HEADER_BTN_CLASS} { display: none !important; }
    /* In a room the panel is only the bar and its drop-down, each with its own
       background: a dark grey pill with outline icons and soft tinted states. */
    /* The bar fits the room name between a minimum (room for the chat input)
       and a maximum (longer names end in an ellipsis); it stays on the right. */
    #${PANEL_ID}.${ROOM_MODE_CLASS} {
      left: auto; width: auto; min-width: 300px; max-width: min(420px, calc(100vw - 40px));
      padding: 0; gap: 6px; font-family: inherit; font-size: 12px; color: #ecebe6;
      background: none; border: none; box-shadow: none;
    }
    @media (max-width: 420px) {
      #${PANEL_ID}.${ROOM_MODE_CLASS} { left: 8px; right: 8px; min-width: 0; max-width: none; }
    }
    .owp-room-bar, .owp-room-drop {
      background: rgba(38, 38, 36, 0.97); border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    .owp-room-bar {
      display: flex; align-items: center; gap: 4px; flex-shrink: 0;
      padding: 5px 6px 5px 10px; border-radius: 20px;
    }
    .owp-room-bar .owp-sync-dot { width: 7px; height: 7px; flex-shrink: 0; }
    .owp-room-bar .owp-sync-dot.synced { background: #97c459; }
    .owp-room-bar .owp-sync-spinner { flex-shrink: 0; }
    /* Fixed width, so the bar does not jump when the latency gains a digit */
    .owp-room-bar .owp-latency {
      min-width: 3.4em; font-size: 11px; font-variant-numeric: tabular-nums;
      color: #9a9993; white-space: nowrap; margin: 0 4px 0 2px;
    }
    .owp-room-name { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .owp-icon {
      width: 15px; height: 15px; flex-shrink: 0;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    /* Watch Party icon of the header and player buttons: the size of a native icon */
    .owp-watch-party-icon svg { display: block; width: 1em; height: 1em; }
    .owp-bar-btn {
      display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; height: 24px; padding: 0 6px;
      border: none; border-radius: 12px; background: transparent; color: #a6a59f;
      cursor: pointer; font-family: inherit; font-size: 12px;
    }
    .owp-bar-btn:hover, .owp-bar-btn:focus-visible { background: rgba(255,255,255,0.08); color: #ecebe6; }
    .owp-bar-btn[aria-expanded="true"] { background: #0c447c; color: #85b7eb; }
    .owp-bar-btn.danger { color: #f09595; }
    .owp-bar-btn.danger[aria-expanded="true"] { background: #791f1f; color: #f09595; }
    .owp-bar-btn .owp-expand { width: 12px; height: 12px; transition: transform 0.15s; }
    .owp-bar-btn[aria-expanded="true"] .owp-expand { transform: rotate(180deg); }
    /* As wide as the bar, without widening it: long chat lines wrap instead */
    .owp-room-drop {
      width: 0; min-width: 100%; box-sizing: border-box;
      min-height: 0; overflow-y: auto; padding: 8px 10px; border-radius: 10px;
    }
    .owp-room-drop[hidden], .owp-room-drop > [hidden] { display: none !important; }
    .owp-leave-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .owp-leave-question { flex: 1; }
    .owp-leave-hint {
      flex-basis: 100%; width: 100%; font-size: 12px; line-height: 1.35;
      color: rgba(255,255,255,.6); overflow-wrap: anywhere;
    }
    .owp-pill-btn {
      height: 24px; padding: 0 8px; border-radius: 12px; cursor: pointer; font-family: inherit; font-size: 12px;
    }
    .owp-pill-btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.25); color: #a6a59f; }
    .owp-pill-btn.danger { background: #791f1f; border: none; color: #f09595; }
    .owp-pill-btn.primary { background: #0c447c; border: none; color: #85b7eb; }
    .owp-pill-btn.primary:hover { background: #185fa5; color: #e6f1fb; }
    .owp-pill-btn.primary[aria-disabled="true"] { background: rgba(255,255,255,0.06); color: #85847e; cursor: not-allowed; }
    /* The sync adjustment drop-down: where the guest is, and the nudge */
    .owp-nudge-row { display: flex; align-items: center; gap: 8px; }
    .owp-nudge-state { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-weight: 500; }
    .owp-nudge-state .owp-sync-dot { width: 7px; height: 7px; flex-shrink: 0; }
    .owp-nudge-state .owp-sync-dot.synced { background: #97c459; }
    .owp-nudge-state .owp-sync-dot.idle { background: #85847e; }
    .owp-nudge-sub { margin-top: 5px; font-size: 11px; color: #9a9993; line-height: 1.45; }
    .owp-nudge-sub[hidden] { display: none; }
    /* Same size as the MUI SVG icons next to it (MuiSvgIcon fontSizeMedium) */
    #${MODERN_HEADER_BTN_ID} .material-icons { font-size: 1.5rem; width: 1em; height: 1em; line-height: 1; }
    .owp-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .owp-panel-title { font-size: 13px; font-weight: 500; }
    .owp-header-actions { display: flex; align-items: center; gap: 6px; }
    .owp-ws-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #9a9993; }
    .owp-ws-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #97c459; }
    .owp-ws-status.offline::before { background: #f09595; }
    .owp-close-btn { margin-left: 0; padding: 0 6px; }
    .owp-section { margin-bottom: 10px; overflow-y: auto; }
    .owp-create-section { margin-bottom: 0; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
    .owp-label { font-size: 11px; color: #9a9993; margin-bottom: 6px; }
    .owp-room-item {
      display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: pointer;
      margin-bottom: 6px; padding: 8px 10px; border-radius: 8px;
      background: rgba(255,255,255,0.04); border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
    }
    .owp-room-item:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.14); }
    .owp-room-title { font-weight: 500; }
    .owp-room-count { font-size: 11px; color: #9a9993; }
    .owp-room-empty { padding: 8px; text-align: center; color: #9a9993; }
    .owp-card-count {
      position: absolute; left: 0.5em; bottom: 0.5em; z-index: 1; max-width: calc(100% - 1em); box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.55em; border-radius: 0.4em;
      background: rgba(0,0,0,0.7); color: #fff; font-size: 0.8em; line-height: 1.3; white-space: nowrap;
    }
    .owp-card-count .material-icons { font-size: 1.25em; line-height: 1; }
    .owp-card-count-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .owp-btn {
      height: 26px; padding: 0 12px; border: none; border-radius: 13px; cursor: pointer;
      background: #0c447c; color: #85b7eb; font-family: inherit; font-size: 12px; font-weight: 500;
    }
    .owp-btn:hover { background: #185fa5; color: #e6f1fb; }
    .owp-btn.danger { background: #791f1f; color: #f09595; }
    .owp-btn:disabled { background: rgba(255,255,255,0.06); color: #85847e; cursor: not-allowed; }
    .owp-hint { font-size: 11px; color: #9a9993; margin-top: 6px; text-align: center; }
    /* The lobby help and its "?" button; the button turns blue while it is open */
    .owp-help-btn { width: 24px; padding: 0; justify-content: center; font-size: 13px; font-weight: 600; }
    .owp-help {
      display: flow-root; margin-bottom: 10px; padding: 8px 10px; border-radius: 8px;
      background: rgba(255,255,255,0.04); line-height: 1.5; text-align: justify;
      flex-shrink: 0;
    }
    .owp-help[hidden] { display: none; }
    /* Floats beside the last line, so it does not need a line of its own */
    .owp-help-ok { float: right; margin: 6px 0 0 8px; }
    .owp-room-note { font-size: 11px; color: #ef9f27; }
    .owp-participants { display: flex; flex-direction: column; }
    .owp-participant { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 0; }
    .owp-participant-avatar {
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      width: 20px; height: 20px; border-radius: 50%; background: #0c447c; color: #85b7eb; font-size: 11px;
    }
    .owp-participant-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* With a status: the name and the Host badge on top, the status below */
    .owp-participant.owp-has-status { align-items: flex-start; }
    .owp-participant.owp-has-status .owp-participant-avatar { margin-top: 2px; }
    .owp-participant-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .owp-participant-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .owp-participant-status { display: flex; align-items: center; gap: 5px; margin-top: 1px; font-size: 11px; }
    /* The dot sits on the middle of the letters, not of the line box */
    .owp-participant-status::before {
      content: ''; flex-shrink: 0; position: relative; top: 0.05em;
      width: 7px; height: 7px; border-radius: 50%; background: currentColor;
    }
    .owp-participant-status.good { color: #97c459; }
    .owp-participant-status.warn { color: #ef9f27; }
    .owp-participant-status.info { color: #85b7eb; }
    .owp-participant-status.bad { color: #f09595; }
    .owp-participant-status.idle { color: #85847e; }
    .owp-host-badge {
      flex-shrink: 0; padding: 0 4px; border-radius: 5px;
      background: #27500a; color: #97c459; font-size: 11px;
    }
    .owp-input {
      width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444;
      background: #000; color: #fff; box-sizing: border-box; margin-bottom: 10px; font-size: 14px;
    }
    .owp-footer { font-size: 11px; color: #9a9993; text-align: center; margin-top: auto; padding-top: 8px; }
    .owp-select {
      width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #444;
      background: #000; color: #fff; box-sizing: border-box; font-size: 13px;
      cursor: pointer; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M6 8L2 4h8z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
    }
    .owp-select:focus { border-color: #1565c0; outline: none; }
    .owp-checkbox-row {
      display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: #aaa;
    }
    .owp-checkbox-row input { accent-color: #388e3c; }
    /* UX-P3: Sync status indicator styles */
    .owp-sync-dot { width: 8px; height: 8px; border-radius: 50%; }
    .owp-sync-dot.synced { background: #69f0ae; }
    .owp-sync-dot.syncing { background: #ffd740; animation: owp-pulse 1s infinite; }
    .owp-sync-dot.pending { background: #ff9800; animation: owp-pulse 0.5s infinite; }
    @keyframes owp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .owp-sync-spinner { width: 12px; height: 12px; border: 2px solid #444; border-top-color: #ff9800; border-radius: 50%; animation: owp-spin 0.8s linear infinite; }
    @keyframes owp-spin { to { transform: rotate(360deg); } }
    /* Chat styles (the chat drop-down of the room bar) */
    #owp-chat-section { display: flex; flex-direction: column; }
    #owp-chat-messages { max-height: 160px; overflow-y: auto; }
    #owp-chat-messages:empty { display: none; }
    .owp-chat-message { position: relative; padding: 3px 0; line-height: 1.4; }
    .owp-chat-message.owp-chat-own .owp-chat-username { color: #97c459; }
    .owp-chat-meta, .owp-chat-text { display: inline; }
    .owp-chat-username { font-weight: 500; color: #85b7eb; margin-right: 4px; }
    /* Hidden on screen like the mockup, still read by screen readers */
    .owp-chat-time, .owp-visually-hidden {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    .owp-chat-text { color: #ecebe6; word-wrap: break-word; }
    #owp-chat-input-container { display: flex; gap: 6px; }
    #owp-chat-messages:not(:empty) + #owp-chat-input-container { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.1); }
    #owp-chat-input {
      flex: 1; min-width: 0; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.14);
      background: transparent; color: #ecebe6; font-family: inherit; font-size: 12px;
    }
    #owp-chat-input::placeholder { color: #9a9993; }
    #owp-chat-input:focus { border-color: #85b7eb; outline: none; }
    #owp-chat-send {
      display: inline-flex; align-items: center; height: 24px; padding: 0 8px;
      border: none; border-radius: 12px; background: #0c447c; color: #85b7eb; cursor: pointer;
    }
    #owp-chat-send:hover { background: #185fa5; color: #e6f1fb; }
    .owp-chat-badge { display: none; padding: 0 5px; border-radius: 8px; background: #791f1f; color: #f09595; font-size: 11px; line-height: 1.45; }
    /* Toast styles */
    /* Bottom right, so chat toasts do not cover the room bar at the top */
    .owp-toast-container {
      position: fixed; bottom: 100px; right: 20px; z-index: 30000;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
    }
    .owp-toast {
      background: rgba(38, 38, 36, 0.97); color: #ecebe6; padding: 8px 12px;
      border-radius: 10px; font-size: 12px; max-width: 320px;
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 4px 16px rgba(0,0,0,0.35); pointer-events: auto; cursor: pointer;
      animation: owp-toast-in 0.3s ease-out;
      transition: transform 0.3s ease-out, opacity 0.3s ease-out;
    }
    .owp-toast.owp-toast-out {
      animation: owp-toast-out 0.3s ease-in forwards;
    }
    .owp-toast-username { font-weight: 500; color: #85b7eb; margin-right: 4px; }
    .owp-toast-text { color: #ecebe6; word-wrap: break-word; }
    .owp-toast-system {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(20, 20, 20, 0.95); color: #fff; padding: 12px 20px;
      border-radius: 8px; font-size: 13px; z-index: 30000;
      backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); cursor: pointer;
      animation: owp-toast-system-in 0.3s ease-out;
    }
    .owp-toast-system.owp-toast-out {
      animation: owp-toast-system-out 0.3s ease-in forwards;
    }
    @keyframes owp-toast-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes owp-toast-out {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(20px); }
    }
    @keyframes owp-toast-system-in {
      from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    @keyframes owp-toast-system-out {
      from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      to { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
    }
  `;

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  };

  // Hides or restores the native SyncPlay button to match the plugin setting.
  // A stylesheet, rather than removing the buttons, survives Jellyfin
  // re-rendering its headers.
  const applyNativeSyncPlayVisibility = () => {
    const existing = document.getElementById(SYNCPLAY_HIDE_STYLE_ID);
    if (!OWP.state.hideNativeSyncPlayButton) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = SYNCPLAY_HIDE_STYLE_ID;
    style.textContent = NATIVE_SYNCPLAY_CSS;
    document.head.appendChild(style);
  };

  Object.assign(ui, { injectStyles, applyNativeSyncPlayVisibility });
})();
