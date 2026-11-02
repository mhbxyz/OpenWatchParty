const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export const introducePage = () => {
    if (reducedMotion.matches || !Element.prototype.animate || !window.IntersectionObserver) return;

    const entrances = new Map();
    const offsets = {
      up: 'translateY(28px)',
      down: 'translateY(-10px)',
      fade: 'none',
    };
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entrances.get(entry.target)?.play();
        observer.unobserve(entry.target);
      });
    }, { threshold: .15, rootMargin: '0px 0px -28px 0px' });

    const reveal = (selector, direction = 'up', delay = 0, stagger = 0, immediate = false) => {
      document.querySelectorAll(selector).forEach((element, index) => {
        const from = { opacity: 0 };
        const to = { opacity: 1 };
        if (direction !== 'fade') {
          from.transform = offsets[direction];
          to.transform = 'none';
        }
        const animation = element.animate([from, to], {
          duration: 800,
          delay: delay + index * stagger,
          easing: 'cubic-bezier(.2, .7, .2, 1)',
          fill: 'both',
        });
        animation.pause();
        entrances.set(element, animation);
        animation.onfinish = () => {
          // Release the effect so hover transforms, menus and video controls keep their normal behaviour.
          entrances.delete(element);
          animation.cancel();
        };
        if (immediate) animation.play();
        else observer.observe(element);
      });
    };

    const stagger = window.matchMedia('(min-width: 761px)').matches ? 120 : 0;
    reveal('.site-header', 'down', 0, 0, true);
    reveal('.hero-kicker', 'up', 50, 0, true);
    reveal('.hero h1', 'up', 150, 0, true);
    reveal('.hero-support', 'up', 350, 0, true);
    reveal('.demo-frame', 'up', 450, 0, true);
    reveal('.demo-footnote', 'fade', 650, 0, true);
    reveal('.promise-item', 'up', 0, stagger);
    reveal('.section-heading', 'up');
    reveal('.step', 'up', 0, stagger);
    reveal('.steps-note', 'fade', 100);
    reveal('.feature-tabs', 'up');
    reveal('.guide-copy', 'up');
    reveal('.guide-links', 'up', 150);
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
