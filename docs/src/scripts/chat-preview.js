const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function initializeChatPreview(chat) {
    const form = chat.querySelector('form');
    const input = chat.querySelector('input');
    const messages = chat.querySelector('.preview-messages');
    form.addEventListener('submit', event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const message = document.createElement('p');
      message.className = 'preview-message is-own is-new';
      const name = document.createElement('span');
      name.textContent = 'You';
      message.append(name, document.createTextNode(` ${text}`));
      messages.append(message);
      while (messages.children.length > 6) messages.firstElementChild.remove();
      input.value = '';
      messages.scrollTop = messages.scrollHeight;
    });
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        if (!reducedMotion.matches) chat.classList.add('is-animating');
        observer.disconnect();
      }
    }, { threshold: .5 });
    observer.observe(chat);
}
