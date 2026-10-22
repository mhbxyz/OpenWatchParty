const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export const introducePage = () => {
    if (reducedMotion.matches || !Element.prototype.animate || !window.IntersectionObserver) return;

    const entrances = new Map();
    const offsets = {
      up: 'translateY(22px)',
      down: 'translateY(-10px)',
      left: 'translateX(-22px)',
      right: 'translateX(22px)',
      fade: 'none',
    };
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entrances.get(entry.target)?.play();
        observer.unobserve(entry.target);
      });
    }, { threshold: .08, rootMargin: '0px 0px -28px 0px' });

    const reveal = (selector, direction = 'up', delay = 0, stagger = 0, immediate = false) => {
      document.querySelectorAll(selector).forEach((element, index) => {
        const from = { opacity: 0 };
        const to = { opacity: 1 };
        if (direction !== 'fade') {
          from.transform = offsets[direction];
          to.transform = 'none';
        }
        const animation = element.animate([from, to], {
          duration: 680,
          delay: delay + index * stagger,
          easing: 'cubic-bezier(.22, 1, .36, 1)',
          fill: 'both',
        });
        animation.pause();
        entrances.set(element, animation);
        animation.onfinish = () => {
          // Release the effect so menus and video controls keep their normal layout.
          entrances.delete(element);
          animation.cancel();
        };
        if (immediate) animation.play();
        else observer.observe(element);
      });
    };

    const stagger = window.matchMedia('(min-width: 761px)').matches ? 90 : 0;
    reveal('.site-header', 'down', 0, 0, true);
    reveal('.hero-kicker', 'fade', 80, 0, true);
    reveal('.hero h1', 'up', 140, 0, true);
    reveal('.hero-description', 'right', 220, 0, true);
    reveal('.hero-actions', 'up', 300, 0, true);
    reveal('.hero-note', 'fade', 380, 0, true);
    reveal('.demo-screen-host', 'left', 330);
    reveal('.demo-screen-guest', 'right', 430);
    reveal('.screen-connection, .demo-toolbar, .demo-progress, .demo-footnote', 'fade', 520);
    reveal('.promise-strip', 'fade');
    reveal('.section-heading', 'up');
    reveal('.step', 'up', 40, stagger);
    reveal('.steps-note, .preview-intro', 'fade', 100);
    reveal('.feature', 'up', 50, stagger);
    reveal('.guide-copy', 'left');
    reveal('.guide-links > a', 'right', 40, stagger / 2);
    reveal('.site-footer', 'fade');

    // Keyboard navigation must never land on a control waiting to appear.
    document.addEventListener('focusin', event => {
      if (!event.target.matches(':focus-visible')) return;
      entrances.forEach((animation, element) => {
        if (element.contains(event.target)) {
          animation.cancel();
          entrances.delete(element);
          observer.unobserve(element);
        }
      });
    });
    reducedMotion.addEventListener('change', () => {
      if (!reducedMotion.matches) return;
      observer.disconnect();
      entrances.forEach(animation => animation.cancel());
      entrances.clear();
    });
  };
