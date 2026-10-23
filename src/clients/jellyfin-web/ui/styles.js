(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const {
    PANEL_ID,
    STYLE_ID,
    SYNCPLAY_HIDE_STYLE_ID,
    APPEARANCE_STYLE_ID,
    MODERN_HEADER_BTN_ID,
    PANEL_HEADER_CLASS,
    PANEL_BUBBLE_CLASS,
    ROOM_MODE_CLASS,
    APPEARANCE
  } = OWP.constants;

  // Jellyfin's built-in SyncPlay button: `.headerSyncButton` in the legacy
  // header, and the MUI toolbar button that opens the `app-sync-play-menu`.
  const NATIVE_SYNCPLAY_CSS =
    '.headerSyncButton, button[aria-controls="app-sync-play-menu"] { display: none !important; }';

  // Sizes in the panel and the toasts follow the text size setting: each one
  // is written for the original 12 px text and multiplied by --owp-scale.
  const px = n => `calc(${n}px * var(--owp-scale))`;

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
    /* Appearance settings: text scale and surface opacity (applyAppearance) */
    #${PANEL_ID}, .owp-toast-container, .owp-toast-system, .owp-queue-next, .owp-start-float {
      --owp-scale: ${APPEARANCE.textSize.default / APPEARANCE.baseTextSize};
      --owp-surface-alpha: ${APPEARANCE.opacity.default / 100};
    }
    @media (prefers-reduced-transparency: reduce) {
      #${PANEL_ID}, .owp-toast-container, .owp-toast-system, .owp-queue-next, .owp-start-float { --owp-surface-alpha: 1 !important; }
    }
    /* Same look as the room bar: dark grey, soft border, Jellyfin's font */
    #${PANEL_ID} {
      position: fixed; top: 72px; right: 20px; width: ${px(360)}; max-width: calc(100vw - 40px); max-height: min(${px(450)}, calc(100vh - 88px));
      padding: ${px(10)} ${px(12)}; border-radius: ${px(12)}; background: rgba(38, 38, 36, var(--owp-surface-alpha));
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      color: #ecebe6; font-family: inherit; font-size: ${px(12)}; z-index: 20000;
      border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 ${px(4)} ${px(16)} rgba(0,0,0,0.35);
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
    #${PANEL_ID}.${PANEL_HEADER_CLASS}.${PANEL_BUBBLE_CLASS} { right: auto; width: ${px(360)}; max-width: calc(100vw - 16px); }
    #${PANEL_ID}.${PANEL_BUBBLE_CLASS}::before {
      content: ''; position: absolute; top: ${px(-6)}; left: var(--owp-arrow-left, 50%); margin-left: ${px(-6)};
      width: ${px(10)}; height: ${px(10)}; transform: rotate(45deg); background: rgba(38, 38, 36, var(--owp-surface-alpha));
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      /* Only the half above the panel, which would otherwise show twice */
      clip-path: polygon(0 0, 100% 0, 0 100%);
      border-left: 1px solid rgba(255,255,255,0.14); border-top: 1px solid rgba(255,255,255,0.14);
    }
    /* In a room the panel is only the bar and its drop-down, each with its own
       background: a dark grey pill with outline icons and soft tinted states. */
    /* The bar fits the room name between a minimum (room for the chat input)
       and a maximum (longer names end in an ellipsis); it stays on the right. */
    #${PANEL_ID}.${ROOM_MODE_CLASS} {
      left: auto; width: auto; min-width: min(${px(300)}, calc(100vw - 40px)); max-width: min(${px(420)}, calc(100vw - 40px));
      padding: 0; gap: ${px(6)}; font-family: inherit; font-size: ${px(12)}; color: #ecebe6;
      background: none; border: none; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none;
    }
    @media (max-width: 420px) {
      #${PANEL_ID}.${ROOM_MODE_CLASS} { left: 8px; right: 8px; min-width: 0; max-width: none; }
    }
    .owp-room-bar, .owp-room-drop {
      background: rgba(38, 38, 36, var(--owp-surface-alpha)); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 ${px(4)} ${px(16)} rgba(0,0,0,0.35);
    }
    .owp-room-bar {
      display: flex; align-items: center; gap: ${px(4)}; flex-shrink: 0;
      padding: ${px(5)} ${px(6)} ${px(5)} ${px(10)}; border-radius: ${px(20)};
    }
    .owp-room-bar .owp-sync-dot { width: ${px(7)}; height: ${px(7)}; flex-shrink: 0; }
    .owp-room-bar .owp-sync-dot.synced { background: #97c459; }
    .owp-room-bar .owp-sync-spinner { flex-shrink: 0; }
    /* Fixed width, so the bar does not jump when the latency gains a digit */
    .owp-room-bar .owp-latency {
      min-width: 3.4em; font-size: ${px(11)}; font-variant-numeric: tabular-nums;
      color: #9a9993; white-space: nowrap; margin: 0 ${px(4)} 0 ${px(2)};
    }
    .owp-room-name { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .owp-icon {
      width: ${px(15)}; height: ${px(15)}; flex-shrink: 0;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }
    /* Watch Party icon of the header and player buttons: the size of a native icon */
    .owp-watch-party-icon svg { display: block; width: 1em; height: 1em; }
    .owp-bar-btn {
      display: inline-flex; align-items: center; gap: ${px(3)}; flex-shrink: 0; height: ${px(24)}; padding: 0 ${px(6)};
      border: none; border-radius: ${px(12)}; background: transparent; color: #a6a59f;
      cursor: pointer; font-family: inherit; font-size: ${px(12)};
    }
    .owp-bar-btn:hover, .owp-bar-btn:focus-visible { background: rgba(255,255,255,0.08); color: #ecebe6; }
    .owp-bar-btn[aria-expanded="true"] { background: #0c447c; color: #85b7eb; }
    .owp-bar-btn.danger { color: #f09595; }
    .owp-bar-btn.danger[aria-expanded="true"] { background: #791f1f; color: #f09595; }
    .owp-bar-btn .owp-expand { width: ${px(12)}; height: ${px(12)}; transition: transform 0.15s; }
    .owp-bar-btn[aria-expanded="true"] .owp-expand { transform: rotate(180deg); }
    /* As wide as the bar, without widening it: long chat lines wrap instead */
    .owp-room-drop {
      width: 0; min-width: 100%; box-sizing: border-box;
      min-height: 0; overflow-y: auto; padding: ${px(8)} ${px(10)}; border-radius: ${px(10)};
    }
    .owp-room-drop[hidden], .owp-room-drop > [hidden] { display: none !important; }
    .owp-leave-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: ${px(8)}; }
    .owp-leave-question { flex: 1; }
    .owp-leave-hint {
      flex-basis: 100%; width: 100%; font-size: ${px(12)}; line-height: 1.35;
      color: rgba(255,255,255,.6); overflow-wrap: anywhere;
    }
    .owp-pill-btn {
      height: ${px(24)}; padding: 0 ${px(8)}; border-radius: ${px(12)}; cursor: pointer; font-family: inherit; font-size: ${px(12)};
    }
    .owp-pill-btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.45); color: #ecebe6; }
    .owp-pill-btn.danger { background: #a83232; border: none; color: #fff; }
    .owp-pill-btn.primary { background: #1a63ad; border: none; color: #fff; }
    .owp-pill-btn.primary:hover { background: #2274c7; color: #fff; }
    .owp-pill-btn.primary[aria-disabled="true"] { background: rgba(255,255,255,0.06); color: #85847e; cursor: not-allowed; }
    .owp-pill-btn.secondary[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
    .owp-pill-btn.owp-pill-icon { display: inline-flex; align-items: center; gap: ${px(4)}; }
    .owp-pill-btn .owp-icon { width: ${px(12)}; height: ${px(12)}; }
    /* The room queue: watched items dimmed, the room's item in blue */
    .owp-queue-head { display: flex; align-items: center; gap: ${px(6)}; margin-bottom: ${px(4)}; }
    .owp-queue-title { flex: 1; font-weight: 500; }
    .owp-queue-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
    .owp-queue-item { display: flex; align-items: center; gap: ${px(6)}; min-width: 0; padding: ${px(3)} ${px(4)}; border-radius: ${px(6)}; }
    .owp-queue-mark {
      width: ${px(15)}; display: flex; justify-content: center; flex-shrink: 0;
      color: #85847e; font-size: ${px(11)}; font-variant-numeric: tabular-nums;
    }
    .owp-queue-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .owp-queue-item.done { color: #85847e; }
    .owp-queue-item.current { background: rgba(12, 68, 124, 0.55); color: #e6f1fb; }
    .owp-queue-item.current .owp-queue-mark, .owp-queue-now { color: #85b7eb; }
    .owp-queue-now { font-size: ${px(11)}; flex-shrink: 0; }
    .owp-queue-actions { display: flex; flex-shrink: 0; }
    .owp-queue-actions .owp-bar-btn { height: ${px(22)}; padding: 0 ${px(4)}; }
    .owp-queue-actions .owp-bar-btn[aria-disabled="true"] { opacity: 0.35; cursor: default; }
    .owp-queue-note { margin-top: ${px(6)}; font-size: ${px(11)}; color: #85847e; }
    /* "Up next": under the bar, or on its own where the bar would be */
    .owp-queue-next {
      position: relative; overflow: hidden; display: flex; flex-wrap: wrap; align-items: center; gap: ${px(6)} ${px(8)};
      padding: ${px(6)} ${px(8)} ${px(6)} ${px(10)}; border-radius: ${px(12)}; box-sizing: border-box;
      background: rgba(38, 38, 36, var(--owp-surface-alpha)); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 ${px(4)} ${px(16)} rgba(0,0,0,0.35);
    }
    .owp-queue-next.owp-queue-float {
      position: fixed; top: 72px; right: 20px; z-index: 20000;
      min-width: min(${px(300)}, calc(100vw - 40px)); max-width: min(${px(420)}, calc(100vw - 40px));
      color: #ecebe6; font-family: inherit; font-size: ${px(12)};
    }
    @media (max-width: 420px) {
      .owp-queue-next.owp-queue-float { left: 8px; right: 8px; min-width: 0; max-width: none; }
    }
    .owp-queue-next-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .owp-queue-next-text b { font-weight: 500; }
    .owp-queue-next-time { font-weight: 700; font-variant-numeric: tabular-nums; color: #85b7eb; flex-shrink: 0; }
    .owp-queue-next-actions { width: 100%; display: flex; justify-content: flex-end; gap: ${px(6)}; }
    .owp-queue-next-bar { position: absolute; left: 0; bottom: 0; height: ${px(2)}; background: #85b7eb; }
    /* A play waiting for the members, or counting down: in place of the room's name */
    .owp-start-label {
      flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: ${px(4)};
      padding: 0; border: none; background: none; color: #ecebe6; font: inherit; font-weight: 500;
      white-space: nowrap; overflow: hidden; cursor: default;
    }
    .owp-start-label.owp-start-action { cursor: pointer; }
    .owp-start-label .owp-icon { width: ${px(14)}; height: ${px(14)}; }
    .owp-start-num { font-weight: 700; font-variant-numeric: tabular-nums; color: #85b7eb; }
    /* On its own where the room bar would be, while the panel is closed */
    .owp-start-label.owp-start-float {
      flex: none; position: fixed; top: 72px; right: 20px; z-index: 20000;
      padding: ${px(8)} ${px(12)}; border-radius: ${px(20)}; font-family: inherit; font-size: ${px(12)};
      background: rgba(38, 38, 36, var(--owp-surface-alpha)); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 ${px(4)} ${px(16)} rgba(0,0,0,0.35);
    }
    /* The sync adjustment drop-down: where the guest is, and the nudge */
    .owp-nudge-row { display: flex; align-items: center; gap: ${px(8)}; }
    .owp-nudge-state { flex: 1; min-width: 0; display: flex; align-items: center; gap: ${px(6)}; font-weight: 500; }
    .owp-nudge-state .owp-sync-dot { width: ${px(7)}; height: ${px(7)}; flex-shrink: 0; }
    .owp-nudge-state .owp-sync-dot.synced { background: #97c459; }
    .owp-nudge-state .owp-sync-dot.idle { background: #85847e; }
    .owp-nudge-sub { margin-top: ${px(5)}; font-size: ${px(11)}; color: #9a9993; line-height: 1.45; }
    .owp-nudge-sub[hidden] { display: none; }
    /* Same size as the MUI SVG icons next to it (MuiSvgIcon fontSizeMedium) */
    #${MODERN_HEADER_BTN_ID} .material-icons { font-size: 1.5rem; width: 1em; height: 1em; line-height: 1; }
    .owp-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: ${px(8)}; padding-bottom: ${px(8)}; border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .owp-panel-title { font-size: ${px(13)}; font-weight: 500; }
    .owp-header-actions { display: flex; align-items: center; gap: ${px(6)}; }
    .owp-ws-status { display: inline-flex; align-items: center; gap: ${px(5)}; font-size: ${px(11)}; color: #9a9993; }
    .owp-ws-status::before { content: ''; width: ${px(7)}; height: ${px(7)}; border-radius: 50%; background: #97c459; }
    .owp-ws-status.offline::before { background: #f09595; }
    .owp-close-btn { margin-left: 0; padding: 0 ${px(6)}; }
    .owp-section { margin-bottom: ${px(10)}; overflow-y: auto; }
    .owp-create-section { margin-bottom: 0; padding-top: ${px(10)}; border-top: 1px solid rgba(255,255,255,0.1); }
    .owp-label { font-size: ${px(11)}; color: #9a9993; margin-bottom: ${px(6)}; }
    .owp-room-item {
      display: flex; justify-content: space-between; align-items: center; gap: ${px(8)}; cursor: pointer;
      margin-bottom: ${px(6)}; padding: ${px(8)} ${px(10)}; border-radius: ${px(8)};
      background: rgba(255,255,255,0.04); border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
    }
    .owp-room-item:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.14); }
    .owp-room-title { font-weight: 500; }
    .owp-room-count { font-size: ${px(11)}; color: #9a9993; }
    .owp-room-empty { padding: ${px(8)}; text-align: center; color: #9a9993; }
    .owp-card-count {
      position: absolute; left: 0.5em; bottom: 0.5em; z-index: 1; max-width: calc(100% - 1em); box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.55em; border-radius: 0.4em;
      background: rgba(0,0,0,0.7); color: #fff; font-size: 0.8em; line-height: 1.3; white-space: nowrap;
    }
    .owp-card-count .material-icons { font-size: 1.25em; line-height: 1; }
    .owp-card-count-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .owp-btn {
      height: ${px(26)}; padding: 0 ${px(12)}; border: none; border-radius: ${px(13)}; cursor: pointer;
      background: #1a63ad; color: #fff; font-family: inherit; font-size: ${px(12)}; font-weight: 500;
    }
    .owp-btn:hover { background: #2274c7; color: #fff; }
    .owp-btn.danger { background: #a83232; color: #fff; }
    .owp-btn:disabled { background: rgba(255,255,255,0.06); color: #85847e; cursor: not-allowed; }
    .owp-hint { font-size: ${px(11)}; color: #9a9993; margin-top: ${px(6)}; text-align: center; }
    /* The lobby help and its "?" button; the button turns blue while it is open */
    .owp-help-btn { width: ${px(24)}; padding: 0; justify-content: center; font-size: ${px(13)}; font-weight: 600; }
    .owp-help {
      display: flow-root; margin-bottom: ${px(10)}; padding: ${px(8)} ${px(10)}; border-radius: ${px(8)};
      background: rgba(255,255,255,0.04); line-height: 1.5; text-align: justify;
      flex-shrink: 0;
    }
    .owp-help[hidden] { display: none; }
    /* Floats beside the last line, so it does not need a line of its own */
    .owp-help-ok { float: right; margin: ${px(6)} 0 0 ${px(8)}; }
    .owp-room-note { font-size: ${px(11)}; color: #ef9f27; }
    .owp-participants { display: flex; flex-direction: column; }
    .owp-participant { display: flex; align-items: center; gap: ${px(6)}; min-width: 0; padding: ${px(4)} 0; }
    .owp-participant-avatar {
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      width: ${px(20)}; height: ${px(20)}; border-radius: 50%; background: #0c447c; color: #85b7eb; font-size: ${px(11)};
    }
    .owp-participant-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* With a status: the name and the Host badge on top, the status below */
    .owp-participant.owp-has-status { align-items: flex-start; }
    .owp-participant.owp-has-status .owp-participant-avatar { margin-top: ${px(2)}; }
    .owp-participant-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .owp-participant-line { display: flex; align-items: center; gap: ${px(6)}; min-width: 0; }
    .owp-participant-status { display: flex; align-items: center; gap: ${px(5)}; margin-top: ${px(1)}; font-size: ${px(11)}; }
    /* The dot sits on the middle of the letters, not of the line box */
    .owp-participant-status::before {
      content: ''; flex-shrink: 0; position: relative; top: 0.05em;
      width: ${px(7)}; height: ${px(7)}; border-radius: 50%; background: currentColor;
    }
    .owp-participant-status.good { color: #97c459; }
    .owp-participant-status.warn { color: #ef9f27; }
    .owp-participant-status.info { color: #85b7eb; }
    .owp-participant-status.bad { color: #f09595; }
    .owp-participant-status.idle { color: #85847e; }
    .owp-host-badge {
      flex-shrink: 0; padding: 0 ${px(4)}; border-radius: ${px(5)};
      background: #27500a; color: #97c459; font-size: ${px(11)};
    }
    .owp-input {
      width: 100%; padding: ${px(12)}; border-radius: ${px(8)}; border: 1px solid #444;
      background: #000; color: #fff; box-sizing: border-box; margin-bottom: ${px(10)}; font-size: ${px(14)};
    }
    .owp-footer { font-size: ${px(11)}; color: #9a9993; text-align: center; margin-top: auto; padding-top: ${px(8)}; }
    .owp-select {
      width: 100%; padding: ${px(8)} ${px(10)}; border-radius: ${px(6)}; border: 1px solid #444;
      background: #000; color: #fff; box-sizing: border-box; font-size: ${px(13)};
      cursor: pointer; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M6 8L2 4h8z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right ${px(10)} center;
    }
    .owp-select:focus { border-color: #1565c0; outline: none; }
    .owp-checkbox-row {
      display: flex; align-items: center; gap: ${px(8)}; margin-top: ${px(8)}; font-size: ${px(12)}; color: #aaa;
    }
    .owp-checkbox-row input { accent-color: #388e3c; }
    /* Sync status indicator styles */
    .owp-sync-dot { width: ${px(8)}; height: ${px(8)}; border-radius: 50%; }
    .owp-sync-dot.synced { background: #69f0ae; }
    .owp-sync-dot.syncing { background: #ffd740; animation: owp-pulse 1s infinite; }
    .owp-sync-dot.pending { background: #ff9800; animation: owp-pulse 0.5s infinite; }
    @keyframes owp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .owp-sync-spinner { width: ${px(12)}; height: ${px(12)}; border: ${px(2)} solid #444; border-top-color: #ff9800; border-radius: 50%; animation: owp-spin 0.8s linear infinite; }
    @keyframes owp-spin { to { transform: rotate(360deg); } }
    /* Chat styles (the chat drop-down of the room bar) */
    #owp-chat-section { display: flex; flex-direction: column; }
    #owp-chat-messages { max-height: ${px(160)}; overflow-y: auto; }
    #owp-chat-messages:empty { display: none; }
    .owp-chat-message { position: relative; padding: ${px(3)} 0; line-height: 1.4; }
    .owp-chat-message.owp-chat-own .owp-chat-username { color: #97c459; }
    .owp-chat-meta, .owp-chat-text { display: inline; }
    .owp-chat-username { font-weight: 500; color: #85b7eb; margin-right: ${px(4)}; }
    /* Hidden on screen like the mockup, still read by screen readers */
    .owp-chat-time, .owp-visually-hidden {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    .owp-chat-text { color: #ecebe6; word-wrap: break-word; }
    /* OWP's own lines (SERVER): a small tag and italic text; errors in red */
    .owp-chat-message.owp-chat-system .owp-chat-username {
      font-size: ${px(9)}; font-weight: 700; letter-spacing: 0.06em; color: #c2c0b6;
      background: rgba(255,255,255,0.1); border-radius: ${px(4)}; padding: 0 ${px(4)}; vertical-align: 0.1em;
    }
    .owp-chat-message.owp-chat-system .owp-chat-text { color: #c2c0b6; font-style: italic; }
    .owp-chat-message.owp-chat-error .owp-chat-text { color: #f09595; }
    #owp-chat-input-container { display: flex; gap: ${px(6)}; }
    #owp-chat-messages:not(:empty) + #owp-chat-input-container { margin-top: ${px(6)}; padding-top: ${px(6)}; border-top: 1px solid rgba(255,255,255,0.1); }
    #owp-chat-input {
      flex: 1; min-width: 0; padding: ${px(4)} ${px(8)}; border-radius: ${px(6)}; border: 1px solid rgba(255,255,255,0.14);
      background: transparent; color: #ecebe6; font-family: inherit; font-size: ${px(12)};
    }
    #owp-chat-input::placeholder { color: #9a9993; }
    #owp-chat-input:focus { border-color: #85b7eb; outline: none; }
    #owp-chat-send {
      display: inline-flex; align-items: center; height: ${px(24)}; padding: 0 ${px(8)};
      border: none; border-radius: ${px(12)}; background: #0c447c; color: #85b7eb; cursor: pointer;
    }
    #owp-chat-send:hover { background: #185fa5; color: #e6f1fb; }
    .owp-chat-badge { display: none; padding: 0 ${px(5)}; border-radius: ${px(8)}; background: #791f1f; color: #f09595; font-size: ${px(11)}; line-height: 1.45; }
    /* Toast styles */
    /* Bottom right, so chat toasts do not cover the room bar at the top */
    .owp-toast-container {
      position: fixed; bottom: 100px; right: 20px; z-index: 30000;
      display: flex; flex-direction: column; gap: ${px(8)}; pointer-events: none;
    }
    .owp-toast {
      background: rgba(38, 38, 36, var(--owp-surface-alpha)); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      color: #ecebe6; padding: ${px(8)} ${px(12)};
      border-radius: ${px(10)}; font-size: ${px(12)}; max-width: ${px(320)};
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 ${px(4)} ${px(16)} rgba(0,0,0,0.35); pointer-events: auto; cursor: pointer;
      animation: owp-toast-in 0.3s ease-out;
      transition: transform 0.3s ease-out, opacity 0.3s ease-out;
    }
    .owp-toast.owp-toast-out {
      animation: owp-toast-out 0.3s ease-in forwards;
    }
    .owp-toast-username { font-weight: 500; color: #85b7eb; margin-right: ${px(4)}; }
    .owp-toast-text { color: #ecebe6; word-wrap: break-word; }
    .owp-toast-system {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(20, 20, 20, var(--owp-surface-alpha)); color: #fff; padding: ${px(12)} ${px(20)};
      border-radius: ${px(8)}; font-size: ${px(13)}; z-index: 30000;
      backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 ${px(4)} ${px(20)} rgba(0,0,0,0.5); cursor: pointer;
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

  // A value the plugin did not send (an older plugin) or that is out of its
  // range falls back to the default.
  const appearanceValue = (value, { min, max, step, default: fallback }) => (
    Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0 ? value : fallback
  );

  // The appearance settings from the plugin, as the variables the styles use.
  // :root makes them win over the defaults in the main stylesheet whatever
  // the order of the two; prefers-reduced-transparency still wins.
  const applyAppearance = () => {
    const opacity = appearanceValue(OWP.state.appearanceOpacity, APPEARANCE.opacity);
    const textSize = appearanceValue(OWP.state.appearanceTextSize, APPEARANCE.textSize);
    let style = document.getElementById(APPEARANCE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = APPEARANCE_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `:root #${PANEL_ID}, :root .owp-toast-container, :root .owp-toast-system, :root .owp-queue-next, :root .owp-start-float {`
      + ` --owp-scale: ${textSize / APPEARANCE.baseTextSize}; --owp-surface-alpha: ${opacity / 100}; }`;
  };

  Object.assign(ui, { injectStyles, applyNativeSyncPlayVisibility, applyAppearance });
})();
