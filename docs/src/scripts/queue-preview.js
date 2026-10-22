const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function initializeQueuePreview(queue) {
    const start = queue.querySelector('[data-queue-start]');
    const next = queue.querySelector('[data-queue-next]');
    const upNext = queue.querySelector('.preview-up-next');
    const countdown = upNext.querySelector('output');
    const currentTitle = queue.querySelector('.is-current > span');
    const upcoming = queue.querySelector('.is-upcoming');
    const note = queue.querySelector('.queue-auto-note');
    let remaining = 10;
    let timer;
    let advanced = false;
    let autoStarted = false;

    const cancelCountdown = () => {
      clearInterval(timer);
      timer = undefined;
      upNext.hidden = true;
    };
    const advance = () => {
      cancelCountdown();
      advanced = true;
      queue.classList.add('has-advanced');
      currentTitle.textContent = 'S1:E2 · Sprite Fright';
      upcoming.hidden = true;
      note.textContent = 'The whole room is watching the next episode.';
      next.disabled = true;
      start.querySelector('span').textContent = 'Replay the up-next preview';
    };
    const begin = () => {
      cancelCountdown();
      advanced = false;
      queue.classList.remove('has-advanced');
      currentTitle.textContent = 'S1:E1 · Wing It!';
      upcoming.hidden = false;
      next.disabled = false;
      note.textContent = 'The next episodes are added automatically.';
      remaining = 10;
      upNext.hidden = false;
      countdown.textContent = '10 s';
      upNext.style.setProperty('--countdown', 1);
      start.querySelector('span').textContent = 'Cancel countdown';
      timer = setInterval(() => {
        remaining -= 1;
        countdown.textContent = `${remaining} s`;
        upNext.style.setProperty('--countdown', remaining / 10);
        if (remaining === 0) advance();
      }, 1000);
    };
    start.addEventListener('click', () => {
      autoStarted = true;
      if (timer) {
        cancelCountdown();
        start.querySelector('span').textContent = 'Try the up-next countdown';
      } else begin();
    });
    next.addEventListener('click', () => { autoStarted = true; advance(); });
    new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !autoStarted && !advanced && !reducedMotion.matches) {
        autoStarted = true;
        begin();
      }
    }, { threshold: .6 }).observe(queue);
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches && timer) {
        cancelCountdown();
        start.querySelector('span').textContent = 'Try the up-next countdown';
      }
    });
}
