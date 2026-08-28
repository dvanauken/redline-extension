import { RedlineDocument, cryptoId, translateAnnotation } from './RedlineDocument.js';
import { drawRedlineAnnotations, redlineTextBoxFill } from './RedlineCanvas.js';
import './vendor/wb/wb-color-picker/wb-color-picker.define.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_COLOR = '#b65d66';
const PT_TO_CSS_PX = 4 / 3;
const LINE_WEIGHTS = [
  ['¼ pt', 0.25 * PT_TO_CSS_PX],
  ['½ pt', 0.5 * PT_TO_CSS_PX],
  ['¾ pt', 0.75 * PT_TO_CSS_PX],
  ['1 pt', 1 * PT_TO_CSS_PX],
  ['1½ pt', 1.5 * PT_TO_CSS_PX],
  ['2¼ pt', 2.25 * PT_TO_CSS_PX],
  ['3 pt', 3 * PT_TO_CSS_PX],
  ['4½ pt', 4.5 * PT_TO_CSS_PX],
  ['6 pt', 6 * PT_TO_CSS_PX],
];
const TEXTBOX_OPACITIES = [
  ['Opaque', 1],
  ['75% opacity', 0.75],
  ['50% opacity', 0.5],
  ['25% opacity', 0.25],
  ['Transparent', 0],
];
const TOOL_LABELS = {
  select: 'Select',
  pen: 'Pen',
  arrow: 'Arrow',
  rectangle: 'Box',
  note: 'Note',
  textbox: 'Text Box',
};
const TEXTBOX_MIN_WIDTH = 100;
const TEXTBOX_MIN_HEIGHT = 48;

function svgElement(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  return el;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function annotationBounds(mark) {
  if (mark.type === 'pen') {
    const xs = mark.points.map(p => p.x);
    const ys = mark.points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (mark.type === 'note') return { x: mark.point.x - 16, y: mark.point.y - 18, width: 220, height: 38 };
  return {
    x: Math.min(mark.start.x, mark.end.x),
    y: Math.min(mark.start.y, mark.end.y),
    width: Math.abs(mark.end.x - mark.start.x),
    height: Math.abs(mark.end.y - mark.start.y),
  };
}

function resizeTextBox(mark, handle, dx, dy) {
  const bounds = annotationBounds(mark);
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  if (right - left < TEXTBOX_MIN_WIDTH) {
    if (handle.includes('w')) left = right - TEXTBOX_MIN_WIDTH;
    else right = left + TEXTBOX_MIN_WIDTH;
  }
  if (bottom - top < TEXTBOX_MIN_HEIGHT) {
    if (handle.includes('n')) top = bottom - TEXTBOX_MIN_HEIGHT;
    else bottom = top + TEXTBOX_MIN_HEIGHT;
  }
  return { ...mark, start: { x: left, y: top }, end: { x: right, y: bottom } };
}

function textBoxHandles(mark) {
  const bounds = annotationBounds(mark);
  const left = bounds.x;
  const top = bounds.y;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return [
    ['nw', left, top], ['n', cx, top], ['ne', right, top], ['e', right, cy],
    ['se', right, bottom], ['s', cx, bottom], ['sw', left, bottom], ['w', left, cy],
  ];
}

function svgTextLines(text, width, fontSize = 16) {
  const maxChars = Math.max(1, Math.floor((width - 20) / (fontSize * 0.56)));
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (!line || candidate.length <= maxChars) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('The browser could not encode the redline image.')),
    'image/png',
  ));
}

async function captureSourceToCanvas(value) {
  const source = value?.canvas ?? value?.image ?? value?.dataUrl ?? value;
  if (source instanceof HTMLCanvasElement) return source;

  let drawable = source;
  let objectURL = null;
  if (source instanceof Blob) {
    objectURL = URL.createObjectURL(source);
    drawable = objectURL;
  }
  if (typeof drawable === 'string') {
    drawable = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new TypeError('The capture image could not be decoded.'));
      image.src = drawable;
    });
  }

  const width = drawable?.naturalWidth ?? drawable?.videoWidth ?? drawable?.width;
  const height = drawable?.naturalHeight ?? drawable?.videoHeight ?? drawable?.height;
  if (!width || !height) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    throw new TypeError('A capture callback must return a canvas, image, Blob, or image data URL.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(drawable, 0, 0);
  if (objectURL) URL.revokeObjectURL(objectURL);
  return canvas;
}

function timestampName(extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `redline-${stamp}.${extension}`;
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/**
 * Reusable, full-viewport redline host.
 *
 * The host application only needs to construct this class and call toggle().
 * Optional callbacks supply application context and a screenshot fallback:
 *
 *   new RedlineOverlay({
 *     getContext: () => ({ documentId, camera }),
 *     captureFallback: () => ({ canvas, scope: 'viewport-fallback' }),
 *   });
 */
export class RedlineOverlay {
  constructor({
    mount = document.body,
    getContext = () => ({}),
    setStatus = () => {},
    capturePage = null,
    captureFallback = null,
    requestText = async () => null,
    confirmClear = async () => false,
    // [extension patch] Hosts without a custom-element registry (a Chrome
    // content script, for one) supply their own colour control here.
    createColorPicker = () => document.createElement('wb-color-picker'),
    // [extension patch] The default block records location.href verbatim.
    // A host that runs on arbitrary sites must be able to redact it, because
    // query strings and fragments routinely carry tokens and search terms.
    describePage = () => ({
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    }),
  } = {}) {
    this.options = {
      mount, getContext, setStatus, capturePage, captureFallback,
      requestText, confirmClear, createColorPicker, describePage,
    };
    this.active = false;
    this.tool = 'pen';
    this.color = DEFAULT_COLOR;
    this.width = 1 * PT_TO_CSS_PX;
    this.textBoxBackgroundOpacity = 1;
    this.selectedId = null;
    this.document = null;
    this.sessionStartedAt = null;
    this._draft = null;
    this._drag = null;
    this._resize = null;
    this._liveAnnotation = null;
    this._textEditor = null;
    this._events = new EventTarget();
    this._previousFocus = null;
    this._dialogDepth = 0;
    this._colorDialogResolve = null;
    this._pendingColor = this.color;
    this._buildDOM();

    this._boundKeyDown = event => this._onKeyDown(event);
    this._boundResize = () => {
      this._syncViewport();
      this._positionTextEditor();
      if (this.colorDialog?.open) this._positionColorDialog();
    };
    window.addEventListener('keydown', this._boundKeyDown, true);
    window.addEventListener('resize', this._boundResize);
  }

  addEventListener(...args) { this._events.addEventListener(...args); }
  removeEventListener(...args) { this._events.removeEventListener(...args); }

  destroy() {
    this._finishTextBoxEditing({ commit: false });
    window.removeEventListener('keydown', this._boundKeyDown, true);
    window.removeEventListener('resize', this._boundResize);
    if (this.colorDialog.open) this.colorDialog.close('cancel');
    if (this.root.open) this.root.close();
    this.colorDialog.remove();
    this.root.remove();
  }

  open({ reset = false } = {}) {
    if (this.active) return;
    if (reset || !this.document) {
      this.document = new RedlineDocument({ width: window.innerWidth, height: window.innerHeight });
      this.sessionStartedAt = new Date().toISOString();
      this.selectedId = null;
    }
    this.active = true;
    this._previousFocus = document.activeElement;
    this.root.hidden = false;
    if (!this.root.open) this.root.showModal();
    document.body.setAttribute('data-redline-active', '');
    this._syncViewport();
    this.setTool(this.tool);
    this._render();
    this.options.setStatus('Redline mode — draw anywhere; Esc closes without losing marks.');
    this._events.dispatchEvent(new CustomEvent('redline:opened'));
    this.toolbar.querySelector(`[data-redline-tool="${this.tool}"]`)?.focus();
  }

  close() {
    if (!this.active) return;
    this._finishTextBoxEditing({ commit: true });
    this.active = false;
    if (this.root.open) this.root.close();
    this.root.hidden = true;
    document.body.removeAttribute('data-redline-active');
    this._draft = null;
    this._drag = null;
    this._resize = null;
    this._liveAnnotation = null;
    this.options.setStatus(this.document?.annotations.length
      ? `Redline closed — ${this.document.annotations.length} annotation(s) retained.`
      : 'Redline closed.');
    this._events.dispatchEvent(new CustomEvent('redline:closed'));
    this._previousFocus?.focus?.();
    this._previousFocus = null;
  }

  toggle() { this.active ? this.close() : this.open(); }

  newSession() {
    this._finishTextBoxEditing({ commit: false });
    this.document = new RedlineDocument({ width: window.innerWidth, height: window.innerHeight });
    this.sessionStartedAt = new Date().toISOString();
    this.selectedId = null;
    this._draft = null;
    this._resize = null;
    this._render();
  }

  setTool(tool) {
    if (!Object.hasOwn(TOOL_LABELS, tool)) return;
    if (this._textEditor && tool !== this.tool) this._finishTextBoxEditing({ commit: true });
    this.tool = tool;
    this.svg.dataset.tool = tool;
    for (const button of this.toolbar.querySelectorAll('[data-redline-tool]')) {
      const selected = button.dataset.redlineTool === tool;
      button.toggleAttribute('data-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this._setMessage(`${TOOL_LABELS[tool]} tool`);
  }

  undo() {
    if (!this.document?.undo()) return false;
    this.selectedId = null;
    this._render();
    return true;
  }

  redo() {
    if (!this.document?.redo()) return false;
    this.selectedId = null;
    this._render();
    return true;
  }

  async clear() {
    if (!this.document?.annotations.length) return false;
    const count = this.document.annotations.length;
    const confirmed = await this._withChildDialog(() => this.options.confirmClear(count));
    if (!confirmed || !this.active) return false;
    this.selectedId = null;
    const changed = this.document.clear();
    this._render();
    return changed;
  }

  removeSelected() {
    if (!this.selectedId || !this.document?.remove(this.selectedId)) return false;
    this.selectedId = null;
    this._render();
    return true;
  }

  /** Import a previously exported .redline.json object. */
  importData(data) {
    if (!data || data.format !== 'open-redline' || data.version !== 1 || !data.document) {
      throw new TypeError('This is not a supported redline document.');
    }
    if (!this.document) this.document = new RedlineDocument();
    this.document.load(data.document);
    this.sessionStartedAt = data.createdAt ?? new Date().toISOString();
    this.selectedId = null;
    this._render();
  }

  async getExportData() {
    const context = await Promise.resolve(this.options.getContext());
    return {
      format: 'open-redline',
      version: 1,
      createdAt: this.sessionStartedAt ?? new Date().toISOString(),
      exportedAt: new Date().toISOString(),
      page: await Promise.resolve(this.options.describePage()),
      context: context ?? {},
      document: this.document?.toJSON() ?? new RedlineDocument().toJSON(),
    };
  }

  chooseImport() {
    this.importInput.value = '';
    this.importInput.click();
  }

  async _importFile(file) {
    if (!file) return null;
    const data = JSON.parse(await file.text());
    this.importData(data);
    this._setMessage(`Imported ${this.document.annotations.length} mark(s)`);
    return data;
  }

  async downloadJSON() {
    const data = await this.getExportData();
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), timestampName('redline.json'));
    this._setMessage('Redline data downloaded');
    return data;
  }

  async captureAnnotatedImage() {
    if (!this.document) throw new Error('Open redline mode before capturing.');
    const capture = await this._captureBaseImage();
    const canvas = document.createElement('canvas');
    canvas.width = capture.canvas.width;
    canvas.height = capture.canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(capture.canvas, 0, 0);
    drawRedlineAnnotations(ctx, this.document.annotations, {
      scaleX: canvas.width / this.document.width,
      scaleY: canvas.height / this.document.height,
    });
    return { canvas, scope: capture.scope };
  }

  async copyImage() {
    this._setBusy(true, 'Capturing this tab…');
    try {
      const { canvas, scope } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      if (!navigator.clipboard?.write || !globalThis.ClipboardItem) {
        downloadBlob(blob, timestampName('png'));
        this._setMessage('Clipboard images are unavailable; downloaded PNG instead.');
        return { blob, scope, copied: false };
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        this._setMessage(scope === 'browser-tab' ? 'Annotated screenshot copied' : 'Annotated viewport fallback copied');
        return { blob, scope, copied: true };
      } catch (error) {
        console.warn('[Redline] Clipboard write was refused; downloading instead.', error);
        downloadBlob(blob, timestampName('png'));
        this._setMessage('Clipboard permission was refused; downloaded PNG instead.');
        return { blob, scope, copied: false };
      }
    } finally {
      this._setBusy(false);
    }
  }

  async downloadImage() {
    this._setBusy(true, 'Capturing this tab…');
    try {
      const { canvas, scope } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, timestampName('png'));
      this._setMessage(scope === 'browser-tab' ? 'Annotated screenshot downloaded' : 'Annotated viewport fallback downloaded');
      return { blob, scope };
    } finally {
      this._setBusy(false);
    }
  }

  _buildDOM() {
    this.root = document.createElement('dialog');
    this.root.dataset.redlineRoot = '';
    this.root.dataset.dialog = 'redline';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Redline annotation mode');

    this.svg = svgElement('svg', {
      'data-redline-canvas': '',
      'aria-label': 'Redline drawing surface',
      role: 'img',
    });
    this.marksLayer = svgElement('g', { 'data-redline-marks': '' });
    this.svg.appendChild(this.marksLayer);
    this.root.appendChild(this.svg);

    this.toolbar = document.createElement('div');
    this.toolbar.dataset.redlineToolbar = '';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'Redline tools');

    const title = document.createElement('strong');
    title.textContent = 'Redline';
    title.dataset.redlineTitle = '';
    this.toolbar.appendChild(title);

    const toolButtons = [
      ['select', '↖', 'Select and move marks (V)'],
      ['pen', '✎', 'Freehand pen (P)'],
      ['arrow', '➜', 'Arrow (A)'],
      ['rectangle', '□', 'Rectangle (R)'],
      ['note', '①', 'Numbered note (N)'],
      ['textbox', 'T', 'Text box — drag to size (T)'],
    ];
    for (const [tool, icon, titleText] of toolButtons) {
      const button = this._button(icon, titleText);
      button.dataset.redlineTool = tool;
      this.toolbar.appendChild(button);
    }

    this.colorButton = this._button('', 'Choose annotation color', 'color');
    this.colorButton.dataset.redlineColor = '';
    this.colorButton.setAttribute('aria-label', 'Annotation color');
    this.colorSwatch = document.createElement('span');
    this.colorSwatch.dataset.redlineColorSwatch = '';
    this.colorSwatch.setAttribute('aria-hidden', 'true');
    const colorText = document.createElement('span');
    colorText.textContent = 'Color';
    this.colorButton.append(this.colorSwatch, colorText);
    this.toolbar.appendChild(this.colorButton);
    this._syncColorButton();

    const widthLabel = document.createElement('label');
    widthLabel.dataset.redlineControl = '';
    widthLabel.title = 'PowerPoint-style line weight';
    widthLabel.innerHTML = '<span>Weight</span>';
    this.widthSelect = document.createElement('select');
    this.widthSelect.setAttribute('aria-label', 'Line weight');
    for (const [label, value] of LINE_WEIGHTS) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      this.widthSelect.appendChild(option);
    }
    this.widthSelect.value = String(this.width);
    this.widthSelect.addEventListener('change', () => {
      this.width = Number(this.widthSelect.value);
      const selected = this.document?.annotations.find(mark => mark.id === this.selectedId);
      if (!selected || selected.width === this.width) return;
      this.document.replace(selected.id, { ...selected, width: this.width });
      this._render();
    });
    widthLabel.appendChild(this.widthSelect);
    this.toolbar.appendChild(widthLabel);

    const fillLabel = document.createElement('label');
    fillLabel.dataset.redlineControl = '';
    fillLabel.title = 'Text box background opacity';
    fillLabel.innerHTML = '<span>Fill</span>';
    this.fillOpacitySelect = document.createElement('select');
    this.fillOpacitySelect.setAttribute('aria-label', 'Text box background');
    for (const [label, value] of TEXTBOX_OPACITIES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      this.fillOpacitySelect.appendChild(option);
    }
    this.fillOpacitySelect.value = String(this.textBoxBackgroundOpacity);
    this.fillOpacitySelect.addEventListener('change', () => {
      this.textBoxBackgroundOpacity = Number(this.fillOpacitySelect.value);
      const selected = this.document?.annotations.find(mark => mark.id === this.selectedId);
      if (selected?.type !== 'textbox' || selected.backgroundOpacity === this.textBoxBackgroundOpacity) return;
      this.document.replace(selected.id, {
        ...selected,
        backgroundOpacity: this.textBoxBackgroundOpacity,
      });
      this._render();
    });
    fillLabel.appendChild(this.fillOpacitySelect);
    this.toolbar.appendChild(fillLabel);

    this.undoButton = this._button('↶', 'Undo mark (Ctrl+Z)', 'undo');
    this.redoButton = this._button('↷', 'Redo mark (Ctrl+Y)', 'redo');
    this.deleteButton = this._button('⌫', 'Delete selected mark (Delete)', 'delete');
    this.clearButton = this._button('Clear', 'Clear all marks', 'clear');
    this.importButton = this._button('Open', 'Import editable annotation data', 'import');
    this.jsonButton = this._button('JSON', 'Download editable annotation data', 'json');
    this.copyButton = this._button('Copy', 'Copy annotated screenshot', 'copy');
    this.downloadButton = this._button('PNG', 'Download annotated screenshot', 'download');
    this.closeButton = this._button('×', 'Close redline mode (Esc)', 'close');
    this.closeButton.dataset.redlineClose = '';
    for (const button of [this.undoButton, this.redoButton, this.deleteButton, this.clearButton, this.importButton, this.jsonButton, this.copyButton, this.downloadButton, this.closeButton]) {
      this.toolbar.appendChild(button);
    }
    this.importInput = document.createElement('input');
    this.importInput.type = 'file';
    this.importInput.accept = '.json,.redline.json,application/json';
    this.importInput.hidden = true;
    this.importInput.setAttribute('aria-label', 'Import redline data');
    this.importInput.addEventListener('change', () => {
      this._importFile(this.importInput.files?.[0]).catch(error => this._reportError(error));
    });
    this.toolbar.appendChild(this.importInput);

    this.message = document.createElement('span');
    this.message.dataset.redlineMessage = '';
    this.message.setAttribute('role', 'status');
    this.message.setAttribute('aria-live', 'polite');
    this.toolbar.appendChild(this.message);

    this.root.appendChild(this.toolbar);
    this.options.mount.appendChild(this.root);
    this._buildColorDialog();

    this.svg.addEventListener('pointerdown', event => {
      this._onPointerDown(event).catch(error => this._reportError(error));
    });
    this.svg.addEventListener('pointermove', event => this._onPointerMove(event));
    this.svg.addEventListener('pointerup', event => {
      this._onPointerUp(event).catch(error => this._reportError(error));
    });
    this.svg.addEventListener('pointercancel', event => {
      this._onPointerUp(event, true).catch(error => this._reportError(error));
    });
    this.svg.addEventListener('dblclick', event => {
      this._onDoubleClick(event).catch(error => this._reportError(error));
    });
    this.root.addEventListener('pointerdown', event => {
      if (!this._textEditor || event.target.closest?.('[data-redline-text-editor], [data-redline-text-controls]')) return;
      this._finishTextBoxEditing({ commit: true });
    }, true);
    this.toolbar.addEventListener('click', event => this._onToolbarClick(event));
    this.root.addEventListener('cancel', event => {
      event.preventDefault();
      this.close();
    });
  }

  _buildColorDialog() {
    this.colorDialog = document.createElement('dialog');
    this.colorDialog.dataset.dialog = 'redline-color';
    this.colorDialog.setAttribute('aria-label', 'Choose annotation color');

    this.colorPicker = this.options.createColorPicker();
    this.colorPicker.setAttribute('value', this.color);
    this.colorPicker.setAttribute('tab', 'theme');
    this.colorPicker.setAttribute('aria-label', 'Annotation color picker');
    this.colorPicker.addEventListener('wb-change', event => {
      if (!event.detail?.color || !this.colorDialog.open) return;
      this._pendingColor = event.detail.color;
      this.colorDialog.close('apply');
    });
    this.colorPicker.addEventListener('click', event => {
      if (!this.colorDialog.open) return;
      const swatch = event.composedPath().find(node => node instanceof Element && node.matches?.('[data-color]'));
      if (!swatch?.dataset.color) return;
      this._pendingColor = swatch.dataset.color;
      this.colorDialog.close('apply');
    });
    this.colorDialog.appendChild(this.colorPicker);
    // [extension patch] keep the color dialog inside the same (shadow) mount as the root.
    this.options.mount.appendChild(this.colorDialog);

    this.colorDialog.addEventListener('cancel', () => {
      this.colorDialog.returnValue = 'cancel';
    });
    this.colorDialog.addEventListener('click', event => {
      if (event.target !== this.colorDialog) return;
      const rect = this.colorDialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) this.colorDialog.close('cancel');
    });
    this.colorDialog.addEventListener('close', () => {
      const resolve = this._colorDialogResolve;
      this._colorDialogResolve = null;
      resolve?.(this.colorDialog.returnValue === 'apply' ? this._pendingColor : null);
    });
  }

  async _withChildDialog(callback) {
    this._dialogDepth += 1;
    try {
      return await callback();
    } finally {
      this._dialogDepth = Math.max(0, this._dialogDepth - 1);
    }
  }

  async _chooseColor() {
    if (this.colorDialog.open) return false;
    const selected = this.document?.annotations.find(mark => mark.id === this.selectedId);
    const initialColor = selected?.color ?? this.color;
    // [extension patch] no registry means no upgrade to wait for.
    if (globalThis.customElements) await customElements.whenDefined('wb-color-picker');
    this._pendingColor = initialColor;
    this.colorPicker.value = initialColor;
    this.colorDialog.returnValue = 'cancel';

    const nextColor = await this._withChildDialog(() => new Promise(resolve => {
      this._colorDialogResolve = resolve;
      this.colorDialog.showModal();
      this._positionColorDialog();
    }));
    if (!nextColor || !this.active) return false;

    this.color = nextColor;
    this._syncColorButton();
    if (!selected || selected.color.toUpperCase() === nextColor.toUpperCase()) return true;
    this.document.replace(selected.id, { ...selected, color: nextColor });
    this._render();
    return true;
  }

  _positionColorDialog() {
    if (!this.colorDialog?.open || !this.colorButton?.isConnected) return;

    const gutter = 8;
    const gap = 6;
    const triggerRect = this.colorButton.getBoundingClientRect();
    const swatchRect = this.colorSwatch?.getBoundingClientRect() ?? triggerRect;

    this.colorDialog.style.left = '0px';
    this.colorDialog.style.top = '0px';
    const dialogRect = this.colorDialog.getBoundingClientRect();
    const maxLeft = Math.max(gutter, window.innerWidth - dialogRect.width - gutter);
    const maxTop = Math.max(gutter, window.innerHeight - dialogRect.height - gutter);

    let left = swatchRect.left;
    let top = triggerRect.bottom + gap;
    let placement = 'bottom-start';
    if (top + dialogRect.height > window.innerHeight - gutter) {
      top = triggerRect.top - dialogRect.height - gap;
      placement = 'top-start';
    }

    left = Math.min(Math.max(gutter, left), maxLeft);
    top = Math.min(Math.max(gutter, top), maxTop);
    this.colorDialog.style.left = `${Math.round(left)}px`;
    this.colorDialog.style.top = `${Math.round(top)}px`;
    this.colorDialog.dataset.placement = placement;
  }

  _syncColorButton() {
    if (!this.colorSwatch || !this.colorButton) return;
    this.colorSwatch.style.backgroundColor = this.color;
    this.colorButton.title = `Annotation color: ${this.color}`;
  }

  _button(text, title, action = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    if (action) button.dataset.redlineAction = action;
    return button;
  }

  _syncViewport() {
    if (!this.document) return;
    this.svg.setAttribute('viewBox', `0 0 ${this.document.width} ${this.document.height}`);
  }

  _point(event) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.document.width / Math.max(1, rect.width),
      y: (event.clientY - rect.top) * this.document.height / Math.max(1, rect.height),
    };
  }

  _startTextBoxEditing(mark, { creating = false } = {}) {
    this._finishTextBoxEditing({ commit: true });
    const editor = document.createElement('textarea');
    editor.dataset.redlineTextEditor = '';
    editor.setAttribute('aria-label', 'Text box content');
    editor.setAttribute('placeholder', 'Type here');
    editor.spellcheck = true;
    editor.value = mark.text ?? '';
    const controls = document.createElement('div');
    controls.dataset.redlineTextControls = '';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Text editing actions');
    const saveButton = this._button('Save', 'Save text (Ctrl+Enter)');
    saveButton.dataset.redlineTextCommit = '';
    const cancelButton = this._button('Cancel', 'Discard text edit');
    cancelButton.dataset.redlineTextCancel = '';
    controls.append(saveButton, cancelButton);
    controls.addEventListener('pointerdown', event => event.preventDefault());
    this._textEditor = { element: editor, controls, mark, creating };
    this.selectedId = mark.id;
    this.root.append(editor, controls);
    this._render();
    this._positionTextEditor();

    editor.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this._finishTextBoxEditing({ commit: true });
        this.close();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this._finishTextBoxEditing({ commit: true });
      }
    });
    editor.addEventListener('blur', () => {
      queueMicrotask(() => {
        if (this._textEditor?.element === editor) this._finishTextBoxEditing({ commit: true });
      });
    });
    saveButton.addEventListener('click', () => this._finishTextBoxEditing({ commit: true }));
    cancelButton.addEventListener('click', () => this._finishTextBoxEditing({ commit: false }));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    this._setMessage('Editing text — Save, click away, or press Ctrl+Enter');
  }

  _positionTextEditor() {
    const editing = this._textEditor;
    if (!editing || !this.document || !this.svg.isConnected) return;
    const bounds = annotationBounds(editing.mark);
    const svgRect = this.svg.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const scaleX = svgRect.width / Math.max(1, this.document.width);
    const scaleY = svgRect.height / Math.max(1, this.document.height);
    const fontSize = (editing.mark.fontSize ?? 16) * scaleY;
    Object.assign(editing.element.style, {
      left: `${svgRect.left - rootRect.left + bounds.x * scaleX}px`,
      top: `${svgRect.top - rootRect.top + bounds.y * scaleY}px`,
      width: `${Math.max(TEXTBOX_MIN_WIDTH * scaleX, bounds.width * scaleX)}px`,
      height: `${Math.max(TEXTBOX_MIN_HEIGHT * scaleY, bounds.height * scaleY)}px`,
      padding: `${Math.max(4, 10 * scaleY)}px ${Math.max(4, 10 * scaleX)}px`,
      borderColor: '#6EA8FF',
      borderWidth: '2px',
      fontSize: `${Math.max(10, fontSize)}px`,
      backgroundColor: redlineTextBoxFill(editing.mark.backgroundOpacity),
    });
    const boxLeft = svgRect.left - rootRect.left + bounds.x * scaleX;
    const boxTop = svgRect.top - rootRect.top + bounds.y * scaleY;
    const boxWidth = Math.max(TEXTBOX_MIN_WIDTH * scaleX, bounds.width * scaleX);
    const boxHeight = Math.max(TEXTBOX_MIN_HEIGHT * scaleY, bounds.height * scaleY);
    const controlsRect = editing.controls.getBoundingClientRect();
    const gutter = 8;
    const controlsLeft = Math.min(
      Math.max(gutter, boxLeft + boxWidth - controlsRect.width),
      Math.max(gutter, rootRect.width - controlsRect.width - gutter),
    );
    const below = boxTop + boxHeight + 6;
    const controlsTop = below + controlsRect.height <= rootRect.height - gutter
      ? below
      : Math.max(gutter, boxTop - controlsRect.height - 6);
    editing.controls.style.left = `${controlsLeft}px`;
    editing.controls.style.top = `${controlsTop}px`;
  }

  _finishTextBoxEditing({ commit }) {
    const editing = this._textEditor;
    if (!editing) return false;
    this._textEditor = null;
    editing.element.remove();
    editing.controls.remove();

    const text = editing.element.value.trim();
    const saved = commit && Boolean(text);
    if (saved) {
      if (editing.creating) {
        const mark = this.document.add({
          ...editing.mark,
          text,
          fontSize: editing.mark.fontSize ?? 16,
          backgroundOpacity: editing.mark.backgroundOpacity ?? this.textBoxBackgroundOpacity,
        });
        this.selectedId = mark.id;
      } else if (text !== editing.mark.text) {
        this.document.replace(editing.mark.id, { ...editing.mark, text });
      }
    } else if (editing.creating) {
      this.selectedId = null;
    }
    if (saved && editing.creating) this.setTool('select');
    this._render();
    if (saved) this._setMessage('Text box saved — double-click to edit');
    else if (!commit) this._setMessage('Text edit cancelled');
    return true;
  }

  _nextNoteNumber() {
    return this.document.annotations.reduce((max, mark) => mark.type === 'note' ? Math.max(max, mark.number) : max, 0) + 1;
  }

  async _onPointerDown(event) {
    if (event.button !== 0 || !this.document) return;
    event.preventDefault();
    const point = this._point(event);
    this.svg.setPointerCapture?.(event.pointerId);

    if (this.tool === 'select') {
      const markEl = event.target.closest?.('[data-redline-id]');
      this.selectedId = markEl?.getAttribute('data-redline-id') ?? null;
      const original = this.document.annotations.find(mark => mark.id === this.selectedId) ?? null;
      const handle = event.target.closest?.('[data-redline-resize]')?.getAttribute('data-redline-resize');
      this._resize = original?.type === 'textbox' && handle
        ? { pointerId: event.pointerId, start: point, original, handle }
        : null;
      this._drag = original && !this._resize ? { pointerId: event.pointerId, start: point, original } : null;
      this._syncSelectionDOM();
      this._syncButtons();
      return;
    }

    if (this.tool === 'note') {
      const value = await this._withChildDialog(() => this.options.requestText('', { editing: false }));
      const text = value === null ? '' : String(value).trim();
      if (this.active && text) {
        const mark = this.document.add({
          id: cryptoId(), type: 'note', point, text,
          number: this._nextNoteNumber(), color: this.color, width: this.width,
        });
        this.selectedId = mark.id;
        this._render();
      }
      return;
    }

    this._draft = this.tool === 'pen'
      ? { id: cryptoId(), type: 'pen', points: [point, point], color: this.color, width: this.width }
      : { id: cryptoId(), type: this.tool, start: point, end: point, color: this.color, width: this.width };
    this._render();
  }

  _onPointerMove(event) {
    if (!this.document) return;
    const point = this._point(event);
    if (this._resize?.pointerId === event.pointerId) {
      this._liveAnnotation = resizeTextBox(
        this._resize.original,
        this._resize.handle,
        point.x - this._resize.start.x,
        point.y - this._resize.start.y,
      );
      this._render();
      return;
    }
    if (this._drag?.pointerId === event.pointerId) {
      this._liveAnnotation = translateAnnotation(
        this._drag.original,
        point.x - this._drag.start.x,
        point.y - this._drag.start.y,
      );
      this._render();
      return;
    }
    if (!this._draft) return;
    if (this._draft.type === 'pen') {
      if (distance(this._draft.points.at(-1), point) >= 2) this._draft.points.push(point);
    } else {
      this._draft.end = point;
    }
    this._render();
  }

  async _onPointerUp(event, cancelled = false) {
    if (!this.document) return;
    this.svg.releasePointerCapture?.(event.pointerId);

    if (this._resize?.pointerId === event.pointerId) {
      const changed = !cancelled && this._liveAnnotation;
      if (changed) this.document.replace(this._resize.original.id, this._liveAnnotation);
      this._resize = null;
      this._liveAnnotation = null;
      this._render();
      return;
    }

    if (this._drag?.pointerId === event.pointerId) {
      const changed = !cancelled && this._liveAnnotation && distance(this._drag.start, this._point(event)) >= 1;
      if (changed) {
        this.document.replace(this._drag.original.id, this._liveAnnotation);
      }
      const hadLivePreview = Boolean(this._liveAnnotation);
      this._drag = null;
      this._liveAnnotation = null;
      if (changed || hadLivePreview) this._render();
      else this._syncButtons();
      return;
    }

    if (!this._draft) return;
    const draft = this._draft;
    this._draft = null;
    const meaningful = draft.type === 'pen'
      ? draft.points.length > 2 || distance(draft.points[0], draft.points.at(-1)) >= 2
      : distance(draft.start, draft.end) >= 3;
    if (!cancelled && meaningful && draft.type === 'textbox') {
      const bounds = annotationBounds(draft);
      draft.start = { x: bounds.x, y: bounds.y };
      draft.end = {
        x: bounds.x + Math.max(TEXTBOX_MIN_WIDTH, bounds.width),
        y: bounds.y + Math.max(TEXTBOX_MIN_HEIGHT, bounds.height),
      };
      draft.text = '';
      draft.fontSize = 16;
      draft.backgroundOpacity = this.textBoxBackgroundOpacity;
      this._startTextBoxEditing(draft, { creating: true });
      return;
    }
    if (!cancelled && meaningful) {
      const mark = this.document.add(draft);
      this.selectedId = mark.id;
    }
    this._render();
  }

  async _onDoubleClick(event) {
    if (this.tool !== 'select') return;
    const id = event.target.closest?.('[data-redline-id]')?.getAttribute('data-redline-id');
    const point = this._point(event);
    // Selecting a mark rebuilds its SVG node. Some browsers consequently send
    // the second click to the drawing surface instead of the original circle,
    // so fall back to geometric note hit-testing for a dependable double-click.
    const textMarks = this.document?.annotations.filter(mark => mark.type === 'note' || mark.type === 'textbox') ?? [];
    const textMark = textMarks.find(mark => mark.id === id) ?? [...textMarks].reverse().find(mark => {
      const bounds = annotationBounds(mark);
      return point.x >= bounds.x && point.x <= bounds.x + bounds.width
        && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
    });
    if (!textMark) return;
    if (textMark.type === 'textbox') {
      this._startTextBoxEditing(textMark);
      return;
    }
    const value = await this._withChildDialog(() => this.options.requestText(textMark.text, {
      editing: true,
    }));
    const text = value === null ? '' : String(value).trim();
    if (this.active && text && text !== textMark.text) {
      this.document.replace(textMark.id, { ...textMark, text });
      this._render();
    }
  }

  _onToolbarClick(event) {
    const tool = event.target.closest('[data-redline-tool]')?.dataset.redlineTool;
    if (tool) return this.setTool(tool);
    const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
    if (!action) return;
    const actions = {
      undo: () => this.undo(),
      redo: () => this.redo(),
      delete: () => this.removeSelected(),
      color: () => this._chooseColor().catch(error => this._reportError(error)),
      clear: () => this.clear().catch(error => this._reportError(error)),
      import: () => this.chooseImport(),
      json: () => this.downloadJSON().catch(error => this._reportError(error)),
      copy: () => this.copyImage().catch(error => this._reportError(error)),
      download: () => this.downloadImage().catch(error => this._reportError(error)),
      close: () => this.close(),
    };
    actions[action]?.();
  }

  _onKeyDown(event) {
    if (!this.active || this._dialogDepth > 0) return;
    // [extension patch] This listener is on window, so when the overlay lives
    // in a shadow root every event retargets to the shadow host and
    // event.target is never the textarea. composedPath()[0] is the element the
    // user is actually typing in. Without this, letters that double as tool
    // shortcuts (v p a r n t) are swallowed instead of typed.
    const target = event.composedPath?.()[0] ?? event.target;
    if (target === this._textEditor?.element) return;
    // Let the native modal dialog dispatch its cancel event for Escape.
    if (event.key === 'Escape') return;
    // Chromium may move reverse-Tab from the first control into browser chrome
    // even for a modal dialog. Keep the toolbar's keyboard loop deterministic.
    if (event.key === 'Tab') {
      const focusable = [...this.toolbar.querySelectorAll('button:not(:disabled), input:not([hidden]):not(:disabled)')];
      if (focusable.length) {
        // [extension patch] shadow-aware: document.activeElement is the host, not the button.
        const index = focusable.indexOf(this.root.getRootNode().activeElement);
        const next = event.shiftKey
          ? (index <= 0 ? focusable.at(-1) : focusable[index - 1])
          : (index < 0 || index === focusable.length - 1 ? focusable[0] : focusable[index + 1]);
        next.focus();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    const editable = target?.matches?.('input, textarea, select, [contenteditable="true"]');
    const ctrl = event.ctrlKey || event.metaKey;
    let handled = true;
    if (ctrl && event.key.toLowerCase() === 'z' && event.shiftKey) this.redo();
    else if (ctrl && event.key.toLowerCase() === 'z') this.undo();
    else if (ctrl && event.key.toLowerCase() === 'y') this.redo();
    else if (!editable && (event.key === 'Delete' || event.key === 'Backspace')) this.removeSelected();
    else if (!editable && !ctrl && !event.altKey) {
      const tool = { v: 'select', p: 'pen', a: 'arrow', r: 'rectangle', n: 'note', t: 'textbox' }[event.key.toLowerCase()];
      if (tool) this.setTool(tool);
      else handled = false;
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  _render() {
    if (!this.marksLayer || !this.document) return;
    this.marksLayer.replaceChildren();
    const annotations = this.document.annotations.map(mark => (
      mark.id === this._liveAnnotation?.id ? this._liveAnnotation : mark
    ));
    if (this._draft) annotations.push(this._draft);
    if (this._textEditor?.creating) annotations.push(this._textEditor.mark);
    for (const mark of annotations) this.marksLayer.appendChild(this._renderMark(mark));
    this._syncButtons();
    this._events.dispatchEvent(new CustomEvent('redline:changed', { detail: { count: this.document.annotations.length } }));
  }

  /** Update selection chrome without replacing mark nodes and breaking dblclick. */
  _syncSelectionDOM() {
    for (const group of this.marksLayer.querySelectorAll('[data-redline-id]')) {
      const selected = group.getAttribute('data-redline-id') === this.selectedId;
      group.toggleAttribute('data-selected', selected);
      group.querySelectorAll('[data-redline-selection], [data-redline-resize]').forEach(node => node.remove());
      if (!selected) continue;
      const mark = this.document.annotations.find(item => item.id === this.selectedId);
      if (!mark) continue;
      this._appendSelection(group, mark);
    }
  }

  _renderMark(mark) {
    const group = svgElement('g', { 'data-redline-id': mark.id, 'data-redline-type': mark.type });
    const isActivelyEditing = mark.id === this._textEditor?.mark.id;
    if (mark.id === this.selectedId && !isActivelyEditing) group.setAttribute('data-selected', '');
    const common = { fill: 'none', stroke: mark.color, 'stroke-width': mark.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

    if (mark.type === 'pen') {
      const points = mark.points.map(point => `${point.x},${point.y}`).join(' ');
      group.appendChild(svgElement('polyline', { ...common, points }));
    } else if (mark.type === 'arrow') {
      group.appendChild(svgElement('line', { ...common, x1: mark.start.x, y1: mark.start.y, x2: mark.end.x, y2: mark.end.y }));
      const angle = Math.atan2(mark.end.y - mark.start.y, mark.end.x - mark.start.x);
      const length = Math.max(12, mark.width * 4);
      const wing1 = { x: mark.end.x - length * Math.cos(angle - Math.PI / 6), y: mark.end.y - length * Math.sin(angle - Math.PI / 6) };
      const wing2 = { x: mark.end.x - length * Math.cos(angle + Math.PI / 6), y: mark.end.y - length * Math.sin(angle + Math.PI / 6) };
      group.appendChild(svgElement('polyline', { ...common, points: `${wing1.x},${wing1.y} ${mark.end.x},${mark.end.y} ${wing2.x},${wing2.y}` }));
    } else if (mark.type === 'rectangle') {
      group.appendChild(svgElement('rect', {
        ...common,
        x: Math.min(mark.start.x, mark.end.x),
        y: Math.min(mark.start.y, mark.end.y),
        width: Math.abs(mark.end.x - mark.start.x),
        height: Math.abs(mark.end.y - mark.start.y),
      }));
    } else if (mark.type === 'textbox') {
      const bounds = annotationBounds(mark);
      group.appendChild(svgElement('rect', {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        rx: 4,
        fill: redlineTextBoxFill(mark.backgroundOpacity),
        stroke: mark.color,
        'stroke-width': mark.width,
      }));
      const fontSize = mark.fontSize ?? 16;
      const lineHeight = fontSize * 1.25;
      const text = svgElement('text', {
        x: bounds.x + 10, y: bounds.y + 10,
        fill: '#FFFFFF', 'font-size': fontSize, 'font-weight': 400,
        'dominant-baseline': 'hanging',
      });
      let offset = 0;
      for (const line of svgTextLines(mark.text, bounds.width, fontSize)) {
        if (10 + offset + lineHeight > bounds.height) break;
        const span = svgElement('tspan', {
          x: bounds.x + 10,
          y: bounds.y + 10 + offset,
          'dominant-baseline': 'hanging',
        });
        span.textContent = line || ' ';
        text.appendChild(span);
        offset += lineHeight;
      }
      group.appendChild(text);
    } else if (mark.type === 'note') {
      const labelWidth = Math.min(420, Math.max(90, mark.text.length * 7.6 + 20));
      group.appendChild(svgElement('circle', { cx: mark.point.x, cy: mark.point.y, r: 14, fill: mark.color }));
      const number = svgElement('text', { x: mark.point.x, y: mark.point.y + 5, 'text-anchor': 'middle', fill: '#fff' });
      number.textContent = String(mark.number);
      group.appendChild(number);
      group.appendChild(svgElement('rect', {
        x: mark.point.x + 22, y: mark.point.y - 16, width: labelWidth, height: 32,
        rx: 5, fill: 'rgba(255,255,255,.96)', stroke: mark.color, 'stroke-width': 2,
      }));
      const text = svgElement('text', { x: mark.point.x + 32, y: mark.point.y + 5, fill: '#111827' });
      text.textContent = mark.text;
      group.appendChild(text);
    }

    if (mark.id === this.selectedId && !isActivelyEditing) this._appendSelection(group, mark);
    return group;
  }

  _appendSelection(group, mark) {
    const bounds = annotationBounds(mark);
    const isTextBox = mark.type === 'textbox';
    group.appendChild(svgElement('rect', {
      'data-redline-selection': '',
      x: isTextBox ? bounds.x : bounds.x - 7,
      y: isTextBox ? bounds.y : bounds.y - 7,
      width: isTextBox ? bounds.width : Math.max(14, bounds.width + 14),
      height: isTextBox ? bounds.height : Math.max(14, bounds.height + 14),
    }));
    if (!isTextBox) return;
    for (const [handle, x, y] of textBoxHandles(mark)) {
      group.appendChild(svgElement('rect', {
        'data-redline-resize': handle,
        x: x - 4, y: y - 4, width: 8, height: 8,
      }));
    }
  }

  _syncButtons() {
    const count = this.document?.annotations.length ?? 0;
    const selected = this.document?.annotations.find(mark => mark.id === this.selectedId);
    if (this.widthSelect) {
      const width = selected?.width ?? this.width;
      const nearest = LINE_WEIGHTS.reduce((best, option) => (
        Math.abs(option[1] - width) < Math.abs(best[1] - width) ? option : best
      ));
      this.widthSelect.value = String(nearest[1]);
    }
    if (this.fillOpacitySelect) {
      const opacity = selected?.type === 'textbox'
        ? selected.backgroundOpacity ?? 1
        : this.textBoxBackgroundOpacity;
      const nearest = TEXTBOX_OPACITIES.reduce((best, option) => (
        Math.abs(option[1] - opacity) < Math.abs(best[1] - opacity) ? option : best
      ));
      this.fillOpacitySelect.value = String(nearest[1]);
    }
    this.undoButton.disabled = !this.document?.canUndo;
    this.redoButton.disabled = !this.document?.canRedo;
    this.deleteButton.disabled = !this.selectedId;
    this.clearButton.disabled = count === 0;
    this.importButton.disabled = false;
    this.jsonButton.disabled = count === 0;
    this.copyButton.disabled = count === 0;
    this.downloadButton.disabled = count === 0;
    this._setMessage(`${count} mark${count === 1 ? '' : 's'}`);
  }

  _setBusy(busy, message = '') {
    for (const button of this.toolbar.querySelectorAll('button')) button.disabled = busy;
    this.toolbar.toggleAttribute('data-busy', busy);
    if (message) this._setMessage(message);
    if (!busy) {
      const count = this.document?.annotations.length ?? 0;
      this.undoButton.disabled = !this.document?.canUndo;
      this.redoButton.disabled = !this.document?.canRedo;
      this.deleteButton.disabled = !this.selectedId;
      this.clearButton.disabled = count === 0;
      this.importButton.disabled = false;
      this.jsonButton.disabled = count === 0;
      this.copyButton.disabled = count === 0;
      this.downloadButton.disabled = count === 0;
    }
  }

  _setMessage(message) { if (this.message) this.message.textContent = message; }

  _reportError(error) {
    console.error('[Redline]', error);
    this._setMessage(`Could not export: ${error.message}`);
    this.options.setStatus(`Redline export failed: ${error.message}`);
  }

  async _captureBaseImage() {
    let nativeError = null;
    if (this.options.capturePage) {
      const result = await this._whileHidden(() => this.options.capturePage());
      return this._normaliseCapture(result, 'host-page');
    }

    if (navigator.mediaDevices?.getDisplayMedia) {
      try {
        return await this._captureBrowserTab();
      } catch (error) {
        nativeError = error;
        console.warn('[Redline] Browser-tab capture unavailable; using viewport fallback.', error);
      }
    }

    if (this.options.captureFallback) {
      const result = await this._whileHidden(() => this.options.captureFallback());
      return this._normaliseCapture(result, 'viewport-fallback');
    }
    throw nativeError ?? new Error('No page capture method is available in this browser.');
  }

  async _normaliseCapture(result, defaultScope) {
    const canvas = await captureSourceToCanvas(result);
    return { canvas, scope: result?.scope ?? defaultScope };
  }

  async _whileHidden(callback) {
    const visibility = this.root.style.visibility;
    this.root.style.visibility = 'hidden';
    try { return await callback(); }
    finally { this.root.style.visibility = visibility; }
  }

  async _captureBrowserTab() {
    const visibility = this.root.style.visibility;
    this.root.style.visibility = 'hidden';
    let stream;
    try {
      // The picker cannot be bypassed by page code. preferCurrentTab keeps the
      // intended choice prominent while still respecting browser permission.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
      const track = stream.getVideoTracks()[0];
      const surface = track?.getSettings?.().displaySurface;
      if (surface && surface !== 'browser') {
        throw new Error('Choose “This Tab” in the share picker so annotations align with the screenshot.');
      }
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      if (!video.videoWidth) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return { canvas, scope: 'browser-tab' };
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      this.root.style.visibility = visibility;
    }
  }
}

