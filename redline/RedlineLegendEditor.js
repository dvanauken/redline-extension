/**
 * The live legend surface and its explanation editor.
 *
 * Everything the user sees of the legend, including the text being edited, its
 * caret, selection and composition underline, is drawn into one <canvas> with
 * `drawLegend`, the function the PNG export uses. A visually hidden <textarea>
 * inside the same closed shadow root owns keyboard input, IME composition, the
 * clipboard and accessibility; it is never visible and never positioned where it
 * can take a pointer. Its value and selection are the editing state.
 *
 * Keys: Ctrl/Cmd+Enter saves; Escape cancels the edit (not Redline); Enter adds
 * a line; ArrowUp/Down and Home/End follow the lines drawn on the canvas; Tab
 * saves and leaves. While an IME is composing, every key belongs to it. Typing
 * never reaches drawing shortcuts or page keyboard handlers.
 *
 * Moving focus elsewhere on the page saves, as the ordinary text box does, but
 * switching windows keeps the edit open.
 *
 * Rendering is cheap on purpose: a caret blink redraws from a cached layout;
 * a keystroke re-wraps only the legend's own rows and never touches the
 * document or its history until the edit ends.
 */

import {
  EXPLANATION_MAX_LENGTH, caretPoint, drawLegend, explanationCardFrame, indexAtPoint, layoutLegend, layoutLegendFrame,
  legendClipping, legendEditingViewport, legendHitTest, lineEdge, paragraphRangeAt, verticalCaretMove, wordRangeAt,
} from './RedlineLegend.js';

const BLINK_MS = 530;
const MULTI_CLICK_MS = 450;
const MULTI_CLICK_DISTANCE = 5;

export class RedlineLegendEditor {
  /**
   * host: {
   *   document, liveLegend, selectedId, legendActive, pageMode  (getters)
   *   scale(): document→CSS pixel factors { x, y }
   *   onFinish({ id, text, original, commit, creating, mergeKey }): the edit ended
   *   onChange(): the session started, ended or changed mode
   *   keepsEditing(node): true for controls that may take focus mid-edit
   *   onInput(): the text being edited changed (not yet saved)
   *   setMessage(text)
   * }
   */
  constructor({ root, svg, measurer, host }) {
    this.root = root;
    this.svg = svg;
    this.measurer = measurer;
    this.host = host;
    this.session = null;
    this._caretOn = true;
    this._blink = null;
    this._cache = null;
    this._clicks = { count: 0, at: 0, point: null };

    this.canvas = document.createElement('canvas');
    this.canvas.dataset.redlineLegendCanvas = '';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Legend hidden');
    this.ctx = this.canvas.getContext('2d');
    svg.after(this.canvas);

    const input = document.createElement('textarea');
    input.dataset.redlineLegendInput = '';
    input.tabIndex = -1;
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-multiline', 'true');
    input.setAttribute('aria-label', 'Bullet explanation');
    input.setAttribute('aria-description', 'Ctrl+Enter saves, Escape cancels');
    input.wrap = 'off';
    this.input = input;
    root.appendChild(input);

    const stop = event => { if (this.session) event.stopPropagation(); };
    input.addEventListener('keydown', event => this._onKeyDown(event));
    for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut']) {
      input.addEventListener(type, stop);
    }
    input.addEventListener('keyup', () => this._sync());
    input.addEventListener('select', () => this._sync());
    input.addEventListener('selectionchange', () => this._sync());
    input.addEventListener('input', event => this._onInput(event));
    input.addEventListener('compositionstart', () => {
      if (!this.session) return;
      this.session.composition = { start: input.selectionStart, end: input.selectionStart };
      this.render();
    });
    input.addEventListener('compositionupdate', event => {
      if (!this.session?.composition) return;
      this.session.composition.end = this.session.composition.start + String(event.data ?? '').length;
    });
    input.addEventListener('compositionend', () => {
      if (!this.session) return;
      this.session.composition = null;
      this._sync(true);
    });
    input.addEventListener('focus', () => this._restartBlink());
    input.addEventListener('blur', () => {
      const session = this.session;
      this.render();
      queueMicrotask(() => {
        if (!session || this.session !== session) return;
        const active = this.root.getRootNode().activeElement;
        // Switching windows or opening an IME candidate window keeps editing;
        // focusing something else in the page saves.
        if (active === input || !document.hasFocus() || this.host.keepsEditing(active)) return;
        this.commit({ focus: false });
      });
    });
    root.addEventListener('scroll', () => this._unscroll());
    this._boundWheel = event => this._onWheel(event);
    root.addEventListener('wheel', this._boundWheel, { passive: false });
    this._onVisibility = () => this._restartBlink();
    document.addEventListener('visibilitychange', this._onVisibility);
    this._watchPixelRatio();
  }

  /** Moving between screens can change the pixel ratio without a resize event. */
  _watchPixelRatio() {
    this._ratioQuery?.removeEventListener('change', this._onRatio);
    this._ratioQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
    this._onRatio = () => {
      this._watchPixelRatio();
      this.render();
    };
    this._ratioQuery?.addEventListener('change', this._onRatio);
  }

  get active() { return Boolean(this.session); }
  get editingId() { return this.session?.id ?? null; }
  get mode() { return this.session?.mode ?? null; }

  owns(node) { return node === this.input; }

  destroy() {
    this.cancel({ focus: false });
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._ratioQuery?.removeEventListener('change', this._onRatio);
    this.root.removeEventListener('wheel', this._boundWheel);
    this.canvas.remove();
    this.input.remove();
  }

  // ---------------------------------------------------------------------------
  // Session

  /**
   * Begin editing a bullet's explanation. mode: 'legend' edits its row in the
   * visible legend; 'card' edits in a card beside the bullet, never exported.
   */
  start(id, { mode = 'legend', point = null, creating = false, mergeKey = null } = {}) {
    const bullet = this.host.document?.find(id);
    if (!bullet || bullet.type !== 'bullet') return false;
    let placement = null;
    if (point && this.session) {
      const previous = this._visual();
      const row = previous?.layout.rows.find(item => item.id === id);
      if (row && previous.decorations.viewport) {
        placement = indexAtPoint(previous.layout, row, this._contentPoint(point, previous), this.measurer);
      }
    }
    if (this.session) this.commit({ focus: false });
    const text = bullet.text ?? '';
    this.session = {
      id, mode, original: text, text, creating, mergeKey,
      affinity: 'downstream', goalX: null, composition: null, anchor: null,
      scroll: { x: 0, y: 0 }, revealCaret: true,
      selection: { start: text.length, end: text.length, direction: 'none' },
    };
    this.input.value = text;
    this.input.setAttribute('aria-label', `Explanation for bullet ${bullet.label}`);
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(text.length, text.length);
    if (placement) {
      this.input.setSelectionRange(placement.index, placement.index);
      this.session.affinity = placement.affinity;
    } else if (point) this.pointerDown(point, { fresh: true });
    this._sync(true);
    this._restartBlink();
    this.host.onChange();
    return true;
  }

  /** Save the edit. Returns false when nothing was being edited. */
  commit({ focus = true } = {}) {
    return this._finish(true, focus);
  }

  /** Discard the edit. Returns false when nothing was being edited. */
  cancel({ focus = true } = {}) {
    return this._finish(false, focus);
  }

  _finish(commit, focus) {
    const session = this.session;
    if (!session) return false;
    // Preserve the explanation exactly, including intentional blank lines.
    const text = this.input.value;
    this.session = null;
    this._stopBlink();
    if (focus || this.root.getRootNode().activeElement === this.input) {
      this.svg.focus({ preventScroll: true });
    }
    this.input.value = '';
    this.input.setAttribute('aria-label', 'Bullet explanation');
    this.host.onFinish({
      id: session.id, text, original: session.original, commit,
      creating: session.creating, mergeKey: session.mergeKey,
    });
    this.host.onChange();
    this.render();
    return true;
  }

  /** Return keyboard focus to an open edit (after a legend control was used). */
  focus() {
    if (!this.session || this.root.getRootNode().activeElement === this.input) return;
    this.input.focus({ preventScroll: true });
    this._sync(true);
  }

  /** Move an open edit between the legend row and the hidden-legend card. */
  setMode(mode) {
    if (!this.session || this.session.mode === mode) return;
    this.session.mode = mode;
    this.session.scroll = { x: 0, y: 0 };
    this.session.revealCaret = true;
    this._cache = null;
    this.render();
    this.host.onChange();
  }

  /** Keep the text and caret, but re-read the bullet (for example after undo). */
  refresh() {
    if (this.session && !this.host.document?.find(this.session.id)) this.cancel({ focus: false });
    else this.render();
  }

  // ---------------------------------------------------------------------------
  // Keyboard and input

  _onKeyDown(event) {
    const session = this.session;
    if (!session) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const handled = () => {
      event.preventDefault();
      this._restartBlink();
    };
    if (event.key === 'Escape') {
      handled();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && ctrl) {
      handled();
      this.commit();
      return;
    }
    if (event.key === 'Tab') {
      handled();
      this.commit();
      return;
    }
    const vertical = { ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (vertical && !ctrl && !event.altKey) {
      handled();
      this._moveCaret(row => verticalCaretMove(this._layout(), row, this._focusIndex(), session.affinity, vertical, session.goalX, this.measurer), event.shiftKey, true);
      return;
    }
    if ((event.key === 'Home' || event.key === 'End') && !ctrl && !event.altKey) {
      handled();
      this._moveCaret(row => lineEdge(row, this._focusIndex(), session.affinity, event.key === 'Home' ? 'start' : 'end'), event.shiftKey);
      return;
    }
    if ((event.key === 'PageUp' || event.key === 'PageDown') && !event.altKey) {
      handled();
      const index = event.key === 'PageUp' ? 0 : this.input.value.length;
      this._moveCaret(() => ({ index, affinity: 'downstream' }), event.shiftKey);
      return;
    }
    // Everything else (characters, Backspace, Delete, Left/Right, Ctrl+A,
    // clipboard shortcuts, undo) is the textarea's own behaviour.
    session.goalX = null;
    session.affinity = 'downstream';
    this._restartBlink();
    setTimeout(() => this._sync(), 0);
  }

  _onInput(event) {
    const session = this.session;
    if (!session) return;
    const value = this.input.value;
    if (value.length > EXPLANATION_MAX_LENGTH) {
      // Refuse the insertion rather than truncating anything already typed.
      const { start, end, direction } = session.selection;
      this.input.value = session.text;
      this.input.setSelectionRange(start, end, direction);
      this.host.setMessage(`Explanations are limited to ${EXPLANATION_MAX_LENGTH.toLocaleString('en-US')} characters; that text was not added.`);
      return;
    }
    if (event.isComposing && session.composition) {
      session.composition.end = Math.max(session.composition.start, this.input.selectionEnd);
    }
    session.goalX = null;
    this._sync(true);
  }

  _focusIndex() {
    const { selectionStart, selectionEnd, selectionDirection } = this.input;
    return selectionDirection === 'backward' ? selectionStart : selectionEnd;
  }

  _anchorIndex() {
    const { selectionStart, selectionEnd, selectionDirection } = this.input;
    return selectionDirection === 'backward' ? selectionEnd : selectionStart;
  }

  _select(anchor, focus) {
    if (focus >= anchor) this.input.setSelectionRange(anchor, focus, 'forward');
    else this.input.setSelectionRange(focus, anchor, 'backward');
  }

  _moveCaret(compute, extend, keepGoal = false) {
    const row = this._row();
    if (!row) return;
    const anchor = this._anchorIndex();
    const result = compute(row);
    this.session.affinity = result.affinity;
    this.session.goalX = keepGoal ? result.goalX : null;
    if (extend) this._select(anchor, result.index);
    else this.input.setSelectionRange(result.index, result.index);
    this._sync(true);
  }

  /** Read the textarea back into the session and redraw when anything changed. */
  _sync(force = false) {
    const session = this.session;
    if (!session) return;
    const { value, selectionStart: start, selectionEnd: end, selectionDirection: direction } = this.input;
    const changed = force || value !== session.text || start !== session.selection.start
      || end !== session.selection.end || direction !== session.selection.direction;
    if (!changed) return;
    const edited = value !== session.text;
    if (edited) this._cache = null;
    session.text = value;
    session.selection = { start, end, direction };
    session.revealCaret = true;
    this._restartBlink();
    this.render();
    this._unscroll();
    if (edited) this.host.onInput?.();
  }

  // ---------------------------------------------------------------------------
  // Pointer

  /**
   * What a document point touches: { kind: 'handle' | 'grip' | 'row' | 'body' | 'card', ... }
   * or null. Handles and the grip exist only while the legend is active.
   */
  hitTest(point) {
    const visual = this._visual();
    if (!visual) return null;
    const { layout, decorations, mode } = visual;
    const scale = decorations.scale;
    if (decorations.viewport) {
      const view = decorations.viewport;
      if (!this._inside(view.box, point)) return null;
      if (!this._inside(view.content, point)) return { kind: 'card', id: this.session.id, layout, box: view.box };
      const source = this._contentPoint(point, visual);
      const hit = legendHitTest(layout, source, scale, { box: { ...layout.box, height: layout.contentHeight }, handles: false });
      return hit ? { ...hit, layout, box: view.box } : { kind: 'card', id: this.session.id, layout, box: view.box };
    }
    if (mode === 'card') {
      const box = layout.box;
      const inside = point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + layout.contentHeight;
      return inside ? { kind: 'card', id: layout.rows[0].id, layout, box } : null;
    }
    const box = decorations.expand ? { ...layout.box, height: Math.max(layout.box.height, layout.contentHeight) } : layout.box;
    const hit = legendHitTest(layout, point, scale, { box, handles: decorations.active });
    return hit ? { ...hit, layout, box } : null;
  }

  /** Place the caret, or extend or multi-click select, from a document point in the edited row. */
  pointerDown(point, { shiftKey = false, fresh = false } = {}) {
    const session = this.session;
    const row = this._row();
    if (!session || !row) return;
    const now = performance.now();
    const previous = this._clicks;
    const scale = this.host.scale();
    const near = previous.point && Math.hypot((point.x - previous.point.x) * scale.x, (point.y - previous.point.y) * scale.y) <= MULTI_CLICK_DISTANCE;
    const count = !fresh && near && now - previous.at <= MULTI_CLICK_MS ? previous.count + 1 : 1;
    this._clicks = { count, at: now, point };
    const hit = indexAtPoint(this._layout(), row, this._contentPoint(point), this.measurer);
    session.goalX = null;
    session.affinity = hit.affinity;
    if (count === 2 || count === 3) {
      const range = count === 2 ? wordRangeAt(row.text, hit.index) : paragraphRangeAt(row.text, hit.index);
      this.input.setSelectionRange(range.start, range.end, 'forward');
      session.anchor = { start: range.start, end: range.end };
    } else if (shiftKey) {
      this._select(this._anchorIndex(), hit.index);
      session.anchor = { start: this._anchorIndex(), end: this._anchorIndex() };
    } else {
      this.input.setSelectionRange(hit.index, hit.index);
      session.anchor = { start: hit.index, end: hit.index };
    }
    if (this.root.getRootNode().activeElement !== this.input) this.input.focus({ preventScroll: true });
    this._sync(true);
  }

  /** Extend a pointer selection while dragging. */
  pointerDrag(point) {
    const session = this.session;
    const row = this._row();
    if (!session?.anchor || !row) return;
    const hit = indexAtPoint(this._layout(), row, this._contentPoint(point), this.measurer);
    const { start, end } = session.anchor;
    if (hit.index < start) this._select(end, hit.index);
    else this._select(start, Math.max(end, hit.index));
    session.affinity = hit.affinity;
    this._sync(true);
  }

  // ---------------------------------------------------------------------------
  // Rendering

  /** The layout and decorations to draw now, or null when nothing is shown. */
  _visual() {
    const host = this.host;
    const doc = host.document;
    if (!doc || host.pageMode) return null;
    const session = this.session;
    const scale = host.scale();
    const texts = session ? new Map([[session.id, session.text]]) : null;
    const editing = session ? {
      id: session.id,
      selectionStart: session.selection.start,
      selectionEnd: session.selection.end,
      caretIndex: this._focusIndex(),
      caretVisible: this._caretOn && session.selection.start === session.selection.end
        && this.root.getRootNode().activeElement === this.input,
      affinity: session.affinity,
      composition: session.composition,
    } : null;

    if (session?.mode === 'card') {
      const bullet = doc.find(session.id);
      if (!bullet) return null;
      const frame = explanationCardFrame(bullet, doc.legend, doc.width, doc.height);
      const layout = this._cached(['card', frame.x, frame.y, frame.width, frame.fontSize, frame.fontFamily, bullet, session.text],
        () => layoutLegendFrame(frame, [bullet], this.measurer, { texts }));
      return this._withViewport({ mode: 'card', layout, decorations: { scale, editing, placeholders: true } });
    }

    const legend = host.liveLegend ?? doc.legend;
    if (!legend?.visible) return null;
    const layout = this._cached(['legend', legend, doc.marks, session?.id, session?.text],
      () => layoutLegend(legend, doc.marks, this.measurer, { texts }));
    if (!layout.rows.length) return null;
    const expand = Boolean(session) && layout.overflows;
    const shown = expand ? { ...layout.box, height: layout.contentHeight } : layout.box;
    return this._withViewport({
      mode: 'legend',
      layout,
      decorations: {
        scale, editing, expand, placeholders: true,
        selectedId: host.selectedId,
        active: Boolean(host.legendActive || session),
        clipping: legendClipping(shown, doc.width, doc.height, doc.crop),
      },
    });
  }

  _inside(box, point) {
    return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  }

  _contentPoint(point, visual = this._visual()) {
    const view = visual?.decorations.viewport;
    return view ? { x: point.x - view.offsetX, y: point.y - view.offsetY } : point;
  }

  _withViewport(visual) {
    const session = this.session;
    if (!session) return visual;
    const { layout, decorations } = visual;
    const scale = decorations.scale;
    const doc = this.host.document;
    const svgRect = this.svg.getBoundingClientRect();
    let top = 8 / scale.y;
    // A temporary edit view stays clear of controls; document placement does
    // not change when the toolbar wraps, moves, or obscures an imported legend.
    for (const node of this.root.querySelectorAll('[data-redline-toolbar], [data-redline-context]')) {
      if (!node.checkVisibility()) continue;
      const rect = node.getBoundingClientRect();
      const left = svgRect.left + layout.box.x * scale.x;
      const right = left + layout.box.width * scale.x;
      if (rect.right > left && rect.left < right) top = Math.max(top, (rect.bottom - svgRect.top + 8) / scale.y);
    }
    top = Math.min(top, Math.max(0, doc.height - 80 / scale.y));
    const area = { x: 8 / scale.x, y: top, width: Math.max(1, doc.width - 16 / scale.x), height: Math.max(1, doc.height - top - 8 / scale.y) };
    const areaKey = [area.x, area.y, area.width, area.height].join(',');
    const row = layout.rows.find(item => item.id === session.id);
    const caret = row ? caretPoint(layout, row, this._focusIndex(), session.affinity, this.measurer) : null;
    const viewport = legendEditingViewport(layout, area, caret, session.scroll, {
      reveal: session.revealCaret || session.areaKey !== areaKey, scale,
    });
    session.areaKey = areaKey;
    session.scroll = viewport ? { x: viewport.scrollX, y: viewport.scrollY } : { x: 0, y: 0 };
    return { ...visual, decorations: { ...decorations, viewport } };
  }

  _onWheel(event) {
    if (!this.session || event.ctrlKey) return;
    const visual = this._visual();
    const view = visual?.decorations.viewport;
    if (!view) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(this.svg.getScreenCTM().inverse());
    if (!this._inside(view.box, point)) return;
    event.preventDefault();
    event.stopPropagation();
    const { scale } = visual.decorations;
    const factorX = event.deltaMode === 1 ? visual.layout.metrics.lineHeight : event.deltaMode === 2 ? view.content.width : 1 / scale.x;
    const factorY = event.deltaMode === 1 ? visual.layout.metrics.lineHeight : event.deltaMode === 2 ? view.content.height : 1 / scale.y;
    const dx = event.shiftKey ? event.deltaY : event.deltaX;
    const dy = event.shiftKey ? 0 : event.deltaY;
    this.session.scroll = { x: view.scrollX + dx * factorX, y: view.scrollY + dy * factorY };
    this.session.revealCaret = false;
    this.render();
  }

  _cached(key, compute) {
    const cache = this._cache;
    if (cache && cache.key.length === key.length && cache.key.every((part, index) => part === key[index])) return cache.layout;
    const layout = compute();
    this._cache = { key, layout };
    return layout;
  }

  _layout() {
    return this._visual()?.layout ?? null;
  }

  _row() {
    return this._layout()?.rows.find(row => row.id === this.session?.id) ?? null;
  }

  render() {
    const doc = this.host.document;
    const ctx = this.ctx;
    if (!ctx) return;
    const rect = this.svg.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    // Drawing a stroke re-renders the overlay on every pointer move; skip the
    // canvas unless something it shows has changed.
    const session = this.session;
    const crop = doc?.crop;
    const visual = doc && rect.width && rect.height ? this._visual() : null;
    const view = visual?.decorations.viewport;
    const key = [
      view && [view.box.x, view.box.y, view.box.width, view.box.height, view.scrollX, view.scrollY].join(','),
      width, height, rect.left, rect.top, doc, doc?.width, doc?.height, doc?.marks, doc?.legend, this.host.liveLegend,
      this.host.selectedId, this.host.legendActive, this.host.pageMode, crop && [crop.x, crop.y, crop.width, crop.height].join(),
      session && [session.id, session.mode, session.text, session.selection.start, session.selection.end, session.selection.direction,
        session.affinity, session.composition && `${session.composition.start}-${session.composition.end}`, this._caretOn,
        this.root.getRootNode().activeElement === this.input].join(''),
    ];
    if (this._drawn && this._drawn.length === key.length && this._drawn.every((part, index) => part === key[index])) return;
    this._drawn = key;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!visual) {
      this._describe(null);
      return;
    }
    // Document units straight to device pixels, as the export does with its
    // own output pixels, so the same layout lands on the same places.
    ctx.setTransform(width / doc.width, 0, 0, height / doc.height, 0, 0);
    drawLegend(ctx, visual.layout, { measurer: this.measurer, decorations: visual.decorations });
    this._describe(visual);
    this._positionInput(visual, rect);
    if (this.session) this.session.revealCaret = false;
  }

  _describe(visual) {
    let label = 'Legend hidden';
    if (visual?.mode === 'card') {
      label = `Editing the explanation for bullet ${visual.layout.rows[0].label} beside its marker; not exported`;
    } else if (visual) {
      const { layout, decorations } = visual;
      const count = layout.rows.length;
      const notes = [];
      if (layout.overflows) notes.push(`${layout.hiddenLines} line${layout.hiddenLines === 1 ? '' : 's'} clipped by its height`);
      if (decorations.clipping.crop) notes.push('partly outside the crop');
      if (decorations.clipping.viewport) notes.push('partly past the window edge');
      label = `Legend with ${count} explanation${count === 1 ? '' : 's'}${notes.length ? `; ${notes.join('; ')}` : ''}`;
    }
    if (visual?.decorations.viewport) label += '; scrollable editing view, saved legend placement unchanged';
    if (this.canvas.getAttribute('aria-label') !== label) this.canvas.setAttribute('aria-label', label);
    this.canvas.dataset.overflow = String(Boolean(visual?.layout.overflows));
    this.canvas.dataset.clipped = visual?.mode === 'legend'
      ? [visual.decorations.clipping.viewport && 'viewport', visual.decorations.clipping.crop && 'crop'].filter(Boolean).join(' ')
      : '';
  }

  /**
   * Keep the hidden input at the caret, so an IME candidate window opens beside
   * it, but always inside the window: a caret below the fold must not let the
   * browser scroll the overlay to reveal it.
   */
  _positionInput(visual, svgRect) {
    const session = this.session;
    if (!session) return;
    const row = visual.layout.rows.find(item => item.id === session.id);
    if (!row) return;
    const doc = this.host.document;
    const caret = caretPoint(visual.layout, row, this._focusIndex(), session.affinity, this.measurer);
    const rootRect = this.root.getBoundingClientRect();
    const sx = svgRect.width / doc.width;
    const sy = svgRect.height / doc.height;
    const height = Math.max(1, Math.min(Math.round(caret.height * sy), rootRect.height));
    const view = visual.decorations.viewport;
    const left = Math.round(svgRect.left - rootRect.left + (caret.x + (view?.offsetX ?? 0)) * sx);
    const top = Math.round(svgRect.top - rootRect.top + (caret.top + (view?.offsetY ?? 0)) * sy);
    Object.assign(this.input.style, {
      left: `${Math.min(Math.max(0, left), Math.max(0, rootRect.width - 2))}px`,
      top: `${Math.min(Math.max(0, top), Math.max(0, rootRect.height - height))}px`,
      height: `${height}px`,
      fontSize: `${Math.max(1, visual.layout.frame.fontSize * sy)}px`,
    });
    this._unscroll();
  }

  /** The overlay never scrolls; undo any scrolling a caret-into-view caused. */
  _unscroll() {
    if (this.root.scrollTop || this.root.scrollLeft) {
      this.root.scrollTop = 0;
      this.root.scrollLeft = 0;
    }
  }

  _restartBlink() {
    this._stopBlink();
    if (!this.session || document.visibilityState === 'hidden') return;
    this._caretOn = true;
    this._blink = setInterval(() => {
      this._caretOn = !this._caretOn;
      this.render();
    }, BLINK_MS);
  }

  _stopBlink() {
    if (this._blink) clearInterval(this._blink);
    this._blink = null;
    this._caretOn = true;
  }
}
