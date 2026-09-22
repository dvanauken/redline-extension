/**
 * Bullets and their legend: label allocation, validation, layout, caret
 * geometry, hit testing and drawing.
 *
 * Nothing here touches the DOM. The live legend canvas and the PNG export both
 * call `layoutLegend` and `drawLegend`, measured with one measurer, so what is
 * edited is exactly what is exported. Editing decorations (caret, selection,
 * placeholders, handles, warnings) are drawn only when the caller passes them,
 * which the export never does.
 *
 * A bullet owns its explanation (`text`), so the link between a legend row and
 * its marker is the bullet's stable id, never a label or an array position.
 * Rows are ordered by label: 1–9, then A–Z. Moving a bullet cannot reorder or
 * renumber anything.
 */

import { bulletGlyphColor } from './RedlineStyles.js';
import {
  REDLINE_FONT_FAMILY, baselineOffset, displayText, fontString, graphemeBoundaries, layoutPreservedText,
} from './RedlineTextLayout.js';

export const BULLET_LABELS = Object.freeze({
  numeric: Object.freeze([...'123456789']),
  alpha: Object.freeze([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']),
});
export const BULLET_SCHEMES = Object.freeze({
  numeric: Object.freeze({ range: '1–9', noun: 'numbered' }),
  alpha: Object.freeze({ range: 'A–Z', noun: 'lettered' }),
});
export const BULLET_RADIUS = 13;
export const BULLET_GLYPH_SIZE = 14;
export const EXPLANATION_MAX_LENGTH = 10000;

export const isBulletLabel = value => typeof value === 'string' && /^[1-9A-Z]$/.test(value);
export const normalizeScheme = value => (value === 'alpha' ? 'alpha' : 'numeric');
export const bulletSchemeOf = label => (/^[1-9]$/.test(label) ? 'numeric' : 'alpha');
export const otherScheme = scheme => (normalizeScheme(scheme) === 'alpha' ? 'numeric' : 'alpha');

function usedLabels(marks) {
  return new Set(marks.filter(mark => mark.type === 'bullet').map(mark => mark.label));
}

/** The lowest label of a scheme not used by any bullet, or null when all are used. */
export function nextBulletLabel(marks, scheme) {
  const used = usedLabels(marks);
  return BULLET_LABELS[normalizeScheme(scheme)].find(label => !used.has(label)) ?? null;
}

export function bulletLabelStatus(marks, scheme) {
  const labels = BULLET_LABELS[normalizeScheme(scheme)];
  const used = usedLabels(marks);
  return {
    scheme: normalizeScheme(scheme),
    next: labels.find(label => !used.has(label)) ?? null,
    used: labels.filter(label => used.has(label)).length,
    total: labels.length,
  };
}

/**
 * Why a bullet cannot be placed in `scheme`, or null when it can. Names the
 * other scheme only when it still has a free label; never switches by itself.
 */
export function bulletLimit(marks, scheme) {
  const current = normalizeScheme(scheme);
  if (nextBulletLabel(marks, current)) return null;
  const other = otherScheme(current);
  const otherAvailable = Boolean(nextBulletLabel(marks, other));
  const { range, noun } = BULLET_SCHEMES[current];
  const total = BULLET_LABELS[current].length;
  const message = otherAvailable
    ? `All ${total} ${noun} bullets (${range}) are in use. Delete one, or switch labels to ${BULLET_SCHEMES[other].range}.`
    : `All ${BULLET_LABELS.numeric.length + BULLET_LABELS.alpha.length} bullet labels (1–9 and A–Z) are in use. Delete a bullet to place another.`;
  return { scheme: current, other, otherAvailable, message };
}

export function compareBulletLabels(a, b) {
  const rank = label => (/^[1-9]$/.test(label) ? 0 : 1);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Bullets in legend row order. */
export function legendBullets(marks) {
  return marks.filter(mark => mark.type === 'bullet').sort((a, b) => compareBulletLabels(a.label, b.label));
}

/** Validated explanation text: line endings normalised, otherwise verbatim. */
export function sanitizeExplanation(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError('A bullet explanation must be text.');
  const text = value.replace(/\r\n?/g, '\n');
  if (text.length > EXPLANATION_MAX_LENGTH) {
    throw new TypeError(`A bullet explanation is limited to ${EXPLANATION_MAX_LENGTH.toLocaleString('en-US')} characters.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Legend state

export const LEGEND_FONT_FAMILIES = Object.freeze({
  'sans-serif': REDLINE_FONT_FAMILY,
  serif: 'Georgia, "Times New Roman", Times, "Liberation Serif", serif',
  monospace: 'Consolas, "Courier New", "Liberation Mono", monospace',
});
export const LEGEND_FONT_OPTIONS = [['Sans-serif', 'sans-serif'], ['Serif', 'serif'], ['Monospace', 'monospace']];
export const LEGEND_FONT_SIZES = [12, 14, 16, 18, 20, 24];
export const LEGEND_WIDTHS = [200, 260, 320, 400, 500, 640];
export const LEGEND_MIN_FONT_SIZE = 10;
export const LEGEND_MAX_FONT_SIZE = 48;
export const LEGEND_MIN_WIDTH = 140;
export const LEGEND_MIN_HEIGHT = 24;
export const LEGEND_MAX_EXTENT = 20000;
export const LEGEND_DEFAULT_WIDTH = 320;
export const LEGEND_DEFAULT_FONT_SIZE = 14;
export const LEGEND_MARGIN = 16;
export const LEGEND_FIELDS = Object.freeze(['visible', 'x', 'y', 'width', 'height', 'fontSize', 'fontFamily']);

export function defaultLegend(docWidth, docHeight, { visible = false, top = LEGEND_MARGIN } = {}) {
  const width = Math.max(LEGEND_MIN_WIDTH, Math.min(LEGEND_DEFAULT_WIDTH, docWidth - LEGEND_MARGIN * 2));
  return {
    visible,
    x: Math.max(0, docWidth - width - LEGEND_MARGIN),
    y: Math.max(0, Math.min(top, docHeight - LEGEND_MIN_HEIGHT)),
    width,
    height: null,
    fontSize: LEGEND_DEFAULT_FONT_SIZE,
    fontFamily: 'sans-serif',
  };
}

/**
 * A validated, frozen legend, or null when there is none. Geometry that is
 * missing defaults from the document size; anything present but malformed
 * rejects the whole document. `height` null means "fit the text".
 */
export function sanitizeLegend(value, docWidth = 1, docHeight = 1) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('The legend must be an object.');
  if (typeof value.visible !== 'boolean') throw new TypeError('legend.visible must be true or false.');
  const fallback = defaultLegend(docWidth, docHeight);
  const number = (key, min, max) => {
    if (value[key] === undefined) return fallback[key];
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      throw new TypeError(`legend.${key} must be a number from ${min} to ${max}.`);
    }
    return n;
  };
  const fontFamily = value.fontFamily ?? fallback.fontFamily;
  if (typeof fontFamily !== 'string' || !Object.hasOwn(LEGEND_FONT_FAMILIES, fontFamily)) {
    throw new TypeError(`legend.fontFamily must be one of: ${Object.keys(LEGEND_FONT_FAMILIES).join(', ')}.`);
  }
  return Object.freeze({
    visible: value.visible,
    x: number('x', -LEGEND_MAX_EXTENT, LEGEND_MAX_EXTENT),
    y: number('y', -LEGEND_MAX_EXTENT, LEGEND_MAX_EXTENT),
    width: number('width', LEGEND_MIN_WIDTH, LEGEND_MAX_EXTENT),
    height: value.height === null ? null : number('height', LEGEND_MIN_HEIGHT, LEGEND_MAX_EXTENT),
    fontSize: number('fontSize', LEGEND_MIN_FONT_SIZE, LEGEND_MAX_FONT_SIZE),
    fontFamily,
  });
}

/** Plain JSON for a legend; an automatic height is omitted. */
export function legendToJSON(legend) {
  if (!legend) return null;
  const { height, ...rest } = legend;
  return height === null ? { ...rest } : { ...rest, height };
}

// ---------------------------------------------------------------------------
// Layout

/** Spacing derived from the font size, in document units. */
export function legendMetrics(fontSize) {
  const s = fontSize;
  return {
    padding: s * 0.75,
    radius: s * 0.8,
    gap: s * 0.6,
    lineHeight: s * 1.35,
    rowGap: s * 0.45,
    glyphSize: s * 0.85,
    badgeHeight: s * 1.3,
    cornerRadius: 6,
  };
}

export function legendFonts(frame) {
  const family = LEGEND_FONT_FAMILIES[frame.fontFamily] ?? REDLINE_FONT_FAMILY;
  const m = legendMetrics(frame.fontSize);
  return { text: fontString(frame.fontSize, 400, family), glyph: fontString(m.glyphSize, 700, family), family };
}

/**
 * Rows, lines and clipping for a legend-shaped frame and some bullets.
 * `texts` (Map id → string) substitutes text being edited.
 */
export function layoutLegendFrame(frame, bullets, measurer, { texts = null } = {}) {
  const metrics = legendMetrics(frame.fontSize);
  const { padding, radius, gap, lineHeight, rowGap } = metrics;
  const fonts = legendFonts(frame);
  const textX = frame.x + padding + radius * 2 + gap;
  const textWidth = Math.max(frame.fontSize * 2, frame.width - (textX - frame.x) - padding);
  const baseline = baselineOffset(fonts.text, lineHeight, measurer);
  const rows = [];
  let top = frame.y + padding;
  for (const bullet of bullets) {
    const text = texts?.has(bullet.id) ? texts.get(bullet.id) : bullet.text ?? '';
    const cy = top + Math.max(radius, lineHeight / 2);
    const firstTop = cy - lineHeight / 2;
    const lines = layoutPreservedText(text, { maxWidth: textWidth, font: fonts.text, measurer })
      .map((line, index) => ({ ...line, top: firstTop + index * lineHeight, baseline: firstTop + index * lineHeight + baseline }));
    const bottom = Math.max(cy + radius, firstTop + lines.length * lineHeight);
    rows.push({
      id: bullet.id, label: bullet.label, color: bullet.color, glyphColor: bulletGlyphColor(bullet.color),
      text, top, bottom, cy, cx: frame.x + padding + radius, lines,
    });
    top = bottom + rowGap;
  }
  const contentHeight = rows.length ? rows.at(-1).bottom - frame.y + padding : padding * 2;
  const height = frame.height ?? contentHeight;
  const overflows = contentHeight > height + 0.5;
  const box = { x: frame.x, y: frame.y, width: frame.width, height };
  const limit = overflows ? box.y + height - metrics.badgeHeight : box.y + height;
  let hiddenLines = 0;
  for (const row of rows) {
    row.glyphVisible = row.cy + radius <= limit + 0.01;
    for (const line of row.lines) {
      line.visible = line.top + lineHeight <= limit + 0.01;
      if (!line.visible) hiddenLines += 1;
    }
  }
  return {
    box, frame, metrics, fonts, textX, textWidth, rows, contentHeight, overflows, hiddenLines,
    autoHeight: frame.height === null || frame.height === undefined,
    font: fonts.text,
  };
}

/** Layout of a document's legend. Draft text for the row being edited goes in `texts`. */
export function layoutLegend(legend, marks, measurer, options) {
  return layoutLegendFrame({ ...legend, height: legend.height ?? null }, legendBullets(marks), measurer, options);
}

/**
 * Where a bullet's explanation is edited while the legend is hidden: a
 * one-row card beside the marker, never exported.
 */
export function explanationCardFrame(bullet, legend, docWidth, docHeight) {
  const fontSize = legend?.fontSize ?? LEGEND_DEFAULT_FONT_SIZE;
  const width = Math.max(LEGEND_MIN_WIDTH, Math.min(legend?.width ?? LEGEND_DEFAULT_WIDTH, docWidth - 16));
  const offset = BULLET_RADIUS + 10;
  let x = bullet.point.x + offset;
  if (x + width > docWidth - 8) x = bullet.point.x - offset - width;
  x = Math.min(Math.max(8, x), Math.max(8, docWidth - width - 8));
  const y = Math.min(Math.max(8, bullet.point.y - BULLET_RADIUS), Math.max(8, docHeight - fontSize * 4));
  return { x, y, width, height: null, fontSize, fontFamily: legend?.fontFamily ?? 'sans-serif' };
}

/** Which bounds a legend box extends past: the document edge and/or the crop. */
export function legendClipping(box, docWidth, docHeight, crop = null) {
  const outside = (area) => box.x < area.x - 0.5 || box.y < area.y - 0.5
    || box.x + box.width > area.x + area.width + 0.5 || box.y + box.height > area.y + area.height + 0.5;
  return {
    viewport: outside({ x: 0, y: 0, width: docWidth, height: docHeight }),
    crop: Boolean(crop) && outside(crop),
  };
}

/**
 * Smallest fixed height a legend can be dragged to: one row and the overflow
 * badge below it, so a clipped legend still shows its first explanation.
 */
export function legendMinFixedHeight(fontSize) {
  const m = legendMetrics(fontSize);
  return Math.max(LEGEND_MIN_HEIGHT, m.padding * 1.5 + Math.max(m.lineHeight, m.radius * 2) + m.badgeHeight);
}

/**
 * Resize a legend from one handle. Horizontal handles keep an automatic height
 * automatic; a vertical handle fixes the height, starting from what is shown.
 */
export function resizeLegend(legend, handle, dx, dy, contentHeight) {
  let left = legend.x;
  let top = legend.y;
  let right = legend.x + legend.width;
  let bottom = legend.y + (legend.height ?? contentHeight);
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  if (right - left < LEGEND_MIN_WIDTH) {
    if (handle.includes('w')) left = right - LEGEND_MIN_WIDTH;
    else right = left + LEGEND_MIN_WIDTH;
  }
  let { height } = legend;
  if (handle.includes('n') || handle.includes('s')) {
    const minimum = legendMinFixedHeight(legend.fontSize);
    if (bottom - top < minimum) {
      if (handle.includes('n')) top = bottom - minimum;
      else bottom = top + minimum;
    }
    height = bottom - top;
  }
  return { ...legend, x: left, y: top, width: right - left, height };
}

/** Move a legend, keeping as much of it inside the document as its size allows. */
export function moveLegend(legend, dx, dy, docWidth, docHeight, shownHeight) {
  const clamp = (value, max) => Math.min(Math.max(0, value), Math.max(0, max));
  return {
    ...legend,
    x: clamp(legend.x + dx, docWidth - legend.width),
    y: clamp(legend.y + dy, docHeight - shownHeight),
  };
}

/**
 * A temporary, scrollable editing view when the legend's text does not fit on
 * screen. Source layout and document geometry are unchanged. Coordinates,
 * selection, and the hidden input use the same source-to-view translation.
 */
export function legendEditingViewport(layout, area, caret, previous = {}, { reveal = true, scale = { x: 1, y: 1 } } = {}) {
  const { box, contentHeight } = layout;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (box.x >= area.x && box.y >= area.y && box.x + box.width <= right
    && box.y + Math.max(box.height, contentHeight) <= bottom) return null;
  const clamp = (n, min, max) => Math.min(Math.max(min, n), Math.max(min, max));
  const width = Math.min(box.width, area.width);
  const x = clamp(box.x, area.x, right - width);
  const y = clamp(box.y, area.y, bottom - Math.min(area.height, 120 / scale.y));
  const height = Math.min(Math.max(contentHeight, 80 / scale.y) + 22 / scale.y, bottom - y);
  const footerHeight = Math.min(22 / scale.y, height / 3);
  const content = { x, y, width, height: height - footerHeight };
  const maxX = Math.max(0, box.width - width);
  const maxY = Math.max(0, contentHeight - content.height);
  let scrollX = clamp(previous.x ?? 0, 0, maxX);
  let scrollY = clamp(previous.y ?? 0, 0, maxY);
  if (reveal && caret) {
    const cx = caret.x - box.x;
    const cy = caret.top - box.y;
    const inset = Math.min(8 / scale.x, width / 4);
    if (cx < scrollX + inset) scrollX = cx - inset;
    else if (cx > scrollX + width - inset) scrollX = cx - width + inset;
    if (cy < scrollY) scrollY = cy;
    else if (cy + caret.height > scrollY + content.height) scrollY = cy + caret.height - content.height;
    scrollX = clamp(scrollX, 0, maxX);
    scrollY = clamp(scrollY, 0, maxY);
  }
  return {
    box: { x, y, width, height }, content, footerHeight,
    scrollX, scrollY, maxX, maxY,
    offsetX: x - box.x - scrollX, offsetY: y - box.y - scrollY,
  };
}

// ---------------------------------------------------------------------------
// Caret geometry

/** Index of the visual line holding a caret, honouring wrap affinity. */
export function caretLineIndex(row, index, affinity = 'downstream') {
  const { lines } = row;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (index <= line.end) {
      const next = lines[i + 1];
      if (index === line.end && next && next.start === index && affinity !== 'upstream') return i + 1;
      return i;
    }
  }
  return lines.length - 1;
}

const segmentWidth = (layout, row, line, end, measurer) => (
  measurer.width(displayText(row.text.slice(line.start, Math.max(line.start, Math.min(end, line.end)))), layout.font)
);

/** Caret position in document units: x, top of its line and line height. */
export function caretPoint(layout, row, index, affinity, measurer) {
  const lineIndex = caretLineIndex(row, index, affinity);
  const line = row.lines[lineIndex];
  const right = layout.box.x + layout.box.width - 1;
  return {
    x: Math.min(right, layout.textX + segmentWidth(layout, row, line, index, measurer)),
    top: line.top,
    height: layout.metrics.lineHeight,
    line: lineIndex,
  };
}

/** Nearest caret index on one visual line to a document x. */
export function indexAtLineX(layout, row, lineIndex, x, measurer) {
  const line = row.lines[Math.max(0, Math.min(row.lines.length - 1, lineIndex))];
  let best = line.start;
  let bestDistance = Infinity;
  for (const boundary of graphemeBoundaries(row.text, line.start, line.end)) {
    const distance = Math.abs(layout.textX + segmentWidth(layout, row, line, boundary, measurer) - x);
    if (distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    } else if (distance > bestDistance) {
      break;
    }
  }
  const next = row.lines[row.lines.indexOf(line) + 1];
  return { index: best, affinity: best === line.end && next && next.start === line.end ? 'upstream' : 'downstream' };
}

/** Caret index nearest a document point inside a row. */
export function indexAtPoint(layout, row, point, measurer) {
  const lineIndex = Math.floor((point.y - row.lines[0].top) / layout.metrics.lineHeight);
  return indexAtLineX(layout, row, lineIndex, point.x, measurer);
}

/**
 * ArrowUp/ArrowDown by visual line. `goalX` keeps the column across short
 * lines. Past the first or last line the caret goes to the text's start or end.
 */
export function verticalCaretMove(layout, row, index, affinity, direction, goalX, measurer) {
  const current = caretLineIndex(row, index, affinity);
  const x = goalX ?? caretPoint(layout, row, index, affinity, measurer).x;
  const target = current + direction;
  if (target < 0) return { index: 0, affinity: 'downstream', goalX: x };
  if (target >= row.lines.length) return { index: row.text.length, affinity: 'downstream', goalX: x };
  return { ...indexAtLineX(layout, row, target, x, measurer), goalX: x };
}

/** Home and End for the visual line holding the caret. */
export function lineEdge(row, index, affinity, edge) {
  const lineIndex = caretLineIndex(row, index, affinity);
  const line = row.lines[lineIndex];
  if (edge === 'start') return { index: line.start, affinity: 'downstream' };
  const next = row.lines[lineIndex + 1];
  return { index: line.end, affinity: next && next.start === line.end ? 'upstream' : 'downstream' };
}

let wordSegmenter = null;

/** The word (or run of spaces or punctuation) around an index, for double-click. */
export function wordRangeAt(text, index) {
  if (!text) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(text.length - 1, index));
  if (typeof Intl?.Segmenter === 'function') {
    wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const part of wordSegmenter.segment(text)) {
      if (at >= part.index && at < part.index + part.segment.length) {
        if (part.segment === '\n') return { start: at, end: at };
        return { start: part.index, end: part.index + part.segment.length };
      }
    }
  }
  let start = at;
  let end = at;
  while (start > 0 && /\w/.test(text[start - 1])) start -= 1;
  while (end < text.length && /\w/.test(text[end])) end += 1;
  return { start, end };
}

/** The paragraph (text between newlines) around an index, for triple-click. */
export function paragraphRangeAt(text, index) {
  const start = text.slice(0, index).lastIndexOf('\n') + 1;
  const newline = text.indexOf('\n', index);
  return { start, end: newline < 0 ? text.length : newline };
}

/** Highlight rectangles for a selection within one row. */
export function selectionRects(layout, row, start, end, measurer) {
  const rects = [];
  const lineHeight = layout.metrics.lineHeight;
  for (const line of row.lines) {
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    const continues = end > line.end && start <= line.end;
    if (from > to || (from === to && !continues)) continue;
    const x1 = layout.textX + segmentWidth(layout, row, line, from, measurer);
    let x2 = layout.textX + segmentWidth(layout, row, line, to, measurer);
    if (continues && row.text[line.end] === '\n') x2 += measurer.width(' ', layout.font);
    rects.push({ x: x1, y: line.top, width: Math.max(0, x2 - x1), height: lineHeight });
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Hit testing

export function legendHandlePoints(box) {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [
    ['nw', box.x, box.y], ['n', cx, box.y], ['ne', right, box.y], ['e', right, cy],
    ['se', right, bottom], ['s', cx, bottom], ['sw', box.x, bottom], ['w', box.x, cy],
  ];
}

/** The move grip above the legend's top edge, sized in screen pixels. */
export function legendGripRect(box, scale) {
  const width = 44 / scale.x;
  const height = 14 / scale.y;
  return { x: box.x + box.width / 2 - width / 2, y: box.y - height - 3 / scale.y, width, height };
}

const inside = (rect, point) => point.x >= rect.x && point.x <= rect.x + rect.width
  && point.y >= rect.y && point.y <= rect.y + rect.height;

/**
 * What a point on a live legend touches: a resize handle, the grip, a row
 * (with its id), or the legend body. `box` may be taller than the layout's
 * clip when an overflowing legend is expanded for editing.
 */
export function legendHitTest(layout, point, scale, { box = layout.box, handles = true } = {}) {
  if (handles) {
    for (const [handle, x, y] of legendHandlePoints(box)) {
      if (Math.abs((point.x - x) * scale.x) <= 7 && Math.abs((point.y - y) * scale.y) <= 7) return { kind: 'handle', handle };
    }
    if (inside(legendGripRect(box, scale), point)) return { kind: 'grip' };
  }
  if (!inside(box, point)) return null;
  const { rowGap } = layout.metrics;
  const rows = layout.rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const top = i === 0 ? box.y : row.top - rowGap / 2;
    const bottom = i === rows.length - 1 ? box.y + box.height : row.bottom + rowGap / 2;
    if (point.y >= top && point.y < bottom) return { kind: 'row', id: row.id, row };
  }
  return { kind: 'body' };
}

// ---------------------------------------------------------------------------
// Drawing

export const LEGEND_COLORS = Object.freeze({
  paper: 'rgba(255,255,255,0.94)',
  border: '#8F887C',
  text: '#292D32',
  ring: '#FFFFFF',
});
const LIVE = {
  placeholder: '#6B6F76',
  caret: '#111827',
  selection: 'rgba(37,99,235,0.28)',
  rowHighlight: 'rgba(37,99,235,0.09)',
  rowBar: '#2563EB',
  frame: '#2563EB',
  warning: '#B45309',
  clip: '#B91C1C',
};

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, r);
  else ctx.rect(x, y, width, height);
}

function drawBadge(ctx, layout, text, { x, y, color, background, align = 'right' }) {
  const size = layout.frame.fontSize * 0.78;
  ctx.font = fontString(size, 600, layout.fonts.family);
  const width = ctx.measureText(text).width + size;
  const height = size * 1.5;
  const left = align === 'right' ? x - width : x;
  ctx.fillStyle = background;
  roundedRect(ctx, left, y, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + size / 2, y + height / 2);
  ctx.textBaseline = 'alphabetic';
}

/**
 * Draw a laid-out legend. Without `decorations` this is exactly the export.
 *
 * decorations: {
 *   scale: { x, y }           document→screen, for constant-size chrome
 *   editing: { id, selectionStart, selectionEnd, caretVisible, affinity, composition: { start, end } | null }
 *   selectedId                row linked to a selected bullet
 *   active                    show frame, grip and resize handles
 *   placeholders              show "Add an explanation" in empty rows
 *   viewport                  temporary scrolling view returned by legendEditingViewport
 *   expand                    draw every line of an overflowing legend while editing
 *   clipping: { viewport, crop }
 * }
 */
export function drawLegend(ctx, layout, { measurer, decorations = null } = {}) {
  const { box, metrics, rows } = layout;
  if (decorations?.viewport) {
    const view = decorations.viewport;
    const scale = decorations.scale;
    ctx.save();
    ctx.fillStyle = LEGEND_COLORS.paper;
    ctx.fillRect(view.box.x, view.box.y, view.box.width, view.box.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.content.x, view.content.y, view.content.width, view.content.height);
    ctx.clip();
    ctx.translate(view.offsetX, view.offsetY);
    drawLegend(ctx, { ...layout, box: { ...box, height: layout.contentHeight }, overflows: false }, {
      measurer,
      decorations: { ...decorations, viewport: null, showAll: true, expand: false, active: false, clipping: {} },
    });
    ctx.restore();
    // Scroll position is editing chrome, never part of the exported legend.
    if (view.maxY > 0) {
      const track = view.content.height;
      const thumb = Math.min(track, Math.max(16 / scale.y, track * track / layout.contentHeight));
      ctx.fillStyle = '#8F887C';
      ctx.fillRect(view.box.x + view.box.width - 4 / scale.x,
        view.box.y + (track - thumb) * view.scrollY / view.maxY, 3 / scale.x, thumb);
    }
    const footerY = view.box.y + view.content.height;
    ctx.fillStyle = '#F7F5F0';
    ctx.fillRect(view.box.x, footerY, view.box.width, view.footerHeight);
    ctx.fillStyle = LEGEND_COLORS.text;
    ctx.font = fontString(11 / scale.y, 400);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.rect(view.box.x, footerY, view.box.width, view.footerHeight);
    ctx.save();
    ctx.clip();
    const clipped = layout.overflows || decorations.clipping?.viewport || decorations.clipping?.crop;
    const label = view.box.width * scale.x < 240
      ? (clipped ? 'Scroll · export clips' : 'Scroll to edit')
      : (clipped ? 'Editing view · scroll · clipped in export' : 'Editing view · scroll for more');
    ctx.fillText(label, view.box.x + 5 / scale.x, footerY + view.footerHeight / 2);
    ctx.restore();
    ctx.strokeStyle = LIVE.frame;
    ctx.lineWidth = 1 / scale.x;
    ctx.setLineDash([]);
    ctx.strokeRect(view.box.x, view.box.y, view.box.width, view.box.height);
    ctx.restore();
    return;
  }
  const live = decorations;
  const scale = live?.scale ?? { x: 1, y: 1 };
  const expand = Boolean(live?.expand && layout.overflows);
  const contentBottom = box.y + layout.contentHeight;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  roundedRect(ctx, box.x, box.y, box.width, box.height, metrics.cornerRadius);
  ctx.fillStyle = LEGEND_COLORS.paper;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = LEGEND_COLORS.border;
  ctx.stroke();

  if (expand) {
    // The text past a fixed height, shown only while editing, on paler paper
    // below a line marking where the export clips it.
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillRect(box.x, box.y + box.height, box.width, contentBottom - box.y - box.height);
    ctx.save();
    ctx.strokeStyle = LIVE.clip;
    ctx.lineWidth = 1.5 / scale.y;
    ctx.setLineDash([6 / scale.x, 4 / scale.x]);
    ctx.strokeRect(box.x, box.y + box.height, box.width, contentBottom - box.y - box.height);
    ctx.restore();
  }

  ctx.save();
  if (!expand) {
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
  }
  const editing = live?.editing ?? null;
  for (const row of rows) {
    const rowEditing = editing?.id === row.id;
    if (live && (rowEditing || live.selectedId === row.id)) {
      ctx.fillStyle = LIVE.rowHighlight;
      ctx.fillRect(box.x + 1, row.top - metrics.rowGap / 2, box.width - 2, row.bottom - row.top + metrics.rowGap);
      ctx.fillStyle = LIVE.rowBar;
      ctx.fillRect(box.x + 1, row.top - metrics.rowGap / 2, 3 / scale.x, row.bottom - row.top + metrics.rowGap);
    }
    if (rowEditing && editing.selectionEnd > editing.selectionStart) {
      ctx.fillStyle = LIVE.selection;
      for (const rect of selectionRects(layout, row, editing.selectionStart, editing.selectionEnd, measurer)) {
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    }
    if (expand || live?.showAll || row.glyphVisible) {
      ctx.beginPath();
      ctx.ellipse(row.cx, row.cy, metrics.radius, metrics.radius, 0, 0, Math.PI * 2);
      ctx.fillStyle = row.color;
      ctx.fill();
      const { ascent, descent } = measurer.metrics(layout.fonts.glyph);
      ctx.font = layout.fonts.glyph;
      ctx.fillStyle = row.glyphColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(row.label, row.cx, row.cy + (ascent - descent) / 2);
    }
    ctx.font = layout.font;
    ctx.textAlign = 'left';
    if (!row.text) {
      if (live?.placeholders && row.lines[0]) {
        ctx.fillStyle = LIVE.placeholder;
        ctx.font = fontString(layout.frame.fontSize, 400, layout.fonts.family).replace(/^400 /, 'italic 400 ');
        ctx.fillText(rowEditing ? 'Type an explanation' : 'Add an explanation', layout.textX, row.lines[0].baseline);
      }
    } else {
      ctx.fillStyle = LEGEND_COLORS.text;
      for (const line of row.lines) {
        if (!expand && !live?.showAll && !line.visible) continue;
        if (line.end > line.start) ctx.fillText(displayText(row.text.slice(line.start, line.end)), layout.textX, line.baseline);
      }
    }
    if (rowEditing && editing.composition && editing.composition.end > editing.composition.start) {
      ctx.fillStyle = LEGEND_COLORS.text;
      for (const rect of selectionRects(layout, row, editing.composition.start, editing.composition.end, measurer)) {
        ctx.fillRect(rect.x, rect.y + rect.height - 2 / scale.y, rect.width, 1.5 / scale.y);
      }
    }
    if (rowEditing && editing.caretVisible) {
      const caret = caretPoint(layout, row, editing.caretIndex ?? editing.selectionEnd, editing.affinity, measurer);
      ctx.fillStyle = LIVE.caret;
      ctx.fillRect(caret.x - 0.75 / scale.x, caret.top + metrics.lineHeight * 0.08, 1.5 / scale.x, metrics.lineHeight * 0.84);
    }
  }
  ctx.restore();

  if (layout.overflows && !expand) {
    const count = layout.hiddenLines;
    drawBadge(ctx, layout, `+${count} more line${count === 1 ? '' : 's'}`, {
      x: box.x + box.width - metrics.padding / 2,
      y: box.y + box.height - metrics.badgeHeight + metrics.badgeHeight * 0.12,
      color: '#FFFFFF', background: '#5B5F66',
    });
  }

  if (live) {
    if (layout.overflows) {
      ctx.save();
      ctx.strokeStyle = LIVE.clip;
      ctx.lineWidth = 2 / scale.y;
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + box.height);
      ctx.lineTo(box.x + box.width, box.y + box.height);
      ctx.stroke();
      ctx.restore();
      if (expand) {
        drawBadge(ctx, layout, 'Clipped in export below this line', {
          x: box.x + box.width - metrics.padding / 2, y: box.y + box.height + 3 / scale.y, color: '#FFFFFF', background: LIVE.clip,
        });
      }
    }
    const clipping = live.clipping ?? {};
    if (clipping.viewport || clipping.crop) {
      ctx.save();
      ctx.strokeStyle = LIVE.warning;
      ctx.lineWidth = 2 / scale.x;
      ctx.setLineDash([8 / scale.x, 5 / scale.x]);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.restore();
      const label = clipping.crop ? 'Outside the crop: clipped in export' : 'Past the window edge: clipped in export';
      drawBadge(ctx, layout, label, {
        x: Math.max(box.x, 0) + metrics.padding / 2, y: Math.max(box.y, 0) + 3 / scale.y,
        color: '#FFFFFF', background: LIVE.warning, align: 'left',
      });
    }
    if (live.active) {
      const outline = expand ? { ...box, height: layout.contentHeight } : box;
      ctx.save();
      ctx.strokeStyle = LIVE.frame;
      ctx.lineWidth = 1.25 / scale.x;
      ctx.setLineDash([5 / scale.x, 4 / scale.x]);
      ctx.strokeRect(box.x - 3 / scale.x, box.y - 3 / scale.y, box.width + 6 / scale.x, outline.height + 6 / scale.y);
      ctx.restore();
      const grip = legendGripRect(box, scale);
      ctx.fillStyle = LIVE.frame;
      roundedRect(ctx, grip.x, grip.y, grip.width, grip.height, 4 / scale.x);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      for (let i = -1; i <= 1; i++) {
        for (const dy of [-2.5, 2.5]) {
          ctx.beginPath();
          ctx.ellipse(grip.x + grip.width / 2 + i * 7 / scale.x, grip.y + grip.height / 2 + dy / scale.y, 1.3 / scale.x, 1.3 / scale.y, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const [, x, y] of legendHandlePoints(box)) {
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = LIVE.frame;
        ctx.lineWidth = 1.25 / scale.x;
        ctx.fillRect(x - 4.5 / scale.x, y - 4.5 / scale.y, 9 / scale.x, 9 / scale.y);
        ctx.strokeRect(x - 4.5 / scale.x, y - 4.5 / scale.y, 9 / scale.x, 9 / scale.y);
      }
    }
  }
  ctx.restore();
}
