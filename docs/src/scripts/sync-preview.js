const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function initializeSyncPreview(sync) {
    let touched = false;
    const setPlayback = value => {
      sync.dataset.playing = String(value);
      sync.querySelector('[data-sync-toggle]').setAttribute('aria-pressed', String(value));
      sync.querySelector('[data-sync-toggle] span').textContent = value ? 'Pause for everyone' : 'Play for everyone';
      sync.querySelector('[data-host-status]').textContent = value ? 'Playing' : 'Paused';
      sync.querySelector('[data-guest-status]').textContent = value ? 'In sync' : 'Paused';
    };
    setPlayback(false);
    sync.querySelector('[data-sync-toggle]').addEventListener('click', () => {
      touched = true;
      setPlayback(sync.dataset.playing !== 'true');
    });
    const people = sync.querySelector('[data-people-toggle]');
    people.addEventListener('click', () => {
      const expanded = people.getAttribute('aria-expanded') !== 'true';
      people.setAttribute('aria-expanded', String(expanded));
      people.classList.toggle('selected', expanded);
      sync.querySelector('#preview-participants').hidden = !expanded;
    });
    new IntersectionObserver(entries => {
      const visible = entries[0].isIntersecting;
      sync.classList.toggle('is-visible', visible);
      if (visible && !touched && !reducedMotion.matches) setPlayback(true);
    }, { threshold: .3 }).observe(sync);
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) setPlayback(false);
    });
}
