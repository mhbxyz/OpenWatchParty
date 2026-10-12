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
  Object.assign(ui, { updateParticipantList });
})();
