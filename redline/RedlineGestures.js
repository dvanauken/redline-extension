/**
 * Pointer gestures on the drawing surface.
 *
 * Two kinds of unfinished work exist, and every interruption resolves them the
 * same way:
 *   - a pointer gesture (drawing a stroke or shape, moving, resizing, rotating,
 *     erasing) lives while a button is down; it commits on release and is
 *     discarded by `cancelPointer()` (pointercancel, lost capture, blur,
 *     Escape, tool or mode change, close, import, capture);
 *   - a path draft (polyline or polygon) lives across clicks; Enter or a
 *     double-click finishes it, Backspace removes its last point, and
 *     `cancel()` discards it (Escape, tool or mode change, close, import).
 * Completed marks are never affected by either.
 */

import { cryptoId, translateAnnotation } from './RedlineDocument.js';
import {
  boxFromPoints, constrainAxis, constrainSquare, distinctPoints, isUsefulPolygon, snapAngle, topmostMarkAt,
} from './RedlineGeometry.js';
import { moveCursor } from './RedlineCursor.js';
import { moveLegend, resizeLegend } from './RedlineLegend.js';
import { TEXTBOX_MIN_HEIGHT, TEXTBOX_MIN_WIDTH } from './RedlineTextLayout.js';
import { handleAt, resizeMark, rotateMark } from './RedlineTransform.js';

const DRAW_BOX_TOOLS = new Set(['line', 'arrow', 'rectangle', 'ellipse', 'textbox']);

export class RedlineGestures {
  /**
   * host: {
   *   document, tool, measurer,
   *   scale(): document→screen factors { x, y },
   *   styleFor(tool): style fields for a new mark,
   *   selectedId, select(id),
   *   render(), setMessage(text),
   *   commitPath(mark), startTextBox(draft), createNote(point), placeBullet(point),
   *   legendEditor, activateLegend(), editExplanation(id, { point }),
   *   commitCursor(cursor),
   * }
   */
  constructor(host) {
    this.host = host;
    this.draft = null;
    this.pointer = null;
    this.live = null;
    /** The legend while it is being moved or resized, before it is committed. */
    this.liveLegend = null;
    /** The pointer proxy while it is being dragged, before it is committed. */
    this.liveCursor = null;
    this._eraseRun = 0;
  }

  get hasPathDraft() {
    return Boolean(this.draft && (this.draft.type === 'polyline' || this.draft.type === 'polygon'));
  }

  _screenDistance(a, b) {
    const scale = this.host.scale();
    return Math.hypot((a.x - b.x) * scale.x, (a.y - b.y) * scale.y);
  }

  _tolerance() {
    const scale = this.host.scale();
    return 6 / Math.min(scale.x, scale.y);
  }

  pointerDown(event, point) {
    const { host } = this;
    const doc = host.document;
    const tool = host.tool;

    if (tool === 'select') {
      // The selected mark's handles sit above every mark, as its frame does.
      const selected = host.selectedId ? doc.find(host.selectedId) : null;
      const handle = this.handleAt(selected, point);
      if (handle) {
        this.pointer = {
          kind: handle === 'rotate' ? 'rotate' : 'resize', pointerId: event.pointerId, start: point, last: point,
          original: selected, handle, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey,
        };
        return true;
      }
      const hit = topmostMarkAt(doc.marks, point, this._tolerance(), host.measurer);
      host.select(hit?.id ?? null);
      if (hit) this.pointer = { kind: 'move', pointerId: event.pointerId, start: point, original: hit, last: point, shift: event.shiftKey };
      return Boolean(hit);
    }

    if (tool === 'note') {
      host.createNote(point);
      return false;
    }

    if (tool === 'bullet') {
      // Pressing on an existing bullet moves it; anywhere else places one.
      const bullets = doc.marks.filter(mark => mark.type === 'bullet');
      const hit = topmostMarkAt(bullets, point, this._tolerance(), host.measurer);
      if (hit) {
        this.pointer = { kind: 'move', pointerId: event.pointerId, start: point, original: hit, last: point, shift: event.shiftKey, bullet: true };
        return true;
      }
      host.placeBullet(point);
      return false;
    }

    if (tool === 'eraser') {
      this._eraseRun += 1;
      this.pointer = { kind: 'erase', pointerId: event.pointerId, mergeKey: `erase:${this._eraseRun}` };
      this._eraseAt(point);
      return true;
    }

    if (tool === 'polyline' || tool === 'polygon') {
      if (!this.draft || this.draft.type !== tool) {
        this.draft = { id: cryptoId(), type: tool, points: [point], previewPoint: point, ...host.styleFor(tool) };
      } else {
        const last = this.draft.points.at(-1);
        const placed = event.shiftKey ? snapAngle(last, point, { scale: host.scale() }) : point;
        // The two clicks of a double-click land on one spot; keep one vertex.
        if (this._screenDistance(placed, last) > 3) this.draft.points.push(placed);
        this.draft.previewPoint = placed;
      }
      host.render();
      return true;
    }

    if (tool === 'pen' || tool === 'brush') {
      this.draft = { id: cryptoId(), type: tool, points: [point, point], ...host.styleFor(tool) };
    } else if (DRAW_BOX_TOOLS.has(tool)) {
      this.draft = { id: cryptoId(), type: tool, start: point, end: point, ...host.styleFor(tool) };
    } else {
      return false;
    }
    this.pointer = { kind: 'draw', pointerId: event.pointerId, last: point, shift: event.shiftKey };
    host.render();
    return true;
  }

  pointerMove(event, point) {
    const { host } = this;
    if (this.hasPathDraft && !this.pointer) {
      const last = this.draft.points.at(-1);
      this.draft.previewPoint = event.shiftKey ? snapAngle(last, point, { scale: host.scale() }) : point;
      this._lastHover = { point, shiftKey: event.shiftKey };
      host.render();
      return;
    }
    const gesture = this.pointer;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.last = point;
    gesture.shift = event.shiftKey;
    gesture.ctrl = event.ctrlKey || event.metaKey;
    this._applyPointer(point, event.shiftKey);
  }

  /**
   * A press on the live legend. Handles resize and the grip moves. On a row
   * being edited, it places the caret and drags a selection. Elsewhere on the
   * legend a click edits that row (or selects the legend) and a drag moves it.
   */
  legendPointerDown(event, point, hit) {
    const { host } = this;
    const editor = host.legendEditor;
    const base = { pointerId: event.pointerId, start: point, last: point, original: host.document.legend, contentHeight: hit.layout.contentHeight };
    if (hit.kind === 'handle') {
      this.pointer = { ...base, kind: 'legend-resize', handle: hit.handle };
    } else if (hit.kind === 'card' || (hit.kind === 'row' && editor.editingId === hit.id)) {
      editor.pointerDown(point, { shiftKey: event.shiftKey });
      this.pointer = { ...base, kind: 'legend-text' };
    } else {
      this.pointer = { ...base, kind: 'legend-move', hit, moved: hit.kind === 'grip' };
    }
    return true;
  }

  /** A press that drags the pointer proxy (from `original`, which may be a new placement). */
  cursorPointerDown(event, point, original) {
    if (!original) return false;
    this.pointer = { kind: 'cursor-move', pointerId: event.pointerId, start: point, last: point, original, shift: event.shiftKey };
    this.liveCursor = original;
    this.host.render();
    return true;
  }

  _applyLegendPointer(point) {
    const { host } = this;
    const gesture = this.pointer;
    const doc = host.document;
    if (gesture.kind === 'legend-text') {
      host.legendEditor.pointerDrag(point);
      return;
    }
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (gesture.kind === 'legend-resize') {
      this.liveLegend = resizeLegend(gesture.original, gesture.handle, dx, dy, gesture.contentHeight);
    } else {
      if (!gesture.moved && this._screenDistance(gesture.start, point) < 4) return;
      gesture.moved = true;
      const shown = gesture.original.height ?? gesture.contentHeight;
      this.liveLegend = moveLegend(gesture.original, dx, dy, doc.width, doc.height, shown);
    }
    host.render();
  }

  _applyPointer(point, shiftKey) {
    const { host } = this;
    const gesture = this.pointer;
    if (gesture.kind.startsWith('legend-')) {
      this._applyLegendPointer(point);
      return;
    }
    if (gesture.kind === 'cursor-move') {
      let dx = point.x - gesture.start.x;
      let dy = point.y - gesture.start.y;
      if (shiftKey) ({ dx, dy } = constrainAxis(dx, dy, { scale: host.scale() }));
      const doc = host.document;
      this.liveCursor = moveCursor(gesture.original, dx, dy, doc.width, doc.height);
      host.render();
      return;
    }
    if (gesture.kind === 'resize') {
      this.live = resizeMark(gesture.original, gesture.handle, gesture.start, point, {
        scale: host.scale(), keepAspect: shiftKey, fromCenter: gesture.ctrl, measurer: host.measurer,
      });
    } else if (gesture.kind === 'rotate') {
      this.live = rotateMark(gesture.original, gesture.start, point, { snap: shiftKey });
    } else if (gesture.kind === 'move') {
      let dx = point.x - gesture.start.x;
      let dy = point.y - gesture.start.y;
      if (shiftKey) ({ dx, dy } = constrainAxis(dx, dy, { scale: host.scale() }));
      this.live = translateAnnotation(gesture.original, dx, dy);
    } else if (gesture.kind === 'erase') {
      this._eraseAt(point);
      return;
    } else if (gesture.kind === 'draw' && this.draft) {
      const draft = this.draft;
      if (draft.type === 'pen' || draft.type === 'brush') {
        if (this._screenDistance(draft.points.at(-1), point) >= 2) draft.points.push(point);
      } else if (shiftKey && (draft.type === 'line' || draft.type === 'arrow')) {
        draft.end = snapAngle(draft.start, point, { scale: host.scale() });
      } else if (shiftKey) {
        draft.end = constrainSquare(draft.start, point, { scale: host.scale() });
      } else {
        draft.end = point;
      }
    }
    host.render();
  }

  /** Re-evaluate the current gesture when Shift is pressed or released. */
  modifiersChanged(shiftKey) {
    if (this.pointer?.kind.startsWith('legend-')) return;
    if (this.pointer && this.pointer.kind !== 'erase' && this.pointer.last && this.pointer.shift !== shiftKey) {
      this.pointer.shift = shiftKey;
      this._applyPointer(this.pointer.last, shiftKey);
    } else if (this.hasPathDraft && !this.pointer && this._lastHover) {
      this.pointerMove({ shiftKey }, this._lastHover.point);
    }
  }

  pointerUp(event, point, { cancelled = false } = {}) {
    const { host } = this;
    const gesture = this.pointer;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!cancelled && point) {
      gesture.last = point;
      if (gesture.kind !== 'erase') this._applyPointer(point, event.shiftKey);
    }
    this.pointer = null;
    const doc = host.document;

    if (gesture.kind === 'cursor-move') {
      const live = this.liveCursor;
      this.liveCursor = null;
      if (!cancelled && live) host.commitCursor(live);
      host.render();
      return;
    }

    if (gesture.kind.startsWith('legend-')) {
      const live = this.liveLegend;
      this.liveLegend = null;
      if (gesture.kind === 'legend-text' || cancelled) {
        host.render();
        return;
      }
      if (live && (gesture.kind === 'legend-resize' || gesture.moved)) {
        doc.setLegend(live);
        host.activateLegend();
      } else if (gesture.hit?.kind === 'row') {
        host.editExplanation(gesture.hit.id, { point: gesture.last });
      } else {
        host.activateLegend();
      }
      host.render();
      return;
    }

    if (gesture.kind === 'erase') {
      doc.breakMerge();
      host.render();
      return;
    }
    if (gesture.kind === 'resize' || gesture.kind === 'rotate' || gesture.kind === 'move') {
      const live = this.live;
      this.live = null;
      const moved = point && this._screenDistance(gesture.start, point) >= 1;
      if (!cancelled && live && moved) {
        doc.replace(gesture.original.id, live);
        if (gesture.kind === 'rotate') host.setMessage(`Rotated to ${Math.round(live.rotation ?? 0) % 360}° · Shift snaps to 15° steps`);
      } else if (!cancelled && gesture.bullet) {
        host.setMessage(`Bullet ${gesture.original.label}: double-click to edit its explanation, or drag to move it`);
      }
      host.render();
      return;
    }
    const draft = this.draft;
    this.draft = null;
    if (cancelled || !draft) {
      host.render();
      return;
    }
    const meaningful = draft.type === 'pen' || draft.type === 'brush'
      ? draft.points.length > 2 || this._screenDistance(draft.points[0], draft.points.at(-1)) >= 2
      : this._screenDistance(draft.start, draft.end) >= 3;
    if (draft.type === 'textbox') {
      const box = boxFromPoints(draft.start, draft.end);
      // A click is enough; keep the initial editor inside the viewport edges.
      box.x = Math.max(0, Math.min(box.x, doc.width - TEXTBOX_MIN_WIDTH));
      box.y = Math.max(0, Math.min(box.y, doc.height - TEXTBOX_MIN_HEIGHT));
      host.startTextBox({
        ...draft,
        start: { x: box.x, y: box.y },
        end: { x: box.x + Math.max(TEXTBOX_MIN_WIDTH, box.width), y: box.y + Math.max(TEXTBOX_MIN_HEIGHT, box.height) },
        text: '',
      });
      return;
    }
    if (meaningful) doc.add(draft);
    host.render();
  }

  /** Finish a polyline or polygon. Returns true when a mark was created. */
  finishPath() {
    if (!this.hasPathDraft) return false;
    const draft = this.draft;
    const points = distinctPoints(draft.points, 3 / Math.min(this.host.scale().x, this.host.scale().y));
    if (draft.type === 'polygon' && !isUsefulPolygon(points, 0.5)) {
      this.host.setMessage('A polygon needs at least three separate points — keep clicking, or Esc to cancel');
      return false;
    }
    if (draft.type === 'polyline' && points.length < 2) {
      this.host.setMessage('A polyline needs at least two separate points — keep clicking, or Esc to cancel');
      return false;
    }
    this.draft = null;
    this._lastHover = null;
    const { previewPoint, ...mark } = draft;
    this.host.commitPath({ ...mark, points });
    return true;
  }

  /** Remove the last placed vertex of a path draft; cancel it when none remain. */
  removeLastPathPoint() {
    if (!this.hasPathDraft) return false;
    this.draft.points.pop();
    if (!this.draft.points.length) this.draft = null;
    else this.draft.previewPoint = this.draft.points.at(-1);
    this.host.render();
    return true;
  }

  /** Discard an in-progress pointer gesture. Returns true if there was one. */
  cancelPointer() {
    const gesture = this.pointer;
    if (!gesture) return false;
    this.pointer = null;
    this.live = null;
    this.liveLegend = null;
    this.liveCursor = null;
    if (gesture.kind === 'draw') this.draft = null;
    if (gesture.kind === 'erase') this.host.document?.breakMerge();
    this.host.render();
    return true;
  }

  /** Discard all unfinished work: a pointer gesture and any path draft. */
  cancel() {
    const hadPointer = this.cancelPointer();
    const hadDraft = Boolean(this.draft);
    this.draft = null;
    this._lastHover = null;
    if (hadDraft) this.host.render();
    return hadPointer || hadDraft;
  }

  /** The resize handle or rotate knob of `mark` under a point, or null. */
  handleAt(mark, point) {
    if (!mark) return null;
    const doc = this.host.document;
    return handleAt(mark, point, { scale: this.host.scale(), bounds: doc });
  }

  _eraseAt(point) {
    const doc = this.host.document;
    const hit = topmostMarkAt(doc.marks, point, this._tolerance(), this.host.measurer);
    if (!hit) return false;
    doc.remove(hit.id, { mergeKey: this.pointer?.mergeKey ?? null });
    if (this.host.selectedId === hit.id) this.host.select(null);
    this.host.render();
    return true;
  }
}
