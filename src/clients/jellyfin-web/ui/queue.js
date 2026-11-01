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
  const hasQueue = () => state.inRoom && state.serverFeatures.includes('media_queue')
    && (state.isHost || state.serverFeatures.includes('queue_suggestions') || state.queueItems.length > 0);

  let viewRoom = '';
  let searchOpen = false;
  let searchTerm = '';
  let searchResults = [];
  let searchPending = false;
  let searchDone = false;

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

  const unavailableText = (id) => {
    const unavailable = state.queueUnavailable.find(entry => entry.id === id);
    if (!unavailable) return '';
    const people = [...(unavailable.you ? [t('queueYou')] : []), ...unavailable.names];
    if (people.length === 1) return t('queueUnavailableOne', { a: people[0] });
    if (people.length === 2) return t('queueUnavailableTwo', { a: people[0], b: people[1] });
    return t('queueUnavailableMore', { a: people[0], count: people.length - 1 });
  };

  const warning = (id) => {
    const text = unavailableText(id);
    if (!text) return null;
    const line = createElement('span', 'owp-queue-sub owp-queue-warn');
    line.append(createIcon('alert'), document.createTextNode(text));
    return line;
  };

  const closeSearch = () => {
    searchOpen = false;
    ui.updateQueue();
    document.getElementById('owp-queue-add')?.focus?.();
  };

  const runSearch = (value) => {
    searchTerm = value;
    queue().search?.(value, (results, searched) => {
      searchPending = results === null;
      searchDone = searched && results !== null;
      if (results) searchResults = results;
      ui.updateQueue();
    });
  };

  const resultAction = (result) => {
    const id = result.item.id;
    if (state.queueItems.some(item => item.id === id)) return createElement('span', 'owp-queue-state', t('queueInQueue'));
    if (!state.isHost && state.queueSuggestions.some(item => item.id === id)) {
      return createElement('span', 'owp-queue-state', t('queueSuggestedState'));
    }
    const host = state.isHost;
    const full = !host && state.queueSuggestions.length >= 10;
    const button = pillButton(host ? 'primary' : 'secondary', t(host ? 'queueAddAction' : 'queueSuggestAction'), () => {
      if (host) queue().add?.(result.item);
      else queue().suggest?.(result.item);
    });
    if (full) {
      button.setAttribute('aria-disabled', 'true');
      button.title = t('queueSuggestionsFull');
      button.onclick = () => {};
    }
    return button;
  };

  const createSearch = () => {
    const search = createElement('div', 'owp-queue-search');
    const box = createElement('label', 'owp-queue-search-box');
    box.appendChild(createIcon('search'));
    const input = createElement('input');
    input.type = 'search';
    input.value = searchTerm;
    input.addEventListener('input', () => runSearch(input.value));
    // Escape leaves the search only; the drop-down's own Escape would close
    // the whole section.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    });
    box.appendChild(input);
    search.append(box, iconButton(t('queueCloseSearch'), 'x', closeSearch));
    return search;
  };

  // The search box is built once per search, so a re-render (results, queue
  // messages arriving while typing) keeps its text, caret and focus; only the
  // head and the results are replaced around it.
  const fillSearch = (section, head) => {
    const existing = section.querySelector('.owp-queue-search');
    const search = existing || createSearch();
    const input = search.querySelector('input');
    input.placeholder = t(state.isHost ? 'queueSearchHost' : 'queueSearchGuest');
    input.setAttribute('aria-label', input.placeholder);
    const list = createElement('div', 'owp-queue-results');
    searchResults.forEach((result) => {
      const row = createElement('div', 'owp-queue-item owp-queue-result');
      const text = createElement('span', 'owp-queue-two');
      const name = createElement('span', 'owp-queue-name', result.label);
      name.title = result.label;
      text.append(name, createElement('span', 'owp-queue-sub', [result.kind, result.detail].filter(Boolean).join(' · ')));
      row.append(text, resultAction(result));
      list.appendChild(row);
    });
    if (searchPending) list.replaceChildren(createElement('div', 'owp-queue-note', t('queueSearching')));
    else if (searchDone && searchResults.length === 0) list.appendChild(createElement('div', 'owp-queue-note', t('queueNoResults')));
    if (existing) {
      section.querySelector('.owp-queue-head')?.replaceWith(head);
      section.querySelector('.owp-queue-results')?.replaceWith(list);
      return;
    }
    section.replaceChildren(head, search, list);
    input.focus?.();
  };

  // Watched items, the room's item and the upcoming ones. The host can play,
  // move and remove the upcoming ones; the server keeps the watched ones and
  // the room's item where they are.
  const fillSection = (section) => {
    const items = state.queueItems;
    const current = items.findIndex(item => item.id === state.roomMediaId);
    const head = createElement('div', 'owp-queue-head');
    head.appendChild(createElement('span', 'owp-queue-title', t('queueTitle')));
    if (state.isHost || state.serverFeatures.includes('queue_suggestions')) {
      const add = iconButton(t(state.isHost ? 'queueAdd' : 'queueSuggest'), 'plus', () => {
        searchOpen = !searchOpen;
        ui.updateQueue();
      });
      add.id = 'owp-queue-add';
      add.setAttribute('aria-expanded', String(searchOpen));
      head.appendChild(add);
    }
    if (state.isHost) {
      const previous = queue().previousItem?.();
      const next = queue().nextItem?.();
      const back = pillButton('secondary', t('queuePrevious'), () => previous && queue().advance(previous.id), 'prev', true);
      const forward = pillButton('primary', t('queueNext'), () => next && queue().advance(next.id), 'next');
      if (!previous) back.setAttribute('aria-disabled', 'true');
      if (!next) forward.setAttribute('aria-disabled', 'true');
      head.append(back, forward);
    }
    if (searchOpen) {
      fillSearch(section, head);
      return;
    }
    const list = createElement('ol', 'owp-queue-list');
    items.forEach((item, index) => {
      const watched = index < current;
      const row = createElement('li', `owp-queue-item${watched ? ' done' : ''}${index === current ? ' current' : ''}`);
      const mark = createElement('span', 'owp-queue-mark');
      if (watched) mark.appendChild(createIcon('check'));
      else if (index === current) mark.appendChild(createIcon('play'));
      else mark.textContent = String(index - current);
      const text = createElement('span', 'owp-queue-two');
      const name = createElement('span', 'owp-queue-name', item.title);
      name.title = item.title;
      text.appendChild(name);
      const unavailable = warning(item.id);
      if (unavailable) text.appendChild(unavailable);
      row.append(mark, text);
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
    if (!items.length) list.appendChild(createElement('li', 'owp-queue-note', t('queueEmpty')));
    const suggestions = createElement('div', 'owp-queue-suggestions');
    if (state.queueSuggestions.length) {
      suggestions.appendChild(createElement('div', 'owp-queue-suggest-title', t('queueSuggestions')));
      state.queueSuggestions.forEach((suggestion) => {
        const row = createElement('div', 'owp-queue-item owp-queue-suggestion');
        const text = createElement('span', 'owp-queue-two');
        const name = createElement('span', 'owp-queue-name', suggestion.title);
        name.title = suggestion.title;
        const sub = createElement('span', 'owp-queue-sub', suggestion.mine
          ? t('queueYourSuggestion')
          : t('queueSuggestedBy', { name: suggestion.by }));
        const unavailable = unavailableText(suggestion.id);
        if (unavailable) {
          const warning = createElement('span', 'owp-queue-warn');
          warning.append(createIcon('alert'), document.createTextNode(unavailable));
          sub.append(document.createTextNode(' · '), warning);
        }
        text.append(name, sub);
        // An empty mark keeps the titles in line with the queue's.
        row.append(createElement('span', 'owp-queue-mark'), text);
        if (state.isHost) {
          const actions = createElement('span', 'owp-queue-actions');
          actions.append(
            iconButton(t('queueAcceptSuggestion'), 'check', () => queue().accept?.(suggestion)),
            iconButton(t('queueDismissSuggestion'), 'x', () => queue().dismiss?.(suggestion.id))
          );
          row.appendChild(actions);
        } else if (suggestion.mine) {
          row.appendChild(iconButton(t('queueWithdrawSuggestion'), 'x', () => queue().withdraw?.(suggestion.id)));
        }
        suggestions.appendChild(row);
      });
    }
    const note = createElement('div', 'owp-queue-note', t(state.isHost ? 'queueAutoNote' : 'queueGuestNote'));
    section.replaceChildren(head, list, suggestions, note);
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
    if (viewRoom !== state.roomId) {
      viewRoom = state.roomId;
      searchOpen = false;
      searchTerm = '';
      searchResults = [];
      searchPending = false;
      searchDone = false;
    }
    if (searchOpen && !state.isHost && !state.serverFeatures.includes('queue_suggestions')) searchOpen = false;
    if (!button) {
      button = iconButton(t('queue'), 'playlist', () => views.toggleRoomSection('queue'));
      button.id = BUTTON_ID;
      button.setAttribute('aria-controls', SECTION_ID);
      button.setAttribute('aria-expanded', String(state.roomBarSection === 'queue'));
      leaveBtn.parentNode.insertBefore(button, document.getElementById('owp-btn-invite') || leaveBtn);
    }
    let badge = button.querySelector('.owp-queue-badge');
    if (state.isHost && state.queueSuggestions.length) {
      if (!badge) {
        badge = createElement('span', 'owp-queue-badge');
        button.appendChild(badge);
      }
      badge.textContent = state.queueSuggestions.length;
    } else badge?.remove();
    if (!section) {
      section = createElement('div');
      section.id = SECTION_ID;
      section.hidden = state.roomBarSection !== 'queue';
      const drop = document.getElementById('owp-room-drop');
      drop?.insertBefore(section, document.getElementById('owp-leave-confirm'));
    }
    // A queue_state that only starts or stops the countdown leaves the list,
    // and the button that has the focus, as they are.
    const key = JSON.stringify([
      state.queueItems, state.queueSuggestions, state.queueUnavailable, state.roomMediaId,
      state.isHost, searchOpen, searchTerm, searchResults, searchPending, searchDone
    ]);
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
