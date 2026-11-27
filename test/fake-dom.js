// A minimal fake DOM for running extension pages (overlay.js, options.js) in node:vm.
// Elements are created on first lookup by id; events are dispatched by hand with fire().
class El {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), doc, children: [], attrs: {}, listeners: {}, style: {}, hidden: false, ownText: '', value: '' });
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new El('#text', this.doc), { ownText: n }) : n); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  focus() { this.doc.activeElement = this; }
  select() {}
  remove() {}
  contains() { return true; }
  getClientRects() { return [{}]; }
  querySelectorAll() { return []; }
  // Only attribute selectors like '[data-edit]' are needed.
  querySelector(sel) { const attr = /^\[([\w-]+)\]$/.exec(sel)?.[1]; return attr ? this.find(el => el !== this && attr in el.attrs) : null; }
  // Dispatches a DOM-like event; returns whether a listener called preventDefault().
  fire(type, props = {}) {
    let prevented = false;
    const ev = { type, button: 0, target: this, preventDefault() { prevented = true; }, ...props };
    for (const fn of this.listeners[type] || []) fn(ev);
    return prevented;
  }
  click() { this.fire('click'); }
  find(pred) { return pred(this) ? this : this.children.reduce((hit, c) => hit || c.find(pred), null); }
}

function makeDocument() {
  const ids = new Map();
  const listeners = {};
  const document = {
    activeElement: null,
    visibilityState: 'visible',
    createElement: tag => new El(tag, document),
    getElementById: id => { if (!ids.has(id)) ids.set(id, new El('div', document)); return ids.get(id); },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    execCommand: () => false,
  };
  document.body = new El('body', document);
  const fireDocument = (type, props = {}) => { for (const fn of listeners[type] || []) fn({ type, preventDefault() {}, ...props }); };
  return { document, fireDocument };
}

module.exports = { El, makeDocument };
