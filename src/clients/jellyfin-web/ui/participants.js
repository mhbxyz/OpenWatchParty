(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { createElement } = views;


  // Names when the server sends them (participant_list), otherwise the count,
  // so an older session server still shows something useful. Each name and the
  // host badge are separate elements, so a name such as "Ana (host)" or one
  // with commas cannot pass for the host or for several people.
  // Each participant's status (participant_statuses), shown under the name with
  // a colored dot. Older servers and clients send none: the row stays as it was.
  const PARTICIPANT_STATUS = {
    playing: { tone: 'good' },
    paused: { tone: 'idle' },
    in_sync: { tone: 'good' },
    catching_up: { tone: 'warn' },
    buffering: { tone: 'warn' },
    loading: { tone: 'info' },
    blocked: { tone: 'bad' },
    not_watching: { tone: 'idle' }
  };


  const createAccessControls = (creating = false) => {
    const group = createElement('div', creating ? 'owp-access owp-access-create' : 'owp-access');
    if (!creating) group.appendChild(createElement('div', 'owp-access-title', t('roomAccess')));
    for (const key of ['approval', 'unlisted']) {
      const value = creating ? state.createAccess : state.roomAccess;
      const row = createElement('div', 'owp-access-row');
      const text = createElement('span', 'owp-access-text');
      const label = key === 'approval' ? 'accessApproval' : 'accessUnlisted';
      text.append(createElement('span', 'owp-access-label', t(label)), createElement('span', 'owp-access-hint', t(`${label}Hint`)));
      const button = createElement('button', 'owp-switch');
      button.type = 'button';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-label', t(label));
      button.setAttribute('aria-checked', String(value[key]));
      button.onclick = () => {
        if (creating) {
          state.createAccess[key] = !state.createAccess[key];
          button.setAttribute('aria-checked', String(state.createAccess[key]));
        } else {
          OWP.actions.setRoomAccess(key === 'approval' ? !value.approval : value.approval, key === 'unlisted' ? !value.unlisted : value.unlisted);
        }
      };
      row.append(text, button);
      group.appendChild(row);
    }
    return group;
  };

  const requestRow = (request, card = false) => {
    const row = createElement('div', 'owp-participant owp-request-row');
    const avatar = createElement('span', 'owp-participant-avatar', Array.from(request.name || t('guest'))[0].toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const text = createElement('span', 'owp-participant-main');
    if (card) {
      const sentence = t('joinRequest', { name: request.name });
      const start = sentence.indexOf(request.name);
      text.append(document.createTextNode(sentence.slice(0, start)), createElement('strong', '', request.name), document.createTextNode(sentence.slice(start + request.name.length)));
    } else {
      text.append(createElement('span', 'owp-participant-name', request.name), createElement('span', 'owp-participant-status warn', t('wantsToJoin')));
    }
    const buttons = createElement('div', 'owp-request-buttons');
    for (const admit of [false, true]) {
      const button = createElement('button', `owp-pill-btn ${admit ? 'primary' : 'secondary'}`, t(admit ? 'letIn' : 'reject'));
      button.type = 'button';
      button.onclick = () => OWP.actions.answerJoin(request.id, admit);
      buttons.appendChild(button);
    }
    row.append(avatar, text, buttons);
    return row;
  };

  const updateAccessUI = () => {
    document.getElementById('owp-access-controls')?.remove();
    document.getElementById('owp-request-card')?.remove();
    document.getElementById('owp-request-badge')?.remove();
    if (!state.inRoom || !state.isHost || !state.serverFeatures.includes('room_access')) return;
    const people = document.getElementById('owp-people-section');
    if (people) {
      const controls = createAccessControls();
      controls.id = 'owp-access-controls';
      people.appendChild(controls);
    }
    if (!state.joinRequests.length || state.roomBarSection === 'people') return;
    const badge = createElement('span', 'owp-request-badge', state.joinRequests.length);
    badge.id = 'owp-request-badge';
    badge.setAttribute('aria-label', t('joinWaitingCount', { count: state.joinRequests.length }));
    document.getElementById('owp-btn-people')?.appendChild(badge);
    const card = createElement('div', 'owp-request-card');
    card.id = 'owp-request-card';
    card.appendChild(requestRow(state.joinRequests[0], true));
    if (state.joinRequests.length > 1) card.appendChild(createElement('div', 'owp-access-hint', t('moreWaiting', { count: state.joinRequests.length - 1 })));
    document.getElementById(OWP.constants.PANEL_ID)?.appendChild(card);
  };

  const fillParticipantList = (list) => {
    if (!state.participants.length) {
      list.replaceChildren(document.createTextNode(t('onlineCount', { count: state.participantCount || 1 })));
      return;
    }
    list.replaceChildren(...state.participants.map((participant) => {
      const name = participant.name || t('guest');
      const item = createElement('div', 'owp-participant');
      const avatar = createElement('span', 'owp-participant-avatar', Array.from(name)[0].toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const nameEl = createElement('span', 'owp-participant-name', name);
      const badge = participant.isHost ? createElement('span', 'owp-host-badge', t('host')) : null;
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
      main.append(line, createElement('span', `owp-participant-status ${status.tone}`, t(`status_${participant.status}`)));
      item.append(avatar, main);
      return item;
    }));
    if (state.isHost && state.serverFeatures.includes('room_access')) {
      for (const request of state.joinRequests) list.appendChild(requestRow(request));
    }
  };


  const participantTotal = () => state.participants.length || state.participantCount || 1;


  // Icon-only buttons: the count goes in the accessible name too.
  const peopleLabel = () => t('participantsCount', { count: participantTotal() });


  const updateParticipantList = () => {
    const list = document.getElementById('owp-participants-list');
    if (list) fillParticipantList(list);
    const count = document.getElementById('owp-people-count');
    if (count) count.textContent = String(participantTotal());
    const button = document.getElementById('owp-btn-people');
    if (button) button.setAttribute('aria-label', peopleLabel());
    if (ui.updateRoomRoleControls) ui.updateRoomRoleControls();
  };

  Object.assign(views, { fillParticipantList, participantTotal, peopleLabel });
  Object.assign(ui, { updateParticipantList, createAccessControls, updateAccessUI });
})();
