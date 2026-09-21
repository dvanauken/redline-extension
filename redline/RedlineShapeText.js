/**
 * Rich text laid out inside Redline shapes.
 *
 * This module is DOM-free. The SVG editor, custom caret/selection chrome and
 * Canvas export all consume the same indexed line/run layout, so changing a
 * polygon vertex immediately changes both the live wrap and the exported wrap.
 */

import { REDLINE_FONT_FAMILY, TEXTBOX_LINE_HEIGHT, baselineOffset, graphemeBoundaries } from './RedlineTextLayout.js';

export const SHAPE_TEXT_TYPES = new Set(['rectangle', 'ellipse', 'polygon']);
export const TEXT_CONTAINER_TYPES = new Set(['textbox', ...SHAPE_TEXT_TYPES]);
export const SHAPE_TEXT_PADDING = 10;
export const DEFAULT_TEXT_COLOR = '#292D32';
export const TEXT_ALIGNMENTS = ['left', 'center', 'right'];
export const VERTICAL_ALIGNMENTS = ['top', 'middle', 'bottom'];
export const FONT_FAMILIES = [
  ['Arial', REDLINE_FONT_FAMILY],
  ['Calibri', 'Calibri, Carlito, Arial, sans-serif'],
  ['Georgia', 'Georgia, "Times New Roman", serif'],
  ['Times New Roman', '"Times New Roman", Times, serif'],
  ['Courier New', '"Courier New", Courier, monospace'],
];

const STYLE_KEYS = ['bold', 'italic', 'underline', 'textColor', 'fontFamily', 'fontSize'];
const finite = value => Number.isFinite(Number(value));
const hex = value => /^#[0-9a-f]{6}$/i.test(String(value ?? ''));

export function defaultTextAlignment(mark) {
  return mark?.type === 'textbox' ? 'left' : 'center';
}

export function defaultVerticalAlignment(mark) {
  return mark?.type === 'textbox' ? 'top' : 'middle';
}

export function baseTextStyle(mark) {
  return {
    bold: Boolean(mark?.bold ?? (mark?.type === 'rectangle' && !('bold' in (mark ?? {})))),
    italic: Boolean(mark?.italic),
    underline: Boolean(mark?.underline),
    color: hex(mark?.textColor) ? mark.textColor : DEFAULT_TEXT_COLOR,
    family: String(mark?.fontFamily || REDLINE_FONT_FAMILY),
    size: Math.max(10, finite(mark?.fontSize) ? Number(mark.fontSize) : 16),
  };
}

export function fontForTextStyle(style) {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${style.size}px ${style.family}`;
}

function sanitizedRun(run, length) {
  const start = Math.max(0, Math.min(length, Math.floor(Number(run?.start)) || 0));
  const end = Math.max(start, Math.min(length, Math.floor(Number(run?.end)) || 0));
  if (end <= start) return null;
  const next = { start, end };
  if (typeof run.bold === 'boolean') next.bold = run.bold;
  if (typeof run.italic === 'boolean') next.italic = run.italic;
  if (typeof run.underline === 'boolean') next.underline = run.underline;
  if (hex(run.textColor)) next.textColor = String(run.textColor);
  if (typeof run.fontFamily === 'string' && run.fontFamily.trim()) next.fontFamily = run.fontFamily.trim().slice(0, 160);
  if (finite(run.fontSize) && Number(run.fontSize) >= 10) next.fontSize = Math.min(512, Number(run.fontSize));
  return Object.keys(next).length > 2 ? next : null;
}

/** Validate, sort and split formatting ranges into non-overlapping runs. */
export function normalizeTextRuns(runs, length) {
  if (!Array.isArray(runs) || !length) return [];
  const source = runs.map(run => sanitizedRun(run, length)).filter(Boolean);
  if (!source.length) return [];
  const boundaries = [...new Set([0, length, ...source.flatMap(run => [run.start, run.end])])].sort((a, b) => a - b);
  const result = [];
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1];
    const end = boundaries[index];
    const style = {};
    for (const run of source) {
      if (run.start <= start && run.end >= end) {
        for (const key of STYLE_KEYS) if (key in run) style[key] = run[key];
      }
    }
    if (!Object.keys(style).length) continue;
    const previous = result.at(-1);
    const same = previous && STYLE_KEYS.every(key => previous[key] === style[key]);
    if (same && previous.end === start) previous.end = end;
    else result.push({ start, end, ...style });
  }
  return result;
}

export function textStyleAt(mark, index) {
  const base = baseTextStyle(mark);
  for (const run of mark?.textRuns ?? []) {
    if (index < run.start || index >= run.end) continue;
    if ('bold' in run) base.bold = run.bold;
    if ('italic' in run) base.italic = run.italic;
    if ('underline' in run) base.underline = run.underline;
    if (run.textColor) base.color = run.textColor;
    if (run.fontFamily) base.family = run.fontFamily;
    if (finite(run.fontSize)) base.size = Number(run.fontSize);
  }
  return base;
}

const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
  && a.color === b.color && a.family === b.family && a.size === b.size;

/** Styled source spans in [start,end), preserving every source index. */
export function styledTextSegments(mark, start, end) {
  const text = String(mark?.text ?? '');
  const segments = [];
  let cursor = start;
  while (cursor < end) {
    const style = textStyleAt(mark, cursor);
    let next = cursor + 1;
    while (next < end && sameStyle(style, textStyleAt(mark, next))) next += 1;
    segments.push({ start: cursor, end: next, text: text.slice(cursor, next).replace(/\t/g, ' '), style });
    cursor = next;
  }
  return segments;
}

export function measureStyledRange(mark, start, end, measurer) {
  return styledTextSegments(mark, start, end)
    .reduce((width, segment) => width + measurer.width(segment.text, fontForTextStyle(segment.style)), 0);
}

const boxOf = mark => ({
  x: Math.min(mark.start.x, mark.end.x),
  y: Math.min(mark.start.y, mark.end.y),
  width: Math.abs(mark.end.x - mark.start.x),
  height: Math.abs(mark.end.y - mark.start.y),
});

function scanlineIntervals(points, y) {
  const xs = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
  }
  xs.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 1; index < xs.length; index += 2) intervals.push([xs[index - 1], xs[index]]);
  return intervals;
}

function intersectIntervals(left, right) {
  const result = [];
  for (const a of left) for (const b of right) {
    const start = Math.max(a[0], b[0]);
    const end = Math.min(a[1], b[1]);
    if (end > start) result.push([start, end]);
  }
  return result;
}

function insetIntervals(intervals, padding) {
  return intervals.map(([start, end]) => [start + padding, end - padding]).filter(([start, end]) => end - start >= 1);
}

/** Horizontal interior spans that stay inside the entire line box. */
export function shapeTextIntervals(mark, top, bottom, padding = SHAPE_TEXT_PADDING) {
  if (mark.type === 'textbox' || mark.type === 'rectangle') {
    const box = boxOf(mark);
    // New text boxes are fitted as the user types, but older/imported boxes can
    // be only one minimum-height row tall. Let their final line occupy the
    // remaining clipped interior instead of silently dropping its text. Closed
    // drawing shapes remain strict: their text must stay wholly inside the wall.
    if (top < box.y + padding || (mark.type === 'textbox'
      ? top >= box.y + box.height - padding
      : bottom > box.y + box.height - padding)) return [];
    return insetIntervals([[box.x, box.x + box.width]], padding);
  }
  if (mark.type === 'ellipse') {
    const box = boxOf(mark);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = Math.max(0, box.width / 2 - padding);
    const ry = Math.max(0, box.height / 2 - padding);
    if (!rx || !ry) return [];
    const ys = [top, (top + bottom) / 2, bottom];
    let half = Infinity;
    for (const y of ys) {
      const ratio = (y - cy) / ry;
      if (Math.abs(ratio) >= 1) return [];
      half = Math.min(half, rx * Math.sqrt(1 - ratio * ratio));
    }
    return [[cx - half, cx + half]];
  }
  if (mark.type === 'polygon') {
    const points = mark.points ?? [];
    if (points.length < 3) return [];
    const samples = [top + 0.01, (top + bottom) / 2, bottom - 0.01];
    let intervals = scanlineIntervals(points, samples[0]);
    for (const y of samples.slice(1)) intervals = intersectIntervals(intervals, scanlineIntervals(points, y));
    return insetIntervals(intervals, padding);
  }
  return [];
}

function textBox(mark) {
  if (mark.type === 'polygon') {
    const xs = mark.points.map(point => point.x);
    const ys = mark.points.map(point => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  return boxOf(mark);
}

function farthestFit(mark, start, end, width, measurer) {
  const boundaries = graphemeBoundaries(String(mark.text ?? ''), start, end);
  let best = start;
  for (let index = 1; index < boundaries.length; index++) {
    if (measureStyledRange(mark, start, boundaries[index], measurer) > width + 0.01) break;
    best = boundaries[index];
  }
  return best;
}

function breakLine(mark, start, width, measurer) {
  const text = String(mark.text ?? '');
  const newline = text.indexOf('\n', start);
  const paragraphEnd = newline < 0 ? text.length : newline;
  if (start === paragraphEnd) return { end: start, next: newline < 0 ? start : start + 1 };
  const fit = farthestFit(mark, start, paragraphEnd, width, measurer);
  if (fit >= paragraphEnd) return { end: paragraphEnd, next: newline < 0 ? paragraphEnd : paragraphEnd + 1 };
  if (fit <= start) {
    const next = graphemeBoundaries(text, start, paragraphEnd)[1] ?? Math.min(text.length, start + 1);
    return { end: next, next };
  }
  // Prefer the latest whitespace or hyphen boundary. A hyphen remains visible
  // at the end of its line; spaces belong to the preceding line for stable
  // source-to-caret mapping.
  let boundary = -1;
  for (let index = start + 1; index <= fit; index++) {
    const previous = text[index - 1];
    if (/\s/.test(previous) || previous === '-' || previous === '\u2010' || previous === '\u2011') boundary = index;
  }
  const end = boundary > start ? boundary : fit;
  return { end, next: end };
}

function lineHeightFor(mark) {
  let size = baseTextStyle(mark).size;
  for (const run of mark.textRuns ?? []) if (finite(run.fontSize)) size = Math.max(size, Number(run.fontSize));
  return size * TEXTBOX_LINE_HEIGHT;
}

function lineSlots(mark, lineHeight) {
  const box = textBox(mark);
  const padding = SHAPE_TEXT_PADDING;
  const slots = [];
  const hasRoom = top => mark.type === 'textbox'
    ? top < box.y + box.height - padding
    : top + lineHeight <= box.y + box.height - padding + 0.01;
  for (let top = box.y + padding; hasRoom(top); top += lineHeight) {
    const intervals = shapeTextIntervals(mark, top, top + lineHeight, padding);
    if (!intervals.length) continue;
    // Text in concave shapes stays a conventional reading block: use the
    // widest continuous interior rather than jumping across a hole.
    const [start, end] = intervals.reduce((best, item) => item[1] - item[0] > best[1] - best[0] ? item : best);
    slots.push({ top, x: start, width: end - start });
  }
  return slots;
}

function flowIntoSlots(mark, slots, lineHeight, measurer) {
  const text = String(mark.text ?? '');
  const align = TEXT_ALIGNMENTS.includes(mark.textAlign) ? mark.textAlign : defaultTextAlignment(mark);
  const lines = [];
  let cursor = 0;
  for (const slot of slots) {
    if (cursor >= text.length && lines.length) break;
    const broken = breakLine(mark, cursor, slot.width, measurer);
    const width = measureStyledRange(mark, cursor, broken.end, measurer);
    const x = align === 'center' ? slot.x + (slot.width - width) / 2 : align === 'right' ? slot.x + slot.width - width : slot.x;
    const segments = styledTextSegments(mark, cursor, broken.end);
    const dominant = segments.reduce((style, segment) => segment.style.size > style.size ? segment.style : style, baseTextStyle(mark));
    const baseline = slot.top + baselineOffset(fontForTextStyle(dominant), lineHeight, measurer);
    let runX = x;
    const runs = segments.map(segment => {
      const run = { ...segment, x: runX, y: baseline };
      run.width = measurer.width(segment.text, fontForTextStyle(segment.style));
      runX += run.width;
      return run;
    });
    lines.push({ start: cursor, end: broken.end, next: broken.next, x, y: baseline, top: slot.top, height: lineHeight, width, available: slot, runs });
    cursor = broken.next;
  }
  return { lines, cursor, overflows: cursor < text.length };
}

/** Indexed rich-text layout for a text box or closed shape. */
export function layoutShapeText(mark, measurer) {
  const text = String(mark?.text ?? '');
  const box = textBox(mark);
  const lineHeight = lineHeightFor(mark);
  let slots = lineSlots(mark, lineHeight);
  let flow = flowIntoSlots(mark, slots, lineHeight, measurer);
  const vertical = VERTICAL_ALIGNMENTS.includes(mark.verticalAlign) ? mark.verticalAlign : defaultVerticalAlignment(mark);
  if (!flow.overflows && flow.lines.length && vertical !== 'top') {
    const used = flow.lines.length;
    const offset = vertical === 'bottom' ? slots.length - used : Math.floor((slots.length - used) / 2);
    if (offset > 0) {
      slots = slots.slice(offset);
      flow = flowIntoSlots(mark, slots, lineHeight, measurer);
    }
  }
  return { box, clip: box, fontSize: baseTextStyle(mark).size, lineHeight, text, ...flow };
}

export function caretGeometry(layout, mark, index, measurer) {
  const safe = Math.max(0, Math.min(layout.text.length, index));
  let line = layout.lines.find(item => safe >= item.start && safe <= item.end);
  if (!line) line = safe <= 0 ? layout.lines[0] : layout.lines.at(-1);
  if (!line) return null;
  const within = Math.max(line.start, Math.min(line.end, safe));
  return { x: line.x + measureStyledRange(mark, line.start, within, measurer), y: line.top, height: line.height };
}

export function selectionGeometry(layout, mark, start, end, measurer) {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (from === to) return [];
  const rectangles = [];
  for (const line of layout.lines) {
    const a = Math.max(from, line.start);
    const b = Math.min(to, line.end);
    if (b <= a) continue;
    const x = line.x + measureStyledRange(mark, line.start, a, measurer);
    rectangles.push({ x, y: line.top, width: Math.max(1, measureStyledRange(mark, a, b, measurer)), height: line.height });
  }
  return rectangles;
}

/** Nearest source caret to a point in the mark's unrotated coordinates. */
export function textIndexAtPoint(layout, mark, point, measurer) {
  if (!layout.lines.length) return 0;
  const line = layout.lines.reduce((best, item) => {
    const distance = point.y < item.top ? item.top - point.y : point.y > item.top + item.height ? point.y - item.top - item.height : 0;
    return distance < best.distance ? { item, distance } : best;
  }, { item: layout.lines[0], distance: Infinity }).item;
  const boundaries = graphemeBoundaries(layout.text, line.start, line.end);
  let best = line.start;
  let distance = Infinity;
  for (const index of boundaries) {
    const x = line.x + measureStyledRange(mark, line.start, index, measurer);
    const delta = Math.abs(point.x - x);
    if (delta < distance) { best = index; distance = delta; }
  }
  return best;
}

function styleField(property, value) {
  if (property === 'bold' || property === 'italic' || property === 'underline') return { [property]: Boolean(value) };
  if (property === 'textColor' && hex(value)) return { textColor: value };
  if (property === 'fontFamily' && typeof value === 'string' && value.trim()) return { fontFamily: value.trim().slice(0, 160) };
  if (property === 'fontSize' && finite(value) && Number(value) >= 10) return { fontSize: Math.min(512, Number(value)) };
  return null;
}

/** Apply character formatting to a selected range, compacting adjacent runs. */
export function applyTextRangeStyle(mark, property, value, start, end) {
  const field = styleField(property, value);
  const text = String(mark?.text ?? '');
  const from = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const to = Math.max(from, Math.min(text.length, Math.max(start, end)));
  if (!field || from === to) return mark;
  const boundaries = [...new Set([0, text.length, from, to, ...(mark.textRuns ?? []).flatMap(run => [run.start, run.end])])].sort((a, b) => a - b);
  const runs = [];
  for (let index = 1; index < boundaries.length; index++) {
    const a = boundaries[index - 1];
    const b = boundaries[index];
    const source = (mark.textRuns ?? []).find(run => run.start <= a && run.end >= b);
    const style = {};
    if (source) for (const key of STYLE_KEYS) if (key in source) style[key] = source[key];
    if (a < to && b > from) Object.assign(style, field);
    if (Object.keys(style).length) runs.push({ start: a, end: b, ...style });
  }
  return { ...mark, textRuns: normalizeTextRuns(runs, text.length) };
}

/** Keep formatting aligned after a single native textarea input operation. */
export function remapTextRuns(mark, nextText, insertedStyle = null) {
  const previous = String(mark?.text ?? '');
  const next = String(nextText ?? '');
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const oldEnd = previous.length - suffix;
  const newEnd = next.length - suffix;
  const delta = newEnd - oldEnd;
  const runs = [];
  for (const run of mark?.textRuns ?? []) {
    if (run.end <= prefix) runs.push({ ...run });
    else if (run.start >= oldEnd) runs.push({ ...run, start: run.start + delta, end: run.end + delta });
    else {
      if (run.start < prefix) runs.push({ ...run, end: prefix });
      if (run.end > oldEnd) runs.push({ ...run, start: newEnd, end: run.end + delta });
    }
  }
  if (newEnd > prefix && insertedStyle) {
    const style = {};
    for (const key of STYLE_KEYS) if (key in insertedStyle) style[key] = insertedStyle[key];
    if (Object.keys(style).length) runs.push({ start: prefix, end: newEnd, ...style });
  }
  return { ...mark, text: next, textRuns: normalizeTextRuns(runs, next.length) };
}

export function sanitizeTextFields(annotation, text, { legacyRectangle = false } = {}) {
  const fields = {};
  if (!text) return fields;
  fields.text = text;
  fields.fontSize = Math.max(10, Math.min(512, finite(annotation.fontSize) ? Number(annotation.fontSize) : 16));
  if (annotation.bold !== undefined && Boolean(annotation.bold) !== legacyRectangle) fields.bold = Boolean(annotation.bold);
  if (annotation.italic) fields.italic = true;
  if (annotation.underline) fields.underline = true;
  if (hex(annotation.textColor) && String(annotation.textColor).toUpperCase() !== DEFAULT_TEXT_COLOR) fields.textColor = String(annotation.textColor);
  if (typeof annotation.fontFamily === 'string' && annotation.fontFamily.trim()
    && annotation.fontFamily.trim() !== REDLINE_FONT_FAMILY) fields.fontFamily = annotation.fontFamily.trim().slice(0, 160);
  if (TEXT_ALIGNMENTS.includes(annotation.textAlign) && annotation.textAlign !== (legacyRectangle ? 'center' : 'left')) fields.textAlign = annotation.textAlign;
  if (VERTICAL_ALIGNMENTS.includes(annotation.verticalAlign) && annotation.verticalAlign !== (legacyRectangle ? 'middle' : 'top')) fields.verticalAlign = annotation.verticalAlign;
  const runs = normalizeTextRuns(annotation.textRuns, text.length);
  if (runs.length) fields.textRuns = runs;
  return fields;
}
