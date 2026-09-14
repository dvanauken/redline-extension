/**
 * Live SVG rendering of marks, drawn from the same primitives as the PNG.
 *
 * Nodes for committed marks are cached by mark identity. The document keeps
 * marks immutable, so an unchanged mark keeps its node across renders: moving
 * the pointer over a large document redraws only the draft, and a double-click
 * still lands on the node that received the first click.
 */

import { markBounds, markPrimitives, boxFromPoints, textBoxHandlePoints } from './RedlineGeometry.js';
import { REDLINE_FONT_FAMILY } from './RedlineTextLayout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgElement(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  return el;
}

function paintAttributes(primitive) {
  return {
    fill: primitive.fill ? primitive.fill.color : 'none',
    'fill-opacity': primitive.fill && primitive.fill.opacity !== 1 ? primitive.fill.opacity : undefined,
    stroke: primitive.stroke ? primitive.stroke.color : 'none',
    'stroke-width': primitive.stroke ? primitive.stroke.width : undefined,
    'stroke-opacity': primitive.stroke && primitive.stroke.opacity !== 1 ? primitive.stroke.opacity : undefined,
    'stroke-linecap': primitive.stroke ? 'round' : undefined,
    'stroke-linejoin': primitive.stroke ? 'round' : undefined,
  };
}

const pointList = points => points.map(point => `${point.x},${point.y}`).join(' ');

function primitiveNode(primitive) {
  const paint = paintAttributes(primitive);
  if (primitive.kind === 'path') {
    if (!primitive.points.length) return null;
    if (primitive.closed) return svgElement('polygon', { ...paint, points: pointList(primitive.points) });
    if (primitive.points.length === 2) {
      const [a, b] = primitive.points;
      return svgElement('line', { ...paint, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return svgElement('polyline', { ...paint, points: pointList(primitive.points) });
  }
  if (primitive.kind === 'rect') {
    return svgElement('rect', {
      ...paint, x: primitive.x, y: primitive.y, width: primitive.width, height: primitive.height,
      rx: primitive.radius || undefined,
    });
  }
  if (primitive.kind === 'ellipse') {
    if (primitive.rx === primitive.ry) {
      return svgElement('circle', { ...paint, cx: primitive.cx, cy: primitive.cy, r: primitive.rx });
    }
    return svgElement('ellipse', { ...paint, cx: primitive.cx, cy: primitive.cy, rx: primitive.rx, ry: primitive.ry });
  }
  if (primitive.kind === 'text') {
    const text = svgElement('text', {
      fill: primitive.color,
      // Presentation attributes rather than a style attribute, which a page's
      // Content-Security-Policy may refuse. Layout already collapsed spaces.
      'font-family': REDLINE_FONT_FAMILY,
      'font-size': primitive.font.size,
      'font-weight': primitive.font.weight,
      'text-anchor': primitive.anchor === 'middle' ? 'middle' : 'start',
    });
    for (const line of primitive.lines) {
      const span = svgElement('tspan', { x: line.x, y: line.y });
      span.textContent = line.text;
      text.appendChild(span);
    }
    if (!primitive.clip) return text;
    // A nested viewport clips without needing a document-unique clipPath id.
    const { x, y, width, height } = primitive.clip;
    const viewport = svgElement('svg', {
      x, y, width: Math.max(0, width), height: Math.max(0, height),
      viewBox: `${x} ${y} ${Math.max(0.001, width)} ${Math.max(0.001, height)}`,
      overflow: 'hidden', 'data-redline-text-clip': '',
    });
    viewport.appendChild(text);
    return viewport;
  }
  return null;
}

/** A group of SVG nodes for drawing primitives, such as the pointer proxy's. */
export function renderPrimitives(primitives, attrs = {}) {
  const group = svgElement('g', attrs);
  for (const primitive of primitives) {
    const node = primitiveNode(primitive);
    if (node) group.appendChild(node);
  }
  return group;
}

export function renderMarkNode(mark, measurer) {
  return renderPrimitives(markPrimitives(mark, measurer), { 'data-redline-id': mark.id, 'data-redline-type': mark.type });
}

export class RedlineSvgLayer {
  constructor(svg, measurer) {
    this.svg = svg;
    this.measurer = measurer;
    this.marks = svgElement('g', { 'data-redline-marks': '' });
    this.selection = svgElement('g', { 'data-redline-selection-layer': '' });
    svg.append(this.marks, this.selection);
    this._cache = new WeakMap();
  }

  _node(mark) {
    let node = this._cache.get(mark);
    if (!node) {
      node = renderMarkNode(mark, this.measurer);
      if (Object.isFrozen(mark)) this._cache.set(mark, node);
    }
    return node;
  }

  /** Reconcile the mark layer with the given marks, touching only changed nodes. */
  render(marks) {
    const nodes = marks.map(mark => this._node(mark));
    const current = this.marks.children;
    nodes.forEach((node, index) => {
      if (current[index] !== node) this.marks.insertBefore(node, current[index] ?? null);
    });
    while (current.length > nodes.length) current[current.length - 1].remove();
  }

  /**
   * Selection chrome in its own layer, so selecting never rebuilds a mark.
   * `scale` converts screen pixels to document units for constant-size chrome.
   */
  renderSelection(mark, { scale = { x: 1, y: 1 }, handles = false } = {}) {
    this.selection.replaceChildren();
    if (!mark) return;
    const padX = 6 / scale.x;
    const padY = 6 / scale.y;
    const bounds = mark.type === 'textbox' ? boxFromPoints(mark.start, mark.end) : markBounds(mark, this.measurer);
    const pad = mark.type === 'textbox' ? { x: 0, y: 0 } : { x: padX, y: padY };
    this.selection.appendChild(svgElement('rect', {
      'data-redline-selection': '',
      'data-redline-selection-for': mark.id,
      x: bounds.x - pad.x,
      y: bounds.y - pad.y,
      width: Math.max(12 / scale.x, bounds.width + pad.x * 2),
      height: Math.max(12 / scale.y, bounds.height + pad.y * 2),
      'vector-effect': 'non-scaling-stroke',
    }));
    if (!handles || mark.type !== 'textbox') return;
    const half = { x: 4.5 / scale.x, y: 4.5 / scale.y };
    for (const [handle, x, y] of textBoxHandlePoints(mark)) {
      this.selection.appendChild(svgElement('rect', {
        'data-redline-resize': handle,
        x: x - half.x, y: y - half.y, width: half.x * 2, height: half.y * 2,
        'vector-effect': 'non-scaling-stroke',
      }));
    }
  }
}
