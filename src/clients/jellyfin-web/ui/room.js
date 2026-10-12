(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { createElement, createIcon, createCloseButton, fillParticipantList, participantTotal, peopleLabel } = views;
  const { updateLeaveConfirm } = ui;


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


  // Seconds and rates with the language's decimal separator.
  const formatNumber = OWP.i18n.formatNumber;


  const NUDGE_STATUS = {
    behind: { marker: 'syncing', text: abs => t('nudgeBehind', { seconds: formatNumber(abs, 1, 1) }) },
    ahead: { marker: 'syncing', text: abs => t('nudgeAhead', { seconds: formatNumber(abs, 1, 1) }) },
    synced: { marker: 'synced', text: () => t('nudgeSynced') },
    busy: { marker: 'idle', text: () => t('nudgeBusy') },
    paused: { marker: 'idle', text: () => t('nudgePaused') },
    loading: { marker: 'idle', text: () => t('nudgeLoading') },
    unavailable: { marker: 'idle', text: () => t('nudgeLoading') }
  };


  // What the automatic correction is doing while the guest is out of sync.
  const describeAutoCorrection = (video) => {
    const seconds = state.outOfSyncSince ? Math.max(0, Math.round((Date.now() - state.outOfSyncSince) / 1000)) : 0;
    const rate = video ? video.playbackRate : 1;
    if (rate && rate !== 1) {
      const speed = formatNumber(rate, 2, 2);
      return seconds ? t('autoRateFor', { rate: speed, seconds }) : t('autoRate', { rate: speed });
    }
    return seconds ? t('autoOutFor', { seconds }) : t('autoStarting');
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
      const step = formatNumber(outOfSync ? current.step : 0.5, 1, 2);
      button.textContent = t(current.kind === 'ahead' ? 'moveBack' : 'moveAhead', { step });
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
    const note = createElement('div', 'owp-nudge-sub', t('nudgeNote'));
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


  const updateRoomRoleControls = () => {
    const leaveBtn = document.getElementById('owp-btn-leave');
    if (!leaveBtn) return;
    const bar = leaveBtn.parentNode;
    let inviteBtn = document.getElementById('owp-btn-invite');
    if (state.isHost && !inviteBtn) {
      inviteBtn = createBarButton('owp-btn-invite', t('invite'), 'share');
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
      syncBtn = createBarButton('owp-btn-sync', t('syncAdjustment'), 'refresh', 'owp-sync-section');
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
    latency.title = t('latency', { client: clientId });
    const roomName = createElement('span', 'owp-room-name', OWP.i18n.localizeRoomName(state.roomName));
    roomName.title = roomName.textContent;

    const peopleBtn = createBarButton('owp-btn-people', t('participants'), 'users', 'owp-people-section');
    peopleBtn.setAttribute('aria-label', peopleLabel());
    const peopleCount = createElement('span', 'owp-people-count', String(participantTotal()));
    peopleCount.id = 'owp-people-count';
    const arrow = createIcon('chevron');
    arrow.setAttribute('class', 'owp-icon owp-icon-chevron owp-expand');
    peopleBtn.append(peopleCount, arrow);
    peopleBtn.onclick = () => toggleRoomSection('people');

    const chatBtn = createBarButton('owp-btn-chat', t('chat'), 'chat', 'owp-chat-section');
    const badge = createElement('span', 'owp-chat-badge');
    badge.id = 'owp-chat-badge';
    chatBtn.appendChild(badge);
    chatBtn.onclick = () => toggleRoomSection('chat');

    // Leaving always asks first; compatible hosts can pass the room on or close it.
    const leaveBtn = createBarButton('owp-btn-leave', t('leaveRoom'), 'logout', 'owp-leave-confirm');
    leaveBtn.classList.add('danger');
    leaveBtn.onclick = () => toggleRoomSection('leave');

    // Invite links are minted by the host: guests get no button at all.
    const roomActions = [peopleBtn, chatBtn];
    if (offersSyncNudge()) {
      const syncBtn = createBarButton('owp-btn-sync', t('syncAdjustment'), 'refresh', 'owp-sync-section');
      syncBtn.onclick = () => toggleRoomSection('sync');
      roomActions.push(syncBtn);
    } else if (state.roomBarSection === 'sync') {
      state.roomBarSection = '';
    }
    if (state.isHost) {
      const inviteBtn = createBarButton('owp-btn-invite', t('invite'), 'share');
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
    input.placeholder = t('typeMessage');
    input.maxLength = 500;
    const send = createElement('button');
    send.id = 'owp-chat-send';
    send.type = 'button';
    send.title = t('sendMessage');
    send.setAttribute('aria-label', t('sendMessage'));
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

  Object.assign(views, { renderRoom, setupChatInput, toggleRoomSection });
  Object.assign(ui, { updateRoomRoleControls, updateSyncSection });
})();
