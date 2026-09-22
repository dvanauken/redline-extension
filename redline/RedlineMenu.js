/**
 * A menu button whose menu is positioned beside the toolbar rather than inside
 * it, so opening it can neither widen the bar nor be clipped by the bar's
 * overflow.
 *
 * Keyboard: Enter, Space or ArrowDown opens on the first item and ArrowUp on
 * the last; arrows, Home and End move; Escape closes and returns focus to the
 * button; Tab closes and lets focus continue.
 */
export class RedlineMenu {
  constructor({ trigger, container, label, onOpen = () => {}, onClose = () => {} }) {
    this.trigger = trigger;
    this.container = container;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.pinned = false;
    this.menu = document.createElement('div');
    this.menu.dataset.redlineMenu = '';
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', label);
    this.menu.hidden = true;
    this.menu.id = `redline-menu-${Math.random().toString(36).slice(2, 10)}`;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', this.menu.id);
    container.appendChild(this.menu);

    trigger.addEventListener('click', event => {
      event.stopPropagation();
      if (this.isOpen) this.close({ focusTrigger: false, force: true });
      else this.open();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        this.open({ focus: event.key === 'ArrowUp' ? 'last' : 'first' });
      }
    });
    this.menu.addEventListener('keydown', event => this._onKeyDown(event));
    this.menu.addEventListener('click', event => {
      const item = event.target.closest('[role^="menuitem"]');
      if (item && !item.hasAttribute('data-redline-keep-open')) this.close();
    });
  }

  get isOpen() { return !this.menu.hidden; }

  items() {
    return [...this.menu.querySelectorAll('[role^="menuitem"]')]
      .filter(item => !item.hidden && !item.disabled);
  }

  add(element) {
    element.tabIndex = -1;
    this.menu.appendChild(element);
    return element;
  }

  addSeparator() {
    const separator = document.createElement('div');
    separator.setAttribute('role', 'separator');
    separator.dataset.redlineMenuSeparator = '';
    this.menu.appendChild(separator);
    return separator;
  }

  setPinned(pinned) {
    this.pinned = Boolean(pinned);
    this.menu.toggleAttribute('data-pinned', this.pinned);
    return this.pinned;
  }

  open({ focus = 'first' } = {}) {
    if (this.trigger.disabled) return;
    this.onOpen(this);
    this.menu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.position();
    const items = this.items();
    // Open on the chosen tool; a checked option such as Include cursor is not a choice among items.
    const target = focus === 'last' ? items.at(-1)
      : items.find(item => item.getAttribute('role') === 'menuitemradio' && item.getAttribute('aria-checked') === 'true') ?? items[0];
    target?.focus({ preventScroll: true });
  }

  close({ focusTrigger = true, force = false } = {}) {
    if (!this.isOpen) return false;
    if (this.pinned && !force) return false;
    const hadFocus = this.menu.contains(this.menu.getRootNode().activeElement);
    this.menu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.onClose(this);
    if (focusTrigger && hadFocus) this.trigger.focus({ preventScroll: true });
    return true;
  }

  /** Below the trigger, flipped above or shifted sideways to stay on screen. */
  position() {
    if (!this.isOpen) return;
    const gutter = 8;
    const gap = 4;
    const anchor = this.trigger.getBoundingClientRect();
    const frame = this.container.getBoundingClientRect();
    this.menu.style.left = '0px';
    this.menu.style.top = '0px';
    const size = this.menu.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.bottom + gap;
    if (top + size.height > window.innerHeight - gutter && anchor.top - size.height - gap >= gutter) {
      top = anchor.top - size.height - gap;
    }
    left = Math.min(Math.max(gutter, left), Math.max(gutter, window.innerWidth - size.width - gutter));
    top = Math.min(Math.max(gutter, top), Math.max(gutter, window.innerHeight - size.height - gutter));
    this.menu.style.left = `${Math.round(left - frame.left)}px`;
    this.menu.style.top = `${Math.round(top - frame.top)}px`;
    this.menu.style.maxHeight = `${Math.max(120, window.innerHeight - gutter * 2)}px`;
  }

  _onKeyDown(event) {
    const items = this.items();
    const index = items.indexOf(this.menu.getRootNode().activeElement);
    const move = next => {
      event.preventDefault();
      event.stopPropagation();
      items[(next + items.length) % items.length]?.focus({ preventScroll: true });
    };
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      // Choosing closes the menu and focuses its button; activating on keydown
      // keeps that same keystroke from reopening the menu.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) items[index].click();
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close({ force: true });
    } else if (event.key === 'Tab') {
      // Let focus continue from the trigger, as if the menu were not there.
      this.trigger.focus({ preventScroll: true });
      this.close({ focusTrigger: false });
    }
  }
}
