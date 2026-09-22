/**
 * The pointer proxy of a RedlineOverlay (see RedlineCursor.js): a drawn mouse
 * pointer that exports can include.
 *
 * Include places it where the pointer last pressed or paused over the page or
 * drawing surface (never over Redline's own controls or editors), or asks for
 * a placement when there is no such position. It stays frozen unless Follow is
 * on; dragging, nudging or placing freezes it again. Escape ends placement,
 * then deselects it.
 *
 * The selection flags (cursorSelected, cursorPlacing, cursorFollow) live on
 * the overlay with the rest of its selection state; this controller owns the
 * pointer trail and the proxy's behaviour and drawing.
 */

import {
  PointerTrail, clampCursor, cursorBounds, cursorHitTest, cursorPrimitives, moveCursor,
} from './RedlineCursor.js';
import { renderPrimitives, svgElement } from './RedlineSvg.js';

export class RedlineOverlayCursor {
  constructor(overlay) {
    this.overlay = overlay;
    /** Recent meaningful pointer positions, over the page or the drawing surface. */
    this.trail = new PointerTrail({
      accept: sample => this._meaningful(sample),
      onCommit: position => this._onTrail(position),
    });
    this._placementFocus = null;
    this._renderKey = null;
  }

  /** Include or leave out the pointer proxy. Returns true when that changed. */
  setIncluded(included) {
    const overlay = this.overlay;
    if (!overlay.document) return false;
    const result = this.setVisibility(included, { select: true });
    if (result.message) overlay._setMessage(result.message);
    overlay._render({ force: true });
    return result.changed;
  }

  /** Show or hide the proxy, selecting it when `select`; returns { changed, message }. */
  setVisibility(included, { select }) {
    const overlay = this.overlay;
    const doc = overlay.document;
    if (!included) {
      overlay.cursorPlacing = false;
      overlay.cursorSelected = false;
      if (!doc.cursor?.visible) return { changed: false, message: '' };
      doc.setCursor({ ...doc.cursor, visible: false });
      return { changed: true, message: 'Pointer left out of exports; its position is kept' };
    }
    if (doc.cursor?.visible) return { changed: false, message: '' };
    const last = this.trail.last;
    let message;
    if (doc.cursor) {
      doc.setCursor({ ...doc.cursor, visible: true });
      message = 'Pointer included at its previous position — drag it or use arrow keys to adjust';
    } else if (last) {
      doc.setCursor(clampCursor({ visible: true, x: last.fx * doc.width, y: last.fy * doc.height }, doc.width, doc.height));
      message = `Pointer included where you last ${last.reason === 'press' ? 'clicked' : 'paused'} — drag it or use arrow keys to adjust`;
    } else if (select && overlay.active && !overlay.pageMode) {
      this.startPlacement();
      return { changed: true, message: '' };
    } else {
      doc.setCursor({ visible: true, x: doc.width / 2, y: doc.height / 2 });
      message = 'Pointer placed at the centre, since no pointer position was known — close the preview to move it';
    }
    if (select && overlay.active && !overlay.pageMode) this._select();
    return { changed: true, message };
  }

  /**
   * Choose the pointer's position: the next press on the drawing surface puts
   * its hotspot there (and may drag on), arrow keys move it, Enter or Escape
   * finishes. Starts from the last meaningful position, or the centre.
   */
  startPlacement() {
    const overlay = this.overlay;
    const doc = overlay.document;
    if (!doc || !overlay.active || overlay.pageMode || overlay._busy) return false;
    overlay.textEditor.finish({ commit: true });
    overlay.legendEditor.commit({ focus: false });
    overlay.gestures.cancel();
    if (overlay.tool === 'crop') overlay.setTool(overlay._toolBeforeCrop);
    const last = this.trail.last;
    const start = doc.cursor ?? (last ? { x: last.fx * doc.width, y: last.fy * doc.height } : { x: doc.width / 2, y: doc.height / 2 });
    doc.setCursor(clampCursor({ visible: true, x: start.x, y: start.y }, doc.width, doc.height));
    this._placementFocus = overlay.root.getRootNode().activeElement;
    overlay.cursorPlacing = true;
    overlay.cursorFollow = false;
    this._select();
    overlay.svg.focus({ preventScroll: true });
    overlay._render({ force: true });
    overlay._setMessage('Click where the pointer should point, or move it with arrow keys and press Enter');
    overlay.options.setStatus('Placing the pointer: click where it should point, or use arrow keys and Enter.');
    return true;
  }

  endPlacement({ restoreFocus = false } = {}) {
    const overlay = this.overlay;
    if (!overlay.cursorPlacing) return false;
    overlay.cursorPlacing = false;
    const cursor = overlay.document?.cursor;
    overlay._render({ force: true });
    if (cursor) overlay._setMessage(`Pointer placed at ${Math.round(cursor.x)}, ${Math.round(cursor.y)}`);
    if (restoreFocus) {
      const target = this._placementFocus?.isConnected && this._placementFocus.checkVisibility?.() ? this._placementFocus : null;
      target?.focus?.({ preventScroll: true });
    }
    this._placementFocus = null;
    return true;
  }

  setFollow(follow) {
    const overlay = this.overlay;
    overlay.cursorFollow = Boolean(follow);
    overlay._render({ force: true });
    overlay._setMessage(overlay.cursorFollow
      ? 'Pointer follows: it moves to where you next click or pause over the page'
      : 'Pointer frozen where it is');
    return overlay.cursorFollow;
  }

  /** Move the pointer by screen pixels. Explicit moves freeze it. */
  nudge(dx, dy) {
    const overlay = this.overlay;
    const doc = overlay.document;
    if (!doc?.cursor?.visible) return false;
    const scale = overlay._scale();
    doc.setCursor(moveCursor(doc.cursor, dx / scale.x, dy / scale.y, doc.width, doc.height));
    overlay.cursorFollow = false;
    overlay._render({ force: true });
    return true;
  }

  /** Start dragging the proxy from a press on the drawing surface (placing it there first when `place`). */
  beginDrag(event, point, { place = false } = {}) {
    const overlay = this.overlay;
    const doc = overlay.document;
    overlay.textEditor.finish({ commit: true });
    overlay.legendEditor.commit({ focus: false });
    const original = place ? clampCursor({ visible: true, x: point.x, y: point.y }, doc.width, doc.height) : doc.cursor;
    overlay.cursorFollow = false;
    this._select();
    overlay.svg.focus({ preventScroll: true });
    if (overlay.gestures.cursorPointerDown(event, point, original)) overlay.svg.setPointerCapture?.(event.pointerId);
    overlay._render({ force: true });
  }

  /** Record a drawing-surface position for the pointer trail. */
  trackSurface(event, press) {
    if (!event.isTrusted) return;
    const rect = this.overlay.svg.getBoundingClientRect();
    const sample = { clientX: event.clientX - rect.left, clientY: event.clientY - rect.top, width: rect.width, height: rect.height };
    if (press) this.trail.press(sample);
    else this.trail.move(sample);
  }

  /** A pointer event anywhere on the page, while Redline is closed or in Browse mode. */
  onPagePointer(event) {
    const overlay = this.overlay;
    // Annotate mode reports positions from the drawing surface itself.
    if ((overlay.active && !overlay.pageMode) || !event.isTrusted) return;
    const rootNode = overlay.root.getRootNode();
    const host = rootNode instanceof ShadowRoot ? rootNode.host : overlay.root;
    if (event.composedPath().includes(host)) {
      this.trail.leave();
      return;
    }
    const sample = { clientX: event.clientX, clientY: event.clientY, width: window.innerWidth, height: window.innerHeight };
    if (event.type === 'pointerdown') this.trail.press(sample);
    else this.trail.move(sample);
  }

  /** The proxy and, when selected, its frame. Rebuilt only when it changes. */
  render() {
    const overlay = this.overlay;
    const doc = overlay.document;
    const cursor = overlay.gestures.liveCursor ?? doc.cursor;
    const selected = Boolean(cursor?.visible && (overlay.cursorSelected || overlay.cursorPlacing));
    const scale = overlay._scale();
    const layer = overlay.cursorLayer;
    overlay.svg.toggleAttribute('data-placing', overlay.cursorPlacing);
    const key = [cursor?.visible, cursor?.x, cursor?.y, selected, overlay.cursorPlacing, scale.x, scale.y].join('|');
    if (key === this._renderKey) return;
    this._renderKey = key;
    layer.replaceChildren();
    if (!cursor?.visible) return;
    layer.appendChild(renderPrimitives(cursorPrimitives(cursor), { 'data-redline-cursor': '' }));
    if (!selected) return;
    const box = cursorBounds(cursor);
    const padX = 5 / scale.x;
    const padY = 5 / scale.y;
    layer.appendChild(svgElement('rect', {
      'data-redline-selection': '', 'data-redline-selection-for': 'cursor',
      x: box.x - padX, y: box.y - padY, width: box.width + padX * 2, height: box.height + padY * 2,
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  /** The proxy becomes the one selected thing. */
  _select() {
    const overlay = this.overlay;
    overlay.cursorSelected = true;
    overlay.legendSelected = false;
    if (overlay.tool === 'select') overlay.selectedId = null;
  }

  /** Whether a pointer sample is a meaningful position for the proxy. */
  _meaningful(sample) {
    const overlay = this.overlay;
    const doc = overlay.document;
    if (!doc || !overlay.active || overlay.pageMode) return true;
    if (overlay.tool === 'crop' || overlay.cursorPlacing || overlay.textEditor.active || overlay._dialogDepth > 0 || overlay._busy) return false;
    if (overlay.gestures.pointer?.kind === 'cursor-move') return false;
    const point = { x: sample.clientX / sample.width * doc.width, y: sample.clientY / sample.height * doc.height };
    if (overlay.legendEditor.hitTest(point)) return false;
    return !(doc.cursor?.visible && cursorHitTest(doc.cursor, point, overlay._scale()));
  }

  _onTrail(position) {
    const overlay = this.overlay;
    const doc = overlay.document;
    if (!overlay.cursorFollow || !doc?.cursor?.visible || overlay.gestures.pointer?.kind === 'cursor-move') return;
    doc.setCursor(clampCursor({ visible: true, x: position.fx * doc.width, y: position.fy * doc.height }, doc.width, doc.height));
    // Closed or in Browse mode nothing renders, so schedule the draft directly.
    if (overlay.active && !overlay.pageMode) overlay._render();
    else overlay.recovery.schedule();
  }
}
