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
  color-scheme: dark;
  width: min(30rem, calc(100vw - 2rem));
  padding: 1rem;
  border: 1px solid #4a4f5a;
  border-radius: 0.5rem;
  background: #181b22;
  color: #e8eaed;
  font: 400 0.875rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
dialog[data-redline-host-dialog]::backdrop { background: rgba(0, 0, 0, 0.45); }
dialog[data-redline-host-dialog] h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}
dialog[data-redline-host-dialog] p { margin: 0 0 0.75rem; }
dialog[data-redline-host-dialog] textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 6rem;
  padding: 0.5rem;
  border: 1px solid #4a4f5a;
  border-radius: 0.25rem;
  background: #11141a;
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
  padding: 0.35rem 0.9rem;
  border: 1px solid #4a4f5a;
  border-radius: 0.25rem;
  background: #232833;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
dialog[data-redline-host-dialog] button[data-primary] {
  border-color: #b65d66;
  background: #b65d66;
  color: #fff;
}
dialog[data-redline-host-dialog] button:focus-visible {
  outline: 2px solid #8ab4f8;
  outline-offset: 2px;
}
dialog[data-redline-host-dialog] small { color: #a8adb8; }
`;

export class HostDialogs {
  /** @param {ShadowRoot|HTMLElement} mount container that also holds the overlay */
  constructor(mount) {
    this.mount = mount;
  }

  /** Resolve once the dialog closes, with its returnValue. */
  _show(dialog) {
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        const value = dialog.returnValue;
        dialog.remove();
        resolve(value);
      }, { once: true });
      this.mount.appendChild(dialog);
      dialog.showModal();
    });
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
