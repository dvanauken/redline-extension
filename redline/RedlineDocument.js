/**
 * Framework-free state model for screen-space redline annotations.
 *
 * Coordinates are CSS pixels in the viewport size recorded when a redline
 * session starts. Keeping this model independent from the DOM makes it usable
 * from the editor, a bookmarklet, or a browser-extension host.
 *
 * Stored marks are frozen. History entries share unchanged marks rather than
 * cloning the whole document for every edit, and the undo stack is bounded.
 * Each history entry is a snapshot of the marks and the legend together.
 *
 * Export settings (crop, output scale and the optional pointer proxy) live
 * beside the marks but outside their undo history.
 *
 * `revision` increases with every change to anything `toJSON()` returns, so a
 * host can notice changes (for reload recovery) without serialising.
 */

import { sanitizeCrop, sanitizeOutputScale } from './RedlineCrop.js';
import { CURSOR_FIELDS, sanitizeCursor } from './RedlineCursor.js';
import {
  LEGEND_FIELDS, isBulletLabel, legendToJSON, sanitizeExplanation, sanitizeLegend,
} from './RedlineLegend.js';
import {
  CLOSED_TYPES, DECORATIONS, FRAMED_TYPES, LINE_TYPES, STROKE_OPACITY_TYPES, normalizeLineEnds, defaultDecorations,
} from './RedlineStyles.js';
import { sanitizeTextFields } from './RedlineShapeText.js';

const VALID_TYPES = new Set([
  'pen', 'arrow', 'rectangle', 'note', 'textbox', 'ellipse', 'bullet', 'brush', 'line', 'polyline', 'polygon',
]);

export const HISTORY_LIMIT = 200;

/** Fields each type understands, so an import can say what it could not keep. */
const BASE_FIELDS = ['id', 'type', 'color', 'width', 'intent'];
const FILL_FIELDS = ['fill', 'fillOpacity', 'outline', 'savedFill'];
const DECORATION_FIELDS = ['startDecoration', 'endDecoration'];
const TEXT_FIELDS = [
  'text', 'fontSize', 'fontFamily', 'textColor', 'bold', 'italic', 'underline',
  'textAlign', 'verticalAlign', 'textRuns',
];
const TYPE_FIELDS = {
  pen: ['points', 'opacity', 'rotation'],
  brush: ['points', 'opacity', 'rotation'],
  polyline: ['points', 'opacity', 'rotation', ...DECORATION_FIELDS],
  polygon: ['points', 'opacity', 'rotation', ...FILL_FIELDS, ...TEXT_FIELDS],
  line: ['start', 'end', 'opacity', ...DECORATION_FIELDS],
  arrow: ['start', 'end', 'opacity', ...DECORATION_FIELDS],
  rectangle: ['start', 'end', 'rotation', 'opacity', ...FILL_FIELDS, ...TEXT_FIELDS],
  ellipse: ['start', 'end', 'rotation', 'opacity', ...FILL_FIELDS, ...TEXT_FIELDS],
  note: ['point', 'text', 'number', 'marker'],
  bullet: ['point', 'label', 'text'],
  textbox: ['start', 'end', 'backgroundOpacity', 'rotation', 'opacity', ...TEXT_FIELDS],
};
const DOCUMENT_FIELDS = ['width', 'height', 'annotations', 'crop', 'outputScale', 'legend', 'cursor'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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

function sanitizeDecoration(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!DECORATIONS.includes(value)) {
    throw new TypeError(`Unsupported ${name}: ${String(value).slice(0, 40)}`);
  }
  return value;
}

/**
 * Clockwise degrees in [0, 360), or 0 when absent. A rotation that is not a
 * finite number rejects the import rather than silently straightening the mark.
 */
export function sanitizeRotation(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid rotation: expected a number of degrees, got ${String(value).slice(0, 40)}`);
  }
  const degrees = Math.round((((value % 360) + 360) % 360) * 1e6) / 1e6;
  return degrees === 360 ? 0 : degrees;
}

/** Return a validated, detached annotation object. */
export function sanitizeAnnotation(annotation) {
  if (!annotation || !VALID_TYPES.has(annotation.type)) {
    throw new TypeError(`Unsupported redline annotation type: ${annotation?.type ?? 'missing'}`);
  }

  let type = annotation.type;
  const decorationFields = {};
  if (LINE_TYPES.has(type)) {
    const fallback = defaultDecorations(type);
    const start = sanitizeDecoration(annotation.startDecoration, fallback.start, 'start decoration');
    const end = sanitizeDecoration(annotation.endDecoration, fallback.end, 'end decoration');
    const normal = normalizeLineEnds(type, start, end);
    type = normal.type;
    if (normal.startDecoration) decorationFields.startDecoration = normal.startDecoration;
    if (normal.endDecoration) decorationFields.endDecoration = normal.endDecoration;
  }

  const base = {
    id: String(annotation.id || cryptoId()),
    type,
    color: String(annotation.color || '#b65d66'),
    width: Math.max(1 / 3, finiteNumber(annotation.width, 4 / 3)),
  };

  // What the mark means, carried into the export so a reader does not have to
  // infer intent from a hex value.
  const intent = String(annotation.intent ?? '').trim().slice(0, 32);
  if (intent) base.intent = intent;

  // Framed marks turn about the centre of their unrotated box. Upright marks
  // omit the field, so they serialise exactly as before.
  const rotation = FRAMED_TYPES.has(type) ? sanitizeRotation(annotation.rotation) : 0;
  const rotationFields = rotation ? { rotation } : {};
  const strokeOpacity = STROKE_OPACITY_TYPES.has(type)
    ? Math.min(1, Math.max(0, finiteNumber(annotation.opacity, type === 'brush' ? 0.35 : 1)))
    : 1;
  const opacityFields = STROKE_OPACITY_TYPES.has(type) && annotation.opacity !== undefined && strokeOpacity !== 1
    ? { opacity: strokeOpacity }
    : {};

  // `fill` defaults to the stroke colour, which is what lets one swatch set
  // stroke and fill together. Painted fill fields remain absent on outlines;
  // savedFill only remembers a fill the user has explicitly hidden.
  if (CLOSED_TYPES.has(type)) {
    const fillOpacity = Math.min(1, Math.max(0, finiteNumber(annotation.fillOpacity, 0)));
    if (fillOpacity > 0) {
      base.fillOpacity = fillOpacity;
      const fill = String(annotation.fill ?? '').trim();
      if (fill && fill.toUpperCase() !== base.color.toUpperCase()) base.fill = fill;
    }
    if (annotation.savedFill !== undefined && annotation.savedFill !== null) {
      const saved = annotation.savedFill;
      if (typeof saved !== 'object' || Array.isArray(saved)
        || typeof saved.color !== 'string' || !saved.color.trim()
        || !Number.isFinite(saved.opacity) || saved.opacity <= 0 || saved.opacity > 1) {
        throw new TypeError('Invalid saved fill: expected a colour and opacity in (0, 1].');
      }
      if (fillOpacity === 0) base.savedFill = { color: saved.color.trim(), opacity: saved.opacity };
    }
    // A mark must paint something, so the outline can only be dropped when
    // there is a fill left to carry it.
    if (annotation.outline === false && fillOpacity > 0) base.outline = false;
  }

  if (['pen', 'brush', 'polyline', 'polygon'].includes(type)) {
    const points = Array.isArray(annotation.points)
      ? annotation.points.map(sanitizePoint)
      : [];
    if (points.length < 2) throw new TypeError('A path annotation requires at least two points.');
    const opacity = Math.min(1, Math.max(0, finiteNumber(annotation.opacity, type === 'brush' ? 0.35 : 1)));
    const text = type === 'polygon' ? String(annotation.text ?? '').replace(/\r\n?/g, '\n').trim() : '';
    return {
      ...base, points, opacity, ...decorationFields, ...rotationFields,
      ...(type === 'polygon' ? sanitizeTextFields(annotation, text) : {}),
    };
  }

  if (type === 'bullet') {
    // New fields are validated strictly: a malformed bullet rejects the import
    // instead of being coerced into a different marker.
    if (!isBulletLabel(annotation.label)) {
      throw new TypeError(`A bullet label must be one character from 1–9 or A–Z: ${String(annotation.label).slice(0, 12)}`);
    }
    const { point } = annotation;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TypeError('A bullet requires a point with finite x and y.');
    }
    const text = sanitizeExplanation(annotation.text);
    return { ...base, point: { x: point.x, y: point.y }, label: annotation.label, ...(text ? { text } : {}) };
  }

  if (type === 'note') {
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

  if (type === 'textbox') {
    const start = sanitizePoint(annotation.start);
    const end = sanitizePoint(annotation.end);
    const text = String(annotation.text ?? '').replace(/\r\n?/g, '\n').trim();
    return {
      ...base,
      start: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) },
      end: { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y) },
      text,
      ...sanitizeTextFields(annotation, text),
      backgroundOpacity: Math.min(1, Math.max(0, finiteNumber(annotation.backgroundOpacity, 0.75))),
      ...opacityFields,
      ...rotationFields,
    };
  }

  const shapeText = CLOSED_TYPES.has(type) ? String(annotation.text ?? '').replace(/\r\n?/g, '\n').trim() : '';
  return {
    ...base,
    start: sanitizePoint(annotation.start),
    end: sanitizePoint(annotation.end),
    ...decorationFields,
    ...opacityFields,
    ...rotationFields,
    ...sanitizeTextFields(annotation, shapeText, { legacyRectangle: type === 'rectangle' }),
  };
}

/** A small fallback for non-secure test/file contexts without randomUUID. */
export function cryptoId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `redline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function assertUniqueIds(marks) {
  const ids = new Set();
  for (const mark of marks) {
    if (ids.has(mark.id)) throw new TypeError('Duplicate redline annotation id: ' + mark.id);
    ids.add(mark.id);
  }
}

/**
 * Two bullets reading "3" would make "see 3" ambiguous. Legacy notes number
 * separately and may repeat, as they always could.
 */
function assertUniqueBulletLabels(marks) {
  const labels = new Set();
  for (const mark of marks) {
    if (mark.type !== 'bullet') continue;
    if (labels.has(mark.label)) throw new TypeError('Duplicate bullet label: ' + mark.label);
    labels.add(mark.label);
  }
}

function assertValidMarks(marks) {
  assertUniqueIds(marks);
  assertUniqueBulletLabels(marks);
}

function sanitizeAnnotations(annotations) {
  if (!Array.isArray(annotations)) throw new TypeError('Annotations must be an array.');
  const clean = annotations.map(annotation => deepFreeze(sanitizeAnnotation(annotation)));
  assertValidMarks(clean);
  return clean;
}

/**
 * Names of fields an import carries that this version does not understand.
 * They cannot be kept, so the caller reports them instead of dropping them
 * silently.
 */
export function unsupportedFields(data) {
  const ignored = new Set();
  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) if (!DOCUMENT_FIELDS.includes(key)) ignored.add(`document.${key}`);
    if (data.legend && typeof data.legend === 'object' && !Array.isArray(data.legend)) {
      for (const key of Object.keys(data.legend)) if (!LEGEND_FIELDS.includes(key)) ignored.add(`legend.${key}`);
    }
    if (data.cursor && typeof data.cursor === 'object' && !Array.isArray(data.cursor)) {
      for (const key of Object.keys(data.cursor)) if (!CURSOR_FIELDS.includes(key)) ignored.add(`cursor.${key}`);
    }
    for (const annotation of Array.isArray(data.annotations) ? data.annotations : []) {
      if (!annotation || typeof annotation !== 'object') continue;
      const known = new Set([...BASE_FIELDS, ...(TYPE_FIELDS[annotation.type] ?? [])]);
      for (const key of Object.keys(annotation)) if (!known.has(key)) ignored.add(`${annotation.type}.${key}`);
    }
  }
  return [...ignored].sort();
}

/**
 * History entries hold the marks and the legend together, so a legend move or
 * a bullet deletion undoes as one step and restores exactly what was there.
 */
function snapshot(annotations, legend) {
  return Object.freeze({ annotations: Object.freeze(annotations), legend });
}

export class RedlineDocument {
  constructor({ width = 1, height = 1, annotations = [], crop = null, outputScale = 1, legend = null, cursor = null } = {}) {
    this.width = Math.max(1, finiteNumber(width, 1));
    this.height = Math.max(1, finiteNumber(height, 1));
    this._state = snapshot(sanitizeAnnotations(annotations), sanitizeLegend(legend, this.width, this.height));
    this._crop = sanitizeCrop(crop, this.width, this.height);
    this._outputScale = sanitizeOutputScale(outputScale);
    this._cursor = sanitizeCursor(cursor, this.width, this.height);
    this._undo = [];
    this._redo = [];
    this._mergeKey = null;
    this.revision = 0;
  }

  /** Detached copies, safe for callers to modify. */
  get annotations() { return clone(this._state.annotations); }
  /** The stored, frozen marks. Cheap to read on every frame; never mutate. */
  get marks() { return this._state.annotations; }
  /** The frozen legend, or null when the document has never had one. */
  get legend() { return this._state.legend; }
  get crop() { return this._crop ? { ...this._crop } : null; }
  get outputScale() { return this._outputScale; }
  set outputScale(scale) { this.setOutputScale(scale); }
  /** The frozen pointer proxy `{visible, x, y}`, or null when never placed. */
  get cursor() { return this._cursor; }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  find(id) {
    return this._state.annotations.find(mark => mark.id === id) ?? null;
  }

  // Export settings do not change marks or consume their undo history.
  setCrop(crop) {
    this._crop = sanitizeCrop(crop, this.width, this.height);
    this.revision += 1;
  }

  setOutputScale(scale) {
    this._outputScale = sanitizeOutputScale(scale);
    this.revision += 1;
  }

  /** Place, move, show or hide the pointer proxy. Returns the stored cursor. */
  setCursor(cursor) {
    const clean = sanitizeCursor(cursor, this.width, this.height);
    const current = this._cursor;
    if (clean && current && clean.visible === current.visible && clean.x === current.x && clean.y === current.y) return current;
    if (!clean && !current) return null;
    this._cursor = clean;
    this.revision += 1;
    return clean;
  }

  /**
   * Replace the marks and/or the legend with already validated values.
   *
   * `mergeKey` folds a run of edits that share it, such as held arrow-key
   * nudges, one erasing drag, or placing a bullet and typing its explanation,
   * into a single undo step.
   */
  _commit({ annotations = this._state.annotations, legend = this._state.legend }, { mergeKey = null } = {}) {
    assertValidMarks(annotations);
    const merging = mergeKey !== null && mergeKey === this._mergeKey && this._undo.length > 0;
    if (!merging) {
      this._undo.push(this._state);
      if (this._undo.length > HISTORY_LIMIT) this._undo.splice(0, this._undo.length - HISTORY_LIMIT);
    }
    this._redo.length = 0;
    this._state = snapshot(annotations, legend);
    this._mergeKey = mergeKey;
    this.revision += 1;
  }

  /** End any run of merged edits, so the next edit starts a new undo step. */
  breakMerge() { this._mergeKey = null; }

  add(annotation, options) {
    const clean = deepFreeze(sanitizeAnnotation(annotation));
    this._commit({ annotations: [...this._state.annotations, clean] }, options);
    return clone(clean);
  }

  replace(id, annotation, options) {
    const index = this._state.annotations.findIndex(item => item.id === id);
    if (index < 0) return false;
    const next = [...this._state.annotations];
    next[index] = deepFreeze(sanitizeAnnotation({ ...annotation, id }));
    this._commit({ annotations: next }, options);
    return true;
  }

  remove(id, options) {
    if (!this._state.annotations.some(item => item.id === id)) return false;
    this._commit({ annotations: this._state.annotations.filter(item => item.id !== id) }, options);
    return true;
  }

  clear() {
    if (!this._state.annotations.length) return false;
    this._commit({ annotations: [] });
    return true;
  }

  /** Replace the legend as one undo step. Returns the stored legend. */
  setLegend(legend, options) {
    const clean = sanitizeLegend(legend, this.width, this.height);
    this._commit({ legend: clean }, options);
    return clean;
  }

  undo() {
    if (!this.canUndo) return false;
    this._redo.push(this._state);
    this._state = this._undo.pop();
    this._mergeKey = null;
    this.revision += 1;
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._undo.push(this._state);
    this._state = this._redo.pop();
    this._mergeKey = null;
    this.revision += 1;
    return true;
  }

  /**
   * Replace state without creating a history entry (used for import).
   * Returns the names of fields that could not be kept.
   *
   * Everything is validated before anything changes. `prepare(snapshot)` runs
   * after validation and before the swap, so a host can lay out and measure the
   * incoming document first; if it throws, the current document, crop and both
   * history stacks are untouched.
   */
  load(data, { prepare = null } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('A redline document must be an object.');
    }
    const { width = this.width, height = this.height, annotations } = data;
    if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
      throw new TypeError('Document dimensions must be finite numbers of at least one pixel.');
    }
    // Validate the entire replacement before changing dimensions, marks or history.
    const clean = sanitizeAnnotations(annotations);
    const legend = sanitizeLegend(data.legend, width, height);
    const crop = sanitizeCrop(data.crop, width, height);
    const outputScale = sanitizeOutputScale(data.outputScale);
    const cursor = sanitizeCursor(data.cursor, width, height);
    const ignored = unsupportedFields(data);
    prepare?.({ width, height, annotations: clean, legend, crop, outputScale, cursor });
    this.width = width;
    this.height = height;
    this._state = snapshot(clean, legend);
    this._crop = crop;
    this._outputScale = outputScale;
    this._cursor = cursor;
    this._undo.length = 0;
    this._redo.length = 0;
    this._mergeKey = null;
    this.revision += 1;
    return { ignoredFields: ignored };
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      annotations: this.annotations,
      ...(this._crop ? { crop: this.crop } : {}),
      ...(this.outputScale !== 1 ? { outputScale: this.outputScale } : {}),
      ...(this._state.legend ? { legend: legendToJSON(this._state.legend) } : {}),
      ...(this._cursor ? { cursor: { ...this._cursor } } : {}),
    };
  }
}

/** Return a translated copy of an annotation. */
export function translateAnnotation(annotation, dx, dy) {
  const moved = clone(annotation);
  const movePoint = point => ({ x: point.x + dx, y: point.y + dy });
  if (['pen', 'brush', 'polyline', 'polygon'].includes(moved.type)) moved.points = moved.points.map(movePoint);
  else if (moved.type === 'note' || moved.type === 'bullet') moved.point = movePoint(moved.point);
  else {
    moved.start = movePoint(moved.start);
    moved.end = movePoint(moved.end);
  }
  return moved;
}
