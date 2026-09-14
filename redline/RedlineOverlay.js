import { RedlineDocument, cryptoId, translateAnnotation } from './RedlineDocument.js';
import { RedlineEyedropper } from './RedlineEyedropper.js';
import { appendIcon } from './icons.js';
import { RedlineCropView } from './RedlineCropView.js';
import {
  PointerTrail, clampCursor, cursorBounds, cursorHitTest, cursorInsideCrop, cursorPrimitives, moveCursor,
} from './RedlineCursor.js';
import {
  blobToDataUrl, canvasToBlob, captureBaseImage, clipboardSupport, composeAnnotatedCanvas, downloadBlob, timestampName,
} from './RedlineExport.js';
import { markPrimitives, topmostMarkAt } from './RedlineGeometry.js';
import { RedlineGestures } from './RedlineGestures.js';
import { prepareLegendLayout } from './RedlineCanvas.js';
import {
  BULLET_SCHEMES, LEGEND_MARGIN, LEGEND_MIN_WIDTH, bulletLabelStatus, bulletLimit, bulletSchemeOf, defaultLegend,
  layoutLegend, legendClipping, moveLegend, nextBulletLabel, normalizeScheme,
} from './RedlineLegend.js';
import { RedlineLegendEditor } from './RedlineLegendEditor.js';
import { RedlinePreview } from './RedlinePreview.js';
import { DraftAutosaver, buildDraft, describeDraft, draftHasContent, readDraft } from './RedlineRecovery.js';
import { buildReport, reportCounts } from './RedlineReport.js';
import {
  applyStyleChange, CLOSED_TYPES, DEFAULT_COLOR, DEFAULT_FILL_OPACITY, DECORATIONS, LINE_TYPES, PT_TO_CSS_PX,
  isHexColor, markDecorations, redlineMarkFill, treatmentOf,
} from './RedlineStyles.js';
import { RedlineSvgLayer, renderPrimitives, svgElement } from './RedlineSvg.js';
import { RedlineTextEditor } from './RedlineTextEditor.js';
import { createCanvasMeasurer, fitTextBoxHeight } from './RedlineTextLayout.js';
import { RedlineToolbar, TOOL_INFO } from './RedlineToolbar.js';
import './vendor/wb/wb-color-picker/wb-color-picker.define.js';

/** Tools that create marks, and so have drawing defaults to style. */
const DRAWING_TOOLS = new Set(['pen', 'brush', 'line', 'arrow', 'rectangle', 'ellipse', 'polyline', 'polygon', 'note', 'bullet', 'textbox']);
const TOOL_KEYS = {
  v: 'select', p: 'pen', b: 'brush', e: 'eraser', l: 'line', a: 'arrow', r: 'rectangle', o: 'ellipse',
  n: 'note', u: 'bullet', t: 'textbox', c: 'crop',
};
const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const NUDGE_MERGE_MS = 800;

const TYPE_NAMES = {
  pen: 'pen stroke', brush: 'highlight', line: 'line', arrow: 'arrow', polyline: 'polyline', polygon: 'polygon',
  rectangle: 'rectangle', ellipse: 'ellipse', note: 'note', bullet: 'bullet', textbox: 'text box',
};

const validEnds = value => DECORATIONS.includes(value?.start) && DECORATIONS.includes(value?.end);

/** The useful part of a clipboard error, without the API boilerplate or a help link. */
const clipboardReason = error => String(error?.message ?? error)
  .replace(/^Failed to execute '\w+' on 'Clipboard':\s*/, '')
  .replace(/\s*See https?:\/\/\S+.*$/, '')
  .replace(/\.$/, '') || 'refused';

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
 *
 * Unfinished work and interruptions (see RedlineGestures.js):
 *   tool change, Browse mode, close, import, clear, undo/redo, export
 *     → cancel any pointer gesture and path draft; completed marks stay;
 *   Escape → close an open menu, else cancel unfinished work, else leave crop
 *     editing, else close Redline;
 *   window blur, hidden tab, resize, a child dialog → cancel a pointer gesture;
 *   Enter or double-click → finish a path; Backspace or Ctrl+Z → drop its last point.
 *
 * Bullet explanations (see RedlineLegendEditor.js) follow the text box rules:
 * tool change, Browse, close, undo/redo, export and pressing elsewhere save an
 * open edit; import and a new session discard it; Escape cancels it first.
 *
 * Pointer proxy (see RedlineCursor.js): Include cursor places it where the
 * pointer last pressed or paused over the page or drawing surface (never over
 * Redline's own controls or editors), or asks for a placement when there is no
 * such position. It stays frozen unless Follow is on; dragging, nudging or
 * placing freezes it again. Escape ends placement, then deselects it.
 *
 * Reload recovery (see RedlineRecovery.js), when the host supplies loadDraft,
 * saveDraft and discardDraft: the first open after a page load checks for a
 * draft before any write, and offers Restore or Discard when one is waiting.
 * While that decision is pending, writes stay paused so the waiting draft is
 * never overwritten. Otherwise changes are saved after a short pause, and
 * immediately when the page is hidden or unloaded.
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
    confirm = async () => false,
    dismissDialogs = () => {},
    setPageLocked = locked => document.body.toggleAttribute('data-redline-active', locked),
    // Reload recovery. All three storage adapters are needed; without them the
    // session lives in memory only.
    loadDraft = null,
    saveDraft = null,
    discardDraft = null,
    requestRecovery = null,
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
      requestText, confirmClear, confirm, dismissDialogs, setPageLocked, createColorPicker, describePage, savePreferences,
      loadDraft, saveDraft, discardDraft, requestRecovery,
    };
    this.active = false;
    this._lifecycleToken = 0;
    this.pageMode = false;
    this.tool = 'pen';
    this._toolBeforeCrop = 'select';
    /** Styles for marks the drawing tools will create. Never a mark's own style. */
    this.defaults = {
      color: DEFAULT_COLOR,
      width: 1 * PT_TO_CSS_PX,
      intent: null,
      fill: null,
      savedFill: null,
      fillOpacity: 0,
      outline: true,
      lastFillOpacity: DEFAULT_FILL_OPACITY,
      brushWidth: 10,
      brushOpacity: 0.35,
      fontSize: 16,
      textBoxBackgroundOpacity: 0.75,
      noteMarker: 'numeric',
      bulletScheme: 'numeric',
      /** Whether a new session's legend starts shown; each document stores its own. */
      legendVisible: false,
      ends: {
        line: { start: 'none', end: 'none' },
        arrow: { start: 'none', end: 'arrow' },
        polyline: { start: 'none', end: 'none' },
      },
    };
    this.selectedId = null;
    /** The legend itself is selected: its frame, grip and handles show. */
    this.legendSelected = false;
    /** Why the last bullet could not be placed, until labels or scheme change. */
    this._bulletLimit = null;
    this.document = null;
    this.sessionStartedAt = null;
    this._events = new EventTarget();
    this._previousFocus = null;
    this._dialogDepth = 0;
    this._colorDialogResolve = null;
    this.toolbarPinned = false;
    this.toolbarPosition = null;
    this._toolbarDrag = null;
    this._preferenceSave = Promise.resolve();
    this._defaultsVersion = 0;
    this._nudge = { id: null, run: 0, at: 0 };
    /** The pointer proxy is selected: its frame shows and arrow keys move it. */
    this.cursorSelected = false;
    /** The next press on the drawing surface places the pointer's hotspot. */
    this.cursorPlacing = false;
    /** Move the pointer to each new meaningful position instead of keeping it frozen. */
    this.cursorFollow = false;
    this.sessionId = cryptoId();
    /** Changes whenever the whole document is replaced, so late async results can tell. */
    this._documentToken = 0;
    const recoverable = Boolean(loadDraft && saveDraft && discardDraft);
    this._recovery = { state: recoverable ? 'unchecked' : 'unavailable', pending: null, paused: false, stored: false, failure: null };
    this._trail = new PointerTrail({
      accept: sample => this._meaningfulPointer(sample),
      onCommit: position => this._onPointerTrail(position),
    });
    this.measurer = createCanvasMeasurer();
    this._loadPreferences(preferences);
    this._buildDOM();
    this._autosave = recoverable ? new DraftAutosaver({
      snapshot: () => this._draftSnapshot(),
      save: draft => this.options.saveDraft(draft),
      discard: () => this.options.discardDraft({ sessionId: this.sessionId }),
      onResult: result => this._onDraftResult(result),
      paused: true,
    }) : null;

    this._boundKeyDown = event => this._onKeyDown(event);
    this._boundKeyUp = event => this._onKeyUp(event);
    this._boundResize = () => {
      this.cropView.cancel();
      this.gestures.cancelPointer();
      this._syncViewport();
      if (this.active) this.toolbarUI.layout();
      this._applyToolbarPosition();
      this.textEditor.position();
      if (this.colorDialog?.open) this._positionColorDialog();
      this._render({ force: true });
    };
    this._boundBlur = () => {
      this.gestures.cancelPointer();
      this._trail.leave();
    };
    this._boundVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      this.gestures.cancelPointer();
      this._trail.leave();
      this._autosave?.flush();
    };
    // The page may be unloading: send the latest draft now rather than after a pause.
    this._boundPageHide = () => this._autosave?.flushNow();
    // Pointer positions over the page itself, while Redline is closed or in
    // Browse mode. Passive and read-only: the page's own handling is untouched.
    this._boundPagePointer = event => this._onPagePointer(event);
    // Closed shadow roots hide their event path from window-level listeners.
    this._keyTarget = this.root.getRootNode();
    this._keyTarget.addEventListener('keydown', this._boundKeyDown, true);
    this._keyTarget.addEventListener('keyup', this._boundKeyUp, true);
    this._boundModeKeyDown = event => {
      if (event.isComposing || event.keyCode === 229 || this.legendEditor?.session?.composition
        || event.key !== 'F2' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || !this.active || this._dialogDepth > 0 || this._busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.setPageMode(!this.pageMode);
    };
    window.addEventListener('keydown', this._boundModeKeyDown, true);
    window.addEventListener('resize', this._boundResize);
    window.addEventListener('blur', this._boundBlur);
    window.addEventListener('pagehide', this._boundPageHide);
    for (const type of ['pointermove', 'pointerdown']) window.addEventListener(type, this._boundPagePointer, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this._boundVisibility);
  }

  addEventListener(...args) { this._events.addEventListener(...args); }
  removeEventListener(...args) { this._events.removeEventListener(...args); }

  /** The main toolbar element (the role="toolbar" bar). */
  get toolbar() { return this.toolbarUI.bar; }

  destroy() {
    this.active = false;
    this._lifecycleToken += 1;
    this.options.dismissDialogs();
    if (this._hoverFrame) cancelAnimationFrame(this._hoverFrame);
    this._autosave?.flushNow();
    this._autosave?.pause();
    this.eyedropper?.destroy();
    this._trail.reset();
    this.preview?.destroy();
    this.textEditor.finish({ commit: false });
    this.legendEditor.destroy();
    this.gestures.cancel();
    this._keyTarget.removeEventListener('keydown', this._boundKeyDown, true);
    this._keyTarget.removeEventListener('keyup', this._boundKeyUp, true);
    window.removeEventListener('keydown', this._boundModeKeyDown, true);
    window.removeEventListener('resize', this._boundResize);
    window.removeEventListener('blur', this._boundBlur);
    window.removeEventListener('pagehide', this._boundPageHide);
    for (const type of ['pointermove', 'pointerdown']) window.removeEventListener(type, this._boundPagePointer, { capture: true });
    document.removeEventListener('visibilitychange', this._boundVisibility);
    this.options.setPageLocked(false);
    if (this.colorDialog.open) this.colorDialog.close('cancel');
    if (this.root.open) this.root.close();
    this.colorDialog.remove();
    this.root.remove();
  }

  open({ reset = false } = {}) {
    if (this.active) return;
    if (reset || !this.document) {
      this.document = this._newDocument();
      this.sessionStartedAt = new Date().toISOString();
      this.selectedId = null;
      this._documentToken += 1;
    }
    this.active = true;
    this.pageMode = false;
    this.root.removeAttribute('data-page-mode');
    this._previousFocus = document.activeElement;
    this._pageFocus = this._previousFocus;
    this.root.hidden = false;
    if (!this.root.open) this.root.showModal();
    this.options.setPageLocked(true);
    this._syncViewport();
    this.setTool(this.tool);
    this.toolbarUI.layout();
    this._applyToolbarPosition();
    this._render({ force: true });
    this.options.setStatus('Annotate mode — F2 switches to Browse; Esc closes without losing marks.');
    this._events.dispatchEvent(new CustomEvent('redline:opened'));
    this.toolbarUI.toolFocusTarget(this.tool)?.focus();
    if (this._recovery.state === 'unchecked') this._checkRecovery();
    else if (this._canPromptRecovery()) this._promptRecovery();
  }

  close() {
    if (!this.active) return;
    this._lifecycleToken += 1;
    this.eyedropper?.cancel();
    this.options.dismissDialogs();
    this.preview?.close();
    if (this.colorDialog.open) this.colorDialog.close('cancel');
    this.cropView.cancel();
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    this.toolbarUI.closeMenus();
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this.active = false;
    this._autosave?.flush();
    if (this.root.open) this.root.close();
    this.root.hidden = true;
    this.options.setPageLocked(false);
    this.options.setStatus(this.document?.marks.length
      ? `Redline closed — ${this.document.marks.length} annotation(s) retained.`
      : 'Redline closed.');
    this._events.dispatchEvent(new CustomEvent('redline:closed'));
    this._previousFocus?.focus?.();
    this._previousFocus = null;
  }

  toggle() { this.active ? this.close() : this.open(); }

  /** Browse mode releases input to the page while keeping a small toolbar on it. */
  setPageMode(enabled) {
    if (!this.active || this._busy || this._dialogDepth > 0 || this.pageMode === enabled) return;
    this.cropView.cancel();
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    this.toolbarUI.closeMenus();
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this._trail.leave();
    if (!enabled) this._pageFocus = document.activeElement;
    this.pageMode = enabled;
    this.root.close();
    this.root.toggleAttribute('data-page-mode', enabled);
    this.options.setPageLocked(!enabled);
    if (enabled) this.root.show();
    else this.root.showModal();
    this._syncViewport();
    this._render({ force: true });
    this._applyToolbarPosition();
    if (enabled) (this._pageFocus ?? this._previousFocus)?.focus?.({ preventScroll: true });
    else this.toolbarUI.toolFocusTarget(this.tool)?.focus({ preventScroll: true });
    this._setMessage('');
    this.options.setStatus(enabled
      ? 'Browse mode — click, type, and scroll normally. F2 resumes annotating.'
      : 'Annotate mode — F2 switches to Browse.');
  }

  newSession() {
    this.textEditor.finish({ commit: false });
    this.legendEditor.cancel({ focus: false });
    this.gestures.cancel();
    this.document = this._newDocument();
    this.sessionStartedAt = new Date().toISOString();
    this.selectedId = null;
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this._bulletLimit = null;
    this._documentToken += 1;
    this._render({ force: true });
  }

  /** An empty document for the current viewport, its legend shown if last chosen so. */
  _newDocument() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let legend = null;
    if (this.defaults.legendVisible) {
      legend = defaultLegend(width, height, { visible: true });
      legend.y = this._legendTop(legend, { x: 1, y: 1 });
    }
    return new RedlineDocument({ width, height, legend });
  }

  /**
   * A top edge, in document units, that keeps a legend at `frame.x` clear of the
   * toolbar and style row when they sit above it. Before the toolbar has been
   * laid out, assume it is in its usual place.
   */
  _legendTop(frame, scale = this._scale()) {
    // The style row grows while editing (a hint, a status message, the Save
    // and Cancel buttons), so leave room for three wrapped rows of controls.
    const ROW_ALLOWANCE = 76;
    const bar = this.active ? this.toolbarUI.bar.getBoundingClientRect() : null;
    if (!bar?.width) return Math.round((10 + 46 + 6 + ROW_ALLOWANCE + 10) / scale.y);
    const context = this.toolbarUI.context.hidden ? null : this.toolbarUI.context.getBoundingClientRect();
    const reserved = {
      left: Math.min(bar.left, context?.left ?? bar.left),
      right: Math.max(bar.right, context?.right ?? bar.right),
      top: bar.top,
      bottom: context?.width ? context.top + Math.max(context.height, ROW_ALLOWANCE) : bar.bottom + 6 + ROW_ALLOWANCE,
    };
    const left = frame.x * scale.x;
    const right = (frame.x + frame.width) * scale.x;
    const covers = reserved.top < window.innerHeight / 3 && reserved.left < right && reserved.right > left;
    return covers ? Math.round((reserved.bottom + 10) / scale.y) : LEGEND_MARGIN;
  }

  setTool(tool) {
    if (!Object.hasOwn(TOOL_INFO, tool)) return;
    if (tool !== this.tool) {
      this.textEditor.finish({ commit: true });
      this.legendEditor.commit({ focus: false });
      this.gestures.cancel();
      this.cropView.cancel();
      if (tool === 'crop') this._toolBeforeCrop = this.tool;
      // Styling controls follow the tool: a drawing tool edits its defaults, so
      // a mark left selected must not be edited by them.
      if (tool !== 'select') this.selectedId = null;
      this.legendSelected = false;
      this.cursorSelected = false;
      this.cursorPlacing = false;
      this._bulletLimit = null;
    }
    this.tool = tool;
    this._savePreferences();
    this.svg.dataset.tool = tool;
    this.svg.removeAttribute('data-hover');
    this._setMessage('');
    if (this.document) this.cropView.sync(this.document, tool === 'crop');
    this._render();
  }

  _finishCrop() {
    this.setTool(this._toolBeforeCrop);
    this.toolbarUI.toolFocusTarget(this.tool)?.focus({ preventScroll: true });
  }

  undo() {
    if (this.gestures.hasPathDraft) return this.gestures.removeLastPathPoint();
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    if (!this.document?.undo()) return false;
    this.selectedId = null;
    this._bulletLimit = null;
    this._render();
    return true;
  }

  redo() {
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    if (!this.document?.redo()) return false;
    this.selectedId = null;
    this._bulletLimit = null;
    this._render();
    return true;
  }

  async clear() {
    if (!this.document?.marks.length) return false;
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    const count = this.document.marks.length;
    const confirmed = await this._withChildDialog(() => this.options.confirmClear(count));
    if (!confirmed || !this.active) return false;
    this.selectedId = null;
    const changed = this.document.clear();
    this._render();
    return changed;
  }

  /** Delete the selected mark. A bullet takes its explanation with it, as one undo step. */
  removeSelected() {
    this.legendEditor.commit({ focus: false });
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    if (!mark || !this.document.remove(mark.id)) return false;
    this.selectedId = null;
    this._bulletLimit = null;
    this._render();
    if (mark.type === 'bullet') this._setMessage(`Deleted bullet ${mark.label} and its explanation — Ctrl+Z restores both`);
    return true;
  }

  /** Copy the selected mark with a new id, offset so both remain visible. */
  duplicateSelected() {
    this.legendEditor.commit({ focus: false });
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    if (!mark) return false;
    this.gestures.cancel();
    const scale = this._scale();
    const copy = translateAnnotation(mark, 12 / scale.x, 12 / scale.y);
    copy.id = cryptoId();
    // Two circles reading "2" would make "see step 2" ambiguous.
    if (copy.type === 'note') copy.number = this._nextNoteNumber(copy.marker);
    if (copy.type === 'bullet') {
      const scheme = bulletSchemeOf(mark.label);
      const label = nextBulletLabel(this.document.marks, scheme);
      if (!label) {
        const { range, noun } = BULLET_SCHEMES[scheme];
        this._setMessage(`Cannot duplicate bullet ${mark.label}: all ${noun} labels (${range}) are in use. Delete one first.`);
        return false;
      }
      copy.label = label;
    }
    this.document.add(copy);
    this.selectedId = copy.id;
    this._render();
    this._setMessage(copy.type === 'bullet'
      ? `Duplicated bullet ${mark.label} as ${copy.label}, with its explanation`
      : `Duplicated ${TYPE_NAMES[copy.type] ?? 'mark'}`);
    return true;
  }

  /** Move the selected mark (or the selected legend) by screen pixels; a held key is one undo step. */
  nudgeSelected(dx, dy) {
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    if (!mark && this.legendSelected && this.document?.legend?.visible) return this._nudgeLegend(dx, dy);
    if (!mark) return false;
    const now = performance.now();
    if (this._nudge.id !== mark.id || now - this._nudge.at > NUDGE_MERGE_MS) this._nudge.run += 1;
    this._nudge.id = mark.id;
    this._nudge.at = now;
    const scale = this._scale();
    this.document.replace(mark.id, translateAnnotation(mark, dx / scale.x, dy / scale.y), {
      mergeKey: `nudge:${mark.id}:${this._nudge.run}`,
    });
    this._render();
    return true;
  }

  _nudgeLegend(dx, dy) {
    const doc = this.document;
    const now = performance.now();
    if (this._nudge.id !== 'legend' || now - this._nudge.at > NUDGE_MERGE_MS) this._nudge.run += 1;
    this._nudge.id = 'legend';
    this._nudge.at = now;
    const scale = this._scale();
    const layout = layoutLegend(doc.legend, doc.marks, this.measurer);
    doc.setLegend(moveLegend(doc.legend, dx / scale.x, dy / scale.y, doc.width, doc.height, layout.box.height), {
      mergeKey: `nudge:legend:${this._nudge.run}`,
    });
    this._render();
    return true;
  }

  /** Import a previously exported .redline.json object. */
  importData(data) {
    if (!data || data.format !== 'open-redline' || data.version !== 1 || !data.document) {
      throw new TypeError('This is not a supported redline document.');
    }
    if (!this.document) this.document = new RedlineDocument();
    // Loading validates everything first, then lays out every mark and the
    // legend with the live measurer; either failure throws without touching
    // the current document or its history.
    const report = this.document.load(data.document, { prepare: snapshot => this._prepareRender(snapshot) });
    this.cropView.cancel();
    this.textEditor.finish({ commit: false });
    this.legendEditor.cancel({ focus: false });
    this.gestures.cancel();
    this._syncViewport();
    this.sessionStartedAt = data.createdAt ?? new Date().toISOString();
    this.selectedId = null;
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this._bulletLimit = null;
    this._documentToken += 1;
    this._render({ force: true });
    return report;
  }

  /** Everything rendering needs from a document, computed without drawing. */
  _prepareRender(snapshot) {
    for (const mark of snapshot.annotations) markPrimitives(mark, this.measurer);
    prepareLegendLayout(snapshot, this.measurer);
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
    const token = this._documentToken;
    const data = JSON.parse(await file.text());
    // A draft restored (or another import finished) while the file was read wins.
    if (token !== this._documentToken) {
      this._setMessage('Import skipped: the session was replaced while the file was being read');
      return null;
    }
    const report = this.importData(data);
    const count = this.document.marks.length;
    const ignored = report?.ignoredFields ?? [];
    const summary = `Imported ${count} mark${count === 1 ? '' : 's'}`;
    if (ignored.length) {
      const detail = `${summary}; not supported and not kept: ${ignored.slice(0, 6).join(', ')}${ignored.length > 6 ? '…' : ''}`;
      this._setMessage(detail);
      this.options.setStatus(detail);
    } else {
      this._setMessage(summary);
    }
    return data;
  }

  async downloadJSON() {
    this.gestures.cancel();
    const data = await this.getExportData();
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), timestampName('redline.json'));
    this._setMessage('Redline data downloaded');
    return data;
  }

  async captureAnnotatedImage() {
    if (!this.document) throw new Error('Open redline mode before capturing.');
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    const snapshot = this.document.toJSON();
    const capture = await this._captureBaseImage();
    const canvas = composeAnnotatedCanvas(snapshot, capture.canvas, { measurer: this.measurer, includesCursor: capture.includesCursor });
    return { canvas, scope: capture.scope, snapshot, capture };
  }

  async copyImage() {
    this._setBusy(true, 'Capturing this tab…');
    try {
      const { canvas, scope } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      const result = await this._copyImageBlob(blob, scope);
      this._setMessage(result.message);
      return { blob, scope, copied: result.copied };
    } finally {
      this._setBusy(false);
    }
  }

  /** Put a PNG on the clipboard, or download it and say exactly why. */
  async _copyImageBlob(blob, scope = 'browser-tab') {
    const support = clipboardSupport();
    if (!support.api || !support.png) {
      downloadBlob(blob, timestampName('png'));
      return { copied: false, message: 'Clipboard images are unavailable in this browser; downloaded PNG instead.' };
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return { copied: true, message: scope === 'browser-tab' ? 'Annotated screenshot copied' : 'Annotated viewport fallback copied' };
    } catch (error) {
      console.warn('[Redline] Clipboard write was refused; downloading instead.', error);
      downloadBlob(blob, timestampName('png'));
      return { copied: false, message: `The clipboard refused the image (${clipboardReason(error)}); downloaded PNG instead.` };
    }
  }

  /**
   * Copy report: the annotated screenshot plus bullet explanations and notes as
   * text. `combined` first tries one clipboard item holding the PNG, HTML (with
   * the image embedded) and plain text. When the browser does not accept those
   * formats or refuses the write, or when `combined` is false, the report text
   * goes to the clipboard and the PNG is downloaded; if even text cannot be
   * copied, the text is downloaded too. The message says exactly what happened.
   */
  async copyReport({ combined = true } = {}) {
    this._setBusy(true, 'Capturing this tab…');
    try {
      const { canvas, snapshot } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      const result = await this._deliverReport({ canvas, blob, snapshot, combined });
      this._setMessage(result.message);
      this.options.setStatus(result.message);
      return result;
    } finally {
      this._setBusy(false);
    }
  }

  async _deliverReport({ canvas, blob, snapshot, combined }) {
    const page = (await Promise.resolve(this.options.describePage())) ?? {};
    const context = (await Promise.resolve(this.options.getContext())) ?? {};
    const createdAt = new Date().toISOString();
    const image = { width: canvas.width, height: canvas.height };
    const support = clipboardSupport();
    let refusal = null;
    if (combined) {
      const missing = [['image/png', support.png], ['text/html', support.html], ['text/plain', support.text]]
        .filter(([, ok]) => !ok).map(([type]) => type);
      if (!support.api) refusal = 'this browser has no clipboard write API';
      else if (missing.length) refusal = `the clipboard does not accept ${missing.join(' or ')} here`;
      else {
        const report = buildReport({ snapshot, page, context, image, createdAt, imageDataUrl: await blobToDataUrl(blob) });
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'image/png': blob,
            'text/html': new Blob([report.html], { type: 'text/html' }),
            'text/plain': new Blob([report.text], { type: 'text/plain' }),
          })]);
          const contents = report.bullets.length || report.notes.length ? reportCounts(report) : 'page details';
          return {
            image: 'clipboard', text: 'clipboard', combined: true, report,
            message: `Report copied: the screenshot and ${contents} together. If the app you paste into keeps only the text or only the image, use Copy report text + download PNG.`,
          };
        } catch (error) {
          console.warn('[Redline] The combined report copy was refused.', error);
          refusal = `the clipboard refused it: ${clipboardReason(error)}`;
        }
      }
    }
    const fileName = timestampName('png');
    const report = buildReport({ snapshot, page, context, image, createdAt, imageFileName: fileName });
    let text = 'none';
    let textError = null;
    if (support.api && support.text) {
      try {
        const item = { 'text/plain': new Blob([report.text], { type: 'text/plain' }) };
        if (support.html) item['text/html'] = new Blob([report.html], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem(item)]);
        text = 'clipboard';
      } catch (error) {
        textError = clipboardReason(error);
      }
    } else {
      textError = 'this browser cannot put text on the clipboard';
    }
    downloadBlob(blob, fileName);
    let textFile = null;
    if (text !== 'clipboard') {
      textFile = fileName.replace(/\.png$/, '-report.txt');
      downloadBlob(new Blob([report.text], { type: 'text/plain' }), textFile);
      text = 'download';
    }
    const message = text === 'clipboard'
      ? `Report text copied; screenshot downloaded as ${fileName}.${refusal ? ` (Image and text together were not copied: ${refusal}.)` : ''}`
      : `Clipboard unavailable (${textError}): downloaded the screenshot as ${fileName} and the report text as ${textFile}. Nothing was copied.`;
    return { image: 'download', text, combined: false, refusal, report, fileName, textFile, message };
  }

  /**
   * Export preview: capture once, compose exactly as an export does, and show
   * the result with its dimensions, legend and pointer. Exports from the
   * preview reuse that image. Focus returns to where it was when it closes,
   * and the overlay is visible again whether or not the capture succeeded.
   */
  async showExportPreview() {
    if (!this.document || this._busy || !this.active || this.pageMode) return false;
    const lifecycle = this._lifecycleToken;
    this._setBusy(true, 'Capturing an export preview…');
    let result;
    try {
      result = await this.captureAnnotatedImage();
    } catch (error) {
      this._setBusy(false);
      this._reportError(error, 'Could not preview the export');
      return false;
    }
    this._setBusy(false);
    if (!this.active || lifecycle !== this._lifecycleToken) return false;
    const returnFocus = this.root.getRootNode().activeElement;
    this.preview ??= new RedlinePreview({
      mount: this.options.mount,
      onAction: (name, detail) => this._onPreviewAction(name, detail).catch(error => {
        console.error('[Redline]', error);
        this.preview.setBusy(false);
        this.preview.setMessage(`Could not ${name}: ${error.message}`);
      }),
    });
    this._preview = { capture: result.capture, canvas: result.canvas, snapshot: result.snapshot };
    await this._withChildDialog(() => this.preview.show(this._previewContent(this._preview)));
    this._preview = null;
    if (this.active) {
      const target = returnFocus?.isConnected && !returnFocus.disabled && returnFocus.checkVisibility?.()
        ? returnFocus : this.toolbarUI.toolFocusTarget(this.tool);
      target?.focus({ preventScroll: true });
    }
    this._render({ force: true });
    return true;
  }

  _previewContent({ capture, canvas, snapshot }) {
    const doc = this.document;
    const parts = [`${canvas.width} × ${canvas.height} PNG`];
    parts.push(snapshot.crop ? `crop ${Math.round(snapshot.crop.width)} × ${Math.round(snapshot.crop.height)} CSS px` : 'full window');
    parts.push(`${(snapshot.outputScale ?? 1) * 100}% output`);
    parts.push(`${Math.round(capture.canvas.width / snapshot.width * 100) / 100}× screenshot pixels`);
    const bullets = snapshot.annotations.filter(mark => mark.type === 'bullet');
    const warnings = [];
    if (bullets.length && snapshot.legend?.visible) {
      parts.push(`legend with ${bullets.length} explanation${bullets.length === 1 ? '' : 's'}`);
      const layout = layoutLegend(snapshot.legend, snapshot.annotations, this.measurer);
      const clipping = legendClipping(layout.box, snapshot.width, snapshot.height, snapshot.crop ?? null);
      if (clipping.crop) warnings.push('Part of the legend lies outside the crop and is clipped in this image.');
      else if (clipping.viewport) warnings.push('Part of the legend lies past the window edge and is clipped in this image.');
      if (layout.overflows) warnings.push(`The legend’s fixed height hides ${layout.hiddenLines} line${layout.hiddenLines === 1 ? '' : 's'}; Copy report and JSON keep the full text.`);
    } else if (bullets.length) {
      parts.push('legend hidden');
      warnings.push(`The legend is hidden on the image; Copy report still lists the ${bullets.length} explanation${bullets.length === 1 ? '' : 's'} as text.`);
    }
    if (snapshot.cursor?.visible) {
      parts.push(capture.includesCursor ? 'real pointer in screenshot' : 'pointer included');
      if (!cursorInsideCrop(snapshot.cursor, snapshot.crop)) warnings.push('The pointer is outside the crop, so it does not appear in this image.');
    } else {
      parts.push('no pointer');
    }
    return {
      canvas,
      summary: parts.join(' · '),
      warnings,
      cursor: { included: Boolean(doc?.cursor?.visible) },
    };
  }

  async _onPreviewAction(name, detail) {
    const state = this._preview;
    if (!state || !this.preview) return;
    if (name === 'cursor') {
      const included = this._setCursorVisibility(Boolean(detail), { select: false });
      const snapshot = this.document.toJSON();
      state.snapshot = snapshot;
      state.canvas = composeAnnotatedCanvas(snapshot, state.capture.canvas, { measurer: this.measurer, includesCursor: state.capture.includesCursor });
      this.preview.update(this._previewContent(state));
      this.preview.setMessage(included.message);
      return;
    }
    this.preview.setBusy(true);
    try {
      const blob = await canvasToBlob(state.canvas);
      if (name === 'download') {
        const fileName = timestampName('png');
        downloadBlob(blob, fileName);
        this.preview.setMessage(`Downloaded this image as ${fileName}`);
      } else if (name === 'copy') {
        this.preview.setMessage((await this._copyImageBlob(blob)).message);
      } else if (name === 'report') {
        const result = await this._deliverReport({ canvas: state.canvas, blob, snapshot: state.snapshot, combined: true });
        this.preview.setMessage(result.message);
      }
    } finally {
      this.preview.setBusy(false);
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
      tabindex: '-1',
    });
    this.layer = new RedlineSvgLayer(this.svg, this.measurer);
    this.marksLayer = this.layer.marks;
    this.root.appendChild(this.svg);

    this.cropView = new RedlineCropView(this.root, {
      onChange: crop => {
        this.document.setCrop(crop);
        this._render();
        if (this.cropView.panel.hidden) this.toolbarUI.toolFocusTarget('crop')?.focus();
      },
      onScale: scale => {
        this.document.setOutputScale(scale);
        this.cropView.render();
        if (this.cropView.panel.hidden) this.toolbarUI.toolFocusTarget('crop')?.focus();
      },
      onDone: () => this._finishCrop(),
      onEdit: () => this.setTool('crop'),
    });

    this.toolbarUI = new RedlineToolbar({
      root: this.root,
      onCommand: (name, detail) => this._onToolbarCommand(name, detail),
    });
    this.grip = this.toolbarUI.grip;

    this.gestures = new RedlineGestures(this._gestureHost());
    const overlay = this;
    this.legendEditor = new RedlineLegendEditor({
      root: this.root,
      svg: this.svg,
      measurer: this.measurer,
      host: {
        get document() { return overlay.document; },
        get liveLegend() { return overlay.gestures.liveLegend; },
        get selectedId() { return overlay.selectedId; },
        get legendActive() { return overlay.legendSelected; },
        get pageMode() { return overlay.pageMode; },
        scale: () => this._scale(),
        onFinish: result => this._onExplanationFinished(result),
        onChange: () => this._render({ force: true }),
        keepsEditing: node => Boolean(node && this.toolbarUI.context.contains(node)
          && node.closest?.('[data-redline-control="legendStyle"], [data-redline-control="explanationActions"], [data-redline-control="legendToggle"]')),
        setMessage: text => this._setMessage(text),
        onInput: () => this._autosave?.schedule(),
      },
    });
    // The pointer proxy is drawn above the marks and the legend, as a real pointer is.
    this.cursorLayer = svgElement('svg', {
      'data-redline-cursor-layer': '', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
    });
    this.legendEditor.canvas.after(this.cursorLayer);
    // Leaving the explanation's own controls for anywhere else saves the edit.
    this.toolbarUI.context.addEventListener('focusout', event => {
      if (!this.legendEditor.active) return;
      const next = event.relatedTarget;
      queueMicrotask(() => {
        const active = this.root.getRootNode().activeElement;
        if (!this.legendEditor.active || this.legendEditor.owns(active) || this.legendEditor.host.keepsEditing(active)) return;
        if (next === null && !document.hasFocus()) return;
        this.legendEditor.commit({ focus: false });
      });
    });
    this.textEditor = new RedlineTextEditor({
      root: this.root,
      svg: this.svg,
      measurer: this.measurer,
      getDocument: () => this.document,
      onFinish: result => this._onTextEditFinished(result),
      onInput: () => this._autosave?.schedule(),
    });

    this.importInput = document.createElement('input');
    this.importInput.type = 'file';
    this.importInput.accept = '.json,.redline.json,application/json';
    this.importInput.hidden = true;
    this.importInput.setAttribute('aria-label', 'Import annotations');
    this.importInput.addEventListener('cancel', event => event.stopPropagation());
    this.importInput.addEventListener('change', () => {
      this._importFile(this.importInput.files?.[0]).catch(error => this._reportError(error, 'Could not import'));
    });
    this.root.appendChild(this.importInput);

    this._applyToolbarPosition();
    this.options.mount.appendChild(this.root);
    this._buildColorDialog();

    this.svg.addEventListener('pointerdown', event => this._onPointerDown(event));
    this.svg.addEventListener('pointermove', event => this._onPointerMove(event));
    this.svg.addEventListener('pointerup', event => this._onPointerUp(event));
    this.svg.addEventListener('pointercancel', event => this._onPointerUp(event, true));
    this.svg.addEventListener('pointerleave', () => this._trail.leave());
    // Anything above the drawing surface (toolbar, menus, editors, dialogs) is
    // not a meaningful pointer position, and crossing onto it forgets a pause.
    this.root.addEventListener('pointermove', event => {
      if (event.composedPath()[0] !== this.svg) this._trail.leave();
    }, true);
    this.svg.addEventListener('lostpointercapture', event => {
      if (this.gestures.pointer?.pointerId === event.pointerId) this.gestures.cancelPointer();
    });
    this.svg.addEventListener('dblclick', event => {
      this._onDoubleClick(event).catch(error => this._reportError(error));
    });
    this.root.addEventListener('pointerdown', event => {
      const path = event.composedPath();
      if (!path.some(node => node?.dataset && ('redlineMenu' in node.dataset || 'redlineMoreTools' in node.dataset || 'redlineMoreActions' in node.dataset))) {
        this.toolbarUI.closeMenus();
      }
      if (!this.textEditor.active || path.some(node => this.textEditor.contains(node))) return;
      this.textEditor.finish({ commit: true });
    }, true);
    this.grip.addEventListener('pointerdown', event => this._onToolbarPointerDown(event));
    this.grip.addEventListener('pointermove', event => this._onToolbarPointerMove(event));
    this.grip.addEventListener('pointerup', event => this._onToolbarPointerUp(event));
    this.grip.addEventListener('pointercancel', event => this._onToolbarPointerUp(event, true));
    this.root.addEventListener('cancel', event => {
      // A file input also fires a bubbling `cancel` when its chooser is
      // dismissed; only the dialog's own close request means Escape.
      if (event.target !== this.root) return;
      event.preventDefault();
      if (this.tool === 'crop') this._finishCrop();
      else this.close();
    });
  }

  _gestureHost() {
    const overlay = this;
    return {
      get document() { return overlay.document; },
      get tool() { return overlay.tool; },
      get selectedId() { return overlay.selectedId; },
      get legendEditor() { return overlay.legendEditor; },
      measurer: this.measurer,
      scale: () => this._scale(),
      placeBullet: point => this._placeBullet(point),
      activateLegend: () => {
        this.legendEditor.commit({ focus: false });
        this.legendSelected = true;
        this.selectedId = this.tool === 'select' ? null : this.selectedId;
        this.svg.focus({ preventScroll: true });
        this._render({ force: true });
      },
      editExplanation: (id, options) => this.editExplanation(id, options),
      styleFor: tool => this._styleFor(tool),
      select: id => { this.selectedId = id; },
      render: () => this._render(),
      setMessage: text => this._setMessage(text),
      commitPath: mark => {
        const added = this.document.add(mark);
        this.selectedId = added.id;
        this.setTool('select');
        this._render();
      },
      commitCursor: cursor => {
        this.document.setCursor(clampCursor(cursor, this.document.width, this.document.height));
        this.cursorSelected = true;
        if (this.cursorPlacing) this.endCursorPlacement();
        this._render({ force: true });
      },
      startTextBox: draft => {
        this.selectedId = null;
        this.textEditor.start({
          ...draft,
          fontSize: draft.fontSize ?? this.defaults.fontSize,
          backgroundOpacity: draft.backgroundOpacity ?? this.defaults.textBoxBackgroundOpacity,
        }, { creating: true });
        this._render();
        this._setMessage('Editing text — Save, click away, or Ctrl+Enter; Esc cancels');
      },
      createNote: point => {
        this._createNote(point).catch(error => this._reportError(error));
      },
    };
  }

  _onToolbarCommand(name, detail) {
    if (name === 'tool') return this.setTool(detail);
    if (name === 'mode') return this.setPageMode(detail === 'browse');
    if (name === 'style') return this._applyStyle(detail);
    if (name === 'color') return this._chooseColor(detail.target, detail.anchor).catch(error => this._reportError(error));
    if (name === 'noteMarker') {
      this.defaults.noteMarker = detail === 'alpha' ? 'alpha' : 'numeric';
      this._defaultsVersion += 1;
      this._savePreferences();
      return this._render();
    }
    if (name === 'bulletScheme') return this.setBulletScheme(detail);
    if (name === 'legend') {
      const changed = this.setLegendProperty(detail.property, detail.value);
      // Resync controls even when nothing changed (Place resets to "Move to…"),
      // and return the keyboard to an explanation edited mid-change.
      if (!changed) this._render({ force: true });
      this.legendEditor.focus();
      return changed;
    }
    if (name === 'legendSelect') {
      if (!this.document?.legend?.visible) return undefined;
      this.legendSelected = true;
      this.selectedId = this.tool === 'select' ? null : this.selectedId;
      this._render({ force: true });
      return this.toolbarUI.legendFontSizeSelect.focus({ preventScroll: true });
    }
    if (name !== 'action') return undefined;
    const actions = {
      explain: () => this.editExplanation(this.selectedId),
      explainCommit: () => this.legendEditor.commit(),
      explainCancel: () => this.legendEditor.cancel(),
      pin: () => this._toggleToolbarPin(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      delete: () => this.removeSelected(),
      duplicate: () => this.duplicateSelected(),
      clear: () => this.clear().catch(error => this._reportError(error)),
      import: () => this.chooseImport(),
      json: () => this.downloadJSON().catch(error => this._reportError(error)),
      copy: () => this.copyImage().catch(error => this._reportError(error)),
      report: () => this.copyReport().catch(error => this._reportError(error)),
      reportFallback: () => this.copyReport({ combined: false }).catch(error => this._reportError(error)),
      preview: () => this.showExportPreview().catch(error => this._reportError(error, 'Could not preview the export')),
      download: () => this.downloadImage().catch(error => this._reportError(error)),
      cursorToggle: () => this.setCursorIncluded(!this.document?.cursor?.visible),
      cursorPlace: () => this.startCursorPlacement(),
      cursorFollow: () => this.setCursorFollow(!this.cursorFollow),
      restoreDraft: () => this.restoreDraft().catch(error => this._reportError(error, 'Could not restore the draft')),
      discardDraft: () => this.discardDraft().catch(error => this._reportError(error, 'Could not discard the draft')),
      resumeRecovery: () => this.resumeRecovery(),
      close: () => this.close(),
    };
    return actions[detail]?.();
  }

  _buildColorDialog() {
    this.colorDialog = document.createElement('dialog');
    this.colorDialog.dataset.dialog = 'redline-color';
    this.colorDialog.setAttribute('aria-labelledby', 'redline-color-heading');

    this.colorHeading = document.createElement('h2');
    this.colorHeading.id = 'redline-color-heading';
    this.colorHeading.dataset.redlineColorHeading = '';
    this.colorDialog.appendChild(this.colorHeading);
    this.eyedropperButton = document.createElement('button');
    this.eyedropperButton.type = 'button';
    this.eyedropperButton.dataset.redlineEyedropperButton = '';
    this.eyedropperButton.textContent = 'Pick from page';
    this.eyedropperButton.title = 'Eyedropper — sample a color from the page';
    this.eyedropperButton.hidden = !this.options.capturePage && !this.options.captureFallback;
    appendIcon(this.eyedropperButton, 'eyedropper');
    this.eyedropperButton.addEventListener('click', () => this._samplePageColor());
    this.colorDialog.appendChild(this.eyedropperButton);

    this.colorPicker = this.options.createColorPicker();
    this.colorPicker.setAttribute('value', this.defaults.color);
    this.colorPicker.setAttribute('aria-label', 'Annotation color picker');
    this.colorPicker.addEventListener('wb-change', event => {
      if (!event.detail?.color || !this.colorDialog.open) return;
      this._settleColorDialog(this._styleFromPick(event.detail));
    });
    this.colorPicker.addEventListener('click', event => {
      if (!this.colorDialog.open) return;
      const swatch = event.composedPath().find(node => node instanceof Element && node.matches?.('[data-color]'));
      if (!swatch?.dataset.color) return;
      this._settleColorDialog(this._styleFromPick(swatch.dataset));
    });
    this.colorDialog.appendChild(this.colorPicker);
    // [extension patch] keep the color dialog inside the same (shadow) mount as the root.
    this.options.mount.appendChild(this.colorDialog);

    this.colorDialog.addEventListener('cancel', event => {
      event.preventDefault();
      this._settleColorDialog(null);
    });
    this.colorDialog.addEventListener('click', event => {
      if (event.target !== this.colorDialog) return;
      const rect = this.colorDialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) this._settleColorDialog(null);
    });
    // Escape or a click outside: nothing was picked. The close event arrives a
    // task later, so ignore one that lands after a new request reopened the dialog.
    this.colorDialog.addEventListener('close', () => {
      if (!this.colorDialog.open) this._settleColorDialog(null);
    });
  }

  /**
   * Resolve the open colour request as soon as a colour is picked, rather than
   * on the dialog's close event, which arrives a task later.
   */
  _settleColorDialog(style) {
    this.eyedropper?.cancel();
    const resolve = this._colorDialogResolve;
    this._colorDialogResolve = null;
    if (this.colorDialog.open) this.colorDialog.close(style ? 'apply' : 'cancel');
    resolve?.(style);
  }

  async _samplePageColor() {
    if (!this.active || !this.colorDialog.open || this.eyedropper?.active) return;
    const request = this._colorDialogResolve;
    const lifecycle = this._lifecycleToken;
    this.eyedropper ??= new RedlineEyedropper({
      mount: this.options.mount,
      capture: () => this._captureBaseImage(),
    });
    this.eyedropperButton.disabled = true;
    try {
      const color = await this._withChildDialog(() => this.eyedropper.pick());
      if (!this.active || lifecycle !== this._lifecycleToken || request !== this._colorDialogResolve) return;
      if (color) {
        this._settleColorDialog({ color, intent: null });
        this._setMessage('Picked ' + color + ' from the page');
      }
    } catch (error) {
      if (this.active && lifecycle === this._lifecycleToken && request === this._colorDialogResolve) {
        this._reportError(error, 'Could not pick a page color');
      }
    } finally {
      this.eyedropperButton.disabled = false;
      if (this.active && this.colorDialog.open && request === this._colorDialogResolve) {
        this.eyedropperButton.focus({ preventScroll: true });
      }
    }
  }

  /** A picked colour, with its intent when the pick carried one. */
  _styleFromPick(source) {
    if (!isHexColor(source.color)) return null;
    const style = { color: String(source.color) };
    if ('intent' in source) style.intent = source.intent ? String(source.intent) : null;
    return style;
  }

  async _withChildDialog(callback) {
    this._dialogDepth += 1;
    this.gestures.cancelPointer();
    try {
      return await callback();
    } finally {
      this._dialogDepth = Math.max(0, this._dialogDepth - 1);
    }
  }

  /**
   * What the style row edits: the selected mark while selecting, otherwise the
   * defaults of the active drawing tool.
   */
  _subject() {
    if (!this.document) return { kind: 'none' };
    const legend = this.document.legend;
    if (this.legendEditor.active) {
      const bullet = this.document.find(this.legendEditor.editingId);
      return {
        kind: 'explanation', type: 'bullet', label: bullet?.label ?? '', legend,
        hint: this.legendEditor.mode === 'card'
          ? 'Legend hidden: this card is for editing and is not exported · Ctrl+Enter saves · Esc cancels'
          : 'Ctrl+Enter saves · Esc cancels · Enter adds a line',
      };
    }
    if (this.cursorPlacing || (this.cursorSelected && this.document.cursor?.visible)) {
      return {
        kind: 'cursor', type: 'cursor', placing: this.cursorPlacing, follow: this.cursorFollow,
        hint: this.cursorPlacing
          ? 'Click where the pointer should point · arrow keys move it · Enter or Esc finishes'
          : 'Drag to move · arrow keys nudge (Shift ×10) · Delete leaves it out of exports · Esc deselects',
      };
    }
    if (this.legendSelected && legend?.visible) {
      return { kind: 'legend', type: 'bullet', legend, hint: 'Drag to move · handles resize · click a row to edit · arrow keys nudge' };
    }
    if (this.tool === 'select') {
      const mark = this.selectedId ? this.document.find(this.selectedId) : null;
      if (mark?.type === 'bullet') {
        return { kind: 'selection', type: mark.type, mark, style: mark, legend, hint: 'Double-click or Enter edits the explanation' };
      }
      if (mark) return { kind: 'selection', type: mark.type, mark, style: mark };
      return { kind: 'none', hint: 'Click a mark to select it · Shift+drag moves straight · arrow keys nudge' };
    }
    if (DRAWING_TOOLS.has(this.tool)) {
      const hints = {
        polyline: 'Click points · Enter or double-click finishes · Backspace removes a point · Esc cancels',
        polygon: 'Click 3+ points · Enter or double-click closes · Backspace removes a point · Esc cancels',
        bullet: legend?.visible
          ? 'Click to place a bullet and type its explanation · Ctrl+Enter saves'
          : 'Click to place a bullet · double-click a bullet to explain it',
      };
      const scheme = this.defaults.bulletScheme;
      return {
        kind: 'defaults', type: this.tool, style: this._styleFor(this.tool),
        noteMarker: this.defaults.noteMarker, hint: hints[this.tool],
        ...(this.tool === 'bullet' ? {
          scheme, legend, status: bulletLabelStatus(this.document.marks, scheme), limit: this._bulletLimit,
        } : {}),
      };
    }
    if (this.tool === 'eraser') return { kind: 'none', hint: 'Click or drag across marks to erase them · Ctrl+Z restores' };
    return { kind: 'none' };
  }

  /** Style fields every new mark of a tool starts with. */
  _styleFor(tool) {
    const d = this.defaults;
    const style = { type: tool, color: d.color, width: d.width };
    if (d.intent) style.intent = d.intent;
    if (CLOSED_TYPES.has(tool) && d.fillOpacity > 0) {
      style.fillOpacity = d.fillOpacity;
      if (d.fill) style.fill = d.fill;
      if (!d.outline) style.outline = false;
    } else if (CLOSED_TYPES.has(tool) && d.savedFill) {
      style.savedFill = { ...d.savedFill };
    }
    if (tool === 'brush') {
      style.width = d.brushWidth;
      style.opacity = d.brushOpacity;
    }
    if (LINE_TYPES.has(tool)) {
      const ends = d.ends[tool];
      if (ends.start !== 'none') style.startDecoration = ends.start;
      if (ends.end !== (tool === 'arrow' ? 'arrow' : 'none')) style.endDecoration = ends.end;
    }
    if (tool === 'textbox') {
      style.fontSize = d.fontSize;
      style.backgroundOpacity = d.textBoxBackgroundOpacity;
    }
    return style;
  }

  _storeDefaults(tool, style) {
    const d = this.defaults;
    d.color = style.color;
    d.intent = style.intent ?? null;
    if (tool === 'brush') {
      d.brushWidth = style.width;
      d.brushOpacity = style.opacity ?? d.brushOpacity;
    } else {
      d.width = style.width;
    }
    if (CLOSED_TYPES.has(tool)) {
      const fill = redlineMarkFill(style);
      d.fillOpacity = fill ? style.fillOpacity : 0;
      d.savedFill = style.savedFill ? { ...style.savedFill } : null;
      d.outline = style.outline !== false;
      if (fill) {
        d.fill = style.fill ?? null;
        d.lastFillOpacity = style.fillOpacity;
      }
    }
    // A straight line may have been renamed arrow (or back) by its ends; the
    // decorations are what the tool remembers.
    if (LINE_TYPES.has(tool)) d.ends[tool] = markDecorations(style);
    if (tool === 'textbox') {
      d.fontSize = style.fontSize ?? d.fontSize;
      d.textBoxBackgroundOpacity = style.backgroundOpacity ?? d.textBoxBackgroundOpacity;
    }
    this._defaultsVersion += 1;
  }

  /** Apply one style edit to exactly one target: the selection or the defaults. */
  _applyStyle(change) {
    const subject = this._subject();
    const value = change.property === 'treatment'
      ? { treatment: change.value, fillOpacity: this.defaults.lastFillOpacity }
      : change.value;
    const edit = { property: change.property, value };
    if (subject.kind === 'selection') {
      let next = applyStyleChange(subject.mark, edit);
      if (next === subject.mark) return false;
      if (next.type === 'textbox') next = fitTextBoxHeight(next, this.measurer);
      this.document.replace(subject.mark.id, next);
      this._render();
      return true;
    }
    if (subject.kind === 'defaults') {
      const next = applyStyleChange(subject.style, edit);
      if (next === subject.style) return false;
      this._storeDefaults(subject.type, next);
      // A path being drawn picks up the new style for its remaining clicks.
      if (this.gestures.draft?.type === subject.type) Object.assign(this.gestures.draft, this._styleFor(subject.type));
      this._savePreferences();
      this._render();
      return true;
    }
    return false;
  }

  async _chooseColor(target = 'stroke', anchor = null) {
    if (this.colorDialog.open) return false;
    // A cancelled native dialog may still have a queued close event. Settle
    // that request now so a quick reopen cannot lose the user's click.
    if (this._colorDialogResolve) this._settleColorDialog(null);
    const subject = this._subject();
    if (subject.kind === 'none') return false;
    const style = subject.style;
    const closed = CLOSED_TYPES.has(style.type);
    const fill = redlineMarkFill(style);
    const initial = target === 'fill' ? (fill?.color ?? style.fill ?? style.color) : style.color;
    const name = TYPE_NAMES[subject.type] ?? 'mark';
    const role = target === 'fill' ? 'Fill' : closed ? 'Outline' : style.type === 'textbox' ? 'Border' : 'Color';
    this.colorHeading.textContent = `${role}${role === 'Color' ? '' : ' color'} · ${subject.kind === 'selection' ? `selected ${name}` : `new ${name}s`}`;
    this._colorAnchor = anchor;
    // [extension patch] no registry means no upgrade to wait for.
    if (globalThis.customElements) await customElements.whenDefined('wb-color-picker');
    this.colorPicker.value = initial;
    if ('annotationStyle' in this.colorPicker) this.colorPicker.annotationStyle = { color: initial, intent: style.intent ?? null };
    this.colorDialog.returnValue = 'cancel';

    const picked = await this._withChildDialog(() => new Promise(resolve => {
      this._colorDialogResolve = resolve;
      this.colorDialog.showModal();
      this._positionColorDialog();
      this.colorPicker.initialFocus?.focus();
    }));
    this._colorAnchor?.focus?.({ preventScroll: true });
    if (!picked || !this.active) return false;
    // The pick names the mark's meaning only when it sets the colour people see
    // first: the outline, or the fill of a fill-only shape.
    const primary = target === 'fill' ? treatmentOf(style) === 'fill' : !(closed && treatmentOf(style) === 'fill');
    const value = { color: picked.color, fillOpacity: this.defaults.lastFillOpacity };
    if (primary && 'intent' in picked) value.intent = picked.intent;
    else if (primary) value.intent = null;
    return this._applyStyle({ property: target === 'fill' ? 'fillColor' : 'strokeColor', value });
  }

  _positionColorDialog() {
    if (!this.colorDialog?.open) return;
    const trigger = this._colorAnchor?.isConnected ? this._colorAnchor : this.toolbarUI.bar;
    const gutter = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    this.colorDialog.style.left = '0px';
    this.colorDialog.style.top = '0px';
    const dialogRect = this.colorDialog.getBoundingClientRect();
    const maxLeft = Math.max(gutter, window.innerWidth - dialogRect.width - gutter);
    const maxTop = Math.max(gutter, window.innerHeight - dialogRect.height - gutter);
    let left = triggerRect.left;
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

  _syncViewport() {
    if (!this.document) return;
    this.svg.setAttribute('viewBox', `0 0 ${this.document.width} ${this.document.height}`);
    this.cursorLayer.setAttribute('viewBox', `0 0 ${this.document.width} ${this.document.height}`);
    this.cropView.sync(this.document, this.tool === 'crop');
  }

  /** Document units to screen pixels, per axis. */
  _scale() {
    const rect = this.svg.getBoundingClientRect();
    const doc = this.document;
    if (!doc || !rect.width || !rect.height) return { x: 1, y: 1 };
    return { x: rect.width / doc.width, y: rect.height / doc.height };
  }

  _point(event) {
    const point = new DOMPoint(event.clientX, event.clientY)
      .matrixTransform(this.svg.getScreenCTM().inverse());
    return { x: point.x, y: point.y };
  }

  _onPointerDown(event) {
    if (event.button !== 0 || !this.document || this._busy || this.pageMode || this.tool === 'crop' || this._dialogDepth > 0) return;
    event.preventDefault();
    this.toolbarUI.closeMenus();
    const point = this._point(event);
    this._trackSurface(event, true);
    // Placing the pointer takes any press; the proxy itself is above everything.
    const cursor = this.document.cursor;
    if (this.cursorPlacing) {
      this._beginCursorDrag(event, point, { place: true });
      return;
    }
    if (cursor?.visible && !this.gestures.hasPathDraft && (this.tool === 'select' || this.cursorSelected)
      && cursorHitTest(cursor, point, this._scale())) {
      this._beginCursorDrag(event, point);
      return;
    }
    if (this.cursorSelected) {
      this.cursorSelected = false;
      this._render({ force: true });
    }
    // The legend sits above the marks, so it takes the press for every tool.
    const legendHit = this.gestures.hasPathDraft ? null : this.legendEditor.hitTest(point);
    if (legendHit) {
      if (this.textEditor.active) this.textEditor.finish({ commit: true });
      if (this.gestures.legendPointerDown(event, point, legendHit)) this.svg.setPointerCapture?.(event.pointerId);
      this._render();
      return;
    }
    if (this.legendEditor.active) this.legendEditor.commit({ focus: false });
    if (this.legendSelected) {
      this.legendSelected = false;
      this._render({ force: true });
    }
    // Drawing takes keyboard focus from the toolbar, so Enter finishes a path
    // and Delete removes a mark instead of activating the last-clicked button.
    this.svg.focus({ preventScroll: true });
    const captured = this.gestures.pointerDown(event, point);
    if (captured && this.gestures.pointer) this.svg.setPointerCapture?.(event.pointerId);
    this._render();
  }

  _onPointerMove(event) {
    if (!this.document || this.pageMode || this._busy) return;
    this._trackSurface(event, false);
    const point = this._point(event);
    this.gestures.pointerMove(event, point);
    if (!this.gestures.pointer) this._queueHover(point);
  }

  _onPointerUp(event, cancelled = false) {
    if (!this.document) return;
    this.gestures.pointerUp(event, cancelled ? null : this._point(event), { cancelled });
    if (this.svg.hasPointerCapture?.(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
  }

  /** Cursor feedback over marks and handles, at most once per frame. */
  _queueHover(point) {
    this._hoverPoint = point;
    if (this._hoverFrame) return;
    this._hoverFrame = requestAnimationFrame(() => {
      this._hoverFrame = null;
      const doc = this.document;
      if (!doc || this.gestures.pointer) return;
      const scale = this._scale();
      const tolerance = 6 / Math.min(scale.x, scale.y);
      const legend = this.gestures.hasPathDraft || this.tool === 'crop' ? null : this.legendEditor.hitTest(this._hoverPoint);
      let hover = null;
      const cursor = doc.cursor;
      if (cursor?.visible && !this.cursorPlacing && (this.tool === 'select' || this.cursorSelected)
        && cursorHitTest(cursor, this._hoverPoint, scale)) {
        hover = 'move';
      } else if (legend) {
        hover = legend.kind === 'handle' ? `resize-${legend.handle}`
          : legend.kind === 'row' || legend.kind === 'card' ? 'text' : 'move';
      } else if (this.tool === 'select' || this.tool === 'eraser') {
        const selected = this.selectedId ? doc.find(this.selectedId) : null;
        const handle = this.tool === 'select' ? this.gestures.handleAt(selected, this._hoverPoint) : null;
        const hit = handle ? null : topmostMarkAt(doc.marks, this._hoverPoint, tolerance, this.measurer);
        hover = handle ? `resize-${handle}` : hit ? (this.tool === 'eraser' ? 'erase' : 'move') : null;
      } else if (this.tool === 'bullet') {
        const bullets = doc.marks.filter(mark => mark.type === 'bullet');
        hover = topmostMarkAt(bullets, this._hoverPoint, tolerance, this.measurer) ? 'move' : null;
      }
      if (hover) this.svg.dataset.hover = hover;
      else this.svg.removeAttribute('data-hover');
    });
  }

  async _createNote(point) {
    const value = await this._withChildDialog(() => this.options.requestText('', { editing: false }));
    const text = value === null ? '' : String(value).trim();
    if (!this.active || !text || this.tool !== 'note') return;
    const d = this.defaults;
    this.document.add({
      id: cryptoId(), type: 'note', point, text,
      number: this._nextNoteNumber(d.noteMarker), marker: d.noteMarker,
      color: d.color, width: d.width,
      ...(d.intent ? { intent: d.intent } : {}),
    });
    this._render();
  }

  /**
   * Place a bullet with the lowest free label of the chosen scheme. With the
   * legend shown, its explanation opens for typing at once, and placing plus
   * typing is one undo step. A full scheme explains itself and places nothing.
   */
  _placeBullet(point) {
    const doc = this.document;
    const d = this.defaults;
    const limit = bulletLimit(doc.marks, d.bulletScheme);
    if (limit) {
      this._bulletLimit = limit;
      this._setMessage(limit.message);
      this.options.setStatus(limit.message);
      this._render({ force: true });
      return null;
    }
    this._bulletLimit = null;
    const id = cryptoId();
    const mergeKey = `bullet:${id}`;
    const added = doc.add({
      id, type: 'bullet', point, label: nextBulletLabel(doc.marks, d.bulletScheme),
      color: d.color, width: d.width, ...(d.intent ? { intent: d.intent } : {}),
    }, { mergeKey });
    if (doc.legend?.visible) {
      this.editExplanation(added.id, { creating: true, mergeKey });
    } else {
      this._render({ force: true });
      this._setMessage(`Placed bullet ${added.label} — double-click it to add an explanation`);
    }
    return added;
  }

  /**
   * Edit a bullet's explanation: in its legend row when the legend is shown,
   * otherwise in a card beside the bullet that is never exported. `point`
   * places the caret where a legend row was clicked.
   */
  editExplanation(id, { point = null, creating = false, mergeKey = null } = {}) {
    const bullet = id ? this.document?.find(id) : null;
    if (!bullet || bullet.type !== 'bullet' || !this.active || this.pageMode) return false;
    if (this.textEditor.active) this.textEditor.finish({ commit: true });
    if (this.legendEditor.editingId === id) {
      if (point) this.legendEditor.pointerDown(point);
      return true;
    }
    this.legendSelected = false;
    if (this.tool === 'select') this.selectedId = id;
    const mode = this.document.legend?.visible ? 'legend' : 'card';
    // The style row's hint says how to save and cancel.
    this._setMessage('');
    return this.legendEditor.start(id, { mode, point, creating, mergeKey });
  }

  _onExplanationFinished({ id, text, original, commit, mergeKey }) {
    const current = this.document?.find(id);
    if (commit && current && text !== original) {
      const { text: _previous, ...rest } = current;
      this.document.replace(id, text ? { ...rest, text } : rest, { mergeKey });
      this._setMessage(`Saved the explanation for bullet ${current.label}`);
    } else if (!commit && current) {
      this._setMessage(`Explanation edit cancelled for bullet ${current.label}`);
    }
    this._render({ force: true });
  }

  /** Numbers or letters for future bullets. Existing bullets keep their labels. */
  setBulletScheme(scheme) {
    const next = normalizeScheme(scheme);
    const changed = next !== this.defaults.bulletScheme;
    this.defaults.bulletScheme = next;
    this._bulletLimit = null;
    this._defaultsVersion += 1;
    if (changed) this._savePreferences();
    this._render({ force: true });
    if (changed) this._setMessage(`New bullets use ${BULLET_SCHEMES[next].range}; existing bullets keep their labels`);
    return changed;
  }

  /**
   * Change one legend setting as one undo step: visible, fontSize, fontFamily,
   * width, height ('auto' | 'fixed') or position (a corner name).
   */
  setLegendProperty(property, value) {
    const doc = this.document;
    if (!doc) return false;
    const current = doc.legend ?? defaultLegend(doc.width, doc.height);
    const shownHeight = () => layoutLegend(current, doc.marks, this.measurer).box.height;
    let next = { ...current };
    if (!doc.legend) next.y = this._legendTop(next);
    switch (property) {
      case 'visible':
        next.visible = Boolean(value);
        break;
      case 'fontSize':
        next.fontSize = Number(value);
        break;
      case 'fontFamily':
        next.fontFamily = String(value);
        break;
      case 'width':
        next.width = Math.max(LEGEND_MIN_WIDTH, Math.min(Number(value), doc.width - LEGEND_MARGIN));
        break;
      case 'height':
        next.height = value === 'auto' ? null : Math.ceil(current.height ?? shownHeight());
        break;
      case 'position': {
        if (!value) return false;
        const height = shownHeight();
        const right = doc.width - next.width - LEGEND_MARGIN;
        next.x = String(value).endsWith('left') ? LEGEND_MARGIN : right;
        next.y = String(value).startsWith('top') ? this._legendTop(next) : doc.height - height - LEGEND_MARGIN;
        next = moveLegend(next, 0, 0, doc.width, doc.height, height);
        break;
      }
      default:
        return false;
    }
    if (doc.legend && Object.keys(next).every(key => next[key] === doc.legend[key])) return false;
    try {
      doc.setLegend(next);
    } catch (error) {
      this._reportError(error, 'Could not change the legend');
      return false;
    }
    if (property === 'visible') {
      this.defaults.legendVisible = next.visible;
      this._savePreferences();
      if (!next.visible) this.legendSelected = false;
      this.legendEditor.setMode(next.visible ? 'legend' : 'card');
      const count = doc.marks.filter(mark => mark.type === 'bullet').length;
      this._setMessage(next.visible
        ? (count ? 'Legend shown' : 'Legend shown — place a bullet to add its explanation')
        : 'Legend hidden — explanations are kept, and exports show markers only');
    }
    this._render({ force: true });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pointer proxy

  /** Include or leave out the pointer proxy. Returns true when that changed. */
  setCursorIncluded(included) {
    if (!this.document) return false;
    const result = this._setCursorVisibility(included, { select: true });
    if (result.message) this._setMessage(result.message);
    this._render({ force: true });
    return result.changed;
  }

  _setCursorVisibility(included, { select }) {
    const doc = this.document;
    if (!included) {
      this.cursorPlacing = false;
      this.cursorSelected = false;
      if (!doc.cursor?.visible) return { changed: false, message: '' };
      doc.setCursor({ ...doc.cursor, visible: false });
      return { changed: true, message: 'Pointer left out of exports; its position is kept' };
    }
    if (doc.cursor?.visible) return { changed: false, message: '' };
    const last = this._trail.last;
    let message;
    if (doc.cursor) {
      doc.setCursor({ ...doc.cursor, visible: true });
      message = 'Pointer included at its previous position — drag it or use arrow keys to adjust';
    } else if (last) {
      doc.setCursor(clampCursor({ visible: true, x: last.fx * doc.width, y: last.fy * doc.height }, doc.width, doc.height));
      message = `Pointer included where you last ${last.reason === 'press' ? 'clicked' : 'paused'} — drag it or use arrow keys to adjust`;
    } else if (select && this.active && !this.pageMode) {
      this.startCursorPlacement();
      return { changed: true, message: '' };
    } else {
      doc.setCursor({ visible: true, x: doc.width / 2, y: doc.height / 2 });
      message = 'Pointer placed at the centre, since no pointer position was known — close the preview to move it';
    }
    if (select && this.active && !this.pageMode) {
      this.cursorSelected = true;
      this.legendSelected = false;
      if (this.tool === 'select') this.selectedId = null;
    }
    return { changed: true, message };
  }

  /**
   * Choose the pointer's position: the next press on the drawing surface puts
   * its hotspot there (and may drag on), arrow keys move it, Enter or Escape
   * finishes. Starts from the last meaningful position, or the centre.
   */
  startCursorPlacement() {
    const doc = this.document;
    if (!doc || !this.active || this.pageMode || this._busy) return false;
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    if (this.tool === 'crop') this.setTool(this._toolBeforeCrop);
    const last = this._trail.last;
    const start = doc.cursor ?? (last ? { x: last.fx * doc.width, y: last.fy * doc.height } : { x: doc.width / 2, y: doc.height / 2 });
    doc.setCursor(clampCursor({ visible: true, x: start.x, y: start.y }, doc.width, doc.height));
    this._placementFocus = this.root.getRootNode().activeElement;
    this.cursorPlacing = true;
    this.cursorSelected = true;
    this.cursorFollow = false;
    this.legendSelected = false;
    if (this.tool === 'select') this.selectedId = null;
    this.svg.focus({ preventScroll: true });
    this._render({ force: true });
    this._setMessage('Click where the pointer should point, or move it with arrow keys and press Enter');
    this.options.setStatus('Placing the pointer: click where it should point, or use arrow keys and Enter.');
    return true;
  }

  endCursorPlacement({ restoreFocus = false } = {}) {
    if (!this.cursorPlacing) return false;
    this.cursorPlacing = false;
    const cursor = this.document?.cursor;
    this._render({ force: true });
    if (cursor) this._setMessage(`Pointer placed at ${Math.round(cursor.x)}, ${Math.round(cursor.y)}`);
    if (restoreFocus) {
      const target = this._placementFocus?.isConnected && this._placementFocus.checkVisibility?.() ? this._placementFocus : null;
      target?.focus?.({ preventScroll: true });
    }
    this._placementFocus = null;
    return true;
  }

  setCursorFollow(follow) {
    this.cursorFollow = Boolean(follow);
    this._render({ force: true });
    this._setMessage(this.cursorFollow
      ? 'Pointer follows: it moves to where you next click or pause over the page'
      : 'Pointer frozen where it is');
    return this.cursorFollow;
  }

  /** Move the pointer by screen pixels. Explicit moves freeze it. */
  nudgeCursor(dx, dy) {
    const doc = this.document;
    if (!doc?.cursor?.visible) return false;
    const scale = this._scale();
    doc.setCursor(moveCursor(doc.cursor, dx / scale.x, dy / scale.y, doc.width, doc.height));
    this.cursorFollow = false;
    this._render({ force: true });
    return true;
  }

  _beginCursorDrag(event, point, { place = false } = {}) {
    const doc = this.document;
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    const original = place ? clampCursor({ visible: true, x: point.x, y: point.y }, doc.width, doc.height) : doc.cursor;
    this.cursorSelected = true;
    this.cursorFollow = false;
    this.legendSelected = false;
    if (this.tool === 'select') this.selectedId = null;
    this.svg.focus({ preventScroll: true });
    if (this.gestures.cursorPointerDown(event, point, original)) this.svg.setPointerCapture?.(event.pointerId);
    this._render({ force: true });
  }

  /** Record a drawing-surface position for the pointer trail. */
  _trackSurface(event, press) {
    if (!event.isTrusted) return;
    const rect = this.svg.getBoundingClientRect();
    const sample = { clientX: event.clientX - rect.left, clientY: event.clientY - rect.top, width: rect.width, height: rect.height };
    if (press) this._trail.press(sample);
    else this._trail.move(sample);
  }

  _onPagePointer(event) {
    // Annotate mode reports positions from the drawing surface itself.
    if ((this.active && !this.pageMode) || !event.isTrusted) return;
    const rootNode = this.root.getRootNode();
    const host = rootNode instanceof ShadowRoot ? rootNode.host : this.root;
    if (event.composedPath().includes(host)) {
      this._trail.leave();
      return;
    }
    const sample = { clientX: event.clientX, clientY: event.clientY, width: window.innerWidth, height: window.innerHeight };
    if (event.type === 'pointerdown') this._trail.press(sample);
    else this._trail.move(sample);
  }

  /** Whether a pointer sample is a meaningful position for the proxy. */
  _meaningfulPointer(sample) {
    const doc = this.document;
    if (!doc || !this.active || this.pageMode) return true;
    if (this.tool === 'crop' || this.cursorPlacing || this.textEditor.active || this._dialogDepth > 0 || this._busy) return false;
    if (this.gestures.pointer?.kind === 'cursor-move') return false;
    const point = { x: sample.clientX / sample.width * doc.width, y: sample.clientY / sample.height * doc.height };
    if (this.legendEditor.hitTest(point)) return false;
    return !(doc.cursor?.visible && cursorHitTest(doc.cursor, point, this._scale()));
  }

  _onPointerTrail(position) {
    const doc = this.document;
    if (!this.cursorFollow || !doc?.cursor?.visible || this.gestures.pointer?.kind === 'cursor-move') return;
    doc.setCursor(clampCursor({ visible: true, x: position.fx * doc.width, y: position.fy * doc.height }, doc.width, doc.height));
    // Closed or in Browse mode nothing renders, so schedule the draft directly.
    if (this.active && !this.pageMode) this._render();
    else this._autosave?.schedule();
  }

  // ---------------------------------------------------------------------------
  // Reload recovery

  _viewportContext() {
    return {
      width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX, scrollY: window.scrollY,
    };
  }

  /** The draft for the current session, including explanation or text edits not yet saved. */
  _draftSnapshot() {
    const json = this.document.toJSON();
    if (this.legendEditor.active) {
      const id = this.legendEditor.editingId;
      const text = this.legendEditor.input.value;
      json.annotations = json.annotations.map(mark => {
        if (mark.id !== id) return mark;
        const { text: _previous, ...rest } = mark;
        return text ? { ...rest, text } : rest;
      });
    }
    if (this.textEditor.active) {
      const editing = this.textEditor.mark;
      const text = this.textEditor.element.value.trim();
      if (editing && text) {
        const next = { ...JSON.parse(JSON.stringify(editing)), text };
        const index = json.annotations.findIndex(mark => mark.id === editing.id);
        if (index >= 0) json.annotations[index] = next;
        else json.annotations.push(next);
      }
    }
    return buildDraft({
      sessionId: this.sessionId, createdAt: this.sessionStartedAt, document: json,
      viewport: this._viewportContext(), ui: { cursorFollow: this.cursorFollow },
    });
  }

  /**
   * The host reports that the page changed address within the same document.
   * Drafts are keyed by address, so the session is saved again under the new
   * one (immediately when `now`, as the page unloads).
   */
  noteAddressChanged({ now = false } = {}) {
    if (!this._autosave || this._recovery.state !== 'idle' || this._recovery.paused) return;
    this._autosave.addressChanged({ now });
  }

  _recoveryState() {
    const recovery = this._recovery;
    const pending = recovery.pending;
    return {
      available: Boolean(this._autosave) && recovery.state !== 'unavailable',
      state: recovery.state,
      paused: recovery.paused,
      stored: recovery.stored,
      // The prompt itself describes the draft; the notice appears once it is dismissed.
      pending: pending && !this._promptingRecovery
        ? { savedTime: pending.summary.savedTime, markCount: pending.summary.markCount, contents: pending.summary.contents } : null,
    };
  }

  async _checkRecovery() {
    const recovery = this._recovery;
    recovery.state = 'checking';
    this._autosave?.pause();
    let stored;
    try {
      stored = await this.options.loadDraft();
    } catch (error) {
      console.warn('[Redline] Reload recovery is unavailable.', error);
      recovery.state = 'unavailable';
      this._setMessage(`Reload recovery is unavailable here: ${error?.message ?? error}`);
      this._render({ force: true });
      return;
    }
    let draft = null;
    let doc = null;
    if (stored) {
      try {
        draft = readDraft(stored);
        doc = new RedlineDocument();
        doc.load(draft.document, { prepare: snapshot => this._prepareRender(snapshot) });
      } catch (error) {
        console.warn('[Redline] Discarding an unreadable recovery draft.', error);
        draft = null;
        await Promise.resolve(this.options.discardDraft()).catch(() => {});
        this._setMessage('An unreadable reload-recovery draft was discarded');
      }
    }
    if (!draft || !draftHasContent(doc.toJSON())) {
      recovery.state = 'idle';
      recovery.stored = false;
      this._autosave.assume({ stored: false });
      this._autosave.resume();
      this._render({ force: true });
      return;
    }
    recovery.state = 'pending';
    recovery.stored = true;
    recovery.pending = { draft, doc, summary: describeDraft(draft, doc, this._viewportContext()) };
    this._autosave.assume({ stored: true });
    this._render({ force: true });
    if (this._canPromptRecovery()) await this._promptRecovery();
    else this._setMessage(`A draft saved at ${recovery.pending.summary.savedTime} is waiting — Restore or Discard it`);
  }

  _canPromptRecovery() {
    return this._recovery.state === 'pending' && Boolean(this.options.requestRecovery) && !this._promptingRecovery
      && this.active && !this.pageMode && !this._busy && this._dialogDepth === 0
      && !this.textEditor.active && !this.legendEditor.active && !this.gestures.pointer && !this.gestures.draft
      && !draftHasContent(this.document?.toJSON());
  }

  async _promptRecovery() {
    const pending = this._recovery.pending;
    if (!pending) return;
    this._promptingRecovery = true;
    this._render({ force: true });
    let result;
    try {
      const summary = describeDraft(pending.draft, pending.doc, this._viewportContext());
      result = await this._withChildDialog(() => this.options.requestRecovery(summary));
    } finally {
      this._promptingRecovery = false;
    }
    if (this._recovery.pending !== pending) {
      this._render({ force: true });
      return;
    }
    if (result?.choice === 'restore') {
      await this.restoreDraft({ scroll: result.scroll, confirmed: true });
    } else if (result?.choice === 'discard') {
      await this.discardDraft({ confirmed: true });
    } else {
      this._setMessage('Draft kept — Restore or Discard it from the style row or More actions');
      this.options.setStatus('Redline draft kept for later. New marks are not saved for reload recovery until you restore or discard it.');
      this._render({ force: true });
    }
  }

  /** Restore the waiting draft, replacing the current document (after confirmation if it has marks). */
  async restoreDraft({ scroll = false, confirmed = false } = {}) {
    const pending = this._recovery.state === 'pending' ? this._recovery.pending : null;
    if (!pending || this._busy) return false;
    const current = this.document?.toJSON();
    if (!confirmed && (draftHasContent(current) || this.textEditor.active || this.legendEditor.active)) {
      const count = current?.annotations.length ?? 0;
      const ok = await this._withChildDialog(() => this.options.confirm({
        title: 'Replace the current marks?',
        message: `Restoring the draft saved at ${pending.summary.savedTime} replaces the ${count} mark${count === 1 ? '' : 's'} now open. Undo cannot bring them back; download JSON first to keep them.`,
        confirmLabel: 'Replace',
      }));
      if (!ok || this._recovery.pending !== pending) return false;
    }
    this.cropView.cancel();
    this.textEditor.finish({ commit: false });
    this.legendEditor.cancel({ focus: false });
    this.gestures.cancel();
    if (!this.document) this.document = new RedlineDocument();
    try {
      this.document.load(pending.draft.document, { prepare: snapshot => this._prepareRender(snapshot) });
    } catch (error) {
      this._reportError(error, 'Could not restore the draft');
      return false;
    }
    this.sessionStartedAt = pending.draft.createdAt;
    this.cursorFollow = pending.draft.ui?.cursorFollow === true;
    this.selectedId = null;
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this._bulletLimit = null;
    this._documentToken += 1;
    this._recovery.state = 'idle';
    this._recovery.pending = null;
    if (scroll) window.scrollTo(pending.draft.viewport.scrollX, pending.draft.viewport.scrollY);
    this._autosave.resume();
    // Save at once, so this session takes over the restored draft's entry
    // before any navigation could leave the old one behind.
    this._autosave.schedule();
    this._autosave.flush();
    this._syncViewport();
    this._render({ force: true });
    const count = this.document.marks.length;
    const message = `Restored ${count} mark${count === 1 ? '' : 's'} saved at ${pending.summary.savedTime}. Marks keep their screen positions; adjust them if the page moved.`;
    this._setMessage(message);
    this.options.setStatus(message);
    return true;
  }

  /**
   * Discard the waiting draft, or, with none waiting, the current session's
   * stored draft, which also pauses reload recovery until resumed so the next
   * change does not store it again.
   */
  async discardDraft({ confirmed = false } = {}) {
    if (!this._autosave || this._busy) return false;
    const pending = this._recovery.state === 'pending' ? this._recovery.pending : null;
    if (!confirmed) {
      const ok = await this._withChildDialog(() => this.options.confirm(pending ? {
        title: 'Discard the waiting draft?',
        message: `Delete the draft saved at ${pending.summary.savedTime} (${pending.summary.contents}) It cannot be recovered afterwards.`,
        confirmLabel: 'Discard',
      } : {
        title: 'Discard the recovery draft?',
        message: 'Delete the reload-recovery copy of these marks? They stay open now, but reload recovery stays off for this page until you resume it.',
        confirmLabel: 'Discard',
      }));
      if (!ok || (pending && this._recovery.pending !== pending)) return false;
    }
    const wasPaused = this._autosave.paused;
    this._autosave.pause();
    this._setBusy(true, 'Discarding the recovery draft…');
    try {
      const result = await this._autosave.discard();
      if (result?.ok === false) {
        // A failed deletion must keep Restore available and must not be reported
        // as a successful discard. Resume existing autosaving only if it was on.
        if (!wasPaused) {
          this._autosave.resume();
          this._autosave.schedule();
        }
        return false;
      }
      let message;
      if (pending) {
        this._recovery.state = 'idle';
        this._recovery.pending = null;
        // Marks drawn while the decision was pending are saved from now on.
        this._autosave.resume();
        this._autosave.schedule();
        message = 'Draft discarded';
      } else {
        this._recovery.paused = true;
        message = 'Recovery draft discarded; reload recovery is paused for this page until you resume it';
      }
      this._recovery.stored = false;
      this._setMessage(message);
      this.options.setStatus(message);
      return true;
    } finally {
      this._setBusy(false);
    }
  }

  resumeRecovery() {
    if (!this._autosave || !this._recovery.paused) return false;
    this._recovery.paused = false;
    if (this._recovery.state !== 'pending') {
      this._autosave.resume();
      this._autosave.schedule();
    }
    this._setMessage('Reload recovery resumed');
    this._render({ force: true });
    return true;
  }

  _onDraftResult(result) {
    const recovery = this._recovery;
    const before = recovery.stored;
    if (result.ok) recovery.stored = result.operation === 'save';
    if (!result.ok) {
      const messages = {
        quota: 'Reload recovery could not save: the extension’s session storage is full. Your marks are still open; download JSON to keep them.',
        'too-large': 'This session is too large for reload recovery. Your marks are still open; download JSON to keep them.',
      };
      const message = result.operation === 'discard'
        ? `Could not discard the recovery draft (${result.error ?? result.code}). It is still kept and may be offered after reload; try again.`
        : messages[result.code]
          ?? `Reload recovery could not save (${result.error ?? result.code}). Your marks are still open; download JSON to keep them.`;
      const failure = `${result.operation}:${result.code}`;
      this._setMessage(message);
      if (recovery.failure !== failure) {
        recovery.failure = failure;
        this.options.setStatus(message);
      }
    } else if (result.ok && recovery.failure) {
      recovery.failure = null;
      this._setMessage('Reload recovery is saving again');
    }
    if (before !== recovery.stored && this.active) this._render({ force: true });
  }

  _onTextEditFinished({ mark, creating, commit, text, geometry }) {
    const saved = commit && Boolean(text);
    if (saved) {
      const next = fitTextBoxHeight({ ...mark, ...geometry, text }, this.measurer);
      if (creating) {
        const added = this.document.add(next);
        this.selectedId = added.id;
      } else if (text !== mark.text || next.end.x !== mark.end.x || next.end.y !== mark.end.y) {
        this.document.replace(mark.id, next);
      }
    } else if (creating) {
      this.selectedId = null;
    }
    if (saved && creating) this.setTool('select');
    this._render();
    if (saved) this._setMessage('Text box saved — double-click to edit');
    else if (!commit) this._setMessage('Text edit cancelled');
  }

  async _onDoubleClick(event) {
    if (this.pageMode || this._busy || !this.document) return;
    if (this.tool === 'polyline' || this.tool === 'polygon') {
      this.gestures.finishPath();
      return;
    }
    const point = this._point(event);
    const scale = this._scale();
    // Double-clicks on the legend select words; its pointer handling did that.
    if (this.legendEditor.hitTest(point)) return;
    if (this.tool === 'select' || this.tool === 'bullet') {
      const bullets = this.document.marks.filter(mark => mark.type === 'bullet');
      const bullet = topmostMarkAt(bullets, point, 6 / Math.min(scale.x, scale.y), this.measurer);
      if (bullet) {
        this.editExplanation(bullet.id);
        return;
      }
    }
    if (this.tool !== 'select') return;
    const textMarks = this.document.marks.filter(mark => mark.type === 'note' || mark.type === 'textbox');
    const textMark = topmostMarkAt(textMarks, point, 6 / Math.min(scale.x, scale.y), this.measurer);
    if (!textMark) return;
    if (textMark.type === 'textbox') {
      this.selectedId = textMark.id;
      this.textEditor.start(textMark);
      this._render();
      this._setMessage('Editing text — Save, click away, or Ctrl+Enter; Esc cancels');
      return;
    }
    const value = await this._withChildDialog(() => this.options.requestText(textMark.text, { editing: true }));
    const text = value === null ? '' : String(value).trim();
    const current = this.document.find(textMark.id);
    if (this.active && current && text && text !== current.text) {
      this.document.replace(current.id, { ...current, text });
      this._render();
    }
  }

  /**
   * The next ordinal for a note.
   *
   * Numbered and lettered notes run as separate sequences, so a document can
   * use digits for the main steps and letters for side callouts without one
   * pushing the other along.
   */
  _nextNoteNumber(marker = this.defaults.noteMarker) {
    const style = marker === 'alpha' ? 'alpha' : 'numeric';
    return this.document.marks.reduce((max, mark) => (
      mark.type === 'note' && (mark.marker === 'alpha' ? 'alpha' : 'numeric') === style
        ? Math.max(max, mark.number)
        : max
    ), 0) + 1;
  }

  _loadPreferences(saved) {
    if (!saved || typeof saved !== 'object') return;
    const d = this.defaults;
    const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
    if (saved.tool !== 'crop' && Object.hasOwn(TOOL_INFO, saved.tool)) this.tool = saved.tool;
    if (isHexColor(saved.color)) d.color = saved.color;
    if (isHexColor(saved.fill)) d.fill = saved.fill;
    if (unit(saved.fillOpacity)) d.fillOpacity = saved.fillOpacity;
    if (isHexColor(saved.savedFill?.color) && unit(saved.savedFill?.opacity) && saved.savedFill.opacity > 0) {
      d.savedFill = { color: saved.savedFill.color, opacity: saved.savedFill.opacity };
    }
    if (unit(saved.lastFillOpacity) && saved.lastFillOpacity > 0) d.lastFillOpacity = saved.lastFillOpacity;
    if (saved.outline === false && d.fillOpacity > 0) d.outline = false;
    if (typeof saved.intent === 'string' && saved.intent) d.intent = saved.intent.slice(0, 32);
    if (saved.noteMarker === 'alpha' || saved.noteMarker === 'numeric') d.noteMarker = saved.noteMarker;
    if (saved.bulletScheme === 'alpha' || saved.bulletScheme === 'numeric') d.bulletScheme = saved.bulletScheme;
    if (typeof saved.legendVisible === 'boolean') d.legendVisible = saved.legendVisible;
    if (Number.isFinite(saved.width) && saved.width >= 1 / 3) d.width = saved.width;
    if (Number.isFinite(saved.brushWidth) && saved.brushWidth > 0) d.brushWidth = saved.brushWidth;
    if (unit(saved.brushOpacity)) d.brushOpacity = saved.brushOpacity;
    // Old preferences described an opaque dark backing. Start the paper style
    // translucent once, then retain any new opacity the user explicitly chooses.
    if (saved.textBoxAppearance === 'paper' && unit(saved.textBoxBackgroundOpacity)) d.textBoxBackgroundOpacity = saved.textBoxBackgroundOpacity;
    if (Number.isFinite(saved.textBoxFontSize) && saved.textBoxFontSize >= 10 && saved.textBoxFontSize <= 96) d.fontSize = saved.textBoxFontSize;
    for (const tool of ['line', 'arrow', 'polyline']) {
      if (validEnds(saved[`${tool}Ends`])) d.ends[tool] = { start: saved[`${tool}Ends`].start, end: saved[`${tool}Ends`].end };
    }
    this.toolbarPinned = saved.toolbarPinned === true;
    if (Number.isFinite(saved.toolbarPosition?.left) && Number.isFinite(saved.toolbarPosition?.top)) {
      this.toolbarPosition = { left: saved.toolbarPosition.left, top: saved.toolbarPosition.top };
    }
  }

  _savePreferences() {
    const d = this.defaults;
    const preferences = {
      tool: this.tool === 'crop' ? this._toolBeforeCrop : this.tool,
      color: d.color, width: d.width, fill: d.fill, fillOpacity: d.fillOpacity, outline: d.outline,
      savedFill: d.savedFill ? { ...d.savedFill } : null,
      lastFillOpacity: d.lastFillOpacity, intent: d.intent, noteMarker: d.noteMarker,
      bulletScheme: d.bulletScheme, legendVisible: d.legendVisible,
      brushWidth: d.brushWidth, brushOpacity: d.brushOpacity,
      textBoxBackgroundOpacity: d.textBoxBackgroundOpacity, textBoxFontSize: d.fontSize,
      textBoxAppearance: 'paper',
      lineEnds: { ...d.ends.line }, arrowEnds: { ...d.ends.arrow }, polylineEnds: { ...d.ends.polyline },
      toolbarPinned: this.toolbarPinned,
      toolbarPosition: this.toolbarPosition ? { ...this.toolbarPosition } : null,
    };
    this._preferenceSave = this._preferenceSave
      .then(() => this.options.savePreferences(preferences))
      .catch(error => console.warn('[Redline] Could not save preferences.', error));
  }

  _applyToolbarPosition() {
    const dock = this.toolbarUI.dock;
    dock.toggleAttribute('data-pinned', this.toolbarPinned);
    if (!this.toolbarPosition) {
      dock.removeAttribute('data-positioned');
      dock.style.removeProperty('left');
      dock.style.removeProperty('top');
    } else {
      dock.dataset.positioned = '';
      dock.style.left = `${this.toolbarPosition.left}px`;
      dock.style.top = `${this.toolbarPosition.top}px`;
      this._clampToolbarPosition();
    }
    this.toolbarUI.positionContext();
    this.toolbarUI.menus.forEach(menu => menu.position());
    this._render();
  }

  _clampToolbarPosition() {
    const dock = this.toolbarUI.dock;
    if (!this.toolbarPosition || !dock.isConnected) return;
    const gutter = 6;
    const rect = this.toolbarUI.bar.getBoundingClientRect();
    const left = Math.min(Math.max(gutter, this.toolbarPosition.left), Math.max(gutter, window.innerWidth - rect.width - gutter));
    const top = Math.min(Math.max(gutter, this.toolbarPosition.top), Math.max(gutter, window.innerHeight - rect.height - gutter));
    this.toolbarPosition = { left, top };
    dock.style.left = `${left}px`;
    dock.style.top = `${top}px`;
  }

  _onToolbarPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = this.toolbarUI.dock.getBoundingClientRect();
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
    this._applyToolbarPosition();
  }

  _toggleToolbarPin() {
    this.toolbarPinned = !this.toolbarPinned;
    if (this.toolbarPinned) this.toolbarPosition = null;
    this._savePreferences();
    this._applyToolbarPosition();
    this.options.setStatus(this.toolbarPinned ? 'Toolbar pinned to the top-left.' : 'Toolbar unpinned. Drag the grip to move it.');
  }

  _onKeyUp(event) {
    if (!this.active) return;
    if (event.key === 'Shift') this.gestures.modifiersChanged(false);
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
    if (target === this.textEditor.element || this.legendEditor.owns(target)) return;
    const handled = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const menu = this.toolbarUI.menuContaining(target);
    if (menu) {
      if (event.key !== 'Tab') return;
      menu.close({ focusTrigger: false });
      menu.trigger.focus({ preventScroll: true });
    }
    if (event.key === 'Shift') {
      this.gestures.modifiersChanged(true);
      return;
    }
    if (this.cropView.handleKey(event, target)) return handled();
    if (event.key === 'Escape') {
      if (this.toolbarUI.closeMenus()) return handled();
      if (this.gestures.cancel()) {
        this._setMessage('Unfinished mark cancelled');
        return handled();
      }
      // An explanation edit whose focus moved to one of its own controls.
      if (this.legendEditor.cancel()) return handled();
      if (this.cursorPlacing) {
        this.endCursorPlacement({ restoreFocus: true });
        return handled();
      }
      if (this.cursorSelected) {
        this.cursorSelected = false;
        this._render({ force: true });
        return handled();
      }
      // Otherwise let the native modal dialog dispatch its cancel event.
      return undefined;
    }
    const editable = target?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (event.key === 'Enter' && this.cursorPlacing && !target?.matches?.('button, select, input, textarea, summary')) {
      this.endCursorPlacement({ restoreFocus: true });
      return handled();
    }
    if (event.key === 'Enter' && this.gestures.hasPathDraft && !target?.matches?.('button, select, input, textarea')) {
      this.gestures.finishPath();
      return handled();
    }
    // Chromium may move reverse-Tab from the first control into browser chrome
    // even for a modal dialog. Keep the toolbar's keyboard loop deterministic.
    if (event.key === 'Tab') {
      const focusable = [...this.root.querySelectorAll('button, input, select, summary, textarea, [tabindex]')]
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
        handled();
      }
      return undefined;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && key === 'z' && event.shiftKey) return (this.redo(), handled());
    if (ctrl && key === 'z') return (this.undo(), handled());
    if (ctrl && key === 'y') return (this.redo(), handled());
    if (ctrl && key === 'd' && !editable && this.tool === 'select' && this.selectedId) {
      this.duplicateSelected();
      return handled();
    }
    if (editable) return undefined;
    const selectedBullet = this.tool === 'select' && this.selectedId ? this.document?.find(this.selectedId) : null;
    if (event.key === 'Enter' && !ctrl && selectedBullet?.type === 'bullet' && !target?.matches?.('button, select, input, textarea, summary')) {
      this.editExplanation(selectedBullet.id);
      return handled();
    }
    if (!ctrl && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (this.gestures.hasPathDraft) this.gestures.removeLastPathPoint();
      else if (this.cursorSelected && this.document?.cursor?.visible) this.setCursorIncluded(false);
      else this.removeSelected();
      return handled();
    }
    const direction = NUDGE_KEYS[event.key];
    const inControls = target?.closest?.('[data-redline-context], [data-redline-crop-panel], [data-redline-text-controls]');
    const cursorMovable = (this.cursorSelected || this.cursorPlacing) && this.document?.cursor?.visible;
    if (direction && !ctrl && !event.altKey && cursorMovable && !inControls) {
      const step = event.shiftKey ? 10 : 1;
      this.nudgeCursor(direction[0] * step, direction[1] * step);
      return handled();
    }
    const legendMovable = this.legendSelected && this.document?.legend?.visible && !this.selectedId;
    if (direction && !ctrl && !event.altKey && ((this.tool === 'select' && this.selectedId) || legendMovable) && !inControls) {
      const step = event.shiftKey ? 10 : 1;
      this.nudgeSelected(direction[0] * step, direction[1] * step);
      return handled();
    }
    if (!ctrl && !event.altKey && !event.shiftKey && TOOL_KEYS[key]) {
      const focusedTool = target?.closest?.('[data-redline-tool], [data-redline-more-tools], [data-redline-more-actions]');
      this.setTool(TOOL_KEYS[key]);
      // Keep the focus ring on the tool that is now active, not the previous one.
      if (focusedTool) this.toolbarUI.toolFocusTarget(this.tool)?.focus({ preventScroll: true });
      return handled();
    }
    return undefined;
  }

  _render({ force = false } = {}) {
    if (!this.document) return;
    const doc = this.document;
    const live = this.gestures.live;
    const marks = live ? doc.marks.map(mark => (mark.id === live.id ? live : mark)) : [...doc.marks];
    if (this.gestures.draft) marks.push(this.gestures.draft);
    // Paint the editor only once: a second translucent SVG backing beneath it
    // would make the background more opaque and double the existing text.
    this.layer.render(this.textEditor.active
      ? marks.filter(mark => mark.id !== this.textEditor.mark.id)
      : marks);

    const selected = this.selectedId ? (live?.id === this.selectedId ? live : doc.find(this.selectedId)) : null;
    if (this.selectedId && !selected) this.selectedId = null;
    const editingSelected = this.textEditor.active && this.textEditor.mark?.id === this.selectedId;
    // The bullet whose explanation is open is outlined, linking it to its row.
    const explained = this.legendEditor.active ? doc.find(this.legendEditor.editingId) : null;
    if (this.legendEditor.active && !explained) this.legendEditor.refresh();
    this.layer.renderSelection(editingSelected ? null : selected ?? explained, {
      scale: this._scale(),
      handles: this.tool === 'select' && !this.gestures.pointer,
    });
    this.cropView.sync(doc, this.tool === 'crop');
    const recovery = this._recovery;
    const key = [
      this.tool, this.pageMode, Boolean(this._busy), this.toolbarPinned, doc.canUndo, doc.canRedo,
      this.selectedId, this._defaultsVersion, this.active, this.legendSelected, this.legendEditor.editingId,
      this.legendEditor.mode, this._bulletLimit?.message, this.cursorSelected, this.cursorPlacing, this.cursorFollow,
      Boolean(doc.cursor?.visible), recovery.state, recovery.paused, recovery.stored, Boolean(recovery.pending),
    ].join('|');
    const changed = doc.marks !== this._syncedMarks || doc.legend !== this._syncedLegend;
    if (force || key !== this._syncKey || changed) {
      this._syncKey = key;
      if (changed) {
        this._syncedMarks = doc.marks;
        this._syncedLegend = doc.legend;
        this._events.dispatchEvent(new CustomEvent('redline:changed', { detail: { count: doc.marks.length } }));
      }
      this._syncToolbar();
    }
    // The editor uses the final toolbar bounds to keep the caret unobscured.
    this.legendEditor.render();
    this._renderCursor();
    const draftKey = `${doc.revision}|${this._documentToken}|${this.cursorFollow}`;
    if (draftKey !== this._draftKey) {
      this._draftKey = draftKey;
      this._autosave?.schedule();
    }
  }

  /** The pointer proxy and, when selected, its frame. Rebuilt only when it changes. */
  _renderCursor() {
    const doc = this.document;
    const cursor = this.gestures.liveCursor ?? doc.cursor;
    const selected = Boolean(cursor?.visible && (this.cursorSelected || this.cursorPlacing));
    const scale = this._scale();
    this.svg.toggleAttribute('data-placing', this.cursorPlacing);
    const key = [cursor?.visible, cursor?.x, cursor?.y, selected, this.cursorPlacing, scale.x, scale.y].join('|');
    if (key === this._cursorKey) return;
    this._cursorKey = key;
    this.cursorLayer.replaceChildren();
    if (!cursor?.visible) return;
    this.cursorLayer.appendChild(renderPrimitives(cursorPrimitives(cursor), { 'data-redline-cursor': '' }));
    if (!selected) return;
    const box = cursorBounds(cursor);
    const padX = 5 / scale.x;
    const padY = 5 / scale.y;
    this.cursorLayer.appendChild(svgElement('rect', {
      'data-redline-selection': '', 'data-redline-selection-for': 'cursor',
      x: box.x - padX, y: box.y - padY, width: box.width + padX * 2, height: box.height + padY * 2,
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  _syncToolbar() {
    const doc = this.document;
    this.toolbarUI.sync({
      tool: this.tool,
      pageMode: this.pageMode,
      busy: Boolean(this._busy),
      pinned: this.toolbarPinned,
      canUndo: Boolean(doc?.canUndo),
      canRedo: Boolean(doc?.canRedo),
      count: doc?.marks.length ?? 0,
      hasSelection: Boolean(this.selectedId && this.tool === 'select'),
      subject: this._subject(),
      cursor: { included: Boolean(doc?.cursor?.visible), placing: this.cursorPlacing, follow: this.cursorFollow },
      recovery: this._recoveryState(),
    });
    for (const control of this.cropView.panel.querySelectorAll('button, select, input')) control.disabled = Boolean(this._busy);
  }

  _setBusy(busy, message = '') {
    this._busy = busy;
    this.root.toggleAttribute('data-busy', busy);
    this.cropView.cancel();
    if (busy) {
      this.gestures.cancel();
      this.toolbarUI.closeMenus();
      this._busyFocus = this.root.getRootNode().activeElement;
    }
    this._render({ force: true });
    if (message) this._setMessage(message);
    if (!busy) {
      if (this.active) {
        const focus = this._busyFocus?.isConnected && !this._busyFocus.disabled && this._busyFocus.checkVisibility?.()
          ? this._busyFocus : this.toolbarUI.toolFocusTarget(this.tool);
        focus?.focus({ preventScroll: true });
      }
      this._busyFocus = null;
    }
  }

  _setMessage(message) { this.toolbarUI?.setMessage(message); }

  _reportError(error, prefix = 'Could not export') {
    console.error('[Redline]', error);
    this._setMessage(`${prefix}: ${error.message}`);
    this.options.setStatus(`Redline: ${prefix.toLowerCase()} — ${error.message}`);
  }

  async _captureBaseImage() {
    return captureBaseImage({
      capturePage: this.options.capturePage,
      captureFallback: this.options.captureFallback,
      whileHidden: callback => this._whileHidden(callback),
    });
  }

  async _whileHidden(callback) {
    // Top-layer dialogs have their own visible style; hiding the shadow host
    // alone does not hide their painted surfaces.
    const nodes = [this.root, ...this.options.mount.querySelectorAll(
      'dialog[data-dialog="redline-color"][open], dialog[data-redline-preview][open], dialog[data-redline-eyedropper][open]',
    )];
    const prior = nodes.map(node => [node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
    for (const node of nodes) node.style.setProperty('visibility', 'hidden', 'important');
    try { return await callback(); }
    finally {
      for (const [node, value, priority] of prior) {
        if (value) node.style.setProperty('visibility', value, priority);
        else node.style.removeProperty('visibility');
      }
    }
  }
}
