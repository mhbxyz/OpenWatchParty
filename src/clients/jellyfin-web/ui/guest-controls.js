(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const state = OWP.state;

  const LOCKED_CLASS = 'owp-guest-locked';
  const PLAY_LOCKED_CLASS = 'owp-guest-play-locked';
  const LABEL_ID = 'owp-guest-lock-label';
  // The position slider's container, marked so the CSS dims it and not the
  // volume slider, which uses the same container class.
  const POSITION_CONTAINER_CLASS = 'owp-position-slider-container';
  const TOAST_INTERVAL_MS = 2500;
  const SEEK_LOCKED_TEXT = 'Only the host can seek';
  const WAITING_TEXT = 'Waiting for the host…';
  const SEEK_BUTTON_SELECTOR = [
    '.btnPreviousTrack',
    '.btnNextTrack',
    '.btnPreviousChapter',
    '.btnNextChapter',
    '.btnRewind',
    '.btnFastForward'
  ].join(', ');
  const SEEK_CODES = new Set([
    'KeyJ', 'KeyL', 'ArrowLeft', 'ArrowRight', 'Comma', 'Period',
    'Home', 'End', 'PageUp', 'PageDown'
  ]);
  const SEEK_KEYS = new Set([
    'j', 'J', 'l', 'L', 'ArrowLeft', 'Left', 'ArrowRight', 'Right',
    ',', '.', 'Home', 'End', 'PageUp', 'PageDown'
  ]);
  let lastBlockedToastAt = -Infinity;

  const getVideo = () => OWP.utils?.getVideo?.() || null;
  const isGuestLocked = (video) => Boolean(video && state.inRoom && !state.isHost);
  // Play and pause are everyone's; play only waits while the host's stream
  // loads.
  const isPlayLocked = (video) => isGuestLocked(video)
    && video.paused
    && state.roomWaiting;

  const showBlockedToast = (message) => {
    const now = Date.now();
    if (now - lastBlockedToastAt < TOAST_INTERVAL_MS) return;
    lastBlockedToastAt = now;
    if (OWP.ui?.showToast) OWP.ui.showToast(message);
  };

  const blockEvent = (event, message = SEEK_LOCKED_TEXT) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    showBlockedToast(message);
  };

  const isVideoSurface = (target) => target?.tagName === 'VIDEO'
    || target?.classList?.contains('videoPlayerContainer');

  const isPositionSlider = (target) => Boolean(target?.closest?.('.videoOsdBottom .osdPositionSlider'));

  // The CSS that makes the slider inert follows the role on the next tick;
  // this covers a guest who presses on it before that.
  const handlePointerDown = (event) => {
    if (isGuestLocked(getVideo()) && isPositionSlider(event.target)) blockEvent(event);
  };

  const handleClick = (event) => {
    const video = getVideo();
    if (!isGuestLocked(video)) return;
    const seekButton = event.target?.closest?.(SEEK_BUTTON_SELECTOR);
    if (seekButton?.closest('.videoOsdBottom')) {
      blockEvent(event);
      return;
    }
    if (isPlayLocked(video)
      && (event.target?.closest?.('.btnPause') || isVideoSurface(event.target))) {
      blockEvent(event, WAITING_TEXT);
    }
  };

  // Text fields such as the OWP chat; not the position slider, a range input
  // that the arrow, Home, End and Page keys would move.
  const isEditable = (target) => !isPositionSlider(target) && Boolean(target?.isContentEditable
    || target?.closest?.('input, textarea, select, [contenteditable]'));

  const isTvNavigationKey = (event) => {
    if (!document.documentElement.classList.contains('layout-tv')) return false;
    const code = event.code || '';
    const key = event.key || '';
    return code.startsWith('Arrow') || key.startsWith('Arrow')
      || code === 'Left' || code === 'Right' || key === 'Left' || key === 'Right'
      || code.startsWith('Navigation') || key.startsWith('Navigation')
      || code.startsWith('Gamepad') || key.startsWith('Gamepad');
  };

  const isSeekKey = (event) => {
    const code = event.code || '';
    const key = event.key || '';
    if (SEEK_CODES.has(code) || SEEK_KEYS.has(code) || SEEK_CODES.has(key) || SEEK_KEYS.has(key)) return true;
    if (/^(Digit|Numpad)[0-9]$/.test(code) || /^[0-9]$/.test(key)) return true;
    return event.shiftKey
      && (code === 'KeyP' || code === 'KeyN' || key.toLowerCase() === 'p' || key.toLowerCase() === 'n');
  };

  const isPlayKey = (event) => event.code === 'KeyK'
    || event.key === 'k'
    || event.key === 'K'
    || event.code === 'Space'
    || event.key === ' '
    || event.keyCode === 32;

  const isArrowKey = (event) => /^(Arrow)?(Up|Down|Left|Right)$/.test(event.code || '')
    || /^(Arrow)?(Up|Down|Left|Right)$/.test(event.key || '');

  const isOtherControl = (target) => Boolean(target?.closest?.('button, [role="button"], a')
    && !target.closest('.btnPause'));

  const handleKeydown = (event) => {
    const video = getVideo();
    if (!isGuestLocked(video) || event.ctrlKey || event.altKey || event.metaKey || isEditable(event.target)) return;
    // On the focused slider every arrow seeks (up and down too), in the TV
    // layout as well.
    const onSlider = isPositionSlider(event.target);
    if (isTvNavigationKey(event) && !onSlider) return;
    if (isSeekKey(event) || (onSlider && isArrowKey(event))) {
      blockEvent(event);
      return;
    }
    if (!isPlayLocked(video) || !isPlayKey(event)) return;
    // Space on another focused control (subtitles, mute...) still presses it;
    // only Jellyfin's play shortcut, which would also run, is kept out.
    if ((event.code === 'Space' || event.key === ' ' || event.keyCode === 32) && isOtherControl(event.target)) {
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }
    blockEvent(event, WAITING_TEXT);
  };

  const removeLabel = () => document.getElementById(LABEL_ID)?.remove();

  const updateLabel = () => {
    const slider = document.querySelector('.videoOsdBottom .osdPositionSlider');
    const container = slider?.closest('.sliderContainer');
    const row = container?.parentNode;
    document.querySelectorAll(`.${POSITION_CONTAINER_CLASS}`).forEach(marked => {
      if (marked !== container) marked.classList.remove(POSITION_CONTAINER_CLASS);
    });
    if (!row?.parentNode) {
      removeLabel();
      return;
    }
    container.classList.add(POSITION_CONTAINER_CLASS);
    let label = document.getElementById(LABEL_ID);
    if (!label) {
      label = document.createElement('div');
      label.id = LABEL_ID;
      const icon = document.createElement('span');
      icon.className = 'material-icons owp-guest-lock-icon';
      const text = document.createElement('span');
      text.className = 'owp-guest-lock-text';
      label.append(icon, text);
    }
    const mode = state.roomWaiting ? 'waiting' : 'locked';
    if (label.dataset.mode !== mode) {
      label.dataset.mode = mode;
      label.querySelector('.owp-guest-lock-icon').textContent = state.roomWaiting ? 'hourglass_empty' : 'lock';
      label.querySelector('.owp-guest-lock-text').textContent = state.roomWaiting
        ? WAITING_TEXT
        : SEEK_LOCKED_TEXT;
    }
    // Below the slider row on screen: Jellyfin stacks the OSD rows with
    // `column-reverse`, where the element before the row is drawn under it.
    const reversed = window.getComputedStyle?.(row.parentNode)?.flexDirection === 'column-reverse';
    const before = reversed ? row : row.nextSibling;
    if (label.parentNode !== row.parentNode || label.nextSibling !== before) {
      row.parentNode.insertBefore(label, before);
    }
  };

  const updateGuestControls = () => {
    const root = document.documentElement;
    const video = getVideo();
    const locked = isGuestLocked(video);
    root.classList.toggle(LOCKED_CLASS, locked);
    root.classList.toggle(PLAY_LOCKED_CLASS, isPlayLocked(video));
    if (locked) updateLabel();
    else removeLabel();
  };

  if (!ui.guestControlListenersInstalled) {
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('touchstart', handlePointerDown, true);
    window.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleKeydown, true);
    ui.guestControlListenersInstalled = true;
  }

  Object.assign(ui, { updateGuestControls });
})();
