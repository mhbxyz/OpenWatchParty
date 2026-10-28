const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { FakeDocument } = require('./fake-dom.js');

let focused = null;
const FakeElement = Object.getPrototypeOf(new FakeDocument().createElement('div'));

FakeElement.focus = function focus() {
  focused = this;
};
FakeElement.blur = function blur() {
  if (focused === this) focused = null;
};
FakeElement.getBoundingClientRect = function getBoundingClientRect() {
  return this.boxForTest || { left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 };
};
FakeElement.setSelectionRange = function setSelectionRange(start, end) {
  this.selectionStart = start;
  this.selectionEnd = end;
};
FakeElement.removeAttribute = function removeAttribute(name) {
  delete this.attributes[name];
  if (name === 'id') this.id = '';
  if (name === 'class') this.className = '';
};
Object.defineProperty(FakeElement, 'title', {
  configurable: true,
  get() { return this.attributes['title'] || this._title || ''; },
  set(v) { this._title = v; this.setAttribute('title', v); }
});

FakeDocument.prototype.addEventListener = function addEventListener(type, listener) {
  (this._listeners ||= {})[type] ||= [];
  this._listeners[type].push(listener);
};
FakeDocument.prototype.removeEventListener = function removeEventListener(type, listener) {
  if (!this._listeners?.[type]) return;
  this._listeners[type] = this._listeners[type].filter(l => l !== listener);
};
FakeDocument.prototype.dispatchEvent = function dispatchEvent(event) {
  const normalized = typeof event === 'string' ? { type: event } : event;
  normalized.target ||= this;
  normalized.currentTarget = this;
  for (const listener of this._listeners?.[normalized.type] || []) listener(normalized);
  return !normalized.defaultPrevented;
};
Object.defineProperty(FakeDocument.prototype, 'activeElement', {
  configurable: true,
  get: () => focused
});

const OWP = require('./setup.js');

globalThis.document = new FakeDocument();
globalThis.window.innerWidth = 1024;
globalThis.window.innerHeight = 768;
OWP.ui = OWP.ui || {};
OWP.ui.stopPlayerCapture = () => {};

require('../chat/emoji-data.js');
delete require.cache[require.resolve('../chat/emoji-picker.js')];
require('../chat/emoji-picker.js');

const createKeyboardEvent = (type, key, options = {}) => {
  return {
    type,
    key,
    shiftKey: Boolean(options.shiftKey),
    bubbles: options.bubbles ?? true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }
  };
};

describe('emoji picker ARIA semantics and toggle state', () => {
  let input;
  let emojiBtn;

  beforeEach(() => {
    document.body.replaceChildren();
    focused = null;
    OWP.emoji.closePicker();
    OWP.emoji.hideSuggestions();

    input = document.createElement('input');
    input.id = 'owp-chat-input';
    input.value = '';
    input.selectionStart = 0;
    input.selectionEnd = 0;

    emojiBtn = document.createElement('button');
    emojiBtn.id = 'owp-emoji-btn';
    emojiBtn.type = 'button';
    emojiBtn.title = OWP.i18n.t('emojiPicker');
    emojiBtn.setAttribute('aria-label', OWP.i18n.t('emojiPicker'));
    emojiBtn.setAttribute('aria-expanded', 'false');
    emojiBtn.setAttribute('aria-haspopup', 'dialog');
    emojiBtn.setAttribute('aria-controls', 'owp-emoji-panel');
    emojiBtn.onclick = () => OWP.emoji.togglePicker(input);

    document.body.append(input, emojiBtn);
  });

  it('toggle button exposes dialog popup, controls, and expanded state', () => {
    assert.equal(emojiBtn.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(emojiBtn.getAttribute('aria-controls'), 'owp-emoji-panel');
    assert.equal(emojiBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(emojiBtn.getAttribute('aria-label'), 'Emoji picker');
    assert.equal(emojiBtn.getAttribute('title'), 'Emoji picker');

    emojiBtn.click();
    assert.equal(emojiBtn.getAttribute('aria-expanded'), 'true');
    assert.ok(document.getElementById('owp-emoji-panel'), 'picker panel should be open');

    emojiBtn.click();
    assert.equal(emojiBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById('owp-emoji-panel'), null, 'picker panel should be closed');
  });

  it('picker panel exposes dialog role, accessible name, and tablist with descriptive category labels', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    assert.ok(panel, 'picker panel must exist');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(panel.getAttribute('aria-modal'), 'false');
    assert.equal(panel.getAttribute('aria-label'), 'Emoji picker');

    const tabs = panel.querySelector('.owp-emoji-cats');
    assert.ok(tabs, 'tablist container must exist');
    assert.equal(tabs.getAttribute('role'), 'tablist');

    const catButtons = Array.from(tabs.querySelectorAll('.owp-emoji-cat-btn'));
    assert.equal(catButtons.length, 6);

    const expectedLabels = [
      'Smileys & Emotion',
      'People & Body',
      'Symbols',
      'Animals & Nature',
      'Food & Drink',
      'Activities'
    ];

    catButtons.forEach((btn, idx) => {
      assert.equal(btn.getAttribute('role'), 'tab');
      assert.equal(btn.getAttribute('aria-label'), expectedLabels[idx]);
      assert.equal(btn.getAttribute('title'), expectedLabels[idx]);
      if (idx === 0) {
        assert.equal(btn.getAttribute('aria-selected'), 'true');
        assert.ok(btn.classList.contains('active'));
      } else {
        assert.equal(btn.getAttribute('aria-selected'), 'false');
      }
    });
  });

  it('emoji grid and cells expose grid items and accessible emoji names', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    const grid = panel.querySelector('.owp-emoji-grid');
    assert.ok(grid, 'emoji grid must exist');

    const items = Array.from(grid.querySelectorAll('.owp-emoji-item'));
    assert.ok(items.length > 0, 'grid must contain emoji items');

    const first = items[0];
    assert.equal(first.tagName, 'BUTTON');
    assert.match(first.getAttribute('aria-label'), /^:[a-z0-9_]+:$/);
    assert.equal(first.getAttribute('aria-label'), first.getAttribute('title'));
    assert.ok(first.textContent.length > 0, 'emoji item must have glyph content');
  });
});

describe('emoji picker keyboard navigation and focus trapping', () => {
  let input;
  let emojiBtn;

  beforeEach(() => {
    document.body.replaceChildren();
    focused = null;
    OWP.emoji.closePicker();
    OWP.emoji.hideSuggestions();

    input = document.createElement('input');
    input.id = 'owp-chat-input';
    input.value = '';
    input.selectionStart = 0;
    input.selectionEnd = 0;

    emojiBtn = document.createElement('button');
    emojiBtn.id = 'owp-emoji-btn';
    emojiBtn.type = 'button';
    emojiBtn.title = OWP.i18n.t('emojiPicker');
    emojiBtn.setAttribute('aria-label', OWP.i18n.t('emojiPicker'));
    emojiBtn.setAttribute('aria-expanded', 'false');
    emojiBtn.setAttribute('aria-haspopup', 'dialog');
    emojiBtn.setAttribute('aria-controls', 'owp-emoji-panel');
    emojiBtn.onclick = () => OWP.emoji.togglePicker(input);

    document.body.append(input, emojiBtn);
  });

  it('opening picker places initial focus on the active category tab', () => {
    OWP.emoji.togglePicker(input);
    const activeTab = document.querySelector('.owp-emoji-cat-btn.active');
    assert.ok(activeTab, 'active tab must exist');
    assert.equal(document.activeElement, activeTab, 'focus must land on the active category tab');
  });

  it('Tab and Shift+Tab trap focus cyclically between picker and toggle button', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    const focusable = Array.from(panel.querySelectorAll('button'));
    const firstTab = focusable[0];
    const lastEmoji = focusable[focusable.length - 1];

    firstTab.focus();
    assert.equal(document.activeElement, firstTab);

    // Shift+Tab from first element wraps to toggle button
    const shiftTabEvent = createKeyboardEvent('keydown', 'Tab', { shiftKey: true });
    panel.dispatchEvent(shiftTabEvent);
    assert.ok(shiftTabEvent.defaultPrevented, 'Shift+Tab on first element should preventDefault');
    assert.equal(document.activeElement, emojiBtn, 'focus should wrap to emoji toggle button');

    // Tab from toggle button moves into picker
    const tabFromToggle = createKeyboardEvent('keydown', 'Tab', { shiftKey: false });
    document.dispatchEvent(tabFromToggle);
    assert.ok(tabFromToggle.defaultPrevented, 'Tab on emoji toggle button should preventDefault');
    assert.equal(document.activeElement, firstTab, 'focus should enter picker onto active tab');

    // Tab from last element wraps to first element
    lastEmoji.focus();
    assert.equal(document.activeElement, lastEmoji);
    const tabFromLast = createKeyboardEvent('keydown', 'Tab', { shiftKey: false });
    panel.dispatchEvent(tabFromLast);
    assert.ok(tabFromLast.defaultPrevented, 'Tab on last element should preventDefault');
    assert.equal(document.activeElement, firstTab, 'focus should wrap to first element in picker');
  });

  it('arrow keys navigate emoji grid horizontally by 1 and vertically by 6', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    const items = Array.from(panel.querySelectorAll('.owp-emoji-item'));
    assert.ok(items.length >= 12, 'must have enough items to test 6-column navigation');

    items[0].focus();
    assert.equal(document.activeElement, items[0]);

    // ArrowRight moves by 1
    const rightEvent = createKeyboardEvent('keydown', 'ArrowRight');
    panel.dispatchEvent(rightEvent);
    assert.ok(rightEvent.defaultPrevented);
    assert.ok(rightEvent.propagationStopped, 'propagation must be stopped to avoid player seek');
    assert.equal(document.activeElement, items[1]);

    // ArrowDown moves down 6 (1 row)
    const downEvent = createKeyboardEvent('keydown', 'ArrowDown');
    panel.dispatchEvent(downEvent);
    assert.ok(downEvent.defaultPrevented);
    assert.equal(document.activeElement, items[7]);

    // ArrowLeft moves back 1
    const leftEvent = createKeyboardEvent('keydown', 'ArrowLeft');
    panel.dispatchEvent(leftEvent);
    assert.ok(leftEvent.defaultPrevented);
    assert.equal(document.activeElement, items[6]);

    // ArrowUp moves up 6 (1 row)
    const upEvent = createKeyboardEvent('keydown', 'ArrowUp');
    panel.dispatchEvent(upEvent);
    assert.ok(upEvent.defaultPrevented);
    assert.equal(document.activeElement, items[0]);

    // ArrowUp from row 0 returns focus to category tabs
    const upFromTopEvent = createKeyboardEvent('keydown', 'ArrowUp');
    panel.dispatchEvent(upFromTopEvent);
    assert.ok(upFromTopEvent.defaultPrevented);
    const activeTab = panel.querySelector('.owp-emoji-cat-btn.active');
    assert.equal(document.activeElement, activeTab, 'focus should return to active category tab');
  });

  it('arrow keys navigate category tabs and switch active category', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    const cats = Array.from(panel.querySelectorAll('.owp-emoji-cat-btn'));

    cats[0].focus();
    assert.equal(document.activeElement, cats[0]);
    assert.equal(cats[0].getAttribute('aria-selected'), 'true');

    // ArrowRight moves to next category tab and activates it
    const rightEvent = createKeyboardEvent('keydown', 'ArrowRight');
    panel.dispatchEvent(rightEvent);
    assert.ok(rightEvent.defaultPrevented);
    assert.equal(document.activeElement, cats[1]);
    assert.equal(cats[1].getAttribute('aria-selected'), 'true');
    assert.equal(cats[0].getAttribute('aria-selected'), 'false');

    // ArrowLeft moves back to first category tab and activates it
    const leftEvent = createKeyboardEvent('keydown', 'ArrowLeft');
    panel.dispatchEvent(leftEvent);
    assert.ok(leftEvent.defaultPrevented);
    assert.equal(document.activeElement, cats[0]);
    assert.equal(cats[0].getAttribute('aria-selected'), 'true');

    // ArrowDown from category tab moves focus down into emoji grid
    const downEvent = createKeyboardEvent('keydown', 'ArrowDown');
    panel.dispatchEvent(downEvent);
    assert.ok(downEvent.defaultPrevented);
    const firstItem = panel.querySelector('.owp-emoji-item');
    assert.equal(document.activeElement, firstItem, 'focus should move into emoji grid');
  });

  it('Escape key closes picker and returns focus to toggle button without closing chat', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    assert.ok(panel);

    const escapeEvent = createKeyboardEvent('keydown', 'Escape');
    panel.dispatchEvent(escapeEvent);
    assert.ok(escapeEvent.defaultPrevented);
    assert.ok(escapeEvent.propagationStopped, 'event propagation must be stopped');
    assert.equal(document.getElementById('owp-emoji-panel'), null, 'picker must be closed');
    assert.equal(emojiBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, emojiBtn, 'focus must return to emoji button');
  });

  it('selecting an emoji inserts it into input and returns focus to input', () => {
    input.value = 'Hello ';
    input.selectionStart = 6;
    input.selectionEnd = 6;

    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    const firstEmoji = panel.querySelector('.owp-emoji-item');
    assert.ok(firstEmoji);

    const char = firstEmoji.textContent;
    firstEmoji.click();

    assert.equal(input.value, `Hello ${char}`);
    assert.equal(document.getElementById('owp-emoji-panel'), null, 'picker should close on select');
    assert.equal(document.activeElement, input, 'focus must return to input');
  });

  it('stops pointerdown, mousedown, and wheel propagation on emoji panel', () => {
    OWP.emoji.togglePicker(input);
    const panel = document.getElementById('owp-emoji-panel');
    assert.ok(panel);

    const pointerEvent = { type: 'pointerdown', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    panel.dispatchEvent(pointerEvent);
    assert.ok(pointerEvent.propagationStopped, 'pointerdown on emoji panel should stop propagation');

    const mouseEvent = { type: 'mousedown', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    panel.dispatchEvent(mouseEvent);
    assert.ok(mouseEvent.propagationStopped, 'mousedown on emoji panel should stop propagation');

    const wheelEvent = { type: 'wheel', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    panel.dispatchEvent(wheelEvent);
    assert.ok(wheelEvent.propagationStopped, 'wheel on emoji panel should stop propagation');
  });
});

describe('emoji autocomplete combobox semantics and interactions', () => {
  let input;

  beforeEach(() => {
    document.body.replaceChildren();
    focused = null;
    OWP.emoji.closePicker();
    OWP.emoji.hideSuggestions();

    input = document.createElement('input');
    input.id = 'owp-chat-input';
    input.value = '';
    input.selectionStart = 0;
    input.selectionEnd = 0;
    document.body.appendChild(input);

    OWP.emoji.setupAutocomplete(input);
  });

  it('input has initial combobox attributes and updates aria-expanded when suggestions appear', () => {
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-autocomplete'), 'list');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(input.getAttribute('aria-controls'), null);

    input.value = 'hello :sm';
    input.selectionStart = 9;
    input.selectionEnd = 9;
    input.dispatchEvent({ type: 'input' });

    const suggestions = document.getElementById('owp-emoji-autocomplete');
    assert.ok(suggestions, 'suggestions popup should appear');
    assert.equal(suggestions.getAttribute('role'), 'listbox');
    assert.equal(suggestions.getAttribute('aria-label'), 'Emoji');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(input.getAttribute('aria-controls'), 'owp-emoji-autocomplete');
  });

  it('autocomplete suggestions have option role and aria-selected', () => {
    input.value = ':sm';
    input.selectionStart = 3;
    input.selectionEnd = 3;
    input.dispatchEvent({ type: 'input' });

    const suggestions = document.getElementById('owp-emoji-autocomplete');
    assert.ok(suggestions);

    const items = Array.from(suggestions.querySelectorAll('.owp-emoji-suggestion'));
    assert.ok(items.length > 0, 'must have suggestions');

    items.forEach((item, index) => {
      assert.equal(item.getAttribute('role'), 'option');
      assert.equal(item.id, `owp-emoji-opt-${index}`);
      assert.match(item.getAttribute('aria-label'), /^:[a-z0-9_]+:$/);
      if (index === 0) {
        assert.equal(item.getAttribute('aria-selected'), 'true');
        assert.ok(item.classList.contains('active'));
      } else {
        assert.equal(item.getAttribute('aria-selected'), 'false');
      }
    });
  });

  it('ArrowDown and ArrowUp navigate suggestions and update aria-activedescendant', () => {
    input.value = ':sm';
    input.selectionStart = 3;
    input.selectionEnd = 3;
    input.dispatchEvent({ type: 'input' });

    const suggestions = document.getElementById('owp-emoji-autocomplete');
    const items = Array.from(suggestions.querySelectorAll('.owp-emoji-suggestion'));
    assert.ok(items.length >= 2, 'need at least 2 suggestions');

    assert.equal(input.getAttribute('aria-activedescendant'), 'owp-emoji-opt-0');

    // ArrowDown
    const downEvent = createKeyboardEvent('keydown', 'ArrowDown');
    const downHandled = OWP.emoji.handleKeydown(downEvent);
    assert.ok(downHandled, 'ArrowDown should be handled by emoji key handler');
    assert.ok(downEvent.defaultPrevented);
    assert.equal(input.getAttribute('aria-activedescendant'), 'owp-emoji-opt-1');
    assert.equal(items[1].getAttribute('aria-selected'), 'true');
    assert.equal(items[0].getAttribute('aria-selected'), 'false');

    // ArrowUp
    const upEvent = createKeyboardEvent('keydown', 'ArrowUp');
    const upHandled = OWP.emoji.handleKeydown(upEvent);
    assert.ok(upHandled, 'ArrowUp should be handled by emoji key handler');
    assert.ok(upEvent.defaultPrevented);
    assert.equal(input.getAttribute('aria-activedescendant'), 'owp-emoji-opt-0');
    assert.equal(items[0].getAttribute('aria-selected'), 'true');
    assert.equal(items[1].getAttribute('aria-selected'), 'false');
  });

  it('Enter and Tab select active suggestion, insert emoji, and reset combobox state', () => {
    // Enter key selection
    input.value = 'testing :so';
    input.selectionStart = 11;
    input.selectionEnd = 11;
    input.dispatchEvent({ type: 'input' });

    assert.ok(document.getElementById('owp-emoji-autocomplete'));
    const enterEvent = createKeyboardEvent('keydown', 'Enter');
    const enterHandled = OWP.emoji.handleKeydown(enterEvent);
    assert.ok(enterHandled, 'Enter should be handled by emoji key handler');
    assert.ok(enterEvent.defaultPrevented);
    assert.equal(document.getElementById('owp-emoji-autocomplete'), null, 'suggestions should be dismissed');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    assert.ok(!input.value.includes(':so'), 'shortcode stem should be replaced by emoji');

    // Tab key selection
    input.value = 'second :he';
    input.selectionStart = 10;
    input.selectionEnd = 10;
    input.dispatchEvent({ type: 'input' });

    assert.ok(document.getElementById('owp-emoji-autocomplete'));
    const tabEvent = createKeyboardEvent('keydown', 'Tab');
    const tabHandled = OWP.emoji.handleKeydown(tabEvent);
    assert.ok(tabHandled, 'Tab should be handled by emoji key handler');
    assert.ok(tabEvent.defaultPrevented);
    assert.equal(document.getElementById('owp-emoji-autocomplete'), null);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);
    assert.ok(!input.value.includes(':he'));
  });

  it('Escape dismisses suggestions, resets aria-expanded and aria-activedescendant without closing chat', () => {
    input.value = 'testing :sm';
    input.selectionStart = 11;
    input.selectionEnd = 11;
    input.dispatchEvent({ type: 'input' });

    assert.ok(document.getElementById('owp-emoji-autocomplete'));
    assert.equal(input.getAttribute('aria-expanded'), 'true');

    const escapeEvent = createKeyboardEvent('keydown', 'Escape');
    const escapeHandled = OWP.emoji.handleKeydown(escapeEvent);
    assert.ok(escapeHandled, 'Escape should be handled and prevent chat drop-down from closing');
    assert.ok(escapeEvent.defaultPrevented);
    assert.equal(document.getElementById('owp-emoji-autocomplete'), null, 'suggestions must be dismissed');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);
  });

  it('stops pointerdown, mousedown, and wheel propagation on autocomplete', () => {
    input.value = ':sm';
    input.selectionStart = 3;
    input.selectionEnd = 3;
    input.dispatchEvent({ type: 'input' });

    const suggestions = document.getElementById('owp-emoji-autocomplete');
    assert.ok(suggestions);

    const autoPointer = { type: 'pointerdown', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    suggestions.dispatchEvent(autoPointer);
    assert.ok(autoPointer.propagationStopped, 'pointerdown on autocomplete should stop propagation');

    const autoMouse = { type: 'mousedown', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    suggestions.dispatchEvent(autoMouse);
    assert.ok(autoMouse.propagationStopped, 'mousedown on autocomplete should stop propagation');

    const autoWheel = { type: 'wheel', bubbles: true, stopPropagation() { this.propagationStopped = true; } };
    suggestions.dispatchEvent(autoWheel);
    assert.ok(autoWheel.propagationStopped, 'wheel on autocomplete should stop propagation');
  });
});
