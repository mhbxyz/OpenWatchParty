(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { PANEL_ID, QUEUE_COUNTDOWN_MS } = OWP.constants;
  const { createElement, createIcon } = views;

  const SECTION_ID = 'owp-queue-section';
  const BUTTON_ID = 'owp-btn-queue';
  const STRIP_ID = 'owp-queue-next';

  const queue = () => OWP.queue || {};
  const hasQueue = () => state.inRoom && state.serverFeatures.includes('media_queue') && state.queueItems.length > 0;

  const iconButton = (label, iconName, onClick, disabled = false) => {
    const button = createElement('button', 'owp-bar-btn');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(createIcon(iconName));
    if (disabled) button.setAttribute('aria-disabled', 'true');
    button.onclick = () => {
      if (button.getAttribute('aria-disabled') !== 'true') onClick();
    };
    return button;
  };

  // A pill with an icon on the side it points to: "previous" before, "next" after.
  const pillButton = (className, label, onClick, iconName = '', iconFirst = false) => {
    const button = createElement('button', `owp-pill-btn ${className}`, label);
    button.type = 'button';
    if (iconName) {
      button.classList.add('owp-pill-icon');
      if (iconFirst) button.prepend(createIcon(iconName));
      else button.appendChild(createIcon(iconName));
    }
    button.onclick = onClick;
    return button;
  };

  // Watched items, the room's item and the upcoming ones. The host can play,
  // move and remove the upcoming ones; the server keeps the watched ones and
  // the room's item where they are.
  const fillSection = (section) => {
    const items = state.queueItems;
    const current = items.findIndex(item => item.id === state.roomMediaId);
    const head = createElement('div', 'owp-queue-head');
    head.appendChild(createElement('span', 'owp-queue-title', t('queueTitle')));
    if (state.isHost) {
      const previous = queue().previousItem?.();
      const next = queue().nextItem?.();
      const back = pillButton('secondary', t('queuePrevious'), () => previous && queue().advance(previous.id), 'prev', true);
      const forward = pillButton('primary', t('queueNext'), () => next && queue().advance(next.id), 'next');
      if (!previous) back.setAttribute('aria-disabled', 'true');
      if (!next) forward.setAttribute('aria-disabled', 'true');
      head.append(back, forward);
    }
    const list = createElement('ol', 'owp-queue-list');
    items.forEach((item, index) => {
      const watched = index < current;
      const row = createElement('li', `owp-queue-item${watched ? ' done' : ''}${index === current ? ' current' : ''}`);
      const mark = createElement('span', 'owp-queue-mark');
      if (watched) mark.appendChild(createIcon('check'));
      else if (index === current) mark.appendChild(createIcon('play'));
      else mark.textContent = String(index - current);
      const name = createElement('span', 'owp-queue-name', item.title);
      name.title = item.title;
      row.append(mark, name);
      if (index === current) row.appendChild(createElement('span', 'owp-queue-now', t('queueWatching')));
      if (state.isHost && index > current) {
        const actions = createElement('span', 'owp-queue-actions');
        actions.append(
          iconButton(t('queuePlayNow'), 'play', () => queue().advance(item.id)),
          iconButton(t('queueMoveUp'), 'up', () => queue().move(item.id, index - 1), index === current + 1),
          iconButton(t('queueMoveDown'), 'down', () => queue().move(item.id, index + 1), index === items.length - 1),
          iconButton(t('queueRemove'), 'x', () => queue().remove(item.id))
        );
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
    const note = createElement('div', 'owp-queue-note', t(state.isHost ? 'queueAutoNote' : 'queueReadOnly'));
    section.replaceChildren(head, list, note);
  };

  // The bar's queue button and its drop-down section, while the room has a
  // queue; an open section closes when the queue empties.
  const updateQueueSection = () => {
    let button = document.getElementById(BUTTON_ID);
    let section = document.getElementById(SECTION_ID);
    const leaveBtn = document.getElementById('owp-btn-leave');
    if (!hasQueue() || !leaveBtn) {
      button?.remove();
      section?.remove();
      if (state.roomBarSection === 'queue') {
        state.roomBarSection = '';
        views.applyRoomSection?.();
      }
      return;
    }
    if (!button) {
      button = iconButton(t('queue'), 'playlist', () => views.toggleRoomSection('queue'));
      button.id = BUTTON_ID;
      button.setAttribute('aria-controls', SECTION_ID);
      button.setAttribute('aria-expanded', String(state.roomBarSection === 'queue'));
      leaveBtn.parentNode.insertBefore(button, document.getElementById('owp-btn-invite') || leaveBtn);
    }
    if (!section) {
      section = createElement('div');
      section.id = SECTION_ID;
      section.hidden = state.roomBarSection !== 'queue';
      const drop = document.getElementById('owp-room-drop');
      drop?.insertBefore(section, document.getElementById('owp-leave-confirm'));
    }
    // A queue_state that only starts or stops the countdown leaves the list,
    // and the button that has the focus, as they are.
    const key = JSON.stringify([state.queueItems, state.roomMediaId, state.isHost]);
    if (section.dataset.key !== key) {
      section.dataset.key = key;
      fillSection(section);
    }
  };

  // "Up next" while the server counts down: under the bar when the panel is
  // open, or on its own where the bar would be when it is closed. One timer
  // ticks each second and ends with the countdown.
  let tickTimer = null;

  const removeStrip = () => {
    document.getElementById(STRIP_ID)?.remove();
    if (tickTimer) OWP.timers.clear(tickTimer);
    tickTimer = null;
  };

  const createStrip = (next) => {
    const strip = createElement('div', 'owp-queue-next');
    strip.id = STRIP_ID;
    const text = createElement('span', 'owp-queue-next-text');
    text.append(document.createTextNode(`${t('queueUpNext')} `), createElement('b', '', next.title));
    text.title = next.title;
    const time = createElement('span', 'owp-queue-next-time');
    strip.append(createIcon('next'), text, time);
    if (state.isHost) {
      const actions = createElement('div', 'owp-queue-next-actions');
      actions.append(
        pillButton('secondary', t('cancel'), () => queue().cancelCountdown()),
        pillButton('primary', t('queueNext'), () => queue().advance(next.id), 'next')
      );
      strip.appendChild(actions);
    }
    strip.appendChild(createElement('span', 'owp-queue-next-bar'));
    return strip;
  };

  const placeStrip = () => {
    const next = queue().nextItem?.();
    const remaining = state.queueCountdownUntil - OWP.utils.getServerNow();
    if (!hasQueue() || !state.queueCountdownUntil || !next || remaining <= 0) {
      removeStrip();
      return;
    }
    let strip = document.getElementById(STRIP_ID);
    if (!strip || strip.dataset.item !== next.id || strip.dataset.host !== String(state.isHost)) {
      strip?.remove();
      strip = createStrip(next);
      strip.dataset.item = next.id;
      strip.dataset.host = String(state.isHost);
    }
    strip.querySelector('.owp-queue-next-time').textContent = t('queueSeconds', { seconds: Math.ceil(remaining / 1000) });
    strip.querySelector('.owp-queue-next-bar').style.width = `${Math.min(100, (remaining / QUEUE_COUNTDOWN_MS) * 100)}%`;
    const panel = document.getElementById(PANEL_ID);
    const bar = panel && !panel.classList.contains('hide') ? panel.querySelector('.owp-room-bar') : null;
    strip.classList.toggle('owp-queue-float', !bar);
    if (bar && strip.previousSibling !== bar) bar.parentNode.insertBefore(strip, bar.nextSibling);
    else if (!bar && strip.parentNode !== document.body) document.body.appendChild(strip);
    if (tickTimer) OWP.timers.clear(tickTimer);
    tickTimer = OWP.timers.setTimeout(updateStrip, remaining % 1000 || 1000, 'room');
  };

  // Over the player, the panel stays in sight while the strip is in it.
  const updateStrip = () => {
    placeStrip();
    if (ui.applyPlayerControls) ui.applyPlayerControls();
  };

  const updateQueue = () => {
    updateQueueSection();
    updateStrip();
  };

  Object.assign(ui, { updateQueue });
})();
