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

  const hideSuggestions = () => {
    if (suggestionBox) {
      suggestionBox.remove();
      suggestionBox = null;
    }
    activeIndex = -1;
  };

  const highlightSuggestion = (items) => {
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  };

  const showSuggestions = (results, stem, input) => {
    hideSuggestions();
    if (!results.length) return;

    suggestionBox = document.createElement('div');
    suggestionBox.id = 'owp-emoji-autocomplete';
    activeIndex = 0;

    const items = results.map(({ s, c }) => {
      const row = document.createElement('div');
      row.className = 'owp-emoji-suggestion';
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
        closePicker();
        if (pickerInput) pickerInput.focus();
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
      items[activeIndex].dispatchEvent(new MouseEvent('mousedown'));
      return true;
    }
    return false;
  };

  const setupAutocomplete = (input) => {
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

    document.addEventListener('click', (e) => {
      if (suggestionBox && !suggestionBox.contains(e.target)) hideSuggestions();
    });
  };

  const CATEGORIES = [
    { key: 'faces',    icon: '😊' },
    { key: 'hands',    icon: '👍' },
    { key: 'symbols',  icon: '❤️'  },
    { key: 'nature',   icon: '🌿' },
    { key: 'food',     icon: '🍕' },
    { key: 'activity', icon: '🎬' },
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
      btn.classList.toggle('active', btn.dataset.cat === key);
    });
  };

  const buildPicker = () => {
    const panel = document.createElement('div');
    panel.id = 'owp-emoji-panel';

    const tabs = document.createElement('div');
    tabs.className = 'owp-emoji-cats';
    CATEGORIES.forEach(({ key, icon }) => {
      const btn = document.createElement('button');
      btn.className = 'owp-emoji-cat-btn';
      btn.type = 'button';
      btn.title = key;
      btn.textContent = icon;
      btn.dataset.cat = key;
      btn.addEventListener('click', () => showTab(key));
      tabs.appendChild(btn);
    });

    const grid = document.createElement('div');
    grid.className = 'owp-emoji-grid';

    panel.append(tabs, grid);
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

  const closePicker = () => {
    if (!pickerEl) return;
    pickerEl.remove();
    const btn = document.getElementById('owp-emoji-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  };

  const openPicker = (emojiBtn, input) => {
    if (!pickerEl) pickerEl = buildPicker();
    pickerInput = input;
    document.body.appendChild(pickerEl);
    positionPicker(emojiBtn);
    showTab(activeTab);
    emojiBtn.setAttribute('aria-expanded', 'true');
  };

  const togglePicker = (input) => {
    const emojiBtn = document.getElementById('owp-emoji-btn');
    if (!emojiBtn) return;
    if (document.body.contains(pickerEl)) {
      closePicker();
    } else {
      openPicker(emojiBtn, input);
    }
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      if (!pickerEl || !document.body?.contains?.(pickerEl)) return;
      const emojiBtn = document.getElementById('owp-emoji-btn');
      if (!pickerEl.contains(e.target) && e.target !== emojiBtn) closePicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pickerEl && document.body?.contains?.(pickerEl)) {
        e.preventDefault();
        closePicker();
        if (pickerInput) pickerInput.focus();
      }
    });
  }

  Object.assign(OWP.emoji, { setupAutocomplete, togglePicker, handleKeydown, closePicker, hideSuggestions, insertEmoji });
})();
