/**
 * Drawing-tool defaults: the styles new marks start with, how a style edit is
 * remembered for a tool, and how those defaults travel through the host's
 * saved preferences.
 *
 * Defaults are never a mark's own style. Nothing here touches the DOM.
 */

import {
  CLOSED_TYPES, DECORATIONS, DEFAULT_COLOR, DEFAULT_FILL_OPACITY, LINE_TYPES, PT_TO_CSS_PX, STROKE_OPACITY_TYPES,
  isHexColor, markDecorations, redlineMarkFill,
} from './RedlineStyles.js';

/** Tools that create marks, and so have drawing defaults to style. */
export const DRAWING_TOOLS = new Set(['pen', 'brush', 'line', 'arrow', 'rectangle', 'ellipse', 'polyline', 'polygon', 'note', 'bullet', 'textbox']);

/** What messages and headings call each mark type. */
export const MARK_NAMES = {
  pen: 'pen stroke', brush: 'highlight', line: 'line', arrow: 'arrow', polyline: 'polyline', polygon: 'polygon',
  rectangle: 'rectangle', ellipse: 'ellipse', note: 'note', bullet: 'bullet', textbox: 'text box',
};

const validEnds = value => DECORATIONS.includes(value?.start) && DECORATIONS.includes(value?.end);
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function createToolDefaults() {
  return {
    color: DEFAULT_COLOR,
    width: 1 * PT_TO_CSS_PX,
    intent: null,
    fill: null,
    savedFill: null,
    fillOpacity: 0,
    outline: true,
    lastFillOpacity: DEFAULT_FILL_OPACITY,
    strokeOpacity: 1,
    brushWidth: 10,
    brushOpacity: 0.35,
    fontSize: 16,
    fontFamily: 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif',
    textColor: '#292D32',
    bold: false,
    italic: false,
    underline: false,
    textAlign: 'center',
    verticalAlign: 'middle',
    textBoxBackgroundOpacity: 0.75,
    noteMarker: 'numeric',
    bulletScheme: 'numeric',
    /** Whether a new session's legend starts shown; each document stores its own. */
    legendVisible: false,
    ends: {
      line: { start: 'none', end: 'none' },
      arrow: { start: 'none', end: 'arrow' },
      polyline: { start: 'none', end: 'none' },
    },
  };
}

/** Style fields every new mark of a tool starts with. */
export function styleForTool(d, tool) {
  const style = { type: tool, color: d.color, width: d.width };
  if (d.intent) style.intent = d.intent;
  if (CLOSED_TYPES.has(tool) && d.fillOpacity > 0) {
    style.fillOpacity = d.fillOpacity;
    if (d.fill) style.fill = d.fill;
    if (!d.outline) style.outline = false;
  } else if (CLOSED_TYPES.has(tool) && d.savedFill) {
    style.savedFill = { ...d.savedFill };
  }
  if (tool === 'brush') {
    style.width = d.brushWidth;
    style.opacity = d.brushOpacity;
  } else if (STROKE_OPACITY_TYPES.has(tool) && d.strokeOpacity !== 1) {
    style.opacity = d.strokeOpacity;
  }
  if (LINE_TYPES.has(tool)) {
    const ends = d.ends[tool];
    if (ends.start !== 'none') style.startDecoration = ends.start;
    if (ends.end !== (tool === 'arrow' ? 'arrow' : 'none')) style.endDecoration = ends.end;
  }
  if (tool === 'textbox') {
    style.fontSize = d.fontSize;
    style.fontFamily = d.fontFamily;
    style.textColor = d.textColor;
    style.bold = d.bold;
    style.italic = d.italic;
    style.underline = d.underline;
    style.textAlign = 'left';
    style.verticalAlign = 'top';
    style.backgroundOpacity = d.textBoxBackgroundOpacity;
  } else if (CLOSED_TYPES.has(tool)) {
    style.fontSize = d.fontSize;
    style.fontFamily = d.fontFamily;
    style.textColor = d.textColor;
    style.bold = tool === 'rectangle' ? true : d.bold;
    style.italic = d.italic;
    style.underline = d.underline;
    style.textAlign = d.textAlign;
    style.verticalAlign = d.verticalAlign;
  }
  return style;
}

/** Remember an edited style as `tool`'s defaults, in place. */
export function storeToolDefaults(d, tool, style) {
  d.color = style.color;
  d.intent = style.intent ?? null;
  if (tool === 'brush') {
    d.brushWidth = style.width;
    d.brushOpacity = style.opacity ?? d.brushOpacity;
  } else {
    d.width = style.width;
    if (STROKE_OPACITY_TYPES.has(tool)) d.strokeOpacity = style.opacity ?? 1;
  }
  if (CLOSED_TYPES.has(tool)) {
    const fill = redlineMarkFill(style);
    d.fillOpacity = fill ? style.fillOpacity : 0;
    d.savedFill = style.savedFill ? { ...style.savedFill } : null;
    d.outline = style.outline !== false;
    if (fill) {
      d.fill = style.fill ?? null;
      d.lastFillOpacity = style.fillOpacity;
    }
  }
  // A straight line may have been renamed arrow (or back) by its ends; the
  // decorations are what the tool remembers.
  if (LINE_TYPES.has(tool)) d.ends[tool] = markDecorations(style);
  if (tool === 'textbox' || CLOSED_TYPES.has(tool)) {
    d.fontSize = style.fontSize ?? d.fontSize;
    d.fontFamily = style.fontFamily ?? d.fontFamily;
    d.textColor = style.textColor ?? d.textColor;
    d.bold = style.bold ?? d.bold;
    d.italic = style.italic ?? d.italic;
    d.underline = style.underline ?? d.underline;
    d.textAlign = style.textAlign ?? d.textAlign;
    d.verticalAlign = style.verticalAlign ?? d.verticalAlign;
  }
  if (tool === 'textbox') {
    d.textBoxBackgroundOpacity = style.backgroundOpacity ?? d.textBoxBackgroundOpacity;
  }
}

/**
 * Apply saved preferences to defaults `d` in place, keeping only valid values.
 * Returns the saved non-style settings: the tool (when `isTool` accepts it)
 * and the toolbar dock state.
 */
export function readPreferences(saved, d, { isTool = () => false } = {}) {
  const result = { tool: null, toolbarPinned: false, toolbarPosition: null };
  if (!saved || typeof saved !== 'object') return result;
  if (saved.tool !== 'crop' && isTool(saved.tool)) result.tool = saved.tool;
  if (isHexColor(saved.color)) d.color = saved.color;
  if (isHexColor(saved.fill)) d.fill = saved.fill;
  if (unit(saved.fillOpacity)) d.fillOpacity = saved.fillOpacity;
  if (isHexColor(saved.savedFill?.color) && unit(saved.savedFill?.opacity) && saved.savedFill.opacity > 0) {
    d.savedFill = { color: saved.savedFill.color, opacity: saved.savedFill.opacity };
  }
  if (unit(saved.lastFillOpacity) && saved.lastFillOpacity > 0) d.lastFillOpacity = saved.lastFillOpacity;
  if (unit(saved.strokeOpacity)) d.strokeOpacity = saved.strokeOpacity;
  if (saved.outline === false && d.fillOpacity > 0) d.outline = false;
  if (typeof saved.intent === 'string' && saved.intent) d.intent = saved.intent.slice(0, 32);
  if (saved.noteMarker === 'alpha' || saved.noteMarker === 'numeric') d.noteMarker = saved.noteMarker;
  if (saved.bulletScheme === 'alpha' || saved.bulletScheme === 'numeric') d.bulletScheme = saved.bulletScheme;
  if (typeof saved.legendVisible === 'boolean') d.legendVisible = saved.legendVisible;
  if (Number.isFinite(saved.width) && saved.width >= 1 / 3) d.width = saved.width;
  if (Number.isFinite(saved.brushWidth) && saved.brushWidth > 0) d.brushWidth = saved.brushWidth;
  if (unit(saved.brushOpacity)) d.brushOpacity = saved.brushOpacity;
  // Old preferences described an opaque dark backing. Start the paper style
  // translucent once, then retain any new opacity the user explicitly chooses.
  if (saved.textBoxAppearance === 'paper' && unit(saved.textBoxBackgroundOpacity)) d.textBoxBackgroundOpacity = saved.textBoxBackgroundOpacity;
  if (Number.isFinite(saved.textBoxFontSize) && saved.textBoxFontSize >= 10 && saved.textBoxFontSize <= 96) d.fontSize = saved.textBoxFontSize;
  if (typeof saved.textFontFamily === 'string' && saved.textFontFamily.trim()) d.fontFamily = saved.textFontFamily.trim().slice(0, 160);
  if (isHexColor(saved.textColor)) d.textColor = saved.textColor;
  if (typeof saved.textBold === 'boolean') d.bold = saved.textBold;
  if (typeof saved.textItalic === 'boolean') d.italic = saved.textItalic;
  if (typeof saved.textUnderline === 'boolean') d.underline = saved.textUnderline;
  if (['left', 'center', 'right'].includes(saved.textAlign)) d.textAlign = saved.textAlign;
  if (['top', 'middle', 'bottom'].includes(saved.verticalAlign)) d.verticalAlign = saved.verticalAlign;
  for (const tool of ['line', 'arrow', 'polyline']) {
    if (validEnds(saved[`${tool}Ends`])) d.ends[tool] = { start: saved[`${tool}Ends`].start, end: saved[`${tool}Ends`].end };
  }
  result.toolbarPinned = saved.toolbarPinned === true;
  if (Number.isFinite(saved.toolbarPosition?.left) && Number.isFinite(saved.toolbarPosition?.top)) {
    result.toolbarPosition = { left: 8, top: saved.toolbarPosition.top };
  }
  return result;
}

/** The preferences object a host stores, from defaults, the tool and the dock state. */
export function writePreferences(d, { tool, toolbarPinned, toolbarPosition }) {
  return {
    tool,
    color: d.color, width: d.width, fill: d.fill, fillOpacity: d.fillOpacity, outline: d.outline,
    savedFill: d.savedFill ? { ...d.savedFill } : null,
    lastFillOpacity: d.lastFillOpacity, strokeOpacity: d.strokeOpacity, intent: d.intent, noteMarker: d.noteMarker,
    bulletScheme: d.bulletScheme, legendVisible: d.legendVisible,
    brushWidth: d.brushWidth, brushOpacity: d.brushOpacity,
    textBoxBackgroundOpacity: d.textBoxBackgroundOpacity, textBoxFontSize: d.fontSize,
    textFontFamily: d.fontFamily, textColor: d.textColor, textBold: d.bold,
    textItalic: d.italic, textUnderline: d.underline, textAlign: d.textAlign, verticalAlign: d.verticalAlign,
    textBoxAppearance: 'paper',
    lineEnds: { ...d.ends.line }, arrowEnds: { ...d.ends.arrow }, polylineEnds: { ...d.ends.polyline },
    toolbarPinned,
    toolbarPosition: toolbarPosition ? { ...toolbarPosition } : null,
  };
}
