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

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index > 0 ? this.parentNode.childNodes[index - 1] : null;
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

  insertBefore(node, reference) {
    if (reference == null) return this.appendChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index === -1) throw new Error('Reference node is not a child');
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  append(...nodes) {
    nodes.forEach(node => this.appendChild(typeof node === 'string' ? new FakeText(node) : node));
  }

  insertBefore(node, referenceNode) {
    if (!referenceNode) return this.appendChild(node);
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) throw new Error('Reference node is not a child');
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
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

  contains(node) {
    for (let candidate = node; candidate; candidate = candidate.parentNode) {
      if (candidate === this) return true;
    }
    return false;
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
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)];
  const attributeValue = name => (name === 'class'
    ? element.className || undefined
    : (Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : undefined));
  if (attributes.some(([, name, operator, value]) => {
    const actual = attributeValue(name);
    if (operator === undefined) return actual === undefined;
    if (operator === '*=') return actual === undefined || !String(actual).includes(value);
    return actual !== value;
  })) return false;
  selector = selector.replace(/\[[^\]]*\]/g, '');
  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch && element.id !== idMatch[1]) return false;
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  if (classes.some(name => !element.classList.contains(name))) return false;
  const tag = selector.match(/^[a-zA-Z][\w-]*/)?.[0];
  return !tag || element.tagName === tag.toUpperCase();
};

const descendants = (root) => root.children.flatMap(child => [child, ...descendants(child)]);

const matchesSelector = (element, selector) => {
  if (selector.includes(',')) return selector.split(',').some(part => matchesSelector(element, part));
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
    // Custom properties go through setProperty, like in a browser; the methods
    // are not enumerable, so a style still compares as its plain properties.
    this.style = Object.defineProperties({}, {
      setProperty: { value(name, value) { this[name] = String(value); } },
      removeProperty: { value(name) { delete this[name]; } }
    });
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
      remove: (...names) => {
        this.className = this.className.split(/\s+/)
          .filter(value => value && !names.includes(value)).join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        if (force === true) {
          this.classList.add(name);
          return true;
        }
        if (force === false || this.classList.contains(name)) {
          this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' ');
          return false;
        }
        this.classList.add(name);
        return true;
      }
    };
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
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
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.documentElement.append(this.head, this.body);
  }

  createElementNS(namespace, tagName) {
    const element = this.createElement(tagName);
    element.namespaceURI = namespace;
    return element;
  }

  createElement(tagName, creationOptions) {
    return new FakeElement(tagName, creationOptions);
  }

  createTextNode(text) {
    return new FakeText(String(text));
  }

  getElementById(id) {
    return [this.body, this.head].flatMap(root => [root, ...descendants(root)])
      .find(element => element.id === id) || null;
  }

  querySelector(selector) {
    if (matchesSelector(this.body, selector)) return this.body;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

class FakeWindow {
  constructor(document) {
    this.document = document;
    this.listeners = {};
  }

  addEventListener(type, listener, options) {
    (this.listeners[type] ||= []).push({ listener, capture: options === true || options?.capture === true });
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter(entry => entry.listener !== listener);
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.propagationStopped = true; };
    event.stopImmediatePropagation ||= () => { event.immediatePropagationStopped = true; };
    for (const entry of this.listeners[event.type] || []) {
      entry.listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return !event.defaultPrevented;
  }
}

module.exports = { FakeDocument, FakeWindow };
