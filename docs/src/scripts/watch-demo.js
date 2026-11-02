const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const formatTime = seconds => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function initializeWatchDemo(demo) {
    const videos = [...demo.querySelectorAll('video')];
    const [host, guest] = videos;
    const toggle = demo.querySelector('[data-demo-toggle]');
    const replay = demo.querySelector('[data-demo-restart]');
    const caption = demo.querySelector('[data-demo-caption]');
    const clock = demo.querySelector('[data-demo-clock]');
    const screenTimes = [...demo.querySelectorAll('[data-demo-time]')];
    let events = [];
    let visible = false;
    let userPaused = false;
    let userStarted = false;
    let playing = false;
    let pendingPlay = false;
    let lastSeek = 0;
    let frame;

    fetch(demo.dataset.timelineUrl)
      .then(response => response.ok ? response.json() : null)
      .then(data => { events = data?.events || []; })
      .catch(() => {});

    const setPlaying = value => {
      playing = value;
      demo.classList.toggle('is-playing', value);
      toggle.setAttribute('aria-pressed', String(value));
      toggle.setAttribute('aria-label', value ? 'Pause the two recordings' : 'Play the two recordings');
    };

    const paint = () => {
      const duration = Number.isFinite(host.duration) && host.duration > 0 ? host.duration : 0;
      demo.style.setProperty('--progress', duration ? host.currentTime / duration : 0);
      clock.textContent = `${formatTime(host.currentTime)} / ${formatTime(duration)}`;
      screenTimes[0].textContent = formatTime(host.currentTime);
      screenTimes[1].textContent = formatTime(guest.currentTime);
    };

    const update = (now = performance.now()) => {
      if (Number.isFinite(host.duration) && host.duration > 0) {
        paint();
        const event = events.findLast(item => item.at <= host.currentTime);
        if (event && caption.textContent !== event.label) caption.textContent = event.label;
        const drift = guest.currentTime - host.currentTime;
        if (!guest.seeking && guest.readyState >= 3) {
          if (Math.abs(drift) > .4 && now - lastSeek > 1500) {
            guest.currentTime = host.currentTime;
            lastSeek = now;
          } else {
            guest.playbackRate = drift > .04 ? .96 : drift < -.04 ? 1.04 : 1;
          }
        }
      }
      if (playing) frame = requestAnimationFrame(update);
    };

    const pause = () => {
      videos.forEach(video => video.pause());
      cancelAnimationFrame(frame);
      setPlaying(false);
    };

    const play = async () => {
      if (pendingPlay) return;
      pendingPlay = true;
      try {
        if (Number.isFinite(host.duration) && host.currentTime >= host.duration - .1) {
          videos.forEach(video => { video.currentTime = 0; });
        }
        if (guest.readyState >= 1 && Math.abs(guest.currentTime - host.currentTime) > .25) {
          guest.currentTime = host.currentTime;
        }
        await Promise.all(videos.map(video => video.play()));
        if (!visible || document.hidden || userPaused) {
          pause();
          return;
        }
        setPlaying(true);
        cancelAnimationFrame(frame);
        update();
      } catch {
        // The shared Play button also covers browsers that block autoplay.
        pause();
      } finally {
        pendingPlay = false;
      }
    };

    videos.forEach(video => { video.controls = false; video.muted = true; });
    host.addEventListener('loadedmetadata', paint);
    toggle.addEventListener('click', () => {
      userPaused = playing || pendingPlay;
      userStarted = !userPaused;
      if (userPaused) pause();
      else play();
    });
    replay.addEventListener('click', () => {
      pause();
      videos.forEach(video => { video.currentTime = 0; });
      userPaused = false;
      userStarted = true;
      update();
      play();
    });
    host.addEventListener('ended', () => {
      pause();
      videos.forEach(video => { video.currentTime = 0; });
      if (visible && !userPaused && (!reducedMotion.matches || userStarted)) play();
    });
    // Brief decoding waits resume natively; rate correction avoids repeated seeks.
    videos.forEach(video => video.addEventListener('canplay', () => {
      if (visible && !userPaused && (!reducedMotion.matches || userStarted) && !playing) play();
    }));
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible && !userPaused && (!reducedMotion.matches || userStarted)) play();
      else if (!visible) pause();
    }, { threshold: .2 }).observe(demo);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause();
      else if (visible && !userPaused && (!reducedMotion.matches || userStarted)) play();
    });
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) { userStarted = false; pause(); }
      else if (visible && !userPaused) play();
    });
}
