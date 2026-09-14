/**
 * Drawing primitives, bounds and hit testing for redline marks.
 *
 * The SVG preview and the PNG renderer both draw the primitives returned by
 * `markPrimitives`, so decorations, text lines and clipping cannot disagree
 * between what the user sees and what they export. Coordinates are document
 * units. Nothing here touches the DOM.
 *
 * Primitive shapes:
 *   { kind: 'path', points, closed, stroke, fill }
 *   { kind: 'rect', x, y, width, height, radius, stroke, fill }
 *   { kind: 'ellipse', cx, cy, rx, ry, stroke, fill }
 *   { kind: 'text', lines: [{ text, x, y }], font: { size, weight }, color, anchor, clip }
 * where stroke is { color, width, opacity } or null and fill is
 * { color, opacity } or null.
 */

import { BULLET_GLYPH_SIZE, BULLET_RADIUS } from './RedlineLegend.js';
import {
  bulletGlyphColor, markDecorations, redlineMarkFill, redlineMarkStroked, redlineNoteGlyph, redlineTextBoxFill,
} from './RedlineStyles.js';
import { fontString, layoutNote, layoutTextBox, NOTE_RADIUS } from './RedlineTextLayout.js';

const EPSILON = 1e-6;

export function boxFromPoints(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** The eight resize handles of a text box, as [name, x, y]. */
export function textBoxHandlePoints(mark) {
  const box = boxFromPoints(mark.start, mark.end);
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    ['nw', box.x, box.y], ['n', cx, box.y], ['ne', right, box.y], ['e', right, cy],
    ['se', right, bottom], ['s', cx, bottom], ['sw', box.x, bottom], ['w', box.x, cy],
  ];
}

const finitePoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);

function strokeOf(mark, overrides = {}) {
  return { color: mark.color, width: mark.width, opacity: 1, ...overrides };
}

/** Radius of an open or filled circle end, growing gently with the stroke. */
export function decorationRadius(width) {
  return Math.max(4, width * 1.5 + 2.5);
}

/** Arrowhead wing length, as the original arrow tool drew it. */
export function arrowheadLength(width) {
  return Math.max(12, width * 4);
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/** Remove `distance` of path from the start, or return [] if nothing is left. */
function trimStart(points, distance) {
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > remaining + EPSILON) {
      const t = remaining / length;
      return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...points.slice(i)];
    }
    remaining -= length;
  }
  return [];
}

function trimEnd(points, distance) {
  return trimStart([...points].reverse(), distance).reverse();
}

/**
 * Unit direction pointing out of the path at one end, taken from the nearest
 * segment of nonzero length. Null when every point coincides.
 */
export function endDirection(points, which) {
  const ordered = which === 'start' ? points : [...points].reverse();
  const tip = ordered[0];
  for (let i = 1; i < ordered.length; i++) {
    const dx = tip.x - ordered[i].x;
    const dy = tip.y - ordered[i].y;
    const length = Math.hypot(dx, dy);
    if (length > EPSILON) return { x: dx / length, y: dy / length };
  }
  return null;
}

function decorationPrimitives(points, which, decoration, mark, stroke) {
  if (decoration === 'none' || !points.length) return [];
  const tip = which === 'start' ? points[0] : points.at(-1);
  if (decoration === 'arrow') {
    const direction = endDirection(points, which);
    if (!direction) return [];
    const angle = Math.atan2(direction.y, direction.x);
    const length = arrowheadLength(mark.width);
    const wing = offset => ({
      x: tip.x - length * Math.cos(angle + offset),
      y: tip.y - length * Math.sin(angle + offset),
    });
    return [{ kind: 'path', points: [wing(-Math.PI / 6), tip, wing(Math.PI / 6)], closed: false, stroke, fill: null }];
  }
  const r = decorationRadius(mark.width);
  if (decoration === 'open-circle') {
    return [{ kind: 'ellipse', cx: tip.x, cy: tip.y, rx: r, ry: r, stroke, fill: null }];
  }
  if (decoration === 'filled-circle') {
    return [{ kind: 'ellipse', cx: tip.x, cy: tip.y, rx: r, ry: r, stroke: null, fill: { color: mark.color, opacity: stroke.opacity } }];
  }
  return [];
}

function openPathPrimitives(points, mark, stroke) {
  const { start, end } = markDecorations(mark);
  const radius = decorationRadius(mark.width);
  let visible = points;
  // An open circle is hollow, so the line stops at its rim instead of
  // showing through it.
  if (start === 'open-circle') visible = trimStart(visible, radius);
  if (end === 'open-circle' && visible.length) visible = trimEnd(visible, radius);
  const primitives = [];
  if (visible.length >= 2 || (visible.length && pathLength(points) <= EPSILON)) {
    primitives.push({ kind: 'path', points: visible, closed: false, stroke, fill: null });
  }
  primitives.push(...decorationPrimitives(points, 'start', start, mark, stroke));
  primitives.push(...decorationPrimitives(points, 'end', end, mark, stroke));
  return primitives;
}

/** Everything a renderer needs to draw one mark. */
export function markPrimitives(mark, measurer) {
  const fill = redlineMarkFill(mark);
  const stroked = redlineMarkStroked(mark);
  switch (mark.type) {
    case 'pen':
    case 'brush':
    case 'polyline':
    case 'polygon': {
      const points = (mark.previewPoint ? [...mark.points, mark.previewPoint] : mark.points).filter(finitePoint);
      if (mark.type === 'brush') {
        return [{
          kind: 'path', points, closed: false, fill: null,
          stroke: strokeOf(mark, { width: Math.max(mark.width * 4, 6), opacity: mark.opacity ?? 0.35 }),
        }];
      }
      const stroke = strokeOf(mark, { opacity: mark.opacity ?? 1 });
      if (mark.type === 'polygon') {
        return [{
          kind: 'path', points, closed: true,
          fill: fill && points.length > 2 ? fill : null,
          stroke: stroked ? stroke : null,
        }];
      }
      if (mark.type === 'polyline') return openPathPrimitives(points, mark, stroke);
      return [{ kind: 'path', points, closed: false, stroke, fill: null }];
    }
    case 'line':
    case 'arrow':
      return openPathPrimitives([mark.start, mark.end], mark, strokeOf(mark));
    case 'rectangle': {
      const box = boxFromPoints(mark.start, mark.end);
      return [{ kind: 'rect', ...box, radius: 0, fill, stroke: stroked ? strokeOf(mark) : null }];
    }
    case 'ellipse': {
      const box = boxFromPoints(mark.start, mark.end);
      return [{
        kind: 'ellipse', cx: box.x + box.width / 2, cy: box.y + box.height / 2,
        rx: box.width / 2, ry: box.height / 2, fill, stroke: stroked ? strokeOf(mark) : null,
      }];
    }
    case 'textbox': {
      const layout = layoutTextBox(mark, measurer);
      return [
        {
          kind: 'rect', ...layout.box, radius: 4, hitArea: true,
          fill: { color: redlineTextBoxFill(mark.backgroundOpacity), opacity: 1 },
          stroke: strokeOf(mark),
        },
        { kind: 'text', lines: layout.lines, font: { size: layout.fontSize, weight: 400 }, color: '#292D32', anchor: 'start', clip: layout.clip },
      ];
    }
    case 'bullet': {
      // A soft dark halo and a white ring keep light and dark fills visible on
      // any page; the glyph colour follows the fill for contrast.
      const { ascent, descent } = measurer.metrics(fontString(BULLET_GLYPH_SIZE, 700));
      const { x, y } = mark.point;
      return [
        {
          kind: 'ellipse', cx: x, cy: y, rx: BULLET_RADIUS + 1.75, ry: BULLET_RADIUS + 1.75,
          fill: null, stroke: { color: 'rgba(31,35,40,0.45)', width: 1, opacity: 1 },
        },
        {
          kind: 'ellipse', cx: x, cy: y, rx: BULLET_RADIUS, ry: BULLET_RADIUS,
          fill: { color: mark.color, opacity: 1 }, stroke: { color: '#FFFFFF', width: 2, opacity: 1 },
        },
        {
          kind: 'text', lines: [{ text: mark.label, x, y: y + (ascent - descent) / 2 }],
          font: { size: BULLET_GLYPH_SIZE, weight: 700 }, color: bulletGlyphColor(mark.color), anchor: 'middle', clip: null,
        },
      ];
    }
    case 'note': {
      const layout = layoutNote(mark, redlineNoteGlyph(mark.number, mark.marker), measurer);
      return [
        {
          kind: 'ellipse', cx: mark.point.x, cy: mark.point.y, rx: NOTE_RADIUS, ry: NOTE_RADIUS,
          fill: { color: mark.color, opacity: 1 }, stroke: null,
        },
        {
          kind: 'text', lines: [{ text: layout.glyph.text, x: layout.glyph.x, y: layout.glyph.y }],
          font: { size: 14, weight: 700 }, color: '#FFFFFF', anchor: 'middle', clip: null,
        },
        {
          kind: 'rect', ...layout.label, radius: 5,
          fill: { color: 'rgba(255,255,255,0.96)', opacity: 1 },
          stroke: { color: mark.color, width: 2, opacity: 1 },
        },
        { kind: 'text', lines: layout.lines, font: { size: 14, weight: 600 }, color: '#111827', anchor: 'start', clip: null },
      ];
    }
    default:
      return [];
  }
}

function unionBounds(boxes) {
  const valid = boxes.filter(box => box && [box.x, box.y, box.width, box.height].every(Number.isFinite));
  if (!valid.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...valid.map(box => box.x));
  const top = Math.min(...valid.map(box => box.y));
  const right = Math.max(...valid.map(box => box.x + box.width));
  const bottom = Math.max(...valid.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function primitiveBounds(primitive) {
  const half = (primitive.stroke?.width ?? 0) / 2;
  const grow = box => ({ x: box.x - half, y: box.y - half, width: box.width + half * 2, height: box.height + half * 2 });
  if (primitive.kind === 'path') {
    if (!primitive.points.length) return null;
    const xs = primitive.points.map(point => point.x);
    const ys = primitive.points.map(point => point.y);
    return grow({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }
  if (primitive.kind === 'rect') return grow(primitive);
  if (primitive.kind === 'ellipse') {
    return grow({ x: primitive.cx - primitive.rx, y: primitive.cy - primitive.ry, width: primitive.rx * 2, height: primitive.ry * 2 });
  }
  return null;
}

/** Visual bounds of a mark, including decorations and stroke width. */
export function markBounds(mark, measurer) {
  return unionBounds(markPrimitives(mark, measurer).map(primitiveBounds));
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToPath(point, points, closed) {
  if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, distanceToSegment(point, points[i - 1], points[i]));
  if (closed && points.length > 2) best = Math.min(best, distanceToSegment(point, points.at(-1), points[0]));
  return best;
}

function hitsPrimitive(primitive, point, tolerance) {
  const reach = tolerance + (primitive.stroke?.width ?? 0) / 2;
  if (primitive.kind === 'path') {
    if (!primitive.points.length) return false;
    if (primitive.fill && primitive.points.length > 2 && pointInPolygon(point, primitive.points)) return true;
    return Boolean(primitive.stroke) && distanceToPath(point, primitive.points, primitive.closed) <= reach;
  }
  if (primitive.kind === 'rect') {
    const inside = point.x >= primitive.x && point.x <= primitive.x + primitive.width
      && point.y >= primitive.y && point.y <= primitive.y + primitive.height;
    if ((primitive.fill || primitive.hitArea) && inside) return true;
    if (!primitive.stroke) return false;
    const corners = [
      { x: primitive.x, y: primitive.y }, { x: primitive.x + primitive.width, y: primitive.y },
      { x: primitive.x + primitive.width, y: primitive.y + primitive.height }, { x: primitive.x, y: primitive.y + primitive.height },
    ];
    return distanceToPath(point, corners, true) <= reach;
  }
  if (primitive.kind === 'ellipse') {
    const { cx, cy, rx, ry } = primitive;
    if (rx < EPSILON || ry < EPSILON) {
      const a = { x: cx - rx, y: cy - ry };
      const b = { x: cx + rx, y: cy + ry };
      return distanceToSegment(point, a, b) <= (primitive.stroke ? reach : tolerance);
    }
    const nx = (point.x - cx) / rx;
    const ny = (point.y - cy) / ry;
    const k = Math.hypot(nx, ny);
    if (primitive.fill && k <= 1) return true;
    if (!primitive.stroke) return false;
    if (k < EPSILON) return Math.min(rx, ry) <= reach;
    const edge = { x: cx + (point.x - cx) / k, y: cy + (point.y - cy) / k };
    return Math.hypot(point.x - edge.x, point.y - edge.y) <= reach;
  }
  return false;
}

/**
 * Whether a point touches what a mark actually paints.
 *
 * An outline-only shape is hit on its outline, not anywhere inside its
 * bounding box, so clicking empty space inside a large box does not select or
 * erase it.
 */
export function hitTestMark(mark, point, tolerance, measurer) {
  return markPrimitives(mark, measurer).some(primitive => hitsPrimitive(primitive, point, tolerance));
}

/** Topmost mark under a point, or null. */
export function topmostMarkAt(marks, point, tolerance, measurer) {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (hitTestMark(marks[i], point, tolerance, measurer)) return marks[i];
  }
  return null;
}

/**
 * Snap a segment to the nearest multiple of `stepDegrees` as seen on screen.
 * `scale` converts document units to screen pixels on each axis, so the
 * constraint still produces true 45° lines after a nonuniform resize.
 */
export function snapAngle(origin, point, { stepDegrees = 45, scale = { x: 1, y: 1 } } = {}) {
  const dx = (point.x - origin.x) * scale.x;
  const dy = (point.y - origin.y) * scale.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return { x: point.x, y: point.y };
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const projected = Math.max(0, dx * ux + dy * uy);
  return { x: origin.x + (ux * projected) / scale.x, y: origin.y + (uy * projected) / scale.y };
}

/** Constrain a drag rectangle to a square on screen, keeping its direction. */
export function constrainSquare(start, point, { scale = { x: 1, y: 1 } } = {}) {
  const dx = (point.x - start.x) * scale.x;
  const dy = (point.y - start.y) * scale.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + ((dx < 0 ? -1 : 1) * size) / scale.x,
    y: start.y + ((dy < 0 ? -1 : 1) * size) / scale.y,
  };
}

/** Keep only the dominant screen axis of a move. */
export function constrainAxis(dx, dy, { scale = { x: 1, y: 1 } } = {}) {
  return Math.abs(dx * scale.x) >= Math.abs(dy * scale.y) ? { dx, dy: 0 } : { dx: 0, dy };
}

/** Points with consecutive near-duplicates removed. */
export function distinctPoints(points, epsilon = 0.5) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > epsilon) result.push(point);
  }
  if (result.length > 2) {
    const first = result[0];
    const last = result.at(-1);
    if (Math.hypot(first.x - last.x, first.y - last.y) <= epsilon) result.pop();
  }
  return result;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(area / 2);
}

/**
 * A newly drawn polygon must enclose something: at least three distinct points
 * that are not all on one line. Older documents may still hold two-point
 * polygons, which the model continues to load.
 */
export function isUsefulPolygon(points, epsilon = 0.5) {
  const distinct = distinctPoints(points, epsilon);
  return distinct.length >= 3 && polygonArea(distinct) > epsilon * epsilon;
}
