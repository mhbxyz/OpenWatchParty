(() => {
  const OWP = window.OpenWatchParty = window.OpenWatchParty || {};
  const ui = OWP.ui = OWP.ui || {};
  const views = ui._panelViews = ui._panelViews || {};
  const state = OWP.state;
  const t = OWP.i18n.t;
  const { createElement } = views;


  const nextHostParticipant = () => state.isHost
    && state.serverFeatures.includes('host_transfer')
    && state.participants.find(participant => !participant.isHost);


  const updateLeaveConfirm = () => {
    const confirm = document.getElementById('owp-leave-confirm');
    const leaveBtn = document.getElementById('owp-btn-leave');
    if (!confirm || !leaveBtn) return;
    const nextHost = nextHostParticipant();
    const canTransfer = Boolean(nextHost);
    const label = state.isHost && !canTransfer ? t('closeRoom') : t('leaveRoom');
    leaveBtn.title = label;
    leaveBtn.setAttribute('aria-label', label);

    const active = document.activeElement;
    const hadFocus = Boolean(active && confirm.contains(active));
    const focusedId = hadFocus ? active.id : '';
    const focusedAction = hadFocus ? active.dataset.action || '' : '';
    const cancel = createElement('button', 'owp-pill-btn secondary', t('cancel'));
    cancel.id = 'owp-btn-cancel-leave';
    cancel.dataset.action = 'cancel';
    cancel.type = 'button';
    cancel.onclick = () => {
      views.toggleRoomSection('leave');
      leaveBtn.focus();
    };
    const question = createElement(
      'span',
      'owp-leave-question',
      state.isHost && !canTransfer ? t('closeRoomQuestion') : t('leaveRoomQuestion')
    );
    const buttons = [question, cancel];
    if (canTransfer) {
      const leave = createElement('button', 'owp-pill-btn secondary', t('leave'));
      leave.id = 'owp-btn-leave-room';
      leave.dataset.action = 'leave';
      leave.type = 'button';
      leave.onclick = () => OWP.actions?.leaveRoom?.();
      buttons.push(leave);
    }
    const confirmLeave = createElement(
      'button',
      'owp-pill-btn danger',
      state.isHost ? (canTransfer ? t('closeForEveryone') : t('closeRoom')) : t('leave')
    );
    confirmLeave.id = 'owp-btn-confirm-leave';
    confirmLeave.dataset.action = state.isHost ? 'close' : 'leave';
    confirmLeave.type = 'button';
    confirmLeave.onclick = () => {
      const action = state.isHost ? OWP.actions?.closeRoom : OWP.actions?.leaveRoom;
      if (action) action();
    };
    buttons.push(confirmLeave);
    if (canTransfer) {
      buttons.push(createElement(
        'div',
        'owp-leave-hint',
        t('leaveHint', { name: nextHost.name || t('guest') })
      ));
    }
    confirm.replaceChildren(...buttons);
    if (hadFocus) {
      const replacement = focusedId && document.getElementById(focusedId);
      const keepsAction = replacement
        && confirm.contains(replacement)
        && replacement.dataset.action === focusedAction;
      (keepsAction ? replacement : cancel).focus({ preventScroll: true });
    }
  };
  Object.assign(ui, { updateLeaveConfirm });
})();
