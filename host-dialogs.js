/**
 * Generic host dialogs for the Redline extension.
 *
 * The overlay expects the host application to supply `requestText` and
 * `confirmClear`. A browser extension has no host application, so it supplies
 * its own accessible native <dialog> implementations instead. `prompt()` and
 * `confirm()` are deliberately avoided: pages can suppress them, and Chrome
 * blocks them outright in some contexts.
 *
 * Both dialogs mount inside the same shadow root as the overlay so that page
 * styles cannot reach them.
 */

export const HOST_DIALOG_CSS = `
dialog[data-redline-host-dialog] {
  color-scheme: light;
  width: min(30rem, calc(100vw - 2rem));
  padding: 1rem 1.125rem;
  border: 1px solid #D9D5CC;
  border-radius: 0.625rem;
  background: #F7F5F0;
  color: #292D32;
  box-shadow: 0 0.75rem 2rem rgb(41 45 50 / 0.18);
  font: 400 0.875rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
dialog[data-redline-host-dialog]::backdrop { background: rgb(41 45 50 / 0.18); }
dialog[data-redline-host-dialog] h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 650;
}
dialog[data-redline-host-dialog] p { margin: 0 0 0.75rem; }
dialog[data-redline-host-dialog] textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 6rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid #D9D5CC;
  border-radius: 0.375rem;
  background: #FFFFFF;
  color: inherit;
  font: inherit;
  resize: vertical;
}
dialog[data-redline-host-dialog] menu {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin: 0.75rem 0 0;
  padding: 0;
}
dialog[data-redline-host-dialog] button {
  min-height: 2.25rem;
  padding: 0.35rem 0.9rem;
  border: 1px solid #D9D5CC;
  border-radius: 0.375rem;
  background: #FFFFFF;
  color: inherit;
  font: 600 0.8125rem/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
dialog[data-redline-host-dialog] button:hover { background: #FBFAF7; border-color: #B9B3A7; }
dialog[data-redline-host-dialog] button[data-primary] {
  border-color: #9A4650;
  background: #9A4650;
  color: #FFFFFF;
}
dialog[data-redline-host-dialog] button[data-primary]:hover { background: #873C45; }
dialog[data-redline-host-dialog] button:focus-visible,
dialog[data-redline-host-dialog] textarea:focus-visible {
  outline: 2px solid #2F6DB5;
  outline-offset: 2px;
}
dialog[data-redline-host-dialog] small { color: #5B5F66; }
dialog[data-redline-host-dialog] ul { margin: 0 0 0.75rem; padding-left: 1.1rem; }
dialog[data-redline-host-dialog] li { margin: 0.2rem 0; }
dialog[data-redline-host-dialog] label[data-redline-recovery-scroll] {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0 0 0.25rem;
}
dialog[data-redline-host-dialog] input[type="checkbox"] { width: 1rem; height: 1rem; margin: 0; accent-color: #9A4650; }
dialog[data-redline-host-dialog] input[type="checkbox"]:focus-visible { outline: 2px solid #2F6DB5; outline-offset: 2px; }
`;

export class HostDialogs {
  /** @param {ShadowRoot|HTMLElement} mount container that also holds the overlay */
  constructor(mount) {
    this.mount = mount;
    this._pending = new Map();
  }

  /** Resolve once the dialog closes, with its returnValue. */
  _show(dialog) {
    const cancelled = dialog.returnValue;
    return new Promise(resolve => {
      const finish = value => {
        if (!this._pending.delete(dialog)) return;
        dialog.removeEventListener('close', closed);
        dialog.remove();
        resolve(value);
      };
      const closed = () => finish(dialog.returnValue);
      this._pending.set(dialog, () => {
        if (dialog.open) dialog.close(cancelled);
        finish(cancelled);
      });
      dialog.addEventListener('close', closed);
      this.mount.appendChild(dialog);
      dialog.showModal();
    });
  }

  /** Closing the workspace cancels all owned dialogs, retaining waiting drafts. */
  dismissAll() {
    for (const cancel of [...this._pending.values()]) cancel();
  }

  /**
   * Multi-line note entry.
   * @returns {Promise<string|null>} the text, or null when cancelled
   */
  async requestText(current = '', context = {}) {
    const dialog = document.createElement('dialog');
    dialog.dataset.redlineHostDialog = '';
    dialog.setAttribute('aria-label', context?.editing ? 'Edit redline note' : 'Add redline note');

    const heading = document.createElement('h2');
    heading.textContent = context?.editing ? 'Edit redline note' : 'Add redline note';

    const field = document.createElement('textarea');
    field.value = current ?? '';
    field.setAttribute('aria-label', 'Note text');

    const hint = document.createElement('small');
    hint.textContent = 'Ctrl+Enter saves · Esc cancels';

    const menu = document.createElement('menu');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.primary = '';
    save.textContent = 'Save';

    // returnValue is a string, so a sentinel distinguishes cancel from "".
    const CANCELLED = '\u0000cancelled';
    dialog.returnValue = CANCELLED;
    cancel.addEventListener('click', () => dialog.close(CANCELLED));
    save.addEventListener('click', () => dialog.close(field.value));
    dialog.addEventListener('cancel', () => { dialog.returnValue = CANCELLED; });
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        dialog.close(field.value);
      }
    });

    menu.append(cancel, save);
    dialog.append(heading, field, hint, menu);

    const shown = this._show(dialog);
    field.focus();
    field.select();
    const result = await shown;
    return result === CANCELLED ? null : result;
  }

  /**
   * Offer a reload-recovery draft.
   * summary: { title, contents, saved, context, advice, scroll: {x, y} | null }
   * @returns {Promise<{choice: 'restore'|'discard'|'later', scroll: boolean}>}
   */
  async recovery(summary) {
    const dialog = document.createElement('dialog');
    dialog.dataset.redlineHostDialog = '';
    dialog.dataset.redlineRecoveryDialog = '';
    dialog.setAttribute('aria-label', summary.title);

    const heading = document.createElement('h2');
    heading.textContent = summary.title;
    const list = document.createElement('ul');
    for (const text of [summary.contents, summary.saved, summary.context]) {
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    }
    const advice = document.createElement('p');
    advice.textContent = summary.advice;
    const hint = document.createElement('small');
    hint.textContent = 'Esc decides later: the draft is kept, and new marks are not saved for recovery until you choose.';

    let scrollBox = null;
    const parts = [heading, list, advice];
    if (summary.scroll) {
      const label = document.createElement('label');
      label.dataset.redlineRecoveryScroll = '';
      scrollBox = document.createElement('input');
      scrollBox.type = 'checkbox';
      scrollBox.checked = true;
      label.append(scrollBox, document.createTextNode(` Scroll the page back to ${summary.scroll.x}, ${summary.scroll.y}`));
      parts.push(label);
    }

    const menu = document.createElement('menu');
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.dataset.redlineRecoveryDiscard = '';
    discard.textContent = 'Discard draft';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.dataset.primary = '';
    restore.dataset.redlineRecoveryRestore = '';
    restore.textContent = 'Restore';
    dialog.returnValue = 'later';
    discard.addEventListener('click', () => dialog.close('discard'));
    restore.addEventListener('click', () => dialog.close('restore'));
    dialog.addEventListener('cancel', () => { dialog.returnValue = 'later'; });
    menu.append(discard, restore);
    dialog.append(...parts, hint, menu);

    const shown = this._show(dialog);
    restore.focus();
    const choice = await shown;
    return { choice: ['restore', 'discard'].includes(choice) ? choice : 'later', scroll: Boolean(scrollBox?.checked) };
  }

  /** @returns {Promise<boolean>} */
  async confirm({ title, message, confirmLabel = 'OK' }) {
    const dialog = document.createElement('dialog');
    dialog.dataset.redlineHostDialog = '';
    dialog.setAttribute('aria-label', title);

    const heading = document.createElement('h2');
    heading.textContent = title;
    const body = document.createElement('p');
    body.textContent = message;

    const menu = document.createElement('menu');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.dataset.primary = '';
    accept.textContent = confirmLabel;

    dialog.returnValue = 'cancel';
    cancel.addEventListener('click', () => dialog.close('cancel'));
    accept.addEventListener('click', () => dialog.close('confirm'));

    menu.append(cancel, accept);
    dialog.append(heading, body, menu);

    const shown = this._show(dialog);
    cancel.focus();
    return await shown === 'confirm';
  }
}
