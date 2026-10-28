(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  OWP.emoji = OWP.emoji || {};

  const getTypingContext = (input) => {
    const text = input.value.slice(0, input.selectionStart);
    const match = text.match(/:([a-z0-9_]*)$/i);
    if (!match || match[1].length < 2) return null;
    return match[1];
  };

  const insertEmoji = (char, stem, input) => {
    const before = input.value.slice(0, input.selectionStart);
    const after  = input.value.slice(input.selectionStart);
    const target = ':' + stem;
    const index = before.toLowerCase().lastIndexOf(target.toLowerCase());
    const replaced = (index !== -1 ? before.slice(0, index) : before) + char;
    input.value = replaced + after;
    const pos = replaced.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  };

  let suggestionBox = null;
  let activeIndex = -1;
  let autocompleteInput = null;

  const hideSuggestions = () => {
    if (suggestionBox) {
      suggestionBox.remove();
      suggestionBox = null;
    }
    if (autocompleteInput) {
      autocompleteInput.setAttribute('aria-expanded', 'false');
      autocompleteInput.removeAttribute('aria-activedescendant');
    }
    activeIndex = -1;
  };

  const highlightSuggestion = (items) => {
    items.forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (autocompleteInput) {
      if (activeIndex >= 0 && items[activeIndex]) {
        autocompleteInput.setAttribute('aria-activedescendant', items[activeIndex].id);
      } else {
        autocompleteInput.removeAttribute('aria-activedescendant');
      }
    }
  };

  const showSuggestions = (results, stem, input) => {
    hideSuggestions();
    if (!results.length) return;

    autocompleteInput = input;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'owp-emoji-autocomplete');

    suggestionBox = document.createElement('div');
    suggestionBox.id = 'owp-emoji-autocomplete';
    suggestionBox.setAttribute('role', 'listbox');
    suggestionBox.setAttribute('aria-label', OWP.i18n.t('emoji'));
    activeIndex = 0;

    const items = results.map(({ s, c }, index) => {
      const row = document.createElement('div');
      row.className = 'owp-emoji-suggestion';
      row.id = 'owp-emoji-opt-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', `:${s}:`);
      const charSpan = document.createElement('span');
      charSpan.className = 'owp-emoji-suggestion-char';
      charSpan.textContent = c;
      const codeSpan = document.createElement('span');
      codeSpan.className = 'owp-emoji-suggestion-code';
      codeSpan.textContent = `:${s}:`;
      row.append(charSpan, codeSpan);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertEmoji(c, stem, input);
        hideSuggestions();
      });
      return row;
    });

    suggestionBox.addEventListener('pointerdown', (e) => e.stopPropagation());
    suggestionBox.addEventListener('mousedown', (e) => e.stopPropagation());
    suggestionBox.addEventListener('wheel', (e) => e.stopPropagation());

    items.forEach((el, index) => {
      el.addEventListener('mouseenter', () => {
        activeIndex = index;
        highlightSuggestion(items);
      });
      suggestionBox.appendChild(el);
    });
    highlightSuggestion(items);

    const rect = input.getBoundingClientRect();
    suggestionBox.style.left = rect.left + 'px';
    suggestionBox.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

    document.body.appendChild(suggestionBox);
  };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      if (suggestionBox) {
        e.preventDefault();
        hideSuggestions();
        return true;
      }
      if (pickerEl && document.body?.contains?.(pickerEl)) {
        e.preventDefault();
        const fromInput = document.activeElement === pickerInput;
        closePicker(!fromInput);
        if (fromInput && pickerInput) pickerInput.focus();
        return true;
      }
      return false;
    }

    if (!suggestionBox) return false;
    const items = Array.from(suggestionBox.querySelectorAll('.owp-emoji-suggestion'));
    if (!items.length) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      highlightSuggestion(items);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightSuggestion(items);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && activeIndex >= 0 && items[activeIndex]) {
      e.preventDefault();
      const event = typeof MouseEvent !== 'undefined' ? new MouseEvent('mousedown') : { type: 'mousedown', preventDefault() {} };
      items[activeIndex].dispatchEvent(event);
      return true;
    }
    return false;
  };

  const setupAutocomplete = (input) => {
    autocompleteInput = input;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-haspopup', 'listbox');

    input.addEventListener('input', () => {
      const textBefore = input.value.slice(0, input.selectionStart);
      const fullMatch = textBefore.match(/:([a-z0-9_]+):$/i);
      if (fullMatch) {
        const code = fullMatch[1].toLowerCase();
        const found = OWP.emoji.EMOJI.find(e => e.s === code);
        if (found) {
          insertEmoji(found.c, fullMatch[1] + ':', input);
          hideSuggestions();
          return;
        }
      }

      const stem = getTypingContext(input);
      if (!stem) {
        hideSuggestions();
        return;
      }
      showSuggestions(OWP.emoji.search(stem, 3), stem, input);
    });
  };

  const CATEGORIES = [
    { key: 'faces',    i18n: 'emojiCat_faces',    icon: '😊' },
    { key: 'hands',    i18n: 'emojiCat_hands',    icon: '👍' },
    { key: 'symbols',  i18n: 'emojiCat_symbols',  icon: '❤️'  },
    { key: 'nature',   i18n: 'emojiCat_nature',   icon: '🌿' },
    { key: 'food',     i18n: 'emojiCat_food',     icon: '🍕' },
    { key: 'activity', i18n: 'emojiCat_activity', icon: '🎬' },
  ];

  let pickerEl = null;
  let pickerInput = null;
  let activeTab = CATEGORIES[0].key;

  const showTab = (key) => {
    activeTab = key;
    const grouped = OWP.emoji.byCategory();
    const grid = pickerEl.querySelector('.owp-emoji-grid');
    grid.replaceChildren();
    (grouped[key] || []).forEach(({ s, c }) => {
      const btn = document.createElement('button');
      btn.className = 'owp-emoji-item';
      btn.type = 'button';
      btn.title = `:${s}:`;
      btn.setAttribute('aria-label', `:${s}:`);
      btn.textContent = c;
      btn.addEventListener('click', () => {
        if (!pickerInput) return;
        const pos = pickerInput.selectionStart;
        const value = pickerInput.value;
        pickerInput.value = value.slice(0, pos) + c + value.slice(pos);
        const newPos = pos + c.length;
        pickerInput.setSelectionRange(newPos, newPos);
        pickerInput.focus();
        closePicker();
      });
      grid.appendChild(btn);
    });

    pickerEl.querySelectorAll('.owp-emoji-cat-btn').forEach(btn => {
      const active = btn.dataset.cat === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  const isPickerOpen = () => Boolean(pickerEl && document.body?.contains?.(pickerEl));
  const focusPicker = () => {
    if (!isPickerOpen()) return;
    const target = pickerEl.querySelector('.owp-emoji-cat-btn.active')
      || pickerEl.querySelector('.owp-emoji-cat-btn')
      || pickerEl.querySelector('.owp-emoji-item');
    target?.focus();
  };

  const buildPicker = () => {
    const panel = document.createElement('div');
    panel.id = 'owp-emoji-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', OWP.i18n.t('emojiPicker'));

    const tabs = document.createElement('div');
    tabs.className = 'owp-emoji-cats';
    tabs.setAttribute('role', 'tablist');
    CATEGORIES.forEach(({ key, i18n, icon }) => {
      const btn = document.createElement('button');
      btn.className = 'owp-emoji-cat-btn';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', key === activeTab ? 'true' : 'false');
      const label = OWP.i18n.t(i18n);
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.textContent = icon;
      btn.dataset.cat = key;
      btn.addEventListener('click', () => showTab(key));
      tabs.appendChild(btn);
    });

    const grid = document.createElement('div');
    grid.className = 'owp-emoji-grid';

    panel.append(tabs, grid);

    const stopPropagation = (e) => e.stopPropagation();
    panel.addEventListener('pointerdown', stopPropagation);
    panel.addEventListener('mousedown', stopPropagation);
    panel.addEventListener('wheel', stopPropagation);
    panel.addEventListener('keyup', stopPropagation);
    panel.addEventListener('keypress', stopPropagation);

    panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker(true);
        return;
      }

      const focusable = Array.from(panel.querySelectorAll('button'));
      if (e.key === 'Tab' && focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const emojiBtn = document.getElementById('owp-emoji-btn');

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          (emojiBtn || last).focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      const active = document.activeElement;
      if (active?.classList?.contains('owp-emoji-item')) {
        const items = Array.from(panel.querySelectorAll('.owp-emoji-item'));
        const idx = items.indexOf(active);
        if (idx !== -1) {
          let nextIdx = -1;
          if (e.key === 'ArrowRight') nextIdx = Math.min(idx + 1, items.length - 1);
          else if (e.key === 'ArrowLeft') nextIdx = Math.max(idx - 1, 0);
          else if (e.key === 'ArrowDown') nextIdx = Math.min(idx + 6, items.length - 1);
          else if (e.key === 'ArrowUp') {
            if (idx >= 6) nextIdx = idx - 6;
            else {
              e.preventDefault();
              focusPicker();
              return;
            }
          } else if (e.key === 'Home') nextIdx = 0;
          else if (e.key === 'End') nextIdx = items.length - 1;

          if (nextIdx !== -1) {
            e.preventDefault();
            items[nextIdx].focus();
            return;
          }
        }
      }

      if (active?.classList?.contains('owp-emoji-cat-btn')) {
        const cats = Array.from(panel.querySelectorAll('.owp-emoji-cat-btn'));
        const idx = cats.indexOf(active);
        if (idx !== -1) {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : cats.length - 1;
            const next = cats[(idx + step) % cats.length];
            next.focus();
            showTab(next.dataset.cat);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            panel.querySelector('.owp-emoji-item')?.focus();
          }
        }
      }
    });

    return panel;
  };

  const positionPicker = (emojiBtn) => {
    const chatDrop = document.getElementById('owp-room-drop') || emojiBtn.closest('.owp-room-drop');
    const bounds = chatDrop ? chatDrop.getBoundingClientRect() : emojiBtn.getBoundingClientRect();
    const btnRect = emojiBtn.getBoundingClientRect();

    const rightOffset = Math.max(8, window.innerWidth - bounds.right);
    pickerEl.style.right = rightOffset + 'px';
    pickerEl.style.left = 'auto';
    pickerEl.style.top = (btnRect.bottom + 6) + 'px';
    pickerEl.style.bottom = 'auto';
  };

  const closePicker = (returnFocus = false) => {
    if (!pickerEl) return;
    pickerEl.remove();
    const btn = document.getElementById('owp-emoji-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (returnFocus && btn) btn.focus();
  };

  const openPicker = (emojiBtn, input) => {
    if (!pickerEl) pickerEl = buildPicker();
    pickerInput = input;
    document.body.appendChild(pickerEl);
    positionPicker(emojiBtn);
    showTab(activeTab);
    emojiBtn.setAttribute('aria-expanded', 'true');
    focusPicker();
  };

  const togglePicker = (input) => {
    const emojiBtn = document.getElementById('owp-emoji-btn');
    if (!emojiBtn) return;
    if (document.body.contains(pickerEl)) {
      closePicker(true);
    } else {
      openPicker(emojiBtn, input);
    }
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    // Registered once here, not in setupAutocomplete: that runs on every
    // room redraw and would pile up document listeners over a session.
    document.addEventListener('click', (e) => {
      if (suggestionBox && !suggestionBox.contains(e.target)) hideSuggestions();
    });
    document.addEventListener('click', (e) => {
      if (!isPickerOpen()) return;
      const emojiBtn = document.getElementById('owp-emoji-btn');
      if (!pickerEl.contains(e.target) && e.target !== emojiBtn) closePicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && document.activeElement?.id === 'owp-emoji-btn' && isPickerOpen()) {
        e.preventDefault();
        focusPicker();
        return;
      }
      if (e.key === 'Escape' && isPickerOpen()) {
        e.preventDefault();
        closePicker(true);
      }
    });
  }

  Object.assign(OWP.emoji, { setupAutocomplete, togglePicker, handleKeydown, closePicker, hideSuggestions, insertEmoji, isPickerOpen, focusPicker });
})();
