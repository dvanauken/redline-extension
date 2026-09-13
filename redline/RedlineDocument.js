/**
 * Framework-free state model for screen-space redline annotations.
 *
 * Coordinates are CSS pixels in the viewport size recorded when a redline
 * session starts. Keeping this model independent from the DOM makes it usable
 * from the editor, a bookmarklet, or a browser-extension host.
 */

import { sanitizeCrop, sanitizeOutputScale } from './RedlineCrop.js';

const VALID_TYPES = new Set(['pen', 'arrow', 'rectangle', 'note', 'textbox', 'brush', 'line', 'polyline', 'polygon']);

/**
 * Shapes that enclose an area, and so can carry a fill.
 *
 * A text box is deliberately absent: it already has `backgroundOpacity` for its
 * dark backing, and giving it a second fill would leave two properties fighting
 * over one surface.
 */
const FILLABLE_TYPES = new Set(['rectangle', 'polygon']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function sanitizePoint(point) {
  return {
    x: finiteNumber(point?.x),
    y: finiteNumber(point?.y),
  };
}

/** Return a validated, detached annotation object. */
export function sanitizeAnnotation(annotation) {
  if (!annotation || !VALID_TYPES.has(annotation.type)) {
    throw new TypeError(`Unsupported redline annotation type: ${annotation?.type ?? 'missing'}`);
  }

  const base = {
    id: String(annotation.id || cryptoId()),
    type: annotation.type,
    color: String(annotation.color || '#b65d66'),
    width: Math.max(1 / 3, finiteNumber(annotation.width, 4 / 3)),
  };

  // What the mark means, carried into the export so a reader does not have to
  // infer intent from a hex value.
  const intent = String(annotation.intent ?? '').trim().slice(0, 32);
  if (intent) base.intent = intent;

  // `fill` defaults to the stroke colour, which is what lets one swatch set
  // stroke and fill together. Only a fill that will actually be painted is kept,
  // so an unfilled mark serialises exactly as it did before.
  if (FILLABLE_TYPES.has(annotation.type)) {
    const fillOpacity = Math.min(1, Math.max(0, finiteNumber(annotation.fillOpacity, 0)));
    if (fillOpacity > 0) {
      base.fillOpacity = fillOpacity;
      const fill = String(annotation.fill ?? '').trim();
      if (fill && fill.toUpperCase() !== base.color.toUpperCase()) base.fill = fill;
    }
    // A mark must paint something, so the outline can only be dropped when
    // there is a fill left to carry it.
    if (annotation.outline === false && fillOpacity > 0) base.outline = false;
  }

  if (['pen', 'brush', 'polyline', 'polygon'].includes(annotation.type)) {
    const points = Array.isArray(annotation.points)
      ? annotation.points.map(sanitizePoint)
      : [];
    if (points.length < 2) throw new TypeError('A path annotation requires at least two points.');
    const opacity = Math.min(1, Math.max(0, finiteNumber(annotation.opacity, annotation.type === 'brush' ? 0.35 : 1)));
    return { ...base, points, opacity };
  }

  if (annotation.type === 'note') {
    return {
      ...base,
      point: sanitizePoint(annotation.point),
      text: String(annotation.text ?? '').trim(),
      // Always the plain ordinal. How it is drawn is `marker`'s business, so a
      // sequence can be re-lettered without renumbering.
      number: Math.max(1, Math.floor(finiteNumber(annotation.number, 1))),
      // Only stored when it differs from the default, so existing notes
      // serialise exactly as they did.
      ...(annotation.marker === 'alpha' ? { marker: 'alpha' } : {}),
    };
  }

  if (annotation.type === 'textbox') {
    const start = sanitizePoint(annotation.start);
    const end = sanitizePoint(annotation.end);
    return {
      ...base,
      start: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) },
      end: { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y) },
      text: String(annotation.text ?? '').trim(),
      fontSize: Math.max(10, finiteNumber(annotation.fontSize, 16)),
      backgroundOpacity: Math.min(1, Math.max(0, finiteNumber(annotation.backgroundOpacity, 1))),
    };
  }

  return {
    ...base,
    start: sanitizePoint(annotation.start),
    end: sanitizePoint(annotation.end),
  };
}

/** A small fallback for non-secure test/file contexts without randomUUID. */
export function cryptoId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `redline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function sanitizeAnnotations(annotations) {
  if (!Array.isArray(annotations)) throw new TypeError('Annotations must be an array.');
  const clean = annotations.map(sanitizeAnnotation);
  const ids = new Set();
  for (const mark of clean) {
    if (ids.has(mark.id)) throw new TypeError('Duplicate redline annotation id: ' + mark.id);
    ids.add(mark.id);
  }
  return clean;
}

export class RedlineDocument {
  constructor({ width = 1, height = 1, annotations = [], crop = null, outputScale = 1 } = {}) {
    this.width = Math.max(1, finiteNumber(width, 1));
    this.height = Math.max(1, finiteNumber(height, 1));
    this._annotations = sanitizeAnnotations(annotations);
    this._crop = sanitizeCrop(crop, this.width, this.height);
    this.outputScale = sanitizeOutputScale(outputScale);
    this._undo = [];
    this._redo = [];
  }

  get annotations() { return clone(this._annotations); }
  get crop() { return this._crop ? { ...this._crop } : null; }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  // Export settings do not change marks or consume their undo history.
  setCrop(crop) { this._crop = sanitizeCrop(crop, this.width, this.height); }
  setOutputScale(scale) { this.outputScale = sanitizeOutputScale(scale); }

  _commit(next) {
    const clean = sanitizeAnnotations(next);
    this._undo.push(clone(this._annotations));
    this._redo.length = 0;
    this._annotations = clean;
  }

  add(annotation) {
    const clean = sanitizeAnnotation(annotation);
    this._commit([...this._annotations, clean]);
    return clone(clean);
  }

  replace(id, annotation) {
    const index = this._annotations.findIndex(item => item.id === id);
    if (index < 0) return false;
    const next = clone(this._annotations);
    next[index] = sanitizeAnnotation({ ...annotation, id });
    this._commit(next);
    return true;
  }

  remove(id) {
    if (!this._annotations.some(item => item.id === id)) return false;
    this._commit(this._annotations.filter(item => item.id !== id));
    return true;
  }

  clear() {
    if (!this._annotations.length) return false;
    this._commit([]);
    return true;
  }

  undo() {
    if (!this.canUndo) return false;
    this._redo.push(clone(this._annotations));
    this._annotations = this._undo.pop();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._undo.push(clone(this._annotations));
    this._annotations = this._redo.pop();
    return true;
  }

  /** Replace state without creating a history entry (used for import). */
  load(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('A redline document must be an object.');
    }
    const { width = this.width, height = this.height, annotations } = data;
    if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
      throw new TypeError('Document dimensions must be finite numbers of at least one pixel.');
    }
    // Validate the entire replacement before changing dimensions, marks or history.
    const clean = sanitizeAnnotations(annotations);
    const crop = sanitizeCrop(data.crop, width, height);
    const outputScale = sanitizeOutputScale(data.outputScale);
    this.width = width;
    this.height = height;
    this._annotations = clean;
    this._crop = crop;
    this.outputScale = outputScale;
    this._undo.length = 0;
    this._redo.length = 0;
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      annotations: this.annotations,
      ...(this._crop ? { crop: this.crop } : {}),
      ...(this.outputScale !== 1 ? { outputScale: this.outputScale } : {}),
    };
  }
}

/** Return a translated copy of an annotation. */
export function translateAnnotation(annotation, dx, dy) {
  const moved = clone(annotation);
  const movePoint = point => ({ x: point.x + dx, y: point.y + dy });
  if (['pen', 'brush', 'polyline', 'polygon'].includes(moved.type)) moved.points = moved.points.map(movePoint);
  else if (moved.type === 'note') moved.point = movePoint(moved.point);
  else {
    moved.start = movePoint(moved.start);
    moved.end = movePoint(moved.end);
  }
  return moved;
}
