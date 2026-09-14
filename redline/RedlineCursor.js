/**
 * The optional pointer proxy: validation, geometry, hit testing, and the
 * tracker for the last meaningful pointer position.
 *
 * `chrome.tabs.captureVisibleTab` never includes the operating-system cursor,
 * and asking for screen sharing only to get one would add a picker and a much
 * broader capability. A rendered arrow is a deterministic, movable stand-in.
 * The live layer and the PNG draw the same `cursorPrimitives`, in document
 * units, so crop, output scale, device pixel ratio and a nonuniform window
 * resize transform the proxy exactly as they transform the marks.
 *
 * The proxy is an export setting, like the crop: it is stored in the document
 * (`document.cursor`) but moving it does not consume annotation undo history.
 *
 * Nothing here touches the DOM.
 */

export const CURSOR_FIELDS = Object.freeze(['visible', 'x', 'y']);

/** Arrow outline in CSS pixels, with the hotspot (the tip) at 0,0. */
export const CURSOR_SHAPE = Object.freeze([
  [0, 0], [0, 16.5], [4, 12.6], [6.9, 19], [9.5, 17.8], [6.7, 11.6], [11.8, 11.6],
].map(([x, y]) => Object.freeze({ x, y })));
export const CURSOR_WIDTH = 11.8;
export const CURSOR_HEIGHT = 19;
export const CURSOR_FILL = '#111827';
export const CURSOR_EDGE = '#FFFFFF';

/** A pause this long over the page or drawing surface counts as meaningful. */
export const CURSOR_DWELL_MS = 500;
/** Screen pixels the pointer may drift while still counting as a pause. */
export const CURSOR_DWELL_TOLERANCE = 4;

/**
 * A validated, frozen cursor, or null when the document has none. The hotspot
 * must lie inside the document; a malformed cursor rejects the whole import.
 */
export function sanitizeCursor(value, docWidth = 1, docHeight = 1) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('The cursor must be an object.');
  if (typeof value.visible !== 'boolean') throw new TypeError('cursor.visible must be true or false.');
  for (const [key, max] of [['x', docWidth], ['y', docHeight]]) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max + 1e-7) {
      throw new TypeError(`cursor.${key} must be a number from 0 to ${max}, inside the document.`);
    }
  }
  return Object.freeze({ visible: value.visible, x: Math.min(value.x, docWidth), y: Math.min(value.y, docHeight) });
}

/** Keep a hotspot inside the document. */
export function clampCursor(cursor, docWidth, docHeight) {
  return {
    ...cursor,
    x: Math.min(Math.max(0, cursor.x), docWidth),
    y: Math.min(Math.max(0, cursor.y), docHeight),
  };
}

/** Move a hotspot by document units, staying inside the document. */
export function moveCursor(cursor, dx, dy, docWidth, docHeight) {
  return clampCursor({ ...cursor, x: cursor.x + dx, y: cursor.y + dy }, docWidth, docHeight);
}

/**
 * Drawing primitives for the proxy: a faint halo, then a dark arrow with a
 * white edge. Dark on light and light on dark pages both show an outline.
 */
export function cursorPrimitives(cursor) {
  const points = CURSOR_SHAPE.map(point => ({ x: cursor.x + point.x, y: cursor.y + point.y }));
  return [
    { kind: 'path', points, closed: true, fill: null, stroke: { color: '#000000', width: 3.5, opacity: 0.22 } },
    { kind: 'path', points, closed: true, fill: { color: CURSOR_FILL, opacity: 1 }, stroke: { color: CURSOR_EDGE, width: 1.5, opacity: 1 } },
  ];
}

/** The arrow's box in document units, before stroke. */
export function cursorBounds(cursor) {
  return { x: cursor.x, y: cursor.y, width: CURSOR_WIDTH, height: CURSOR_HEIGHT };
}

/** Whether a document point is on the proxy, with a few screen pixels of slack. */
export function cursorHitTest(cursor, point, scale = { x: 1, y: 1 }, slack = 5) {
  if (!cursor?.visible) return false;
  const padX = slack / scale.x;
  const padY = slack / scale.y;
  const box = cursorBounds(cursor);
  return point.x >= box.x - padX && point.x <= box.x + box.width + padX
    && point.y >= box.y - padY && point.y <= box.y + box.height + padY;
}

/** Whether the hotspot lies inside a crop (a proxy outside it is not exported). */
export function cursorInsideCrop(cursor, crop) {
  if (!cursor || !crop) return true;
  return cursor.x >= crop.x && cursor.x <= crop.x + crop.width && cursor.y >= crop.y && cursor.y <= crop.y + crop.height;
}

/**
 * The last meaningful pointer position.
 *
 * A press over the page or drawing surface counts at once. A pause counts
 * after the pointer has rested for `dwellMs`. Moving over Redline's own
 * controls, editors or dialogs calls `leave()`, which forgets a pause still
 * being timed, so crossing the page to reach Copy never counts.
 *
 * `accept(sample)` lets the host refuse a position it knows is not meaningful
 * (over the legend or an editor, say) without forgetting the previous one.
 *
 * Samples are { clientX, clientY, width, height } in CSS pixels; the committed
 * position is stored as fractions of the viewport, which is how the drawing
 * surface maps onto document units.
 */
export class PointerTrail {
  constructor({
    dwellMs = CURSOR_DWELL_MS,
    tolerance = CURSOR_DWELL_TOLERANCE,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = id => clearTimeout(id),
    now = () => Date.now(),
    accept = () => true,
    onCommit = () => {},
  } = {}) {
    Object.assign(this, { dwellMs, tolerance, setTimer, clearTimer, now, accept, onCommit });
    this._pending = null;
    this._timer = null;
    this._last = null;
  }

  /** { fx, fy, reason: 'press' | 'pause', at } or null. */
  get last() { return this._last; }

  move(sample) {
    if (!validSample(sample)) return;
    const pending = this._pending;
    if (pending && Math.hypot(sample.clientX - pending.clientX, sample.clientY - pending.clientY) <= this.tolerance) return;
    this.leave();
    this._pending = sample;
    this._timer = this.setTimer(() => {
      this._timer = null;
      this._commit('pause');
    }, this.dwellMs);
  }

  press(sample) {
    if (!validSample(sample)) return;
    this.leave();
    this._pending = sample;
    this._commit('press');
  }

  /** Forget a pause still being timed. The last committed position stays. */
  leave() {
    if (this._timer !== null) this.clearTimer(this._timer);
    this._timer = null;
    this._pending = null;
  }

  reset() {
    this.leave();
    this._last = null;
  }

  _commit(reason) {
    const sample = this._pending;
    this._pending = null;
    // The host can still refuse a sample it knows is over its own controls.
    if (!sample || !this.accept(sample)) return;
    this._last = Object.freeze({
      fx: Math.min(1, Math.max(0, sample.clientX / sample.width)),
      fy: Math.min(1, Math.max(0, sample.clientY / sample.height)),
      reason,
      at: this.now(),
    });
    this.onCommit(this._last);
  }
}

function validSample(sample) {
  return sample && [sample.clientX, sample.clientY, sample.width, sample.height].every(Number.isFinite)
    && sample.width > 0 && sample.height > 0;
}
