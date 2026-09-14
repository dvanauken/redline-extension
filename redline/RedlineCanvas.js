/**
 * Canvas renderer shared by PNG export and tests.
 *
 * It draws the primitives from RedlineGeometry.js, the same ones the live SVG
 * draws, measured with the same text measurer.
 */

import { cursorPrimitives } from './RedlineCursor.js';
import { markPrimitives } from './RedlineGeometry.js';
import { drawLegend, layoutLegend } from './RedlineLegend.js';
import { createApproximateMeasurer, fontString } from './RedlineTextLayout.js';

export {
  redlineMarkFill, redlineMarkStroked, redlineNoteGlyph, redlineTextBoxFill,
} from './RedlineStyles.js';

function tracePath(ctx, primitive) {
  const [first, ...rest] = primitive.points;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  if (primitive.closed) ctx.closePath();
}

function traceRect(ctx, { x, y, width, height, radius }) {
  ctx.beginPath();
  const r = Math.min(radius ?? 0, width / 2, height / 2);
  if (r > 0) ctx.roundRect(x, y, width, height, r);
  else ctx.rect(x, y, width, height);
}

function paint(ctx, primitive) {
  if (primitive.fill) {
    ctx.save();
    ctx.globalAlpha = primitive.fill.opacity;
    ctx.fillStyle = primitive.fill.color;
    ctx.fill();
    ctx.restore();
  }
  if (primitive.stroke) {
    ctx.save();
    ctx.globalAlpha = primitive.stroke.opacity;
    ctx.strokeStyle = primitive.stroke.color;
    ctx.lineWidth = primitive.stroke.width;
    ctx.stroke();
    ctx.restore();
  }
}

export function drawPrimitive(ctx, primitive) {
  if (primitive.kind === 'path') {
    if (!primitive.points.length) return;
    tracePath(ctx, primitive);
    paint(ctx, primitive);
  } else if (primitive.kind === 'rect') {
    traceRect(ctx, primitive);
    paint(ctx, primitive);
  } else if (primitive.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(primitive.cx, primitive.cy, Math.max(0, primitive.rx), Math.max(0, primitive.ry), 0, 0, Math.PI * 2);
    paint(ctx, primitive);
  } else if (primitive.kind === 'text') {
    ctx.save();
    if (primitive.clip) {
      ctx.beginPath();
      ctx.rect(primitive.clip.x, primitive.clip.y, primitive.clip.width, primitive.clip.height);
      ctx.clip();
    }
    ctx.font = fontString(primitive.font.size, primitive.font.weight);
    ctx.fillStyle = primitive.color;
    ctx.textAlign = primitive.anchor === 'middle' ? 'center' : 'left';
    ctx.textBaseline = 'alphabetic';
    for (const line of primitive.lines) {
      if (line.text) ctx.fillText(line.text, line.x, line.y);
    }
    ctx.restore();
  }
}

export function drawRedlineAnnotations(ctx, annotations, {
  scaleX = 1,
  scaleY = scaleX,
  measurer = createApproximateMeasurer(),
} = {}) {
  ctx.save();
  ctx.scale(scaleX, scaleY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const mark of annotations) {
    for (const primitive of markPrimitives(mark, measurer)) drawPrimitive(ctx, primitive);
  }
  ctx.restore();
}

/** The export legend layout for a document snapshot, or null when none is drawn. */
export function prepareLegendLayout(snapshot, measurer) {
  if (!snapshot.legend?.visible) return null;
  const layout = layoutLegend(snapshot.legend, snapshot.annotations, measurer);
  return layout.rows.length ? layout : null;
}

/** Draw the pointer proxy, if the snapshot includes a visible one. */
export function drawRedlineCursor(ctx, cursor, { scaleX = 1, scaleY = scaleX } = {}) {
  if (!cursor?.visible) return;
  ctx.save();
  ctx.scale(scaleX, scaleY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const primitive of cursorPrimitives(cursor)) drawPrimitive(ctx, primitive);
  ctx.restore();
}

/**
 * Draw a document snapshot (RedlineDocument#toJSON): its marks, then its legend
 * when visible with at least one bullet to explain, then the pointer proxy when
 * included. No editing decoration is ever drawn here. `cursor: false` leaves
 * the proxy out, for a capture that already contains real cursor pixels.
 */
export function drawRedlineDocument(ctx, snapshot, {
  scaleX = 1,
  scaleY = scaleX,
  measurer = createApproximateMeasurer(),
  cursor = true,
} = {}) {
  drawRedlineAnnotations(ctx, snapshot.annotations, { scaleX, scaleY, measurer });
  const layout = prepareLegendLayout(snapshot, measurer);
  if (layout) {
    ctx.save();
    ctx.scale(scaleX, scaleY);
    drawLegend(ctx, layout, { measurer });
    ctx.restore();
  }
  if (cursor) drawRedlineCursor(ctx, snapshot.cursor, { scaleX, scaleY });
}
