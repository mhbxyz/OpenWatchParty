class FakeNode {
  constructor(nodeType, tagName = '') {
    this.nodeType = nodeType;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this._text = '';
  }

  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map(node => node.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = String(value);
      return;
    }
    this.replaceChildren(new FakeText(String(value)));
  }

  appendChild(node) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    nodes.forEach(node => this.appendChild(typeof node === 'string' ? new FakeText(node) : node));
  }

  prepend(...nodes) {
    nodes.reverse().forEach(node => {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      if (child.parentNode) child.remove();
      child.parentNode = this;
      this.childNodes.unshift(child);
    });
  }

  replaceChildren(...nodes) {
    this.childNodes.forEach(node => { node.parentNode = null; });
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index !== -1) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super(3);
    this._text = text;
  }
}

const matchesSimple = (element, selector) => {
  const notMatch = selector.match(/:not\(([^)]+)\)$/);
  if (notMatch) {
    selector = selector.slice(0, notMatch.index);
    if (matchesSimple(element, notMatch[1])) return false;
  }
  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch && element.id !== idMatch[1]) return false;
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  if (classes.some(name => !element.classList.contains(name))) return false;
  const tag = selector.match(/^[a-zA-Z][\w-]*/)?.[0];
  return !tag || element.tagName === tag.toUpperCase();
};

const descendants = (root) => root.children.flatMap(child => [child, ...descendants(child)]);

const matchesSelector = (element, selector) => {
  const parts = selector.trim().split(/\s+/);
  let candidate = element;
  if (!matchesSimple(candidate, parts.pop())) return false;
  while (parts.length) {
    const part = parts.pop();
    candidate = candidate.parentNode;
    while (candidate && (candidate.nodeType !== 1 || !matchesSimple(candidate, part))) {
      candidate = candidate.parentNode;
    }
    if (!candidate) return false;
  }
  return true;
};

class FakeElement extends FakeNode {
  constructor(tagName, creationOptions = {}) {
    super(1, tagName);
    this.id = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.creationOptions = creationOptions;
  }

  get classList() {
    return {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(name => classes.add(name));
        this.className = [...classes].join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: name => {
        if (this.classList.contains(name)) {
          this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' ');
          return false;
        }
        this.classList.add(name);
        return true;
      }
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  dispatchEvent(event) {
    const normalized = typeof event === 'string' ? { type: event } : event;
    normalized.target ||= this;
    normalized.currentTarget = this;
    normalized.bubbles ??= true;
    const originalStopPropagation = normalized.stopPropagation;
    normalized.stopPropagation = () => {
      normalized.propagationStopped = true;
      if (originalStopPropagation) originalStopPropagation.call(normalized);
    };
    for (const listener of this.listeners[normalized.type] || []) listener(normalized);
    if (normalized.type === 'click' && typeof this.onclick === 'function') this.onclick(normalized);
    if (normalized.bubbles && !normalized.propagationStopped && this.parentNode?.dispatchEvent) {
      this.parentNode.dispatchEvent(normalized);
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', stopPropagation() {}, preventDefault() {} });
  }

  querySelectorAll(selector) {
    return descendants(this).filter(element => matchesSelector(element, selector));
  }

  querySelector(selector) {
    for (const alternative of selector.split(',')) {
      const match = this.querySelectorAll(alternative.trim())[0];
      if (match) return match;
    }
    return null;
  }

  closest(selector) {
    let element = this;
    while (element) {
      if (element.nodeType === 1 && matchesSelector(element, selector)) return element;
      element = element.parentNode;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }

  createElement(tagName, creationOptions) {
    return new FakeElement(tagName, creationOptions);
  }

  createTextNode(text) {
    return new FakeText(String(text));
  }

  getElementById(id) {
    return this.body.id === id ? this.body : descendants(this.body).find(element => element.id === id) || null;
  }

  querySelector(selector) {
    if (matchesSelector(this.body, selector)) return this.body;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

module.exports = { FakeDocument };
