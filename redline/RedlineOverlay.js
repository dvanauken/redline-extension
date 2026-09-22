import { RedlineDocument, cryptoId, translateAnnotation } from './RedlineDocument.js';
import { RedlineCropView } from './RedlineCropView.js';
import { clampCursor, cursorHitTest } from './RedlineCursor.js';
import { hitTestMark, markPrimitives, topmostMarkAt } from './RedlineGeometry.js';
import { RedlineGestures } from './RedlineGestures.js';
import { prepareLegendLayout } from './RedlineCanvas.js';
import {
  BULLET_SCHEMES, LEGEND_MARGIN, LEGEND_MIN_WIDTH, bulletLabelStatus, bulletLimit, bulletSchemeOf, defaultLegend,
  layoutLegend, moveLegend, nextBulletLabel, normalizeScheme,
} from './RedlineLegend.js';
import { RedlineLegendEditor } from './RedlineLegendEditor.js';
import { RedlineOverlayColor } from './RedlineOverlayColor.js';
import { RedlineOverlayCursor } from './RedlineOverlayCursor.js';
import { RedlineOverlayDock } from './RedlineOverlayDock.js';
import { RedlineOverlayExport } from './RedlineOverlayExport.js';
import { handleOverlayKeyDown } from './RedlineOverlayKeys.js';
import { RedlineOverlayRecovery } from './RedlineOverlayRecovery.js';
import { applyStyleChange } from './RedlineStyles.js';
import { RedlineSvgLayer, svgElement } from './RedlineSvg.js';
import { RedlineTextEditor } from './RedlineTextEditor.js';
import { createCanvasMeasurer, fitTextBoxHeight } from './RedlineTextLayout.js';
import { SHAPE_TEXT_TYPES, TEXT_CONTAINER_TYPES } from './RedlineShapeText.js';
import { RedlineToolbar, TOOL_INFO } from './RedlineToolbar.js';
import {
  DRAWING_TOOLS, MARK_NAMES, createToolDefaults, readPreferences, storeToolDefaults, styleForTool, writePreferences,
} from './RedlineToolDefaults.js';
import {
  DIRECT_SELECTION_TYPES, directPointAt, directSegmentAt, directSelectionPoints, handleCursor, insertDirectPoint,
  keepCornerInPlace, moveDirectPoint, removeDirectPoint,
} from './RedlineTransform.js';
import './vendor/wb/wb-color-picker/wb-color-picker.define.js';

const NUDGE_MERGE_MS = 800;

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
 * Reload recovery (see RedlineOverlayRecovery.js) needs the host's loadDraft,
 * saveDraft and discardDraft. Keyboard routing is in RedlineOverlayKeys.js and
 * the export actions are in RedlineOverlayExport.js; the methods here delegate.
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
    this.defaults = createToolDefaults();
    this.selectedId = null;
    /** Object mode transforms the whole mark; direct mode edits path vertices. */
    this.selectionMode = 'object';
    this.selectedVertex = null;
    /** The legend itself is selected: its frame, grip and handles show. */
    this.legendSelected = false;
    /** Why the last bullet could not be placed, until labels or scheme change. */
    this._bulletLimit = null;
    this.document = null;
    this.sessionStartedAt = null;
    this._events = new EventTarget();
    this._previousFocus = null;
    this._dialogDepth = 0;
    this.dock = new RedlineOverlayDock(this);
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
    this.recovery = new RedlineOverlayRecovery(this, { loadDraft, saveDraft, discardDraft, requestRecovery });
    this.exporter = new RedlineOverlayExport(this);
    this.pointerProxy = new RedlineOverlayCursor(this);
    this.measurer = createCanvasMeasurer();
    this._loadPreferences(preferences);
    this._buildDOM();

    this._boundKeyDown = event => this._onKeyDown(event);
    this._boundKeyUp = event => this._onKeyUp(event);
    this._boundResize = () => {
      this.cropView.cancel();
      this.gestures.cancelPointer();
      this._syncViewport();
      if (this.active) this.toolbarUI.layout();
      this.dock.apply();
      this.textEditor.position();
      if (this.color?.open) this.color.position();
      this._render({ force: true });
    };
    this._boundBlur = () => {
      this.gestures.cancelPointer();
      this.pointerProxy.trail.leave();
    };
    this._boundVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      this.gestures.cancelPointer();
      this.pointerProxy.trail.leave();
      this.recovery.flush();
    };
    // The page may be unloading: send the latest draft now rather than after a pause.
    this._boundPageHide = () => this.recovery.flushNow();
    // Pointer positions over the page itself, while Redline is closed or in
    // Browse mode. Passive and read-only: the page's own handling is untouched.
    this._boundPagePointer = event => this.pointerProxy.onPagePointer(event);
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
    this.recovery.stop();
    this.pointerProxy.trail.reset();
    this.exporter.destroy();
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
    this.color.destroy();
    if (this.root.open) this.root.close();
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
    this.dock.apply();
    this._render({ force: true });
    this.options.setStatus('Annotate mode — F2 switches to Browse; Esc closes without losing marks.');
    this._events.dispatchEvent(new CustomEvent('redline:opened'));
    this.toolbarUI.toolFocusTarget(this.tool)?.focus();
    this.recovery.onOpen();
  }

  close() {
    if (!this.active) return;
    this._lifecycleToken += 1;
    this.color.cancelEyedropper();
    this.options.dismissDialogs();
    this.exporter.closePreview();
    this.color.close();
    this.cropView.cancel();
    this.textEditor.finish({ commit: true });
    this.legendEditor.commit({ focus: false });
    this.gestures.cancel();
    this.toolbarUI.closeMenus();
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this.active = false;
    this.recovery.flush();
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
    this.pointerProxy.trail.leave();
    if (!enabled) this._pageFocus = document.activeElement;
    this.pageMode = enabled;
    this.root.close();
    this.root.toggleAttribute('data-page-mode', enabled);
    this.options.setPageLocked(!enabled);
    if (enabled) this.root.show();
    else this.root.showModal();
    this._syncViewport();
    this._render({ force: true });
    this.dock.apply();
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
    this._resetSelection();
    this._documentToken += 1;
    this._render({ force: true });
  }

  /** Nothing selected or being placed, for a document that was just replaced. */
  _resetSelection() {
    this.selectedId = null;
    this.legendSelected = false;
    this.cursorSelected = false;
    this.cursorPlacing = false;
    this._bulletLimit = null;
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
   * single toolbar strip when it sits above it. Before the toolbar has been
   * laid out, assume it is in its usual place.
   */
  _legendTop(frame, scale = this._scale()) {
    const bar = this.active ? this.toolbarUI.bar.getBoundingClientRect() : null;
    if (!bar?.width) return Math.round((10 + 46 + 10) / scale.y);
    const reserved = {
      left: bar.left,
      right: bar.right,
      top: bar.top,
      bottom: bar.bottom,
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
      if (tool !== 'select') {
        this.selectionMode = 'object';
        this.selectedVertex = null;
      }
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
      : `Duplicated ${MARK_NAMES[copy.type] ?? 'mark'}`);
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
    let next;
    if (this.selectionMode === 'direct' && this.selectedVertex !== null && DIRECT_SELECTION_TYPES.has(mark.type)) {
      const vertex = directSelectionPoints(mark)[this.selectedVertex];
      next = moveDirectPoint(mark, this.selectedVertex, vertex, {
        x: vertex.x + dx / scale.x, y: vertex.y + dy / scale.y,
      });
    } else {
      next = translateAnnotation(mark, dx / scale.x, dy / scale.y);
    }
    this.document.replace(mark.id, next, {
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
    this._resetSelection();
    this._documentToken += 1;
    this._render({ force: true });
    return report;
  }

  /** Everything rendering needs from a document, computed without drawing. */
  _prepareRender(snapshot) {
    for (const mark of snapshot.annotations) markPrimitives(mark, this.measurer);
    prepareLegendLayout(snapshot, this.measurer);
  }

  getExportData() { return this.exporter.getExportData(); }

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

  downloadJSON() { return this.exporter.downloadJSON(); }
  captureAnnotatedImage(options) { return this.exporter.captureAnnotatedImage(options); }
  copyImage() { return this.exporter.copyImage(); }
  copyFullPageImage() { return this.exporter.copyFullPageImage(); }
  downloadImage() { return this.exporter.downloadImage(); }
  /** Copy the annotated screenshot and a text report; see RedlineOverlayExport#copyReport. */
  copyReport(options) { return this.exporter.copyReport(options); }
  showExportPreview() { return this.exporter.showExportPreview(); }

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
        onInput: () => this.recovery.schedule(),
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
      onInput: () => this.recovery.schedule(),
      onChange: () => this._render({ force: true }),
      keepsEditing: () => this._dialogDepth > 0,
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

    this.dock.apply();
    this.options.mount.appendChild(this.root);
    this.color = new RedlineOverlayColor(this);

    this.svg.addEventListener('pointerdown', event => this._onPointerDown(event));
    this.svg.addEventListener('pointermove', event => this._onPointerMove(event));
    this.svg.addEventListener('pointerup', event => this._onPointerUp(event));
    this.svg.addEventListener('pointercancel', event => this._onPointerUp(event, true));
    this.svg.addEventListener('pointerleave', () => this.pointerProxy.trail.leave());
    // Anything above the drawing surface (toolbar, menus, editors, dialogs) is
    // not a meaningful pointer position, and crossing onto it forgets a pause.
    this.root.addEventListener('pointermove', event => {
      if (event.composedPath()[0] !== this.svg) this.pointerProxy.trail.leave();
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
      if (!this.textEditor.active || path.includes(this.svg) || path.some(node => this.textEditor.contains(node))) return;
      this.textEditor.finish({ commit: true });
    }, true);
    this.dock.attach(this.grip);
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
      get selectionMode() { return overlay.selectionMode; },
      get selectedVertex() { return overlay.selectedVertex; },
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
      select: id => {
        if (this.selectedId !== id) this.selectedVertex = null;
        this.selectedId = id;
      },
      selectVertex: index => { this.selectedVertex = index; },
      setSelectionMode: mode => this.setSelectionMode(mode),
      insertVertex: point => this.insertSelectedVertex(point),
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
    if (name === 'selectionMode') return this.setSelectionMode(detail);
    if (name === 'color') return this.color.choose(detail.target, detail.anchor).catch(error => this._reportError(error));
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
      pin: () => this.dock.togglePin(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      delete: () => this.removeSelected(),
      duplicate: () => this.duplicateSelected(),
      clear: () => this.clear().catch(error => this._reportError(error)),
      import: () => this.chooseImport(),
      json: () => this.downloadJSON().catch(error => this._reportError(error)),
      copy: () => this.copyImage().catch(error => this._reportError(error)),
      fullPage: () => this.copyFullPageImage().catch(error => this._reportError(error, 'Could not capture the full page')),
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
   * What the strip's contextual controls edit: the selected mark while selecting, otherwise the
   * defaults of the active drawing tool.
   */
  _subject() {
    if (!this.document) return { kind: 'none' };
    const legend = this.document.legend;
    if (this.textEditor.active) {
      const mark = this.textEditor.mark;
      return {
        kind: 'selection', type: mark.type, mark,
        style: { ...mark, ...this.textEditor.currentStyle() }, legend,
        hint: 'Editing text · drag to select · formatting applies to the selection · Ctrl+Enter saves · Esc cancels',
      };
    }
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
      if (mark?.type === 'rectangle') {
        return { kind: 'selection', type: mark.type, mark, style: mark, legend, hint: 'Start typing, press Enter, or double-click to edit its label' };
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
  _styleFor(tool) { return styleForTool(this.defaults, tool); }

  _storeDefaults(tool, style) {
    storeToolDefaults(this.defaults, tool, style);
    this._defaultsVersion += 1;
  }

  /** Apply one style edit to exactly one target: the selection or the defaults. */
  _applyStyle(change, { mergeKey = null, savePreferences = true } = {}) {
    const textProperties = new Set(['fontSize', 'fontFamily', 'textColor', 'bold', 'italic', 'underline', 'textAlign', 'verticalAlign']);
    if (this.textEditor.active && textProperties.has(change.property)) {
      const changed = this.textEditor.applyFormat(change.property, change.value);
      if (changed) this._render({ force: true });
      return changed;
    }
    const subject = this._subject();
    const value = change.property === 'treatment'
      ? { treatment: change.value, fillOpacity: this.defaults.lastFillOpacity }
      : change.value;
    const edit = { property: change.property, value };
    if (subject.kind === 'selection') {
      let next = applyStyleChange(subject.mark, edit);
      if (next === subject.mark) return false;
      if (next.type === 'textbox') next = keepCornerInPlace(next, fitTextBoxHeight(next, this.measurer));
      this.document.replace(subject.mark.id, next, { mergeKey });
      this._render();
      return true;
    }
    if (subject.kind === 'defaults') {
      const next = applyStyleChange(subject.style, edit);
      if (next === subject.style) return false;
      this._storeDefaults(subject.type, next);
      // A path being drawn picks up the new style for its remaining clicks.
      if (this.gestures.draft?.type === subject.type) Object.assign(this.gestures.draft, this._styleFor(subject.type));
      if (savePreferences) this._savePreferences();
      this._render();
      return true;
    }
    return false;
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
    if (this.textEditor.active) {
      const editing = this.textEditor.mark;
      const tolerance = 6 / Math.min(this._scale().x, this._scale().y);
      if (editing && hitTestMark(editing, point, tolerance, this.measurer)) {
        this._textPointerId = event.pointerId;
        this.textEditor.pointerDown(point, { shiftKey: event.shiftKey });
        this.svg.setPointerCapture?.(event.pointerId);
        this._render({ force: true });
        return;
      }
      this.textEditor.finish({ commit: true });
    }
    this.pointerProxy.trackSurface(event, true);
    // Placing the pointer takes any press; the proxy itself is above everything.
    const cursor = this.document.cursor;
    if (this.cursorPlacing) {
      this.pointerProxy.beginDrag(event, point, { place: true });
      return;
    }
    if (cursor?.visible && !this.gestures.hasPathDraft && (this.tool === 'select' || this.cursorSelected)
      && cursorHitTest(cursor, point, this._scale())) {
      this.pointerProxy.beginDrag(event, point);
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
    this.pointerProxy.trackSurface(event, false);
    const point = this._point(event);
    if (this._textPointerId === event.pointerId && this.textEditor.active) {
      this.textEditor.pointerDrag(point);
      this._render({ force: true });
      return;
    }
    this.gestures.pointerMove(event, point);
    if (!this.gestures.pointer) this._queueHover(point);
  }

  _onPointerUp(event, cancelled = false) {
    if (!this.document) return;
    if (this._textPointerId === event.pointerId) {
      this._textPointerId = null;
      this.textEditor.pointerUp();
      if (this.svg.hasPointerCapture?.(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
      this._render({ force: true });
      return;
    }
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
        const direct = this.tool === 'select' && this.selectionMode === 'direct' && DIRECT_SELECTION_TYPES.has(selected?.type);
        const pointHandle = direct ? directPointAt(selected, this._hoverPoint, { scale }) : null;
        const segment = direct ? directSegmentAt(selected, this._hoverPoint, { scale }) : null;
        const handle = this.tool === 'select' && !direct ? this.gestures.handleAt(selected, this._hoverPoint) : null;
        const hit = handle ? null : topmostMarkAt(doc.marks, this._hoverPoint, tolerance, this.measurer);
        hover = pointHandle !== null ? 'endpoint' : segment ? 'point-insert'
          : handle ? handleCursor(selected, handle, scale) : hit ? (this.tool === 'eraser' ? 'erase' : direct ? 'default' : 'move') : null;
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
    // The contextual status text says how to save and cancel.
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
  // Pointer proxy (RedlineOverlayCursor.js)

  /** Include or leave out the pointer proxy. Returns true when that changed. */
  setCursorIncluded(included) { return this.pointerProxy.setIncluded(included); }
  startCursorPlacement() { return this.pointerProxy.startPlacement(); }
  endCursorPlacement(options) { return this.pointerProxy.endPlacement(options); }
  setCursorFollow(follow) { return this.pointerProxy.setFollow(follow); }
  nudgeCursor(dx, dy) { return this.pointerProxy.nudge(dx, dy); }

  // ---------------------------------------------------------------------------
  // Reload recovery (RedlineOverlayRecovery.js)

  /** The host reports a same-document address change; the draft follows it. */
  noteAddressChanged(options) { this.recovery.noteAddressChanged(options); }
  restoreDraft(options) { return this.recovery.restore(options); }
  discardDraft(options) { return this.recovery.discard(options); }
  resumeRecovery() { return this.recovery.resume(); }

  _onTextEditFinished({ mark, preview, creating, commit, text }) {
    const saved = commit && (Boolean(text) || (!creating && mark.type === 'textbox'));
    if (saved) {
      let next = { ...preview, text };
      if (mark.type === 'textbox') next = keepCornerInPlace(next, fitTextBoxHeight(next, this.measurer));
      if (creating) {
        const added = this.document.add(next);
        this.selectedId = added.id;
      } else if (JSON.stringify(next) !== JSON.stringify(mark)) {
        this.document.replace(mark.id, next);
      }
    } else if (commit && !creating && SHAPE_TEXT_TYPES.has(mark.type)) {
      const next = { ...mark };
      for (const field of ['text', 'fontSize', 'fontFamily', 'textColor', 'bold', 'italic', 'underline', 'textAlign', 'verticalAlign', 'textRuns']) delete next[field];
      this.document.replace(mark.id, next);
    } else if (creating) {
      this.selectedId = null;
    }
    if (saved && creating) this.setTool('select');
    this._render();
    if (saved) this._setMessage(`${mark.type === 'textbox' ? 'Text box' : 'Shape text'} saved — double-click to edit`);
    else if (!commit) this._setMessage('Text edit cancelled');
    else this._setMessage('Shape text removed');
  }

  _startDirectTextEdit(mark, { initialText = null } = {}) {
    if (!mark || !TEXT_CONTAINER_TYPES.has(mark.type) || this.textEditor.active) return false;
    this.selectedId = mark.id;
    this.textEditor.start(mark, { initialText });
    this._render();
    this._setMessage(mark.type === 'textbox'
      ? 'Editing text — select text to format it; Ctrl+Enter or click away saves; Esc cancels'
      : `Editing ${mark.type} text — it wraps to the live contour; select text to format it; Ctrl+Enter saves`);
    return true;
  }

  setSelectionMode(mode) {
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    const direct = mode === 'direct' && DIRECT_SELECTION_TYPES.has(mark?.type);
    this.selectionMode = direct ? 'direct' : 'object';
    this.selectedVertex = null;
    this._render({ force: true });
    this._setMessage(direct
      ? 'Direct selection — drag white points · Ctrl+click or double-click a segment to insert · Delete removes a point · V returns to object selection'
      : 'Object selection — green handles resize · center handle moves · rotation handle turns · V edits points');
    return direct;
  }

  insertSelectedVertex(point) {
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    if (this.selectionMode !== 'direct' || !mark) return false;
    const inserted = insertDirectPoint(mark, point, { scale: this._scale() });
    if (!inserted) return false;
    this.document.replace(mark.id, inserted.mark);
    this.selectedVertex = inserted.index;
    this._render({ force: true });
    this._setMessage(`Inserted point ${inserted.index + 1} · drag it to refine the contour`);
    return true;
  }

  removeSelectedVertex() {
    const mark = this.selectedId ? this.document?.find(this.selectedId) : null;
    if (this.selectionMode !== 'direct' || !mark || this.selectedVertex === null) return false;
    const next = removeDirectPoint(mark, this.selectedVertex);
    if (!next) {
      this._setMessage(mark.type === 'polygon' ? 'A polygon must keep at least three points' : 'A path must keep at least two points');
      return false;
    }
    this.document.replace(mark.id, next);
    this.selectedVertex = Math.min(this.selectedVertex, next.points.length - 1);
    this._render({ force: true });
    return true;
  }

  async _onDoubleClick(event) {
    if (this.pageMode || this._busy || !this.document) return;
    if (this.tool === 'polyline' || this.tool === 'polygon') {
      this.gestures.finishPath();
      return;
    }
    const point = this._point(event);
    const scale = this._scale();
    if (this.tool === 'select' && this.selectionMode === 'direct' && this.selectedId) {
      const selected = this.document.find(this.selectedId);
      if (directSegmentAt(selected, point, { scale })) {
        this.insertSelectedVertex(point);
        return;
      }
    }
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
    const textMarks = this.document.marks.filter(mark => mark.type === 'note' || TEXT_CONTAINER_TYPES.has(mark.type));
    const textMark = topmostMarkAt(textMarks, point, 6 / Math.min(scale.x, scale.y), this.measurer);
    if (!textMark) return;
    if (TEXT_CONTAINER_TYPES.has(textMark.type)) {
      this._startDirectTextEdit(textMark);
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
    const { tool, toolbarPinned, toolbarPosition } = readPreferences(saved, this.defaults, { isTool: name => Object.hasOwn(TOOL_INFO, name) });
    if (tool) this.tool = tool;
    if (saved && typeof saved === 'object') {
      this.dock.pinned = toolbarPinned;
      if (toolbarPosition) this.dock.position = toolbarPosition;
    }
  }

  _savePreferences() {
    const preferences = writePreferences(this.defaults, {
      tool: this.tool === 'crop' ? this._toolBeforeCrop : this.tool,
      toolbarPinned: this.dock.pinned,
      toolbarPosition: this.dock.position,
    });
    this._preferenceSave = this._preferenceSave
      .then(() => this.options.savePreferences(preferences))
      .catch(error => console.warn('[Redline] Could not save preferences.', error));
  }

  _onKeyUp(event) {
    if (!this.active) return;
    if (event.key === 'Shift') this.gestures.modifiersChanged(false);
  }

  _onKeyDown(event) { handleOverlayKeyDown(this, event); }

  _render({ force = false } = {}) {
    if (!this.document) return;
    const doc = this.document;
    const live = this.gestures.live;
    const marks = live ? doc.marks.map(mark => (mark.id === live.id ? live : mark)) : [...doc.marks];
    if (this.gestures.draft) marks.push(this.gestures.draft);
    // Paint the editor only once: a second translucent SVG backing beneath it
    // would make the background more opaque and double the existing text.
    let paintedMarks = marks;
    if (this.textEditor.active) {
      const editing = this.textEditor.mark;
      paintedMarks = marks.map(mark => mark.id === editing.id ? editing : mark);
      if (this.textEditor.creating && !paintedMarks.some(mark => mark.id === editing.id)) paintedMarks.push(editing);
    }
    this.layer.render(paintedMarks);
    this.layer.renderTextEditing(this.textEditor.active ? this.textEditor.mark : null, {
      start: this.textEditor.selectionStart,
      end: this.textEditor.selectionEnd,
      focused: this.textEditor.active,
    });

    const selected = this.selectedId ? (live?.id === this.selectedId ? live : doc.find(this.selectedId)) : null;
    if (this.selectedId && !selected) this.selectedId = null;
    const editingSelected = this.textEditor.active && this.textEditor.mark?.id === this.selectedId;
    // The bullet whose explanation is open is outlined, linking it to its row.
    const explained = this.legendEditor.active ? doc.find(this.legendEditor.editingId) : null;
    if (this.legendEditor.active && !explained) this.legendEditor.refresh();
    this.layer.renderSelection(editingSelected ? null : selected ?? explained, {
      scale: this._scale(),
      handles: this.tool === 'select' && !this.gestures.pointer,
      bounds: doc,
      mode: this.selectionMode,
      selectedVertex: this.selectedVertex,
    });
    this.cropView.sync(doc, this.tool === 'crop');
    const key = [
      this.tool, this.pageMode, Boolean(this._busy), this.dock.pinned, doc.canUndo, doc.canRedo,
      this.selectedId, this._defaultsVersion, this.active, this.legendSelected, this.legendEditor.editingId,
      this.legendEditor.mode, this._bulletLimit?.message, this.cursorSelected, this.cursorPlacing, this.cursorFollow,
      Boolean(doc.cursor?.visible), this.recovery.renderKey(),
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
    this.pointerProxy.render();
    const draftKey = `${doc.revision}|${this._documentToken}|${this.cursorFollow}`;
    if (draftKey !== this._draftKey) {
      this._draftKey = draftKey;
      this.recovery.schedule();
    }
  }

  _syncToolbar() {
    const doc = this.document;
    this.toolbarUI.sync({
      tool: this.tool,
      pageMode: this.pageMode,
      busy: Boolean(this._busy),
      pinned: this.dock.pinned,
      canUndo: Boolean(doc?.canUndo),
      canRedo: Boolean(doc?.canRedo),
      count: doc?.marks.length ?? 0,
      hasSelection: Boolean(this.selectedId && this.tool === 'select'),
      selectionMode: this.selectionMode,
      subject: this._subject(),
      cursor: { included: Boolean(doc?.cursor?.visible), placing: this.cursorPlacing, follow: this.cursorFollow },
      recovery: this.recovery.toolbarState(),
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
}
