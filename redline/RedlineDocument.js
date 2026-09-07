/**
 * Framework-free state model for screen-space redline annotations.
 *
 * Coordinates are CSS pixels in the viewport size recorded when a redline
 * session starts. Keeping this model independent from the DOM makes it usable
 * from the editor, a bookmarklet, or a browser-extension host.
 */

const VALID_TYPES = new Set(['pen', 'brush', 'line', 'polyline', 'polygon', 'arrow', 'rectangle', 'note', 'textbox']);

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
      number: Math.max(1, Math.floor(finiteNumber(annotation.number, 1))),
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
  constructor({ width = 1, height = 1, annotations = [] } = {}) {
    this.width = Math.max(1, finiteNumber(width, 1));
    this.height = Math.max(1, finiteNumber(height, 1));
    this._annotations = sanitizeAnnotations(annotations);
    this._undo = [];
    this._redo = [];
  }

  get annotations() { return clone(this._annotations); }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

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
    this.width = width;
    this.height = height;
    this._annotations = clean;
    this._undo.length = 0;
    this._redo.length = 0;
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      annotations: this.annotations,
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
