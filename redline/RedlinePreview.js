/**
 * Export preview: the exact image an export would produce.
 *
 * The overlay captures the page once and composes it with the same
 * `composeAnnotatedCanvas` call every export uses, from a document snapshot, so
 * the preview shows the real crop, output size, legend and optional pointer and
 * can never show a caret, selection, handle, temporary editing view or any
 * other control. Exporting from the preview reuses that composed image, so what
 * was previewed is what is copied or downloaded.
 *
 * The composed <canvas> is displayed directly inside the closed shadow root;
 * no image URL is created and nothing enters the page's DOM.
 */

let headingIds = 0;

export class RedlinePreview {
  /**
   * onAction(name, detail): 'copy' | 'report' | 'download' | 'cursor' (detail: included)
   */
  constructor({ mount, onAction }) {
    this.mount = mount;
    this.onAction = onAction;
    this._resolve = null;

    const dialog = document.createElement('dialog');
    dialog.dataset.redlinePreview = '';
    const headingId = `redline-preview-heading-${++headingIds}`;
    dialog.setAttribute('aria-labelledby', headingId);

    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.id = headingId;
    heading.textContent = 'Export preview';
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.previewAction = 'close';
    close.setAttribute('aria-label', 'Close preview');
    close.title = 'Close preview (Esc)';
    close.textContent = '×';
    header.append(heading, close);

    this.summary = document.createElement('p');
    this.summary.dataset.redlinePreviewSummary = '';
    this.warnings = document.createElement('ul');
    this.warnings.dataset.redlinePreviewWarnings = '';
    this.frame = document.createElement('div');
    this.frame.dataset.redlinePreviewFrame = '';

    const footer = document.createElement('footer');
    const cursorLabel = document.createElement('label');
    cursorLabel.dataset.redlinePreviewCursor = '';
    this.cursorBox = document.createElement('input');
    this.cursorBox.type = 'checkbox';
    this.cursorBox.addEventListener('change', () => this.onAction('cursor', this.cursorBox.checked));
    cursorLabel.append(this.cursorBox, document.createTextNode(' Include cursor'));
    this.message = document.createElement('span');
    this.message.dataset.redlinePreviewMessage = '';
    this.message.setAttribute('role', 'status');
    this.message.setAttribute('aria-live', 'polite');
    const action = (name, text, title, primary = false) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.dataset.previewAction = name;
      element.textContent = text;
      element.title = title;
      if (primary) element.dataset.primary = '';
      return element;
    };
    this.reportButton = action('report', 'Copy report', 'Copy this image with bullet explanations and notes as text');
    this.downloadButton = action('download', 'Download PNG', 'Download this image');
    this.copyButton = action('copy', 'Copy image', 'Copy this image to the clipboard', true);
    footer.append(cursorLabel, this.message, this.reportButton, this.downloadButton, this.copyButton);

    dialog.append(header, this.summary, this.warnings, this.frame, footer);
    dialog.addEventListener('click', event => {
      const name = event.target.closest?.('[data-preview-action]')?.dataset.previewAction;
      if (!name) return;
      if (name === 'close') this.close();
      else this.onAction(name);
    });
    // Keys stay inside the preview, so drawing shortcuts never fire behind it.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => {
      this.frame.replaceChildren();
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.();
    });
    this.dialog = dialog;
    mount.appendChild(dialog);
  }

  get open() { return this.dialog.open; }
  get canvas() { return this.frame.querySelector('canvas'); }

  /** Show a composed export. Resolves when the preview closes. */
  show(content) {
    this.update(content);
    this.setMessage('');
    const closed = new Promise(resolve => { this._resolve = resolve; });
    if (!this.dialog.open) this.dialog.showModal();
    this.copyButton.focus({ preventScroll: true });
    return closed;
  }

  /** Replace the image and its description, keeping focus where it is. */
  update({ canvas, summary, warnings = [], cursor = { included: false, available: true } }) {
    canvas.dataset.redlinePreviewCanvas = '';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Exported image preview, ${canvas.width} × ${canvas.height} pixels`);
    this.frame.replaceChildren(canvas);
    this.summary.textContent = summary;
    this.warnings.replaceChildren(...warnings.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    this.warnings.hidden = warnings.length === 0;
    this.cursorBox.checked = Boolean(cursor.included);
  }

  setBusy(busy) {
    for (const control of this.dialog.querySelectorAll('button, input')) {
      if (control.dataset.previewAction !== 'close') control.disabled = busy;
    }
  }

  setMessage(text) {
    this.message.textContent = text;
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  destroy() {
    this.close();
    this.dialog.remove();
  }
}
