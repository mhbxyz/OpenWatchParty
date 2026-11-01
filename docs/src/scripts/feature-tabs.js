const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Rotates the room-feature tabs every `period` ms while the section is visible.
// Hover and keyboard focus pause the rotation; a click restarts the cycle from that tab.
export function initializeFeatureTabs(root, period = 5000) {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
    let index = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
    let timer;
    let visible = false;
    let hovering = false;
    let focused = false;

    root.style.setProperty('--rotate-duration', `${period}ms`);

    const running = () => visible && !hovering && !focused && !document.hidden && !reducedMotion.matches;

    const schedule = () => {
      clearTimeout(timer);
      root.classList.remove('is-rotating');
      if (!running()) return;
      void root.offsetWidth; // restart the progress-rule animation
      root.classList.add('is-rotating');
      timer = setTimeout(() => select(index + 1), period);
    };

    const select = (next, { focus = false } = {}) => {
      index = (next + tabs.length) % tabs.length;
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
      });
      if (focus) tabs[index].focus();
      schedule();
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i));
      tab.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); select(index + 1, { focus: true }); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); select(index - 1, { focus: true }); }
        if (event.key === 'Home') { event.preventDefault(); select(0, { focus: true }); }
        if (event.key === 'End') { event.preventDefault(); select(tabs.length - 1, { focus: true }); }
      });
    });
    root.addEventListener('mouseenter', () => { hovering = true; schedule(); });
    root.addEventListener('mouseleave', () => { hovering = false; schedule(); });
    root.addEventListener('focusin', event => {
      if (!event.target.matches(':focus-visible') && !event.target.matches('input')) return;
      focused = true;
      schedule();
    });
    root.addEventListener('focusout', event => {
      if (root.contains(event.relatedTarget)) return;
      focused = false;
      schedule();
    });
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      schedule();
    }, { threshold: .35 }).observe(root);
    document.addEventListener('visibilitychange', schedule);
    reducedMotion.addEventListener('change', schedule);

    select(index);
}
