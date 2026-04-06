(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const { PANEL_ID, STYLE_ID } = OWP.constants;

  const CSS_STYLES = `
    #${PANEL_ID} {
      position: fixed; bottom: 100px; right: 20px; width: 300px; max-height: 450px;
      padding: 16px; border-radius: 12px; background: rgba(10, 10, 10, 0.98);
      backdrop-filter: blur(20px); color: #fff; font-family: sans-serif; z-index: 20000;
      border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 12px 40px rgba(0,0,0,0.8);
      display: flex; flex-direction: column;
    }
    #${PANEL_ID}.hide { display: none; }
    .owp-header { font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 8px; }
    .owp-section { margin-bottom: 15px; overflow-y: auto; }
    .owp-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
    .owp-room-item {
      background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 8px;
      display: flex; justify-content: space-between; align-items: center; cursor: pointer;
      border: 1px solid transparent; transition: all 0.2s;
    }
    .owp-room-item:hover { background: rgba(255,255,255,0.1); border-color: #1565c0; }
    .owp-btn {
      border: none; border-radius: 6px; padding: 10px 15px;
      background: #388e3c; color: #fff; cursor: pointer; font-weight: bold; font-size: 13px;
    }
    .owp-btn.secondary { background: #1565c0; }
    .owp-btn.danger { background: #d32f2f; }
    .owp-input {
      width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444;
      background: #000; color: #fff; box-sizing: border-box; margin-bottom: 10px; font-size: 14px;
    }
    .owp-footer { font-size: 10px; color: #555; text-align: center; margin-top: auto; padding-top: 10px; }
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
    .owp-sync-status { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-top: 8px; padding: 6px 8px; border-radius: 4px; background: rgba(255,255,255,0.05); }
    .owp-sync-dot { width: 8px; height: 8px; border-radius: 50%; }
    .owp-sync-dot.synced { background: #69f0ae; }
    .owp-sync-dot.syncing { background: #ffd740; animation: owp-pulse 1s infinite; }
    .owp-sync-dot.pending { background: #ff9800; animation: owp-pulse 0.5s infinite; }
    @keyframes owp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .owp-sync-spinner { width: 12px; height: 12px; border: 2px solid #444; border-top-color: #ff9800; border-radius: 50%; animation: owp-spin 0.8s linear infinite; }
    @keyframes owp-spin { to { transform: rotate(360deg); } }
    /* Chat styles */
    #owp-chat-section { display: flex; flex-direction: column; height: 180px; border-top: 1px solid #333; margin-top: 10px; padding-top: 10px; }
    #owp-chat-messages { flex: 1; overflow-y: auto; padding: 4px 0; font-size: 12px; }
    .owp-chat-message { margin-bottom: 8px; padding: 4px 0; }
    .owp-chat-message.owp-chat-own .owp-chat-username { color: #69f0ae; }
    .owp-chat-meta { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
    .owp-chat-username { font-weight: bold; color: #64b5f6; font-size: 11px; }
    .owp-chat-time { font-size: 10px; color: #666; }
    .owp-chat-text { color: #ddd; word-wrap: break-word; line-height: 1.4; }
    #owp-chat-input-container { display: flex; gap: 8px; padding-top: 8px; border-top: 1px solid #333; }
    #owp-chat-input { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #444; background: #111; color: #fff; font-size: 12px; }
    #owp-chat-input:focus { border-color: #1565c0; outline: none; }
    #owp-chat-send { padding: 8px 12px; border-radius: 6px; border: none; background: #1565c0; color: #fff; cursor: pointer; font-size: 12px; }
    #owp-chat-send:hover { background: #1976d2; }
    .owp-chat-badge { display: none; background: #d32f2f; color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 10px; margin-left: 4px; }
    .owp-global-btn {
      margin-right: 10px;
      color: #fff;
      opacity: 0.92;
    }
    .owp-global-btn:hover {
      opacity: 1;
      color: #69f0ae;
    }
    /* Toast styles */
    .owp-toast-container {
      position: fixed; top: 70px; right: 20px; z-index: 30000;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
    }
    .owp-toast {
      background: rgba(20, 20, 20, 0.95); color: #fff; padding: 10px 14px;
      border-radius: 8px; font-size: 13px; max-width: 320px;
      backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); pointer-events: auto; cursor: pointer;
      animation: owp-toast-in 0.3s ease-out;
      transition: transform 0.3s ease-out, opacity 0.3s ease-out;
    }
    .owp-toast.owp-toast-out {
      animation: owp-toast-out 0.3s ease-in forwards;
    }
    .owp-toast-username { font-weight: bold; color: #64b5f6; margin-right: 6px; }
    .owp-toast-text { color: #eee; word-wrap: break-word; }
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

  Object.assign(ui, { injectStyles });
})();
