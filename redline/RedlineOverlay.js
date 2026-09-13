import { RedlineDocument, cryptoId, translateAnnotation } from './RedlineDocument.js';
import {
  drawRedlineAnnotations, redlineMarkFill, redlineMarkStroked, redlineNoteGlyph, redlineTextBoxFill,
} from './RedlineCanvas.js';
import { appendIcon } from './icons.js';
import { cropExportGeometry } from './RedlineCrop.js';
import { RedlineCropView } from './RedlineCropView.js';
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
const BRUSH_OPACITIES = [['20%', 0.2], ['35%', 0.35], ['50%', 0.5], ['65%', 0.65]];
/** Digits run out of room in the circle after 9; letters carry 26 in the same space. */
const NOTE_MARKERS = [['1, 2, 3', 'numeric'], ['A, B, C', 'alpha']];
const TOOL_LABELS = {
  select: 'Select',
  crop: 'Crop',
  pen: 'Pen',
  brush: 'Highlighter',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
  eraser: 'Eraser',
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

/** A hex colour carrying an alpha, for previewing a translucent fill in the UI. */
function withAlpha(hex, alpha) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return `${hex}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0')}`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function annotationBounds(mark) {
  if (['pen', 'brush', 'polyline', 'polygon'].includes(mark.type) && Array.isArray(mark.points) && mark.points.length) {
    const xs = mark.points.map(p => p.x);
    const ys = mark.points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (mark.type === 'note' && mark.point) return { x: mark.point.x - 16, y: mark.point.y - 18, width: 220, height: 38 };
  if (!mark.start || !mark.end) return { x: 0, y: 0, width: 0, height: 0 };
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
    // [extension patch] Persistence belongs to the host, never to the page's storage.
    preferences = {},
    savePreferences = async () => {},
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
      requestText, confirmClear, createColorPicker, describePage, savePreferences,
    };
    this.active = false;
    this.pageMode = false;
    this.tool = 'pen';
    this._toolBeforeCrop = 'select';
    this.color = DEFAULT_COLOR;
    // Fill treatment for shapes that enclose an area, chosen from the picker's
    // style gallery. `fill` null means the fill reuses the stroke colour.
    this.fill = null;
    this.fillOpacity = 0;
    this.outline = true;
    this.intent = null;
    this.noteMarker = 'numeric';
    this.width = 1 * PT_TO_CSS_PX;
    this.textBoxBackgroundOpacity = 1;
    this.selectedId = null;
    this.document = null;
    this.sessionStartedAt = null;
    this._draft = null;
    this._draftElement = null;
    this._drag = null;
    this._resize = null;
    this._liveAnnotation = null;
    this._textEditor = null;
    this._events = new EventTarget();
    this._previousFocus = null;
    this._dialogDepth = 0;
    this._colorDialogResolve = null;
    this._pendingStyle = null;
    this.toolbarPinned = false;
    this.toolbarPosition = null;
    this._toolbarDrag = null;
    this.brushWidth = 10;
    this.brushOpacity = 0.35;
    this._preferenceSave = Promise.resolve();
    this._loadPreferences(preferences);
    this._buildDOM();

    this._boundKeyDown = event => this._onKeyDown(event);
    this._boundResize = () => {
      this.cropView.cancel();
      this._syncViewport();
      this._applyToolbarPosition();
      this._positionTextEditor();
      if (this.colorDialog?.open) this._positionColorDialog();
    };
    // Closed shadow roots hide their event path from window-level listeners.
    this._keyTarget = this.root.getRootNode();
    this._keyTarget.addEventListener('keydown', this._boundKeyDown, true);
    this._boundModeKeyDown = event => {
      if (event.key !== 'F2' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || !this.active || this._dialogDepth > 0 || this._busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.setPageMode(!this.pageMode);
    };
    window.addEventListener('keydown', this._boundModeKeyDown, true);
    window.addEventListener('resize', this._boundResize);
  }

  addEventListener(...args) { this._events.addEventListener(...args); }
  removeEventListener(...args) { this._events.removeEventListener(...args); }

  destroy() {
    this._finishTextBoxEditing({ commit: false });
    this._keyTarget.removeEventListener('keydown', this._boundKeyDown, true);
    window.removeEventListener('keydown', this._boundModeKeyDown, true);
    window.removeEventListener('resize', this._boundResize);
    document.body.removeAttribute('data-redline-active');
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
    this.pageMode = false;
    this.root.removeAttribute('data-page-mode');
    this._previousFocus = document.activeElement;
    this._pageFocus = this._previousFocus;
    this.root.hidden = false;
    if (!this.root.open) this.root.showModal();
    document.body.setAttribute('data-redline-active', '');
    this._syncViewport();
    this.setTool(this.tool);
    this._render();
    this.options.setStatus('Annotation mode — F2 switches to the page; Esc closes without losing marks.');
    this._events.dispatchEvent(new CustomEvent('redline:opened'));
    this.toolbar.querySelector(`[data-redline-tool="${this.tool}"]`)?.focus();
  }

  close() {
    if (!this.active) return;
    this.cropView.cancel();
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

  /** Release modal input ownership while keeping a small toolbar on the page. */
  setPageMode(enabled) {
    if (!this.active || this._busy || this._dialogDepth > 0 || this.pageMode === enabled) return;
    this.cropView.cancel();
    this._finishTextBoxEditing({ commit: true });
    this._draft = null;
    this._draftElement = null;
    this._drag = null;
    this._resize = null;
    this._liveAnnotation = null;
    if (!enabled) this._pageFocus = document.activeElement;
    this.pageMode = enabled;
    this.root.close();
    this.root.toggleAttribute('data-page-mode', enabled);
    document.body.toggleAttribute('data-redline-active', !enabled);
    if (enabled) this.root.show();
    else this.root.showModal();
    this._syncViewport();
    this._render();
    this._applyToolbarPosition();
    if (enabled) (this._pageFocus ?? this._previousFocus)?.focus?.({ preventScroll: true });
    else this.toolbar.querySelector('[data-redline-tool="' + this.tool + '"]')?.focus({ preventScroll: true });
    this.options.setStatus(enabled
      ? 'Page mode — click, type, and scroll normally. F2 resumes annotations.'
      : 'Annotation mode — F2 switches to the page.');
  }

  _syncInteractionMode() {
    this.modeButton.textContent = this.pageMode ? 'Annotate' : 'Page';
    this.modeButton.title = this.pageMode ? 'Resume annotations (F2)' : 'Interact with page (F2)';
    this.modeButton.setAttribute('aria-label', this.modeButton.title);
    this.modeButton.setAttribute('aria-pressed', String(this.pageMode));
    this.toolbar.setAttribute('aria-label', this.pageMode ? 'Redline paused — page mode' : 'Redline tools — annotation mode');
    this.toolbar.querySelector('[data-redline-shape-menu]').inert = this.pageMode;
    for (const control of this.toolbar.querySelectorAll('button, select, input')) {
      if (this.pageMode && ![this.grip, this.modeButton, this.pinButton, this.closeButton].includes(control)) control.disabled = true;
    }
    if (this.pageMode) this._setMessage('Page mode · F2 to annotate');
  }

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
    if (tool !== this.tool && (tool === 'crop' || this.tool === 'crop')) {
      this.cropView.cancel();
      this._draft = null;
      this._draftElement = null;
      this._drag = null;
      this._resize = null;
      this._liveAnnotation = null;
      this.selectedId = null;
      if (tool === 'crop') this._toolBeforeCrop = this.tool;
    }
    this.tool = tool;
    this._savePreferences();
    this.svg.dataset.tool = tool;
    for (const button of this.toolbar.querySelectorAll('[data-redline-tool]')) {
      const selected = button.dataset.redlineTool === tool;
      button.toggleAttribute('data-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this._setMessage(`${TOOL_LABELS[tool]} tool`);
    this.cropView.sync(this.document, tool === 'crop');
    if (tool === 'crop') this._render();
  }

  _finishCrop() {
    this.setTool(this._toolBeforeCrop);
    this.toolbar.querySelector('[data-redline-tool="' + this.tool + '"]')?.focus({ preventScroll: true });
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
    this.cropView.cancel();
    this._finishTextBoxEditing({ commit: false });
    this._draft = null;
    this._draftElement = null;
    this._drag = null;
    this._resize = null;
    this._liveAnnotation = null;
    this._syncViewport();
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
    this._finishTextBoxEditing({ commit: true });
    const snapshot = this.document.toJSON();
    const capture = await this._captureBaseImage();
    const { crop, source, width, height } = cropExportGeometry(snapshot, capture.canvas.width, capture.canvas.height);
    if (width > 32767 || height > 32767 || width * height > 64_000_000) {
      throw new Error('Output is too large. Choose a smaller crop or output scale.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(capture.canvas, source.x, source.y, source.width, source.height, 0, 0, width, height);
    const scaleX = width / crop.width;
    const scaleY = height / crop.height;
    ctx.save();
    ctx.translate(-crop.x * scaleX, -crop.y * scaleY);
    drawRedlineAnnotations(ctx, snapshot.annotations, {
      scaleX,
      scaleY,
    });
    ctx.restore();
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
      // Match the independent X/Y scaling used by the editor and PNG export.
      preserveAspectRatio: 'none',
    });
    this.marksLayer = svgElement('g', { 'data-redline-marks': '' });
    this.svg.appendChild(this.marksLayer);
    this.root.appendChild(this.svg);

    this.cropView = new RedlineCropView(this.root, {
      onChange: crop => {
        this.document.setCrop(crop);
        this._render();
        if (this.cropView.panel.hidden) this.toolbar.querySelector('[data-redline-tool="crop"]')?.focus();
      },
      onScale: scale => {
        this.document.setOutputScale(scale);
        this.cropView.render();
        if (this.cropView.panel.hidden) this.toolbar.querySelector('[data-redline-tool="crop"]')?.focus();
      },
      onDone: () => this._finishCrop(),
      onEdit: () => this.setTool('crop'),
    });

    this.toolbar = document.createElement('div');
    this.toolbar.dataset.redlineToolbar = '';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'Redline tools');

    this.grip = appendIcon(this._button('', 'Drag to move toolbar', 'grip'), 'grip');
    this.grip.dataset.redlineGrip = '';
    this.grip.setAttribute('aria-label', 'Move toolbar');
    this.toolbar.appendChild(this.grip);

    this.modeButton = this._button('Page', 'Interact with page (F2)', 'page-mode');
    this.modeButton.dataset.redlineMode = '';
    this.modeButton.setAttribute('aria-pressed', 'false');
    this.toolbar.appendChild(this.modeButton);

    const title = document.createElement('strong');
    title.textContent = 'Redline';
    title.dataset.redlineTitle = '';
    this.toolbar.appendChild(title);

    const toolButtons = [
      ['select', 'Select and move marks (V)'],
      ['pen', 'Freehand pen (P)'],
      ['brush', 'Highlight / brush (B)'],
      ['line', 'Line (L)'],
      ['arrow', 'Arrow (A)'],
      ['rectangle', 'Rectangle (R)'],
      ['note', 'Numbered note (N)'],
      ['textbox', 'Text box — drag to size (T)'],
      ['crop', 'Crop screenshot — drag a region, resize with handles (C)'],
    ];
    for (const [tool, titleText] of toolButtons) {
      const button = this._button('', titleText);
      button.dataset.redlineTool = tool;
      appendIcon(button, tool);
      this.toolbar.appendChild(button);
    }

    const shapeMenu = document.createElement('details');
    shapeMenu.dataset.redlineShapeMenu = '';
    const shapeSummary = document.createElement('summary');
    shapeSummary.textContent = 'Paths';
    shapeSummary.title = 'More path tools';
    shapeMenu.appendChild(shapeSummary);
    for (const [tool, titleText] of [['polyline', 'Polyline — click points, Enter to finish'], ['polygon', 'Polygon — click points, Enter to finish']]) {
      const button = this._button('', titleText);
      button.dataset.redlineTool = tool;
      appendIcon(button, tool);
      shapeMenu.appendChild(button);
    }
    const eraserButton = this._button('', 'Erase the mark nearest the click (E)');
    eraserButton.dataset.redlineTool = 'eraser';
    appendIcon(eraserButton, 'eraser');
    shapeMenu.appendChild(eraserButton);
    this.toolbar.appendChild(shapeMenu);

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
      this._savePreferences();
      const selected = this.document?.annotations.find(mark => mark.id === this.selectedId);
      if (!selected || selected.width === this.width) return;
      this.document.replace(selected.id, { ...selected, width: this.width });
      this._render();
    });
    widthLabel.appendChild(this.widthSelect);
    this.toolbar.appendChild(widthLabel);

    const brushWidthLabel = document.createElement('label');
    brushWidthLabel.dataset.redlineControl = '';
    brushWidthLabel.title = 'Highlighter width';
    brushWidthLabel.innerHTML = '<span>Brush</span>';
    this.brushWidthSelect = document.createElement('select');
    this.brushWidthSelect.setAttribute('aria-label', 'Brush width');
    for (const [label, value] of LINE_WEIGHTS.map(([label, value]) => [label, Math.max(6, value * 3)])) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      this.brushWidthSelect.appendChild(option);
    }
    this.brushWidthSelect.value = String(this.brushWidth);
    this.brushWidthSelect.addEventListener('change', () => {
      this.brushWidth = Number(this.brushWidthSelect.value);
      this._savePreferences();
    });
    brushWidthLabel.appendChild(this.brushWidthSelect);
    this.toolbar.appendChild(brushWidthLabel);

    this.brushOpacitySelect = document.createElement('select');
    this.brushOpacitySelect.setAttribute('aria-label', 'Brush opacity');
    for (const [label, value] of BRUSH_OPACITIES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      this.brushOpacitySelect.appendChild(option);
    }
    this.brushOpacitySelect.value = String(this.brushOpacity);
    this.brushOpacitySelect.addEventListener('change', () => {
      this.brushOpacity = Number(this.brushOpacitySelect.value);
      this._savePreferences();
    });
    brushWidthLabel.appendChild(this.brushOpacitySelect);

    const fillLabel = document.createElement('label');
    fillLabel.dataset.redlineControl = '';
    // Named for what it actually drives. Shape fill comes from the picker's
    // style gallery; this only ever touched the text-box backing.
    fillLabel.title = 'Text box background opacity';
    fillLabel.innerHTML = '<span>Text fill</span>';
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
      this._savePreferences();
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

    const markerLabel = document.createElement('label');
    markerLabel.dataset.redlineControl = '';
    markerLabel.title = 'Numbered or lettered note markers';
    markerLabel.innerHTML = '<span>Steps</span>';
    this.noteMarkerSelect = document.createElement('select');
    this.noteMarkerSelect.setAttribute('aria-label', 'Note marker style');
    for (const [label, value] of NOTE_MARKERS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.noteMarkerSelect.appendChild(option);
    }
    this.noteMarkerSelect.value = this.noteMarker;
    // Unlike Weight, this sets the style of the *next* note and never touches an
    // existing one. Creating a note leaves it selected, so applying this to the
    // selection would silently re-letter the note just placed, and moving a note
    // between sequences renumbers it — breaking any "see step 2" already typed.
    this.noteMarkerSelect.addEventListener('change', () => {
      this.noteMarker = this.noteMarkerSelect.value === 'alpha' ? 'alpha' : 'numeric';
      this._savePreferences();
    });
    markerLabel.appendChild(this.noteMarkerSelect);
    this.toolbar.appendChild(markerLabel);

    this.undoButton = appendIcon(this._button('', 'Undo mark (Ctrl+Z)', 'undo'), 'undo');
    this.redoButton = appendIcon(this._button('', 'Redo mark (Ctrl+Y)', 'redo'), 'redo');
    this.deleteButton = appendIcon(this._button('', 'Delete selected mark (Delete)', 'delete'), 'delete');
    this.clearButton = this._button('Clear', 'Clear all marks', 'clear');
    this.importButton = this._button('Open', 'Import editable annotation data', 'import');
    this.jsonButton = this._button('JSON', 'Download editable annotation data', 'json');
    this.copyButton = appendIcon(this._button('Copy', 'Copy annotated screenshot', 'copy'), 'copy');
    this.downloadButton = appendIcon(this._button('PNG', 'Download annotated screenshot', 'download'), 'download');
    this.closeButton = appendIcon(this._button('', 'Close redline mode (Esc)', 'close'), 'close');
    this.pinButton = appendIcon(this._button('', 'Pin toolbar to the top-left', 'pin'), 'pin');
    this.pinButton.dataset.redlinePin = '';
    this.toolbar.appendChild(this.pinButton);
    this._syncToolbarPin();
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
    this._applyToolbarPosition();

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
    this.grip.addEventListener('pointerdown', event => this._onToolbarPointerDown(event));
    this.grip.addEventListener('pointermove', event => this._onToolbarPointerMove(event));
    this.grip.addEventListener('pointerup', event => this._onToolbarPointerUp(event));
    this.grip.addEventListener('pointercancel', event => this._onToolbarPointerUp(event, true));
    this.root.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.tool === 'crop') this._finishCrop();
      else this.close();
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
      this._pendingStyle = this._styleFromPick(event.detail);
      this.colorDialog.close('apply');
    });
    this.colorPicker.addEventListener('click', event => {
      if (!this.colorDialog.open) return;
      const swatch = event.composedPath().find(node => node instanceof Element && node.matches?.('[data-color]'));
      if (!swatch?.dataset.color) return;
      this._pendingStyle = this._styleFromPick(swatch.dataset);
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
      resolve?.(this.colorDialog.returnValue === 'apply' ? this._pendingStyle : null);
    });
  }

  /**
   * Read a style out of a picker event detail or a swatch's dataset.
   *
   * A pick that omits `fillOpacity` changes only the colour, which is how the
   * tint ramp and the custom field leave a gallery treatment alone. The
   * vendored `<wb-color-picker>` only ever reports a colour, so it lands here
   * too without needing to know about fills.
   */
  _styleFromPick(source) {
    const style = { color: String(source.color) };
    if ('intent' in source) style.intent = source.intent ? String(source.intent) : null;
    if ('fillOpacity' in source) {
      const opacity = Number(source.fillOpacity);
      style.fillOpacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
      style.fill = style.fillOpacity > 0 && source.fill ? String(source.fill) : null;
    }
    // A dataset carries strings, so only an explicit "false" drops the outline.
    if ('outline' in source) style.outline = source.outline !== false && source.outline !== 'false';
    return style;
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
    // A selected mark seeds the dialog, so reopening it shows that mark's own
    // treatment rather than whatever was last chosen from the toolbar.
    const initial = selected
      ? {
        color: selected.color,
        fill: selected.fill ?? null,
        fillOpacity: selected.fillOpacity ?? 0,
        outline: selected.outline !== false,
        intent: selected.intent ?? null,
      }
      : {
        color: this.color,
        fill: this.fill,
        fillOpacity: this.fillOpacity,
        outline: this.outline,
        intent: this.intent,
      };
    // [extension patch] no registry means no upgrade to wait for.
    if (globalThis.customElements) await customElements.whenDefined('wb-color-picker');
    this._pendingStyle = null;
    this.colorPicker.value = initial.color;
    if ('annotationStyle' in this.colorPicker) this.colorPicker.annotationStyle = initial;
    this.colorDialog.returnValue = 'cancel';

    const picked = await this._withChildDialog(() => new Promise(resolve => {
      this._colorDialogResolve = resolve;
      this.colorDialog.showModal();
      this._positionColorDialog();
    }));
    if (!picked || !this.active) return false;

    // A pick can carry only a colour, so anything it leaves out stays as it was.
    const next = { ...initial, ...picked };
    this.color = next.color;
    this.fill = next.fill ?? null;
    this.fillOpacity = next.fillOpacity ?? 0;
    this.outline = next.outline !== false;
    this.intent = next.intent ?? null;
    this._savePreferences();
    this._syncColorButton();
    if (!selected) return true;
    const unchanged = selected.color.toUpperCase() === this.color.toUpperCase()
      && (selected.fillOpacity ?? 0) === this.fillOpacity
      && (selected.fill ?? null) === this.fill
      && (selected.outline !== false) === this.outline
      && (selected.intent ?? null) === this.intent;
    if (unchanged) return true;
    this.document.replace(selected.id, {
      ...selected,
      color: this.color,
      fill: this.fill,
      fillOpacity: this.fillOpacity,
      outline: this.outline,
      intent: this.intent,
    });
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
    // The swatch shows the whole treatment: the stroke as its rim, the fill as
    // its centre, so the toolbar says what the next box will look like.
    this._paintSwatch({
      color: this.color, fill: this.fill, fillOpacity: this.fillOpacity, outline: this.outline,
    });
    const fill = this.fillOpacity > 0 ? `, ${Math.round(this.fillOpacity * 100)}% fill` : '';
    const outline = this.fillOpacity > 0 && !this.outline ? ', no outline' : '';
    this.colorButton.title = `Annotation color: ${this.color}${fill}${outline}`;
  }

  /** Show a treatment on the toolbar swatch: fill in the centre, stroke as the rim. */
  _paintSwatch(style) {
    const paint = redlineMarkFill(style);
    this.colorSwatch.style.backgroundColor = paint ? withAlpha(paint.color, paint.opacity) : 'transparent';
    this.colorSwatch.style.boxShadow = redlineMarkStroked(style)
      ? `inset 0 0 0 3px ${style.color}`
      : 'none';
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
    this.cropView.sync(this.document, this.tool === 'crop');
  }

  _point(event) {
    const point = new DOMPoint(event.clientX, event.clientY)
      .matrixTransform(this.svg.getScreenCTM().inverse());
    return { x: point.x, y: point.y };
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

  /**
   * The next ordinal for a note.
   *
   * Numbered and lettered notes run as separate sequences, so a document can
   * use digits for the main steps and letters for side callouts without one
   * pushing the other along.
   */
  _nextNoteNumber(marker = this.noteMarker) {
    const style = marker === 'alpha' ? 'alpha' : 'numeric';
    return this.document.annotations.reduce((max, mark) => (
      mark.type === 'note' && (mark.marker === 'alpha' ? 'alpha' : 'numeric') === style
        ? Math.max(max, mark.number)
        : max
    ), 0) + 1;
  }

  _loadPreferences(saved) {
    if (saved && typeof saved === 'object') {
      if (saved.tool !== 'crop' && Object.hasOwn(TOOL_LABELS, saved.tool)) this.tool = saved.tool;
      if (/^#[0-9a-f]{6}$/i.test(saved.color)) this.color = saved.color;
      if (/^#[0-9a-f]{6}$/i.test(saved.fill)) this.fill = saved.fill;
      if (Number.isFinite(saved.fillOpacity) && saved.fillOpacity >= 0 && saved.fillOpacity <= 1) {
        this.fillOpacity = saved.fillOpacity;
      }
      if (saved.outline === false) this.outline = false;
      if (typeof saved.intent === 'string' && saved.intent) this.intent = saved.intent.slice(0, 32);
      if (saved.noteMarker === 'alpha' || saved.noteMarker === 'numeric') this.noteMarker = saved.noteMarker;
      if (Number.isFinite(saved.width) && saved.width >= 1 / 3) this.width = saved.width;
      if (Number.isFinite(saved.brushWidth) && saved.brushWidth > 0) this.brushWidth = saved.brushWidth;
      if (Number.isFinite(saved.brushOpacity) && saved.brushOpacity >= 0 && saved.brushOpacity <= 1) this.brushOpacity = saved.brushOpacity;
      if (Number.isFinite(saved.textBoxBackgroundOpacity) && saved.textBoxBackgroundOpacity >= 0 && saved.textBoxBackgroundOpacity <= 1) {
        this.textBoxBackgroundOpacity = saved.textBoxBackgroundOpacity;
      }
      this.toolbarPinned = saved.toolbarPinned === true;
      if (Number.isFinite(saved.toolbarPosition?.left) && Number.isFinite(saved.toolbarPosition?.top)) {
        this.toolbarPosition = { left: saved.toolbarPosition.left, top: saved.toolbarPosition.top };
      }
    }
  }

  _savePreferences() {
    const preferences = {
      tool: this.tool === 'crop' ? this._toolBeforeCrop : this.tool, color: this.color, width: this.width,
      fill: this.fill, fillOpacity: this.fillOpacity, outline: this.outline, intent: this.intent,
      noteMarker: this.noteMarker,
      brushWidth: this.brushWidth, brushOpacity: this.brushOpacity,
      textBoxBackgroundOpacity: this.textBoxBackgroundOpacity,
      toolbarPinned: this.toolbarPinned,
      toolbarPosition: this.toolbarPosition ? { ...this.toolbarPosition } : null,
    };
    this._preferenceSave = this._preferenceSave
      .then(() => this.options.savePreferences(preferences))
      .catch(error => console.warn('[Redline] Could not save preferences.', error));
  }

  _eraseAt(point) {
    const hit = [...(this.document?.annotations ?? [])].reverse().find(mark => {
      const bounds = annotationBounds(mark);
      return point.x >= bounds.x - 12 && point.x <= bounds.x + bounds.width + 12
        && point.y >= bounds.y - 12 && point.y <= bounds.y + bounds.height + 12;
    });
    if (!hit) return false;
    this.document.remove(hit.id);
    this.selectedId = null;
    this._render();
    return true;
  }

  _finishPathDraft() {
    if (!this._draft || !['polyline', 'polygon'].includes(this._draft.type)) return false;
    const draft = this._draft;
    this._draft = null;
    this._draftElement = null;
    delete draft.previewPoint;
    if (draft.points.length < 2) {
      this._render();
      return false;
    }
    const mark = this.document.add(draft);
    this.selectedId = mark.id;
    this.setTool('select');
    this._render();
    return true;
  }

  async _onPointerDown(event) {
    if (event.button !== 0 || !this.document || this._busy || this.pageMode || this.tool === 'crop') return;
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
          number: this._nextNoteNumber(), marker: this.noteMarker,
          color: this.color, width: this.width,
          ...(this.intent ? { intent: this.intent } : {}),
        });
        this.selectedId = mark.id;
        this._render();
      }
      return;
    }

    if (this.tool === 'eraser') {
      this._eraseAt(point);
      return;
    }

    if (this.tool === 'polyline' || this.tool === 'polygon') {
      if (!this._draft) this._draft = {
        id: cryptoId(), type: this.tool, points: [point], previewPoint: point,
        ...this._draftStyle(),
      };
      else this._draft.points.push(point);
      this._render();
      return;
    }

    this._draft = this.tool === 'pen' || this.tool === 'brush'
      ? { id: cryptoId(), type: this.tool, points: [point, point], ...this._draftStyle(), width: this.tool === 'brush' ? this.brushWidth : this.width, opacity: this.tool === 'brush' ? this.brushOpacity : 1 }
      : { id: cryptoId(), type: this.tool, start: point, end: point, ...this._draftStyle() };
    this._render();
  }

  /**
   * Style every new mark inherits from the toolbar.
   *
   * The fill fields are only included when there is a fill to apply, so an
   * unfilled mark is byte-identical to one made before fills existed. The
   * model drops them anyway for types that cannot enclose an area.
   */
  _draftStyle() {
    const style = { color: this.color, width: this.width };
    if (this.intent) style.intent = this.intent;
    if (this.fillOpacity > 0) {
      style.fillOpacity = this.fillOpacity;
      if (this.fill) style.fill = this.fill;
      if (!this.outline) style.outline = false;
    }
    return style;
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
    if (this._draft.type === 'polyline' || this._draft.type === 'polygon') {
      this._draft.previewPoint = point;
      this._render();
      return;
    }
    if (this._draft.type === 'pen' || this._draft.type === 'brush') {
      if (distance(this._draft.points.at(-1), point) >= 2) {
        this._draft.points.push(point);
        if (this._draft.type === 'brush' && this._draftElement) {
          this._draftElement.setAttribute('points', this._draft.points.map(item => `${item.x},${item.y}`).join(' '));
        }
      }
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
    if (this._draft.type === 'polyline' || this._draft.type === 'polygon') return;
    const draft = this._draft;
    this._draft = null;
    this._draftElement = null;
    const meaningful = draft.type === 'pen' || draft.type === 'brush'
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
    if (this.tool === 'polyline' || this.tool === 'polygon') {
      this._finishPathDraft();
      return;
    }
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

  _applyToolbarPosition() {
    this._syncToolbarPin();
    if (!this.toolbarPosition) {
      this.toolbar.removeAttribute('data-positioned');
      this.toolbar.style.removeProperty('left');
      this.toolbar.style.removeProperty('top');
      return;
    }
    this.toolbar.dataset.positioned = '';
    this.toolbar.style.left = `${this.toolbarPosition.left}px`;
    this.toolbar.style.top = `${this.toolbarPosition.top}px`;
    this._clampToolbarPosition();
  }

  _clampToolbarPosition() {
    if (!this.toolbarPosition || !this.toolbar.isConnected) return;
    const gutter = 6;
    const rect = this.toolbar.getBoundingClientRect();
    const left = Math.min(Math.max(gutter, this.toolbarPosition.left), Math.max(gutter, window.innerWidth - rect.width - gutter));
    const top = Math.min(Math.max(gutter, this.toolbarPosition.top), Math.max(gutter, window.innerHeight - rect.height - gutter));
    this.toolbarPosition = { left, top };
    this.toolbar.style.left = `${left}px`;
    this.toolbar.style.top = `${top}px`;
  }

  _onToolbarPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = this.toolbar.getBoundingClientRect();
    this._toolbarDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    this.grip.setPointerCapture?.(event.pointerId);
  }

  _onToolbarPointerMove(event) {
    if (this._toolbarDrag?.pointerId !== event.pointerId) return;
    this.toolbarPinned = false;
    this.toolbarPosition = {
      left: this._toolbarDrag.left + event.clientX - this._toolbarDrag.startX,
      top: this._toolbarDrag.top + event.clientY - this._toolbarDrag.startY,
    };
    this._applyToolbarPosition();
  }

  _onToolbarPointerUp(event, cancelled = false) {
    if (this._toolbarDrag?.pointerId !== event.pointerId) return;
    this.grip.releasePointerCapture?.(event.pointerId);
    if (cancelled) this.toolbarPosition = null;
    else this._clampToolbarPosition();
    this._toolbarDrag = null;
    this._savePreferences();
    this._syncToolbarPin();
  }

  _onToolbarClick(event) {
    const tool = event.target.closest('[data-redline-tool]')?.dataset.redlineTool;
    if (tool) return this.setTool(tool);
    const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
    if (!action) return;
    const actions = {
      'page-mode': () => this.setPageMode(!this.pageMode),
      pin: () => this._toggleToolbarPin(),
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

  _toggleToolbarPin() {
    this.toolbarPinned = !this.toolbarPinned;
    if (this.toolbarPinned) this.toolbarPosition = null;
    this._savePreferences();
    this._applyToolbarPosition();
    this.options.setStatus(this.toolbarPinned ? 'Toolbar pinned to the top-left.' : 'Toolbar unpinned. Drag the grip to move it.');
  }

  _syncToolbarPin() {
    this.toolbar.toggleAttribute('data-pinned', this.toolbarPinned);
    if (!this.pinButton) return;
    this.pinButton.toggleAttribute('data-active', this.toolbarPinned);
    this.pinButton.setAttribute('aria-pressed', String(this.toolbarPinned));
    this.pinButton.title = this.toolbarPinned
      ? 'Unpin toolbar from the top-left'
      : 'Pin toolbar to the top-left';
    this.pinButton.setAttribute('aria-label', this.pinButton.title);
  }

  _onKeyDown(event) {
    if (!this.active || this.pageMode || this._dialogDepth > 0) return;
    // [extension patch] Listen inside the root and inspect the original target,
    // including when that root is closed to the surrounding page.
    const target = event.composedPath?.()[0] ?? event.target;
    if (this._busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (target === this._textEditor?.element) return;
    if (this.cropView.handleKey(event, target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Let the native modal dialog dispatch its cancel event for Escape.
    if (event.key === 'Escape') return;
    if (event.key === 'Enter' && this._draft && ['polyline', 'polygon'].includes(this._draft.type)) {
      this._finishPathDraft();
      event.preventDefault();
      return;
    }
    // Chromium may move reverse-Tab from the first control into browser chrome
    // even for a modal dialog. Keep the toolbar's keyboard loop deterministic.
    if (event.key === 'Tab') {
      const focusable = [...this.root.querySelectorAll('button, input, select, summary, [tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
          && !element.closest('[hidden], [inert]')
          && element.checkVisibility({ visibilityProperty: true }));
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
      const tool = { v: 'select', p: 'pen', b: 'brush', e: 'eraser', l: 'line', a: 'arrow', r: 'rectangle', n: 'note', t: 'textbox', c: 'crop' }[event.key.toLowerCase()];
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
    this.cropView.sync(this.document, this.tool === 'crop');
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
    const paint = redlineMarkFill(mark);
    const filled = paint ? { fill: paint.color, 'fill-opacity': paint.opacity } : null;
    const outlined = redlineMarkStroked(mark);

    if (['pen', 'brush', 'polyline', 'polygon'].includes(mark.type)) {
      const renderPoints = mark.previewPoint ? [...mark.points, mark.previewPoint] : mark.points;
      const points = renderPoints.map(point => `${point.x},${point.y}`).join(' ');
      const style = mark.type === 'brush'
        ? { ...common, 'stroke-opacity': mark.opacity ?? 0.35, 'stroke-width': Math.max(mark.width * 4, 6) }
        : outlined ? common : { ...common, stroke: 'none' };
      // A filled polygon paints under its own outline, so it goes in first.
      if (mark.type === 'polygon' && filled && renderPoints.length > 2) {
        group.appendChild(svgElement('polygon', { ...filled, stroke: 'none', points }));
      }
      const polyline = svgElement('polyline', { ...style, points });
      group.appendChild(polyline);
      if (mark === this._draft) this._draftElement = polyline;
      if (mark.type === 'polygon' && renderPoints.length > 1) {
        group.appendChild(svgElement('line', { ...style, x1: renderPoints.at(-1).x, y1: renderPoints.at(-1).y, x2: renderPoints[0].x, y2: renderPoints[0].y }));
      }
    } else if (mark.type === 'line') {
      group.appendChild(svgElement('line', { ...common, x1: mark.start.x, y1: mark.start.y, x2: mark.end.x, y2: mark.end.y }));
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
        ...(filled ?? {}),
        ...(outlined ? {} : { stroke: 'none' }),
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
      number.textContent = redlineNoteGlyph(mark.number, mark.marker);
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
    for (const control of this.toolbar.querySelectorAll('button, select, input')) control.disabled = false;
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
    // Always the default for the next note, never the selection: a control that
    // does not apply to the selected mark must not claim to describe it.
    if (this.noteMarkerSelect) this.noteMarkerSelect.value = this.noteMarker;
    // The swatch tracks the selection too, so it always shows the treatment the
    // picker would open on.
    if (this.colorSwatch && selected) this._paintSwatch(selected);
    else this._syncColorButton();
    this.undoButton.disabled = !this.document?.canUndo;
    this.redoButton.disabled = !this.document?.canRedo;
    this.deleteButton.disabled = !this.selectedId;
    this.clearButton.disabled = count === 0;
    this.importButton.disabled = false;
    this.jsonButton.disabled = false;
    this.copyButton.disabled = false;
    this.downloadButton.disabled = false;
    this._setMessage(`${count} mark${count === 1 ? '' : 's'}`);
    this._syncInteractionMode();
  }

  _setBusy(busy, message = '') {
    this._busy = busy;
    this.root.toggleAttribute('data-busy', busy);
    this.cropView.cancel();
    if (busy) this._busyFocus = this.root.getRootNode().activeElement;
    for (const control of this.root.querySelectorAll('button, select, input')) control.disabled = busy;
    this.toolbar.toggleAttribute('data-busy', busy);
    if (message) this._setMessage(message);
    if (!busy) {
      const count = this.document?.annotations.length ?? 0;
      this.undoButton.disabled = !this.document?.canUndo;
      this.redoButton.disabled = !this.document?.canRedo;
      this.deleteButton.disabled = !this.selectedId;
      this.clearButton.disabled = count === 0;
      this.importButton.disabled = false;
      this.jsonButton.disabled = false;
      this.copyButton.disabled = false;
      this.downloadButton.disabled = false;
      if (this.active) {
        const focus = this._busyFocus?.isConnected && !this._busyFocus.disabled
          ? this._busyFocus : this.toolbar.querySelector('[data-redline-tool][data-active]');
        focus?.focus({ preventScroll: true });
      }
      this._busyFocus = null;
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
