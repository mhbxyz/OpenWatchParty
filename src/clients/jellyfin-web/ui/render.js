(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;
  const { PANEL_ID, BTN_ID, DEFAULT_WS_URL, ROOM_MODE_CLASS } = OWP.constants;

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  // Outline icons for the room bar, from Tabler Icons (MIT, https://tabler.io/icons;
  // see THIRD_PARTY_NOTICES.md). Jellyfin only ships the filled Material icons.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    users: ['M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2', 'M16 3.13a4 4 0 0 1 0 7.75', 'M21 21v-2a4 4 0 0 0 -3 -3.85'],
    chat: ['M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1'],
    logout: ['M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2', 'M9 12h12l-3 -3', 'M18 15l3 -3'],
    x: ['M18 6l-12 12', 'M6 6l12 12'],
    chevron: ['M6 9l6 6l6 -6'],
    send: ['M10 14l11 -11', 'M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5'],
    share: ['M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M8.7 10.7l6.6 -3.4', 'M8.7 13.3l6.6 3.4'],
    refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4']
  };

  // The Watch Party icon for the header and player buttons: a screen with a
  // play button and two viewers. Original artwork contributed to the project
  // by francotosqui, drawn on Material's 24 grid with 2-unit lines so it sits
  // next to Jellyfin's own icons (Cast, Search) at the same size and weight.
  const WATCH_PARTY_ICON = [
    ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', d: 'M5.9 15H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2.9' }],
    ['path', { d: 'M10.2 6.9v4.6l4-2.3z' }],
    ['circle', { cx: '8.6', cy: '14.8', r: '1.9' }],
    ['circle', { cx: '15.4', cy: '14.8', r: '1.9' }],
    ['path', { d: 'M5 21a3.6 3.1 0 0 1 7.2 0zM11.8 21a3.6 3.1 0 0 1 7.2 0z' }]
  ];

  // Wrapped in `.material-icons` so it takes the size the native icons get in
  // each button.
  const createWatchPartyIcon = () => {
    const wrapper = createElement('span', 'material-icons owp-watch-party-icon');
    wrapper.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('focusable', 'false');
    WATCH_PARTY_ICON.forEach(([tag, attributes]) => {
      const shape = document.createElementNS(SVG_NS, tag);
      Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, value));
      svg.appendChild(shape);
    });
    wrapper.appendChild(svg);
    return wrapper;
  };
  // The header buttons (ui/header.js) use it too.
  ui.createWatchPartyIcon = createWatchPartyIcon;

  const createIcon = (name) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `owp-icon owp-icon-${name}`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    ICON_PATHS[name].forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  };

  // Hides the panel. Keyboard focus inside it must not stay in a hidden panel:
  // it goes back to the button that opened the panel when that button is
  // shown, or out of the panel otherwise.
  const hidePanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const active = document.activeElement;
    const hadFocus = !!active && active !== panel && typeof panel.contains === 'function' && panel.contains(active);
    panel.classList.add('hide');
    if (!hadFocus) return;
    const opener = panel.dataset.opener && document.getElementById(panel.dataset.opener);
    if (opener && typeof opener.getClientRects === 'function' && opener.getClientRects().length > 0) opener.focus();
    else if (typeof active.blur === 'function') active.blur();
  };

  // Hides the panel from inside it, so closing does not mean reaching for the
  // button that opened it.
  const createCloseButton = () => {
    const button = createElement('button', 'owp-close-btn owp-bar-btn');
    button.type = 'button';
    button.title = 'Close panel';
    button.setAttribute('aria-label', 'Close panel');
    button.appendChild(createIcon('x'));
    button.onclick = hidePanel;
    return button;
  };

  const CREATE_ROOM_HINT_ID = 'owp-create-hint';
  const CREATE_ROOM_HINT = 'Start playing something to create a room.';

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

  const HELP_ID = 'owp-help';
  const HELP_BUTTON_ID = 'owp-btn-help';
  const HELP_TEXT = 'Watch movies and shows together, in sync. This panel opens from the Watch Party button, at the top of Jellyfin or in the player.';

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
  const announceLobbyHelp = () => announce(`Watch Party: ${HELP_TEXT}`);

  const createLobbyHelp = () => {
    const help = createElement('div', 'owp-help');
    help.id = HELP_ID;
    const ok = createElement('button', 'owp-pill-btn secondary owp-help-ok', 'Got it');
    ok.type = 'button';
    ok.onclick = closeLobbyHelp;
    help.append(createElement('span', '', HELP_TEXT), ok);
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
    button.title = 'Help';
    button.setAttribute('aria-label', 'Help');
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
    roomSection.appendChild(createElement('div', 'owp-label', 'Available rooms'));
    const roomList = createElement('div');
    roomList.id = 'owp-room-list';
    roomSection.appendChild(roomList);
    const createSection = createElement('div', 'owp-section owp-create-section');
    const btn = createElement('button', 'owp-btn', 'Create Room');
    btn.id = 'owp-btn-create';
    btn.style.width = '100%';
    btn.onclick = () => OWP.actions && OWP.actions.createRoom && OWP.actions.createRoom();
    btn.setAttribute('aria-describedby', CREATE_ROOM_HINT_ID);
    const hint = createElement('div', 'owp-hint', CREATE_ROOM_HINT);
    hint.id = CREATE_ROOM_HINT_ID;
    createSection.append(btn, hint);
    lobby.append(roomSection, createSection);

    const footer = createElement('div', 'owp-footer');
    footer.append(document.createTextNode('Server: '), document.createTextNode(String(DEFAULT_WS_URL.replace(/^wss?:\/\//, '').replace('/ws', ''))));
    panel.replaceChildren(header, createLobbyHelp(), lobby, footer);
    applyLobbyHelp();
    ui.updateRoomListUI();
    updateCreateRoomButton();
  };

  // Names when the server sends them (participant_list), otherwise the count,
  // so an older session server still shows something useful. Each name and the
  // host badge are separate elements, so a name such as "Ana (host)" or one
  // with commas cannot pass for the host or for several people.
  // Each participant's status (participant_statuses), shown under the name with
  // a colored dot. Older servers and clients send none: the row stays as it was.
  const PARTICIPANT_STATUS = {
    playing: { label: 'Playing', tone: 'good' },
    paused: { label: 'Paused', tone: 'idle' },
    in_sync: { label: 'In sync', tone: 'good' },
    catching_up: { label: 'Catching up', tone: 'warn' },
    buffering: { label: 'Buffering', tone: 'warn' },
    loading: { label: 'Loading', tone: 'info' },
    blocked: { label: 'Needs to press Play', tone: 'bad' },
    not_watching: { label: 'Not watching', tone: 'idle' }
  };

  const fillParticipantList = (list) => {
    if (!state.participants.length) {
      list.replaceChildren(document.createTextNode(`Online: ${String(state.participantCount || 1)}`));
      return;
    }
    list.replaceChildren(...state.participants.map((participant) => {
      const name = participant.name || 'Guest';
      const item = createElement('div', 'owp-participant');
      const avatar = createElement('span', 'owp-participant-avatar', Array.from(name)[0].toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const nameEl = createElement('span', 'owp-participant-name', name);
      const badge = participant.isHost ? createElement('span', 'owp-host-badge', 'Host') : null;
      const status = PARTICIPANT_STATUS[participant.status];
      if (!status) {
        item.append(avatar, nameEl);
        if (badge) item.appendChild(badge);
        return item;
      }
      item.classList.add('owp-has-status');
      const line = createElement('span', 'owp-participant-line');
      line.appendChild(nameEl);
      if (badge) line.appendChild(badge);
      const main = createElement('span', 'owp-participant-main');
      main.append(line, createElement('span', `owp-participant-status ${status.tone}`, status.label));
      item.append(avatar, main);
      return item;
    }));
  };

  const participantTotal = () => state.participants.length || state.participantCount || 1;

  // Icon-only buttons: the count goes in the accessible name too.
  const peopleLabel = () => `Participants, ${String(participantTotal())}`;

  const updateParticipantList = () => {
    const list = document.getElementById('owp-participants-list');
    if (list) fillParticipantList(list);
    const count = document.getElementById('owp-people-count');
    if (count) count.textContent = String(participantTotal());
    const button = document.getElementById('owp-btn-people');
    if (button) button.setAttribute('aria-label', peopleLabel());
    if (ui.updateRoomRoleControls) ui.updateRoomRoleControls();
  };

  const createBarButton = (id, label, iconName, sectionId) => {
    const button = createElement('button', 'owp-bar-btn');
    button.id = id;
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    if (sectionId) {
      button.setAttribute('aria-controls', sectionId);
      button.setAttribute('aria-expanded', 'false');
    }
    button.appendChild(createIcon(iconName));
    return button;
  };

  // The room view is a single bar; people, chat and the host's "close the
  // room" confirmation open one at a time in a drop-down below it.
  const ROOM_SECTIONS = [
    { name: 'people', sectionId: 'owp-people-section', buttonId: 'owp-btn-people' },
    { name: 'chat', sectionId: 'owp-chat-section', buttonId: 'owp-btn-chat' },
    { name: 'sync', sectionId: 'owp-sync-section', buttonId: 'owp-btn-sync' },
    { name: 'leave', sectionId: 'owp-leave-confirm', buttonId: 'owp-btn-leave' }
  ];

  // The sync adjustment: offered to guests when the plugin enables it. The
  // host is the reference and never needs it.
  const offersSyncNudge = () => state.showSyncNudge && !state.isHost;

  const NUDGE_STATUS = {
    behind: { marker: 'syncing', text: abs => `${abs.toFixed(1)} s behind the host` },
    ahead: { marker: 'syncing', text: abs => `${abs.toFixed(1)} s ahead of the host` },
    synced: { marker: 'synced', text: () => 'In sync with the host' },
    busy: { marker: 'idle', text: () => 'Following the host...' },
    paused: { marker: 'idle', text: () => 'The room is paused' },
    loading: { marker: 'idle', text: () => 'Waiting for the video' },
    unavailable: { marker: 'idle', text: () => 'Waiting for the video' }
  };

  // What the automatic correction is doing while the guest is out of sync.
  const describeAutoCorrection = (video) => {
    const seconds = state.outOfSyncSince ? Math.max(0, Math.round((Date.now() - state.outOfSyncSince) / 1000)) : 0;
    const rate = video ? video.playbackRate : 1;
    const since = seconds ? ` for ${seconds} s` : '';
    if (rate && rate !== 1) return `Automatic correction: ${rate.toFixed(2)}× speed${since}.`;
    return seconds ? `Automatic correction: out of sync for ${seconds} s.` : 'Automatic correction: starting.';
  };

  // Refreshes the drop-down's text while it is open. The button keeps its
  // element (and keyboard focus); aria-disabled, unlike disabled, keeps it
  // focusable when there is nothing to nudge.
  const updateSyncSection = () => {
    const section = document.getElementById('owp-sync-section');
    if (!section || section.hidden || !OWP.playback?.nudgeState) return;
    const current = OWP.playback.nudgeState();
    const status = NUDGE_STATUS[current.kind] || NUDGE_STATUS.unavailable;
    const outOfSync = current.kind === 'behind' || current.kind === 'ahead';
    const dot = section.querySelector('.owp-nudge-state .owp-sync-dot');
    if (dot) dot.className = `owp-sync-dot ${status.marker}`;
    const text = document.getElementById('owp-nudge-text');
    if (text) text.textContent = status.text(Math.abs(current.drift || 0));
    const auto = document.getElementById('owp-nudge-auto');
    if (auto) {
      auto.hidden = !outOfSync;
      if (outOfSync) auto.textContent = describeAutoCorrection(state.currentVideoElement || OWP.utils?.getVideo?.());
    }
    const button = document.getElementById('owp-btn-nudge');
    if (button) {
      const step = outOfSync ? String(current.step) : '0.5';
      button.textContent = current.kind === 'ahead' ? `Move back ${step} s` : `Move ahead ${step} s`;
      button.setAttribute('aria-disabled', String(!outOfSync));
    }
  };

  const createSyncSection = () => {
    const section = createElement('div');
    section.id = 'owp-sync-section';
    const row = createElement('div', 'owp-nudge-row');
    const status = createElement('span', 'owp-nudge-state');
    const text = createElement('span');
    text.id = 'owp-nudge-text';
    status.append(createElement('span', 'owp-sync-dot idle'), text);
    const nudge = createElement('button', 'owp-pill-btn primary');
    nudge.id = 'owp-btn-nudge';
    nudge.type = 'button';
    nudge.onclick = () => {
      if (nudge.getAttribute('aria-disabled') !== 'true' && OWP.playback?.nudge) OWP.playback.nudge();
      updateSyncSection();
    };
    row.append(status, nudge);
    const auto = createElement('div', 'owp-nudge-sub');
    auto.id = 'owp-nudge-auto';
    const note = createElement('div', 'owp-nudge-sub', 'Only moves your video; the host stays in control.');
    section.append(row, auto, note);
    return section;
  };

  const applyRoomSection = () => {
    const open = state.roomBarSection;
    const drop = document.getElementById('owp-room-drop');
    if (drop) drop.hidden = !open;
    ROOM_SECTIONS.forEach(({ name, sectionId, buttonId }) => {
      const section = document.getElementById(sectionId);
      if (section) section.hidden = name !== open;
      const button = document.getElementById(buttonId);
      if (button && button.getAttribute('aria-controls') === sectionId) button.setAttribute('aria-expanded', String(name === open));
    });
    // Read only when it is on screen: a redraw while the panel is hidden must
    // not mark messages that nobody saw.
    if (open === 'sync') updateSyncSection();
    if (open === 'chat' && OWP.chat && OWP.chat.isChatVisible()) {
      OWP.chat.markRead();
      const messages = document.getElementById('owp-chat-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    }
  };

  const toggleRoomSection = (name) => {
    state.roomBarSection = state.roomBarSection === name ? '' : name;
    applyRoomSection();
  };

  // Escape closes the open drop-down and puts focus back on its button.
  const closeRoomSectionFromKeyboard = (event) => {
    if (event.key !== 'Escape') return false;
    const open = ROOM_SECTIONS.find(section => section.name === state.roomBarSection);
    if (!open) return false;
    event.preventDefault();
    state.roomBarSection = '';
    applyRoomSection();
    const button = document.getElementById(open.buttonId);
    if (button) button.focus();
    return true;
  };

  const nextHostParticipant = () => state.isHost
    && state.serverFeatures.includes('host_transfer')
    && state.participants.find(participant => !participant.isHost);

  const updateLeaveConfirm = () => {
    const confirm = document.getElementById('owp-leave-confirm');
    const leaveBtn = document.getElementById('owp-btn-leave');
    if (!confirm || !leaveBtn) return;
    const nextHost = nextHostParticipant();
    const canTransfer = Boolean(nextHost);
    const label = state.isHost && !canTransfer ? 'Close room' : 'Leave room';
    leaveBtn.title = label;
    leaveBtn.setAttribute('aria-label', label);

    const active = document.activeElement;
    const hadFocus = Boolean(active && confirm.contains(active));
    const focusedId = hadFocus ? active.id : '';
    const focusedAction = hadFocus ? active.dataset.action || '' : '';
    const cancel = createElement('button', 'owp-pill-btn secondary', 'Cancel');
    cancel.id = 'owp-btn-cancel-leave';
    cancel.dataset.action = 'cancel';
    cancel.type = 'button';
    cancel.onclick = () => {
      toggleRoomSection('leave');
      leaveBtn.focus();
    };
    const question = createElement(
      'span',
      'owp-leave-question',
      state.isHost && !canTransfer ? 'Close the room for everyone?' : 'Leave the room?'
    );
    const buttons = [question, cancel];
    if (canTransfer) {
      const leave = createElement('button', 'owp-pill-btn secondary', 'Leave');
      leave.id = 'owp-btn-leave-room';
      leave.dataset.action = 'leave';
      leave.type = 'button';
      leave.onclick = () => OWP.actions?.leaveRoom?.();
      buttons.push(leave);
    }
    const confirmLeave = createElement(
      'button',
      'owp-pill-btn danger',
      state.isHost ? (canTransfer ? 'Close for everyone' : 'Close room') : 'Leave'
    );
    confirmLeave.id = 'owp-btn-confirm-leave';
    confirmLeave.dataset.action = state.isHost ? 'close' : 'leave';
    confirmLeave.type = 'button';
    confirmLeave.onclick = () => {
      const action = state.isHost ? OWP.actions?.closeRoom : OWP.actions?.leaveRoom;
      if (action) action();
    };
    buttons.push(confirmLeave);
    if (canTransfer) {
      buttons.push(createElement(
        'div',
        'owp-leave-hint',
        `If you leave, ${nextHost.name || 'Guest'} becomes the host and the room stays open.`
      ));
    }
    confirm.replaceChildren(...buttons);
    if (hadFocus) {
      const replacement = focusedId && document.getElementById(focusedId);
      const keepsAction = replacement
        && confirm.contains(replacement)
        && replacement.dataset.action === focusedAction;
      (keepsAction ? replacement : cancel).focus({ preventScroll: true });
    }
  };

  const updateRoomRoleControls = () => {
    const leaveBtn = document.getElementById('owp-btn-leave');
    if (!leaveBtn) return;
    const bar = leaveBtn.parentNode;
    let inviteBtn = document.getElementById('owp-btn-invite');
    if (state.isHost && !inviteBtn) {
      inviteBtn = createBarButton('owp-btn-invite', 'Invite', 'share');
      inviteBtn.onclick = () => OWP.actions?.copyInviteLink?.();
      bar.insertBefore(inviteBtn, leaveBtn);
    } else if (!state.isHost && inviteBtn) {
      inviteBtn.remove();
      inviteBtn = null;
    }
    // A promoted guest stops being offered the sync adjustment, and a demoted
    // host starts being offered it, without waiting for a full redraw.
    let syncBtn = document.getElementById('owp-btn-sync');
    const drop = document.getElementById('owp-room-drop');
    if (offersSyncNudge() && !syncBtn) {
      syncBtn = createBarButton('owp-btn-sync', 'Sync adjustment', 'refresh', 'owp-sync-section');
      syncBtn.onclick = () => toggleRoomSection('sync');
      bar.insertBefore(syncBtn, inviteBtn || leaveBtn);
      if (drop && !document.getElementById('owp-sync-section')) {
        drop.insertBefore(createSyncSection(), document.getElementById('owp-leave-confirm'));
      }
    } else if (!offersSyncNudge() && syncBtn) {
      syncBtn.remove();
      document.getElementById('owp-sync-section')?.remove();
      if (state.roomBarSection === 'sync') state.roomBarSection = '';
    }
    updateLeaveConfirm();
    applyRoomSection();
  };

  const renderRoom = (panel) => {
    const bar = createElement('div', 'owp-room-bar');
    const clientId = String(state.clientId).split('-')[1] || '...';
    // The last measured value, so a redraw does not blank it until the next pong.
    const latency = createElement('span', 'owp-latency', state.lastRttMs === null ? '-' : `${state.lastRttMs} ms`);
    latency.title = `Latency to the watch party server (client ${clientId})`;
    const roomName = createElement('span', 'owp-room-name', state.roomName);
    roomName.title = state.roomName;

    const peopleBtn = createBarButton('owp-btn-people', 'Participants', 'users', 'owp-people-section');
    peopleBtn.setAttribute('aria-label', peopleLabel());
    const peopleCount = createElement('span', 'owp-people-count', String(participantTotal()));
    peopleCount.id = 'owp-people-count';
    const arrow = createIcon('chevron');
    arrow.setAttribute('class', 'owp-icon owp-icon-chevron owp-expand');
    peopleBtn.append(peopleCount, arrow);
    peopleBtn.onclick = () => toggleRoomSection('people');

    const chatBtn = createBarButton('owp-btn-chat', 'Chat', 'chat', 'owp-chat-section');
    const badge = createElement('span', 'owp-chat-badge');
    badge.id = 'owp-chat-badge';
    chatBtn.appendChild(badge);
    chatBtn.onclick = () => toggleRoomSection('chat');

    // Leaving always asks first; compatible hosts can pass the room on or close it.
    const leaveBtn = createBarButton('owp-btn-leave', 'Leave room', 'logout', 'owp-leave-confirm');
    leaveBtn.classList.add('danger');
    leaveBtn.onclick = () => toggleRoomSection('leave');

    // Invite links are minted by the host: guests get no button at all.
    const roomActions = [peopleBtn, chatBtn];
    if (offersSyncNudge()) {
      const syncBtn = createBarButton('owp-btn-sync', 'Sync adjustment', 'refresh', 'owp-sync-section');
      syncBtn.onclick = () => toggleRoomSection('sync');
      roomActions.push(syncBtn);
    } else if (state.roomBarSection === 'sync') {
      state.roomBarSection = '';
    }
    if (state.isHost) {
      const inviteBtn = createBarButton('owp-btn-invite', 'Invite', 'share');
      inviteBtn.onclick = () => OWP.actions && OWP.actions.copyInviteLink && OWP.actions.copyInviteLink();
      roomActions.push(inviteBtn);
    }
    roomActions.push(leaveBtn);

    bar.append(ui.buildSyncStatusIndicator(), latency, roomName, ...roomActions, createCloseButton());

    const drop = createElement('div', 'owp-room-drop');
    drop.id = 'owp-room-drop';
    bar.addEventListener('keydown', closeRoomSectionFromKeyboard);
    drop.addEventListener('keydown', closeRoomSectionFromKeyboard);

    const peopleSection = createElement('div');
    peopleSection.id = 'owp-people-section';
    const participantList = createElement('div', 'owp-participants');
    participantList.id = 'owp-participants-list';
    fillParticipantList(participantList);
    peopleSection.appendChild(participantList);

    const chatSection = createElement('div');
    chatSection.id = 'owp-chat-section';
    const messages = createElement('div');
    messages.id = 'owp-chat-messages';
    const inputContainer = createElement('div');
    inputContainer.id = 'owp-chat-input-container';
    const input = createElement('input');
    input.id = 'owp-chat-input';
    input.type = 'text';
    input.placeholder = 'Type a message...';
    input.maxLength = 500;
    const send = createElement('button');
    send.id = 'owp-chat-send';
    send.type = 'button';
    send.title = 'Send message';
    send.setAttribute('aria-label', 'Send message');
    send.appendChild(createIcon('send'));
    inputContainer.append(input, send);
    chatSection.append(messages, inputContainer);

    const confirm = createElement('div', 'owp-leave-confirm');
    confirm.id = 'owp-leave-confirm';
    drop.append(peopleSection, chatSection);
    if (offersSyncNudge()) drop.appendChild(createSyncSection());
    drop.appendChild(confirm);

    panel.replaceChildren(bar, drop);
    updateRoomRoleControls();
    applyRoomSection();
  };

  const setupChatInput = (panel) => {
    const chatInput = panel.querySelector('#owp-chat-input');
    const chatSend = panel.querySelector('#owp-chat-send');
    if (!chatInput || !chatSend) return;
    ui.stopPlayerCapture(chatInput);
    chatInput.addEventListener('keydown', (e) => {
      // The input stops key events from bubbling (so the player ignores
      // typing), so the drop-down's Escape handler is called from here.
      if (closeRoomSectionFromKeyboard(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (OWP.chat && OWP.chat.send(chatInput.value)) {
          chatInput.value = '';
        }
      }
    });
    chatSend.addEventListener('click', () => {
      if (OWP.chat && OWP.chat.send(chatInput.value)) {
        chatInput.value = '';
      }
    });
    if (OWP.chat) {
      OWP.chat.renderAllMessages();
      if (OWP.chat.isChatVisible()) OWP.chat.markRead();
      else OWP.chat.updateBadge();
    }
  };

  const render = (forceFullRender = false) => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!forceFullRender && panel.dataset.inRoom === String(state.inRoom) && panel.children.length > 0) {
      ui.updateStatusIndicator();
      ui.updateSyncIndicator();
      ui.updateRoomListUI();
      updateCreateRoomButton();
      ui.renderHomeWatchParties();
      return;
    }
    const redrawingRoom = state.inRoom
      && panel.dataset.inRoom === 'true'
      && panel.children.length > 0;
    const oldMessages = redrawingRoom ? panel.querySelector('#owp-chat-messages') : null;
    const messageNodes = oldMessages ? Array.from(oldMessages.childNodes) : null;
    const oldScrollTop = oldMessages ? Number(oldMessages.scrollTop) || 0 : 0;
    const wasChatAtBottom = oldMessages
      ? oldScrollTop + (Number(oldMessages.clientHeight) || 0) >= (Number(oldMessages.scrollHeight) || 0) - 1
      : true;
    const oldInput = redrawingRoom ? panel.querySelector('#owp-chat-input') : null;
    const chatDraft = oldInput ? oldInput.value : '';
    // A full draw replaces every control. Keyboard focus inside the panel
    // (on Create Room or Join, say) goes to the same control if it is drawn
    // again, or to the first one, instead of falling out of the dialog.
    const active = document.activeElement;
    const focusInside = !!active && active !== panel && typeof panel.contains === 'function' && panel.contains(active);
    const focusedId = focusInside ? active.id : '';
    panel.dataset.inRoom = String(state.inRoom);
    if (state.inRoom) panel.classList.add(ROOM_MODE_CLASS);
    else panel.classList.remove(ROOM_MODE_CLASS);
    if (!state.inRoom) {
      renderLobby(panel);
    } else {
      renderRoom(panel);
      setupChatInput(panel);
      if (redrawingRoom) {
        const messages = panel.querySelector('#owp-chat-messages');
        if (messages && messageNodes) {
          messages.replaceChildren(...messageNodes);
          messages.scrollTop = wasChatAtBottom ? messages.scrollHeight : oldScrollTop;
        }
        const input = panel.querySelector('#owp-chat-input');
        if (input) input.value = chatDraft;
      }
    }
    // The lobby and the room bar sit differently below the header.
    if (ui.updatePanelPlacement) ui.updatePanelPlacement();
    ui.updateStatusIndicator();
    ui.renderHomeWatchParties();
    if (focusInside && !panel.classList.contains('hide')) {
      const same = focusedId && document.getElementById(focusedId);
      if (same && panel.contains(same)) same.focus({ preventScroll: true });
      else focusPanelStart(panel);
    }
  };

  // The panel's own controls: the help, its "?" and the close button.
  const PANEL_FRAME_CONTROLS = ['owp-close-btn', 'owp-help-btn', 'owp-help-ok'];

  // A panel opened from the keyboard takes focus, as a dialog should: its first
  // control other than its own, or the close button. A mouse click leaves
  // focus alone, so the player's keyboard shortcuts keep working.
  const focusPanelStart = (panel) => {
    const buttons = Array.from(panel.querySelectorAll('button')).filter(button => !button.disabled);
    const target = buttons.find(button => !PANEL_FRAME_CONTROLS.some(name => button.classList.contains(name)))
      || buttons.find(button => button.classList.contains('owp-close-btn'));
    if (target) target.focus({ preventScroll: true });
  };

  // Enter and Space fire `click` with `detail` 0; a mouse click counts its clicks.
  const isKeyboardClick = event => !!event && event.detail === 0;

  const injectOsdButton = () => {
    // Jellyfin keeps the previous player page in the DOM, hidden as
    // `.page.hide`: use the buttons of the shown player, and move the button
    // there when it is still in another player page.
    const videoOsd = Array.from(document.querySelectorAll('.videoOsdBottom .buttons'))
      .find(buttons => !buttons.closest('.page.hide'));
    if (!videoOsd) return;
    const existing = document.getElementById(BTN_ID);
    if (existing) {
      if (existing.closest('.videoOsdBottom .buttons') === videoOsd) return;
      existing.remove();
    }
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'paper-icon-button-light btnWatchParty autoSize';
    btn.title = 'Watch Party';
    btn.appendChild(createWatchPartyIcon());
    btn.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const panel = document.getElementById(PANEL_ID);
      panel.classList.toggle('hide');
      if (!panel.classList.contains('hide')) {
        panel.dataset.opener = BTN_ID;
        if (ui.resetPanelPlacement) ui.resetPanelPlacement(panel);
        setLobbyHelpOpen(false);
        render(true);
        if (isKeyboardClick(e)) focusPanelStart(panel);
      }
      btn.setAttribute('aria-expanded', String(!panel.classList.contains('hide')));
    };
    btn.setAttribute('aria-label', 'Watch Party');
    btn.setAttribute('aria-controls', PANEL_ID);
    const currentPanel = document.getElementById(PANEL_ID);
    btn.setAttribute('aria-expanded', String(!!currentPanel && !currentPanel.classList.contains('hide')));
    const favBtn = videoOsd.querySelector('[title="Add to favorites"], [title="Remove from favorites"]');
    if (favBtn) {
      favBtn.insertAdjacentElement('beforebegin', btn);
    } else {
      videoOsd.appendChild(btn);
    }
  };

  Object.assign(ui, {
    render,
    injectOsdButton,
    updateCreateRoomButton,
    updateParticipantList,
    updateLeaveConfirm,
    updateRoomRoleControls,
    focusPanelStart,
    isKeyboardClick,
    hidePanel,
    updateSyncSection,
    setLobbyHelpOpen,
    announceLobbyHelp
  });
})();
