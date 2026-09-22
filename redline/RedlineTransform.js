/**
 * Selection handles that resize and rotate marks, modelled on PowerPoint.
 *
 * A framed mark (rectangle, ellipse, text box, pen or highlighter stroke,
 * polyline, polygon) shows a frame with a handle on every corner and at the
 * middle of every edge, plus a rotate knob beyond the top edge. The frame is
 * the mark's upright box turned by its rotation, so the handles stay on the
 * shape after it turns. A straight line or arrow shows a handle on each end
 * instead. Bullets and notes are fixed-size markers and only move.
 *
 * Resizing happens in the mark's upright coordinates. The result is then
 * shifted so that what should hold still (the opposite handle, or the centre
 * with Ctrl) stays where it was on the page, whatever the rotation.
 *
 * Coordinates are document units; `scale` converts them to screen pixels so
 * handles keep a constant on-screen size and reach. Nothing here touches the
 * DOM.
 */

import { sanitizeRotation, translateAnnotation } from './RedlineDocument.js';
import {
  boxCenter, markFrame, markRotation, paintedStrokeWidth, rotatePoint, snapAngle,
} from './RedlineGeometry.js';
import { PATH_TYPES } from './RedlineStyles.js';
import { layoutTextBox, TEXTBOX_MIN_HEIGHT, TEXTBOX_MIN_WIDTH } from './RedlineTextLayout.js';

/** Screen-pixel sizes of the selection chrome, shared with the SVG layer. */
export const HANDLE_RADIUS = 5;
export const HANDLE_REACH = 8;
export const ROTATE_KNOB_RADIUS = 9;
/** Distance from the frame edge to the centre of the rotate knob. */
export const ROTATE_KNOB_OFFSET = 30;
export const DIRECT_POINT_RADIUS = 2;
export const DIRECT_POINT_REACH = 8;
/** Shift while rotating snaps to multiples of this many degrees. */
export const ROTATION_SNAP = 15;

const LINE_END_TYPES = new Set(['line', 'arrow']);
export const DIRECT_SELECTION_TYPES = new Set(['pen', 'brush', 'polyline', 'polygon']);
const ORIGIN = { x: 0, y: 0 };

/** Direction of each frame handle from the frame centre, in upright coordinates. */
const HANDLE_DIRECTIONS = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};
export const FRAME_HANDLES = Object.keys(HANDLE_DIRECTIONS);

const screenLength = (vector, scale) => Math.hypot(vector.x * scale.x, vector.y * scale.y);

/**
 * How far the frame sits outside a mark's geometry. Strokes grow by half
 * their painted width, so the handles surround the ink rather than its centre
 * line; shapes and text boxes keep their handles on the box, as PowerPoint does.
 */
function framePadding(mark) {
  return PATH_TYPES.has(mark.type) ? paintedStrokeWidth(mark) / 2 : 0;
}

/**
 * The frame of a framed mark: `box`, its upright geometry grown by the frame
 * padding; `geometry` and `pad`; `center`, the rotation pivot; and `rotation`.
 * Null for marks without a frame.
 */
export function selectionFrame(mark) {
  const geometry = markFrame(mark);
  if (!geometry) return null;
  const pad = framePadding(mark);
  return {
    box: { x: geometry.x - pad, y: geometry.y - pad, width: geometry.width + pad * 2, height: geometry.height + pad * 2 },
    geometry,
    pad,
    center: boxCenter(geometry),
    rotation: markRotation(mark),
  };
}

/** The rotate knob beyond the top edge, or below the frame when above would leave the surface. */
function rotateKnob({ box, center, rotation }, scale, bounds) {
  const up = rotatePoint({ x: 0, y: -1 }, ORIGIN, rotation);
  const reach = ROTATE_KNOB_OFFSET / Math.max(1e-6, screenLength(up, scale));
  const knob = side => {
    const from = rotatePoint({ x: center.x, y: center.y + (side * box.height) / 2 }, center, rotation);
    return { name: 'rotate', x: from.x - side * up.x * reach, y: from.y - side * up.y * reach, from };
  };
  const above = knob(-1);
  const inside = point => !bounds || (point.x >= 0 && point.x <= bounds.width && point.y >= 0 && point.y <= bounds.height);
  if (inside(above)) return above;
  const below = knob(1);
  return inside(below) ? below : above;
}

/**
 * Handles of a selected mark as `{ name, x, y }`: the eight frame handles and
 * the rotate knob (whose `from` is where its stem meets the frame) for a framed
 * mark, `start` and `end` for a straight line, and none for anything else.
 *
 * A stroke with no extent along one axis, such as a perfectly straight
 * underline, cannot be stretched along it, so the edge handles that would only
 * do that are left out. `bounds` ({ width, height }) keeps the knob on the
 * drawing surface.
 */
export function selectionHandles(mark, { scale = { x: 1, y: 1 }, bounds = null } = {}) {
  if (LINE_END_TYPES.has(mark?.type)) {
    return [{ name: 'start', x: mark.start.x, y: mark.start.y }, { name: 'end', x: mark.end.x, y: mark.end.y }];
  }
  const frame = selectionFrame(mark);
  if (!frame) return [];
  const { box, center, rotation, geometry } = frame;
  const flatX = geometry.width * screenLength(rotatePoint({ x: 1, y: 0 }, ORIGIN, rotation), scale) < 1;
  const flatY = geometry.height * screenLength(rotatePoint({ x: 0, y: 1 }, ORIGIN, rotation), scale) < 1;
  const handles = [];
  for (const name of FRAME_HANDLES) {
    const [ux, uy] = HANDLE_DIRECTIONS[name];
    if ((uy === 0 && flatX) || (ux === 0 && flatY)) continue;
    const upright = { x: center.x + (ux * box.width) / 2, y: center.y + (uy * box.height) / 2 };
    handles.push({ name, ...rotatePoint(upright, center, rotation) });
  }
  handles.push({ name: 'center', x: center.x, y: center.y });
  handles.push(rotateKnob(frame, scale, bounds));
  return handles;
}

/** The handle under a point, preferring the nearest when handles overlap. */
export function handleAt(mark, point, options = {}) {
  const scale = options.scale ?? { x: 1, y: 1 };
  let best = null;
  let bestDistance = Infinity;
  for (const handle of selectionHandles(mark, options)) {
    const distance = Math.hypot((point.x - handle.x) * scale.x, (point.y - handle.y) * scale.y);
    const reach = handle.name === 'rotate' ? ROTATE_KNOB_RADIUS + 2 : HANDLE_REACH;
    if (distance <= reach && distance < bestDistance) {
      best = handle.name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The pointer to show over a handle: `rotate`, `endpoint`, or `resize-e`,
 * `resize-se`, `resize-s` or `resize-sw` for the handle's on-screen direction,
 * so a rotated frame still shows arrows along the way it resizes.
 */
export function handleCursor(mark, handle, scale = { x: 1, y: 1 }) {
  if (handle === 'rotate') return 'rotate';
  if (handle === 'center') return 'move';
  if (handle === 'start' || handle === 'end') return 'endpoint';
  const direction = HANDLE_DIRECTIONS[handle];
  if (!direction) return null;
  const turned = rotatePoint({ x: direction[0], y: direction[1] }, ORIGIN, markRotation(mark));
  const degrees = (((Math.atan2(turned.y * scale.y, turned.x * scale.x) * 180) / Math.PI) + 360) % 180;
  return `resize-${['e', 'se', 's', 'sw'][Math.round(degrees / 45) % 4]}`;
}

/** Vertex positions as painted on the page, including object rotation. */
export function directSelectionPoints(mark) {
  if (!DIRECT_SELECTION_TYPES.has(mark?.type)) return [];
  const frame = selectionFrame(mark);
  const rotation = frame?.rotation ?? 0;
  return (mark.points ?? []).map((point, index) => ({
    index,
    ...(rotation ? rotatePoint(point, frame.center, rotation) : point),
  }));
}

export function directPointAt(mark, point, { scale = { x: 1, y: 1 } } = {}) {
  let best = null;
  let distance = Infinity;
  for (const vertex of directSelectionPoints(mark)) {
    const current = Math.hypot((point.x - vertex.x) * scale.x, (point.y - vertex.y) * scale.y);
    if (current <= DIRECT_POINT_REACH && current < distance) { best = vertex.index; distance = current; }
  }
  return best;
}

function closestOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 1e-9 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator)) : 0;
  const projected = { x: a.x + dx * t, y: a.y + dy * t };
  return { point: projected, distance: Math.hypot(point.x - projected.x, point.y - projected.y) };
}

/** Nearest editable segment, returned as the insertion index and point. */
export function directSegmentAt(mark, point, { scale = { x: 1, y: 1 }, reach = 7 } = {}) {
  if (!DIRECT_SELECTION_TYPES.has(mark?.type) || mark.points.length < 2) return null;
  const frame = selectionFrame(mark);
  const local = frame?.rotation ? rotatePoint(point, frame.center, -frame.rotation) : point;
  const scaled = value => ({ x: value.x * scale.x, y: value.y * scale.y });
  const target = scaled(local);
  let best = null;
  const count = mark.type === 'polygon' ? mark.points.length : mark.points.length - 1;
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % mark.points.length;
    const closest = closestOnSegment(target, scaled(mark.points[index]), scaled(mark.points[next]));
    if (closest.distance <= reach && (!best || closest.distance < best.distance)) {
      best = { index: index + 1, distance: closest.distance, point: { x: closest.point.x / scale.x, y: closest.point.y / scale.y } };
    }
  }
  return best;
}

export function moveDirectPoint(mark, index, from, to) {
  if (!DIRECT_SELECTION_TYPES.has(mark?.type) || !mark.points[index]) return mark;
  const frame = selectionFrame(mark);
  const a = frame?.rotation ? rotatePoint(from, frame.center, -frame.rotation) : from;
  const b = frame?.rotation ? rotatePoint(to, frame.center, -frame.rotation) : to;
  const points = mark.points.map((point, current) => current === index
    ? { x: point.x + b.x - a.x, y: point.y + b.y - a.y }
    : point);
  return { ...mark, points };
}

export function insertDirectPoint(mark, point, options = {}) {
  const segment = directSegmentAt(mark, point, options);
  if (!segment) return null;
  const points = [...mark.points];
  points.splice(segment.index, 0, segment.point);
  return { mark: { ...mark, points }, index: segment.index };
}

export function removeDirectPoint(mark, index) {
  if (!DIRECT_SELECTION_TYPES.has(mark?.type) || !mark.points[index]) return null;
  const minimum = mark.type === 'polygon' ? 3 : 2;
  if (mark.points.length <= minimum) return null;
  const points = mark.points.filter((_point, current) => current !== index);
  return { ...mark, points };
}

/**
 * Scale factor and fixed coordinate for one upright axis of a resize.
 *
 * `u` is the handle's direction on this axis (-1, 0 or 1) and `travel` the
 * pointer's upright movement. The dragged frame edge follows the pointer;
 * the geometry inside the padding follows it and may flip past the fixed edge,
 * except a text box, which stops at `minimum` instead.
 */
function resizeAxis({ u, travel, start, size, pad, fromCenter, minimum, flip }) {
  const pivot = fromCenter ? start + size / 2 : u < 0 ? start + size : start;
  if (u === 0 || size <= 1e-9) return { factor: 1, pivot };
  const pads = fromCenter ? 1 : 2;
  const base = fromCenter ? size / 2 : size;
  const extent = u * (base + pads * pad) + travel;
  const floor = fromCenter ? minimum / 2 : minimum;
  let target = Math.max(Math.abs(extent) - pads * pad, floor);
  if (flip && Math.sign(extent) === -u) target = -target;
  return { factor: target / base, pivot };
}

/**
 * Resize a mark by dragging one of its handles from `from` to `to`.
 *
 * Frame handles resize framed marks: Shift on a corner keeps the proportions
 * and Ctrl resizes about the centre. A text box never becomes smaller than its
 * minimum size or than the height its text needs at the new width. `start`
 * and `end` move a straight line's ends; Shift snaps the line to 45°.
 */
export function resizeMark(original, handle, from, to, {
  scale = { x: 1, y: 1 }, keepAspect = false, fromCenter = false, measurer = null,
} = {}) {
  if (handle === 'start' || handle === 'end') {
    if (!LINE_END_TYPES.has(original.type)) return original;
    const other = handle === 'start' ? original.end : original.start;
    let point = { x: original[handle].x + to.x - from.x, y: original[handle].y + to.y - from.y };
    if (keepAspect) point = snapAngle(other, point, { scale });
    return { ...original, [handle]: point };
  }
  const direction = HANDLE_DIRECTIONS[handle];
  const frame = selectionFrame(original);
  if (!direction || !frame) return original;
  const { geometry, pad, center, rotation } = frame;
  const [ux, uy] = direction;
  const a = rotatePoint(from, center, -rotation);
  const b = rotatePoint(to, center, -rotation);
  const textbox = original.type === 'textbox';
  // Keep at least a screen pixel along each axis, so a shape cannot vanish.
  const pixel = vector => 1 / Math.max(1e-6, screenLength(rotatePoint(vector, ORIGIN, rotation), scale));
  const x = resizeAxis({
    u: ux, travel: b.x - a.x, start: geometry.x, size: geometry.width, pad, fromCenter,
    minimum: textbox ? TEXTBOX_MIN_WIDTH : pixel({ x: 1, y: 0 }), flip: !textbox,
  });
  const y = resizeAxis({
    u: uy, travel: b.y - a.y, start: geometry.y, size: geometry.height, pad, fromCenter,
    minimum: textbox ? TEXTBOX_MIN_HEIGHT : pixel({ x: 0, y: 1 }), flip: !textbox,
  });
  if (keepAspect && ux !== 0 && uy !== 0 && geometry.width > 1e-9 && geometry.height > 1e-9) {
    const factor = Math.max(Math.abs(x.factor), Math.abs(y.factor));
    x.factor = Math.sign(x.factor) * factor;
    y.factor = Math.sign(y.factor) * factor;
  }
  if (textbox) {
    // The text decides how short the box can be at its new width.
    const width = geometry.width * x.factor;
    const probe = { ...original, start: { x: 0, y: 0 }, end: { x: width, y: 1 } };
    const minHeight = Math.max(TEXTBOX_MIN_HEIGHT, Math.ceil(layoutTextBox(probe, measurer).requiredHeight));
    if (geometry.height * y.factor < minHeight) y.factor = minHeight / Math.max(1e-9, geometry.height);
  }

  // Scale in upright coordinates, then shift so the fixed point keeps its
  // place on the page: a turned frame whose centre moved would otherwise swing.
  const mapX = value => x.pivot + (value - x.pivot) * x.factor;
  const mapY = value => y.pivot + (value - y.pivot) * y.factor;
  const nextCenter = {
    x: (mapX(geometry.x) + mapX(geometry.x + geometry.width)) / 2,
    y: (mapY(geometry.y) + mapY(geometry.y + geometry.height)) / 2,
  };
  const turned = rotatePoint(nextCenter, center, rotation);
  const dx = turned.x - nextCenter.x;
  const dy = turned.y - nextCenter.y;
  const place = point => ({ x: mapX(point.x) + dx, y: mapY(point.y) + dy });
  if (PATH_TYPES.has(original.type)) return { ...original, points: original.points.map(place) };
  const corner = place({ x: geometry.x, y: geometry.y });
  const opposite = place({ x: geometry.x + geometry.width, y: geometry.y + geometry.height });
  return {
    ...original,
    start: { x: Math.min(corner.x, opposite.x), y: Math.min(corner.y, opposite.y) },
    end: { x: Math.max(corner.x, opposite.x), y: Math.max(corner.y, opposite.y) },
  };
}

/**
 * Rotate a framed mark about its centre by the angle the pointer swept from
 * `from` to `to`. Shift snaps the result to 15° steps.
 */
export function rotateMark(original, from, to, { snap = false } = {}) {
  const geometry = markFrame(original);
  if (!geometry) return original;
  const center = boxCenter(geometry);
  const swept = Math.atan2(to.y - center.y, to.x - center.x) - Math.atan2(from.y - center.y, from.x - center.x);
  let degrees = markRotation(original) + (swept * 180) / Math.PI;
  if (snap) degrees = Math.round(degrees / ROTATION_SNAP) * ROTATION_SNAP;
  const { rotation: _previous, ...upright } = original;
  const rotation = sanitizeRotation(degrees);
  return rotation ? { ...upright, rotation } : upright;
}

/**
 * Keep a rotated mark's upright top-left corner where it was on the page after
 * its geometry changed size in its own coordinates, as when a rotated text box
 * grows while typing or for a larger font. Upright marks are returned as is.
 */
export function keepCornerInPlace(original, next) {
  const rotation = markRotation(original);
  if (!rotation) return next;
  const before = boxCenter(markFrame(original));
  const after = boxCenter(markFrame(next));
  const turned = rotatePoint(after, before, rotation);
  const dx = turned.x - after.x;
  const dy = turned.y - after.y;
  return Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 ? next : translateAnnotation(next, dx, dy);
}
