/**
 * Style vocabulary shared by the model, both renderers and the toolbar.
 *
 * Everything here is DOM-free. `applyStyleChange` is the single place a style
 * edit turns into mark fields, and it is used for a selected mark and for the
 * drawing defaults alike, so the two cannot drift apart.
 */

export const DEFAULT_COLOR = '#b65d66';
export const PT_TO_CSS_PX = 4 / 3;

export const LINE_WEIGHTS = [
  ['¼ pt', 0.25 * PT_TO_CSS_PX],
  ['½ pt', 0.5 * PT_TO_CSS_PX],
  ['¾ pt', 0.75 * PT_TO_CSS_PX],
  ['1 pt', 1 * PT_TO_CSS_PX],
  ['1½ pt', 1.5 * PT_TO_CSS_PX],
  ['2¼ pt', 2.25 * PT_TO_CSS_PX],
  ['3 pt', 3 * PT_TO_CSS_PX],
  ['4½ pt', 4.5 * PT_TO_CSS_PX],
  ['6 pt', 6 * PT_TO_CSS_PX],
];

/** Stored highlighter width; it paints four times wider, never below 6px. */
export const HIGHLIGHTER_WIDTHS = [['12 px', 3], ['16 px', 4], ['24 px', 6], ['32 px', 8], ['40 px', 10]];
export const FONT_SIZES = [12, 14, 16, 20, 24, 32];
export const TEXT_ALIGNMENTS = [['Left', 'left'], ['Center', 'center'], ['Right', 'right']];
export const VERTICAL_ALIGNMENTS = [['Top', 'top'], ['Middle', 'middle'], ['Bottom', 'bottom']];
export const TEXT_BACKGROUNDS = [['Opaque', 1], ['75%', 0.75], ['50%', 0.5], ['25%', 0.25], ['None', 0]];
export const DEFAULT_FILL_OPACITY = 0.25;
export const NOTE_MARKERS = [['1, 2, 3', 'numeric'], ['A, B, C', 'alpha']];
export const BULLET_SCHEME_OPTIONS = [['1–9', 'numeric'], ['A–Z', 'alpha']];

/** Marks that enclose an area and so offer outline and fill treatments. */
export const CLOSED_TYPES = new Set(['rectangle', 'ellipse', 'polygon']);
/** Marks whose primary line/border can carry independent opacity. */
export const STROKE_OPACITY_TYPES = new Set([
  'pen', 'brush', 'line', 'arrow', 'polyline', 'polygon', 'rectangle', 'ellipse', 'textbox',
]);
/** Marks with two free ends that can carry decorations. */
export const LINE_TYPES = new Set(['line', 'arrow', 'polyline']);
export const PATH_TYPES = new Set(['pen', 'brush', 'polyline', 'polygon']);
export const BOX_TYPES = new Set(['rectangle', 'ellipse', 'line', 'arrow', 'textbox']);
/**
 * Marks drawn inside a frame that can be resized from eight handles and
 * rotated. Straight lines resize from their two ends instead; bullets and notes
 * are fixed-size markers.
 */
export const FRAMED_TYPES = new Set(['rectangle', 'ellipse', 'textbox', 'pen', 'brush', 'polyline', 'polygon']);

export const DECORATIONS = ['none', 'arrow', 'open-circle', 'filled-circle'];
export const DECORATION_LABELS = {
  none: 'None',
  arrow: 'Arrowhead',
  'open-circle': 'Open circle',
  'filled-circle': 'Filled circle',
};

export const END_PRESETS = [
  { key: 'plain', label: 'No end decorations', start: 'none', end: 'none' },
  { key: 'arrow-end', label: 'Arrow at the end', start: 'none', end: 'arrow' },
  { key: 'arrow-start', label: 'Arrow at the start', start: 'arrow', end: 'none' },
  { key: 'arrow-both', label: 'Arrows at both ends', start: 'arrow', end: 'arrow' },
  { key: 'dot-arrow', label: 'Filled circle to arrow', start: 'filled-circle', end: 'arrow' },
  { key: 'circle-both', label: 'Open circles at both ends', start: 'open-circle', end: 'open-circle' },
];

export function defaultDecorations(type) {
  return type === 'arrow' ? { start: 'none', end: 'arrow' } : { start: 'none', end: 'none' };
}

/** Effective start and end decorations; closed and freehand marks have none. */
export function markDecorations(mark) {
  if (!LINE_TYPES.has(mark?.type)) return { start: 'none', end: 'none' };
  const fallback = defaultDecorations(mark.type);
  return {
    start: DECORATIONS.includes(mark.startDecoration) ? mark.startDecoration : fallback.start,
    end: DECORATIONS.includes(mark.endDecoration) ? mark.endDecoration : fallback.end,
  };
}

/**
 * Fill paint for a mark, or null when it has none.
 *
 * A mark's `fill` defaults to its stroke colour, which is what lets a single
 * swatch set stroke and fill together.
 */
export function redlineMarkFill(mark) {
  const opacity = Number(mark?.fillOpacity);
  if (!Number.isFinite(opacity) || opacity <= 0) return null;
  return { color: mark.fill ?? mark.color, opacity: Math.min(1, opacity) };
}

/**
 * Whether a mark paints its outline. Dropping the outline is only allowed where
 * a fill takes over; a shape with neither would be invisible.
 */
export function redlineMarkStroked(mark) {
  if (mark?.outline !== false) return true;
  return !redlineMarkFill(mark);
}

export function treatmentOf(mark) {
  if (!redlineMarkFill(mark)) return 'outline';
  return redlineMarkStroked(mark) ? 'outline-fill' : 'fill';
}

/**
 * The glyph inside a note's circle.
 *
 * Legacy documents can contain `10` or `AA`; they must keep rendering. The
 * stored `number` is the plain ordinal, so the sequence survives either
 * presentation.
 */
export function redlineNoteGlyph(number, marker = 'numeric') {
  const ordinal = Math.max(1, Math.floor(Number(number)) || 1);
  if (marker !== 'alpha') return String(ordinal);
  let remaining = ordinal;
  let glyph = '';
  while (remaining > 0) {
    glyph = String.fromCharCode(65 + ((remaining - 1) % 26)) + glyph;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return glyph;
}

function relativeLuminance(hex) {
  const channel = value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export const BULLET_DARK_GLYPH = '#1F2328';

/**
 * Glyph colour inside a bullet circle: white where it reads clearly, dark ink
 * on light fills such as yellow, so every palette colour stays legible.
 */
export function bulletGlyphColor(fill) {
  if (!isHexColor(fill)) return '#FFFFFF';
  const luminance = relativeLuminance(fill);
  const onWhite = 1.05 / (luminance + 0.05);
  return onWhite >= 4.5 || onWhite >= (luminance + 0.05) / (relativeLuminance(BULLET_DARK_GLYPH) + 0.05)
    ? '#FFFFFF'
    : BULLET_DARK_GLYPH;
}

/** Readable label ink for rectangle fills; translucent or empty shapes use dark ink. */
export function rectangleLabelColor(mark) {
  const fill = redlineMarkFill(mark);
  return fill && fill.opacity >= 0.65 ? bulletGlyphColor(fill.color) : BULLET_DARK_GLYPH;
}

/** White paper backing, translucent by default so page content stays visible. */
export function redlineTextBoxFill(opacity = 0.75) {
  const alpha = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 0.75));
  return `rgba(255,255,255,${alpha})`;
}

export const isHexColor = value => /^#[0-9a-f]{6}$/i.test(String(value ?? ''));

const sameColor = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

function setIntent(next, value) {
  if (!('intent' in value)) return;
  if (value.intent) next.intent = String(value.intent).slice(0, 32);
  else delete next.intent;
}

/** A whole-object text style becomes the base style for every character. */
function clearTextRunProperty(next, property) {
  if (!Array.isArray(next.textRuns)) return;
  const runs = next.textRuns.map(run => {
    const changed = { ...run };
    delete changed[property];
    return changed;
  }).filter(run => Object.keys(run).some(key => key !== 'start' && key !== 'end'));
  if (runs.length) next.textRuns = runs;
  else delete next.textRuns;
}

function withFillOpacity(next, opacity) {
  const clamped = Math.min(1, Math.max(0, Number(opacity) || 0));
  if (clamped > 0) {
    if (!redlineMarkFill(next) && next.savedFill) {
      if (sameColor(next.savedFill.color, next.color)) delete next.fill;
      else next.fill = next.savedFill.color;
    }
    next.fillOpacity = clamped;
    delete next.savedFill;
  } else {
    const fill = redlineMarkFill(next);
    // Outline hides the fill without discarding that shape's colour/strength.
    if (fill) next.savedFill = { color: fill.color, opacity: fill.opacity };
    delete next.fillOpacity;
    delete next.fill;
    delete next.outline;
  }
}

function withStrokeOpacity(next, mark, opacity) {
  if (!STROKE_OPACITY_TYPES.has(mark.type)) return;
  const value = Number(opacity);
  if (!Number.isFinite(value)) return;
  const clamped = Math.min(1, Math.max(0, value));
  // Existing path documents always carry opacity. Other marks omit the
  // default so old JSON remains compact and unchanged.
  if (clamped === 1 && !['pen', 'brush', 'polyline', 'polygon'].includes(mark.type)) delete next.opacity;
  else next.opacity = clamped;
}

/**
 * Apply one style edit to a mark-shaped object and return the new object.
 *
 * Changes:
 *   strokeColor  { color, intent? }   outline / ink colour
 *   fillColor    { color, intent? }
 *   treatment    'outline' | 'outline-fill' | 'fill', with `fillOpacity` to use
 *                when a fill has to appear
 *   fillOpacity  number in (0, 1]
 *   width, opacity, fontSize, backgroundOpacity  numbers
 *   ends         { start, end } decorations
 *
 * Changing the stroke of a filled shape whose fill followed the stroke pins
 * the fill to its previous colour first, so the treatment and fill survive.
 */
export function applyStyleChange(mark, { property, value }) {
  const next = { ...mark };
  const closed = CLOSED_TYPES.has(mark.type);
  switch (property) {
    case 'strokeColor': {
      if (!isHexColor(value?.color)) return mark;
      if (closed && redlineMarkFill(mark) && !mark.fill) next.fill = mark.color;
      next.color = value.color;
      if (next.fill && sameColor(next.fill, next.color)) delete next.fill;
      if (closed && value.enable === true) delete next.outline;
      withStrokeOpacity(next, mark, value.opacity);
      setIntent(next, value);
      break;
    }
    case 'fillColor': {
      if (!closed || !isHexColor(value?.color)) return mark;
      if (!redlineMarkFill(mark) || value.fillOpacity !== undefined) {
        withFillOpacity(next, value.fillOpacity ?? mark.savedFill?.opacity ?? DEFAULT_FILL_OPACITY);
      }
      if (sameColor(value.color, next.color)) delete next.fill;
      else next.fill = value.color;
      setIntent(next, value);
      break;
    }
    case 'treatment': {
      if (!closed) return mark;
      const fallback = Number(value?.fillOpacity) > 0 ? Number(value.fillOpacity) : DEFAULT_FILL_OPACITY;
      const treatment = typeof value === 'string' ? value : value?.treatment;
      if (treatment === 'outline') {
        withFillOpacity(next, 0);
      } else if (treatment === 'outline-fill' || treatment === 'fill') {
        withFillOpacity(next, redlineMarkFill(mark) ? mark.fillOpacity : mark.savedFill?.opacity ?? fallback);
        if (treatment === 'fill') next.outline = false;
        else delete next.outline;
      } else {
        return mark;
      }
      break;
    }
    case 'fillOpacity': {
      if (!closed) return mark;
      withFillOpacity(next, value);
      break;
    }
    case 'width': {
      const width = Number(value);
      if (!Number.isFinite(width) || width <= 0) return mark;
      next.width = width;
      break;
    }
    case 'opacity': {
      if (!STROKE_OPACITY_TYPES.has(mark.type) || !Number.isFinite(Number(value))) return mark;
      withStrokeOpacity(next, mark, value);
      break;
    }
    case 'fontSize': {
      const size = Number(value);
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type) || !Number.isFinite(size) || size < 10) return mark;
      next.fontSize = size;
      clearTextRunProperty(next, property);
      break;
    }
    case 'fontFamily': {
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type) || typeof value !== 'string' || !value.trim()) return mark;
      next.fontFamily = value.trim().slice(0, 160);
      clearTextRunProperty(next, property);
      break;
    }
    case 'textColor': {
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type) || !isHexColor(value)) return mark;
      next.textColor = value;
      clearTextRunProperty(next, property);
      break;
    }
    case 'bold':
    case 'italic':
    case 'underline': {
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type)) return mark;
      next[property] = Boolean(value);
      clearTextRunProperty(next, property);
      break;
    }
    case 'textAlign': {
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type) || !['left', 'center', 'right'].includes(value)) return mark;
      next.textAlign = value;
      break;
    }
    case 'verticalAlign': {
      if (!['textbox', 'rectangle', 'ellipse', 'polygon'].includes(mark.type) || !['top', 'middle', 'bottom'].includes(value)) return mark;
      next.verticalAlign = value;
      break;
    }
    case 'backgroundOpacity': {
      const opacity = Number(value);
      if (mark.type !== 'textbox' || !Number.isFinite(opacity)) return mark;
      next.backgroundOpacity = Math.min(1, Math.max(0, opacity));
      break;
    }
    case 'ends': {
      if (!LINE_TYPES.has(mark.type)) return mark;
      const start = DECORATIONS.includes(value?.start) ? value.start : markDecorations(mark).start;
      const end = DECORATIONS.includes(value?.end) ? value.end : markDecorations(mark).end;
      delete next.startDecoration;
      delete next.endDecoration;
      Object.assign(next, normalizeLineEnds(mark.type, start, end));
      break;
    }
    default:
      return mark;
  }
  return next;
}

/**
 * Canonical type and decoration fields for a straight line or polyline.
 *
 * A straight line with exactly one arrowhead at its end is an `arrow`, which
 * older readers already draw correctly; every other combination is a `line`
 * with explicit decorations. Defaults are omitted so legacy marks serialise
 * exactly as before.
 */
export function normalizeLineEnds(type, start, end) {
  let resolved = type;
  if (type === 'line' || type === 'arrow') resolved = start === 'none' && end === 'arrow' ? 'arrow' : 'line';
  const fallback = defaultDecorations(resolved);
  const fields = { type: resolved };
  if (start !== fallback.start) fields.startDecoration = start;
  if (end !== fallback.end) fields.endDecoration = end;
  return fields;
}

/** Nearest listed value, for a control showing a mark with an unlisted one. */
export function nearestOption(options, value) {
  return options.reduce((best, option) => (
    Math.abs(option - value) < Math.abs(best - value) ? option : best
  ), options[0]);
}
