(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { createElement, createIcon } = views;
  const { PANEL_ID } = OWP.constants;


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


  // Each participant's audio and subtitle tracks for the room's item
  // (participant_tracks), in a box under the row that the arrow beside the
  // name opens. Only to see them: nothing changes anyone's tracks. One box is
  // open at a time, and a press in the panel outside it closes it.
  let openTracks = '';
  const tracksKey = (participant, index) => `${state.roomId}|${index}|${participant.name}`;
  const roomTracks = participant => (participant.tracks && state.roomMediaId
    && participant.tracks.media_id === String(state.roomMediaId).toLowerCase() ? participant.tracks : null);

  // The language of a code such as "spa" or "pt-BR", in the interface's own
  // language; '' when it is unknown.
  const languageName = (code) => {
    if (!code || code.toLowerCase() === 'und') return '';
    const language = OWP.i18n.locale();
    try {
      const name = new Intl.DisplayNames([language], { type: 'language' }).of(code);
      return name ? name.charAt(0).toLocaleUpperCase(language) + name.slice(1) : code;
    } catch (err) {
      return code;
    }
  };

  // A track by its title, else by its language; none is "Off" for subtitles.
  // A forced one is marked, unless its title already says so in the
  // interface language, as Jellyfin's own track names do.
  const trackLabel = (track, kind) => {
    if (!track) return t(kind === 'subtitle' ? 'tracksOff' : 'tracksNone');
    const name = track.title || languageName(track.language) || t('unknown');
    if (!track.forced) return name;
    const forced = t('tracksForced', { track: '' }).replace(/[()]/g, '').trim().toLocaleLowerCase();
    return track.title?.toLocaleLowerCase().includes(forced) ? name : t('tracksForced', { track: name });
  };

  const tracksBox = (tracks, id) => {
    const box = createElement('div', 'owp-tracks');
    box.id = id;
    for (const [key, kind] of [['tracksAudio', 'audio'], ['tracksSubtitles', 'subtitle']]) {
      box.append(createElement('span', 'owp-tracks-label', t(key)), createElement('span', 'owp-tracks-value', trackLabel(tracks[kind], kind)));
    }
    return box;
  };

  const tracksFold = (key, name, boxId) => {
    const fold = createElement('button', 'owp-bar-btn owp-tracks-fold');
    fold.type = 'button';
    fold.dataset.tracksKey = key;
    fold.setAttribute('aria-expanded', String(openTracks === key));
    fold.setAttribute('aria-controls', boxId);
    fold.setAttribute('aria-label', t('tracksOf', { name }));
    fold.title = t('tracksOf', { name });
    const arrow = createIcon('chevron');
    arrow.setAttribute('class', 'owp-icon owp-icon-chevron owp-expand');
    fold.appendChild(arrow);
    fold.onclick = () => {
      openTracks = openTracks === key ? '' : key;
      updateParticipantList();
      const list = document.getElementById('owp-participants-list');
      const again = Array.from(list?.querySelectorAll('.owp-tracks-fold') || []).find(other => other.dataset.tracksKey === key);
      if (again?.focus) again.focus();
    };
    return fold;
  };

  // A press in the panel outside the open box and the arrows closes the box.
  const closeTracksOnPress = new WeakSet();
  const watchPresses = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || closeTracksOnPress.has(panel)) return;
    closeTracksOnPress.add(panel);
    panel.addEventListener('pointerdown', (event) => {
      if (!openTracks || event.target?.closest?.('.owp-tracks, .owp-tracks-fold')) return;
      openTracks = '';
      updateParticipantList();
    });
  };

  const fillParticipantList = (list) => {
    watchPresses();
    if (!state.participants.length) {
      openTracks = '';
      list.replaceChildren(document.createTextNode(t('onlineCount', { count: state.participantCount || 1 })));
      return;
    }
    const keys = state.participants.map((participant, index) => (roomTracks(participant) ? tracksKey(participant, index) : ''));
    if (!keys.includes(openTracks)) openTracks = '';
    list.replaceChildren(...state.participants.map((participant, index) => {
      const name = participant.name || t('guest');
      const item = createElement('div', 'owp-participant');
      const avatar = createElement('span', 'owp-participant-avatar', Array.from(name)[0].toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const nameEl = createElement('span', 'owp-participant-name', name);
      const badge = participant.isHost ? createElement('span', 'owp-host-badge', t('host')) : null;
      const status = PARTICIPANT_STATUS[participant.status];
      const tracks = roomTracks(participant);
      if (!status && !tracks) {
        item.append(avatar, nameEl);
        if (badge) item.appendChild(badge);
        return item;
      }
      item.classList.add('owp-has-status');
      const line = createElement('span', 'owp-participant-line');
      line.appendChild(nameEl);
      if (badge) line.appendChild(badge);
      const main = createElement('span', 'owp-participant-main');
      main.appendChild(line);
      if (status) main.appendChild(createElement('span', `owp-participant-status ${status.tone}`, t(`status_${participant.status}`)));
      if (tracks) {
        const key = keys[index];
        const boxId = `owp-tracks-${index}`;
        line.appendChild(tracksFold(key, name, boxId));
        if (openTracks === key) main.appendChild(tracksBox(tracks, boxId));
      }
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
