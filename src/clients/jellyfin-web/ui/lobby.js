(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { DEFAULT_WS_URL } = OWP.constants;
  const { createElement, createCloseButton } = views;


  const CREATE_ROOM_HINT_ID = 'owp-create-hint';


  // A room starts from what is playing; without it there is nothing to share.
  const canCreateRoom = () => Boolean(OWP.utils?.getPlayingItemId?.());


  const updateCreateRoomButton = () => {
    const button = document.getElementById('owp-btn-create');
    if (!button) return;
    const enabled = canCreateRoom();
    button.disabled = !enabled;
    const hint = document.getElementById(CREATE_ROOM_HINT_ID);
    if (hint) hint.hidden = enabled;
  };


  const SERVER_LABEL_ID = 'owp-server-label';


  // Host and path, without the scheme and the /ws endpoint. Only the parts
  // that are safe to show, should a URL ever carry more.
  const serverLabel = (value) => {
    try {
      const url = new URL(value);
      if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) return t('unavailable');
      return `${url.host}${url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '')}`;
    } catch (err) {
      return t('unavailable');
    }
  };


  // Token refresh can change the configured URL without replacing the socket.
  // While connected, show the active socket's target, not the next connection's.
  const updateServerLabel = () => {
    const label = document.getElementById(SERVER_LABEL_ID);
    const target = state.ws?.readyState === 1 ? state.ws.url : state.wsUrl || DEFAULT_WS_URL;
    if (label) label.textContent = serverLabel(String(target));
  };


  const HELP_ID = 'owp-help';

  const HELP_BUTTON_ID = 'owp-btn-help';


  const applyLobbyHelp = () => {
    const help = document.getElementById(HELP_ID);
    if (help) help.hidden = !state.lobbyHelpOpen;
    const button = document.getElementById(HELP_BUTTON_ID);
    if (button) button.setAttribute('aria-expanded', String(state.lobbyHelpOpen));
  };


  const setLobbyHelpOpen = (open) => {
    state.lobbyHelpOpen = open;
    applyLobbyHelp();
  };


  // Its button disappears with the help, so focus goes back to the "?".
  const closeLobbyHelp = () => {
    setLobbyHelpOpen(false);
    const button = document.getElementById(HELP_BUTTON_ID);
    if (button) button.focus();
  };


  const ANNOUNCER_ID = 'owp-announcer';

  const ANNOUNCE_DELAY_MS = 100;


  // A polite live region, so that screen readers read out what appears without
  // taking focus. It is added empty and filled a moment later: a region added
  // with its text already in place is often not read.
  const announce = (text) => {
    let region = document.getElementById(ANNOUNCER_ID);
    if (!region) {
      region = createElement('div', 'owp-visually-hidden');
      region.id = ANNOUNCER_ID;
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    region.textContent = '';
    OWP.timers.setTimeout(() => { region.textContent = text; }, ANNOUNCE_DELAY_MS);
  };


  // The first-run help opens the panel by itself, without moving focus.
  const announceLobbyHelp = () => announce(`${t('watchParty')}: ${t('lobbyHelp')}`);


  const createLobbyHelp = () => {
    const help = createElement('div', 'owp-help');
    help.id = HELP_ID;
    const ok = createElement('button', 'owp-pill-btn secondary owp-help-ok', t('gotIt'));
    ok.type = 'button';
    ok.onclick = closeLobbyHelp;
    help.append(createElement('span', '', t('lobbyHelp')), ok);
    help.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeLobbyHelp();
    });
    return help;
  };


  const createHelpButton = () => {
    const button = createElement('button', 'owp-bar-btn owp-help-btn', '?');
    button.id = HELP_BUTTON_ID;
    button.type = 'button';
    button.title = t('help');
    button.setAttribute('aria-label', t('help'));
    button.setAttribute('aria-controls', HELP_ID);
    button.onclick = () => setLobbyHelpOpen(!state.lobbyHelpOpen);
    return button;
  };


  const renderLobby = (panel) => {
    const header = createElement('div', 'owp-header');
    header.append(createElement('span', 'owp-panel-title', 'OpenWatchParty'), document.createTextNode(' '));
    const status = createElement('span');
    status.id = 'owp-ws-indicator';
    const actions = createElement('span', 'owp-header-actions');
    actions.append(status, createHelpButton(), createCloseButton());
    header.appendChild(actions);

    const lobby = createElement('div', 'owp-lobby-container');
    const roomSection = createElement('div', 'owp-section');
    roomSection.appendChild(createElement('div', 'owp-label', t('availableRooms')));
    const roomList = createElement('div');
    roomList.id = 'owp-room-list';
    roomSection.appendChild(roomList);
    const createSection = createElement('div', 'owp-section owp-create-section');
    const btn = createElement('button', 'owp-btn', t('createRoom'));
    btn.id = 'owp-btn-create';
    btn.style.width = '100%';
    btn.onclick = () => OWP.actions && OWP.actions.createRoom && OWP.actions.createRoom();
    btn.setAttribute('aria-describedby', CREATE_ROOM_HINT_ID);
    const hint = createElement('div', 'owp-hint', t('createRoomHint'));
    hint.id = CREATE_ROOM_HINT_ID;
    createSection.append(btn, hint);
    lobby.append(roomSection, createSection);

    const footer = createElement('div', 'owp-footer');
    const server = createElement('span');
    server.id = SERVER_LABEL_ID;
    footer.append(document.createTextNode(t('server')), server);
    panel.replaceChildren(header, createLobbyHelp(), lobby, footer);
    applyLobbyHelp();
    ui.updateRoomListUI();
    updateCreateRoomButton();
    updateServerLabel();
  };

  Object.assign(views, { renderLobby, updateServerLabel });
  Object.assign(ui, { updateCreateRoomButton, setLobbyHelpOpen, announceLobbyHelp });
})();
