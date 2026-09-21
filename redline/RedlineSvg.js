/**
 * Live SVG rendering of marks, drawn from the same primitives as the PNG.
 *
 * Nodes for committed marks are cached by mark identity. The document keeps
 * marks immutable, so an unchanged mark keeps its node across renders: moving
 * the pointer over a large document redraws only the draft, and a double-click
 * still lands on the node that received the first click.
 */

import { markBounds, markPrimitives } from './RedlineGeometry.js';
import { REDLINE_FONT_FAMILY } from './RedlineTextLayout.js';
import { caretGeometry, layoutShapeText, selectionGeometry } from './RedlineShapeText.js';
import {
  DIRECT_POINT_RADIUS, HANDLE_RADIUS, ROTATE_KNOB_RADIUS, directSelectionPoints, selectionFrame, selectionHandles,
} from './RedlineTransform.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Lucide's rotate-cw arrow (ISC licence), drawn inside the rotate knob. */
const ROTATE_ICON = 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5';

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
  if (primitive.rotation?.angle) {
    const { angle, cx, cy } = primitive.rotation;
    const node = primitiveNode({ ...primitive, rotation: null });
    if (!node) return null;
    const group = svgElement('g', { transform: `rotate(${angle} ${cx} ${cy})` });
    group.appendChild(node);
    return group;
  }
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
      if (line.runs?.length) {
        for (const run of line.runs) {
          const span = svgElement('tspan', {
            x: run.x, y: run.y,
            'font-family': run.style.family,
            'font-size': run.style.size,
            'font-weight': run.style.bold ? 700 : 400,
            'font-style': run.style.italic ? 'italic' : 'normal',
            'text-decoration': run.style.underline ? 'underline' : undefined,
            fill: run.style.color,
          });
          span.textContent = run.text;
          text.appendChild(span);
        }
      } else {
        const span = svgElement('tspan', { x: line.x, y: line.y });
        span.textContent = line.text;
        text.appendChild(span);
      }
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
    this.textEditing = svgElement('g', { 'data-redline-text-editing-layer': '' });
    this.selection = svgElement('g', { 'data-redline-selection-layer': '' });
    svg.append(this.marks, this.textEditing, this.selection);
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

  /** Draw the native text selection/caret over a shape-aware text layout. */
  renderTextEditing(mark, { start = 0, end = start, focused = true } = {}) {
    this.textEditing.replaceChildren();
    if (!mark) return;
    const layout = layoutShapeText(mark, this.measurer);
    const group = svgElement('g', { 'data-redline-rich-text-selection': '' });
    const frame = selectionFrame(mark);
    if (frame?.rotation) group.setAttribute('transform', `rotate(${frame.rotation} ${frame.center.x} ${frame.center.y})`);
    for (const rect of selectionGeometry(layout, mark, start, end, this.measurer)) {
      group.appendChild(svgElement('rect', { ...rect, 'data-redline-text-selection': '' }));
    }
    if (focused && start === end) {
      const caret = caretGeometry(layout, mark, end, this.measurer);
      if (caret) group.appendChild(svgElement('line', {
        x1: caret.x, y1: caret.y, x2: caret.x, y2: caret.y + caret.height,
        'data-redline-text-caret': '', 'vector-effect': 'non-scaling-stroke',
      }));
    }
    this.textEditing.appendChild(group);
  }

  /**
   * Selection chrome in its own layer, so selecting never rebuilds a mark.
   *
   * A framed mark shows its frame, turned with the mark; anything else shows a
   * dashed box around what it paints. With `handles`, the resize handles and
   * rotate knob from RedlineTransform.js are added. `scale` converts document
   * units to screen pixels, so the chrome keeps a constant on-screen size, and
   * `bounds` keeps the knob on the drawing surface.
   */
  renderSelection(mark, {
    scale = { x: 1, y: 1 }, handles = false, bounds = null, mode = 'object', selectedVertex = null,
  } = {}) {
    this.selection.replaceChildren();
    if (!mark) return;
    if (mode === 'direct') {
      const vertices = directSelectionPoints(mark);
      if (!vertices.length) return;
      this.selection.appendChild(svgElement(mark.type === 'polygon' ? 'polygon' : 'polyline', {
        points: pointList(vertices),
        'data-redline-direct-boundary': '',
        'data-redline-selection-for': mark.id,
        'vector-effect': 'non-scaling-stroke',
      }));
      const at = ({ x, y }) => `translate(${x} ${y}) scale(${1 / scale.x} ${1 / scale.y})`;
      for (const vertex of vertices) {
        this.selection.appendChild(svgElement('circle', {
          r: DIRECT_POINT_RADIUS,
          transform: at(vertex),
          'data-redline-direct-point': vertex.index,
          'data-selected': vertex.index === selectedVertex ? '' : undefined,
          'vector-effect': 'non-scaling-stroke',
        }));
      }
      return;
    }
    const frame = selectionFrame(mark);
    if (frame) {
      const { box, center, rotation } = frame;
      this.selection.appendChild(svgElement('rect', {
        'data-redline-selection': '',
        'data-redline-frame': '',
        'data-redline-selection-for': mark.id,
        x: box.x, y: box.y, width: box.width, height: box.height,
        transform: rotation ? `rotate(${rotation} ${center.x} ${center.y})` : undefined,
        'vector-effect': 'non-scaling-stroke',
      }));
    } else {
      const padX = 6 / scale.x;
      const padY = 6 / scale.y;
      const painted = markBounds(mark, this.measurer);
      this.selection.appendChild(svgElement('rect', {
        'data-redline-selection': '',
        'data-redline-selection-for': mark.id,
        x: painted.x - padX,
        y: painted.y - padY,
        width: Math.max(12 / scale.x, painted.width + padX * 2),
        height: Math.max(12 / scale.y, painted.height + padY * 2),
        'vector-effect': 'non-scaling-stroke',
      }));
    }
    if (!handles) return;
    // Each handle is drawn in screen pixels about its document position.
    const at = ({ x, y }) => `translate(${x} ${y}) scale(${1 / scale.x} ${1 / scale.y})`;
    for (const handle of selectionHandles(mark, { scale, bounds })) {
      if (handle.name === 'rotate') {
        this.selection.appendChild(svgElement('line', {
          'data-redline-rotate-stem': '',
          x1: handle.from.x, y1: handle.from.y, x2: handle.x, y2: handle.y,
          'vector-effect': 'non-scaling-stroke',
        }));
        const knob = svgElement('g', { 'data-redline-rotate': '', transform: at(handle) });
        const icon = svgElement('g', { transform: 'scale(0.46) translate(-12 -12)' });
        icon.appendChild(svgElement('path', { d: ROTATE_ICON, 'data-redline-rotate-icon': '' }));
        knob.append(svgElement('circle', { r: ROTATE_KNOB_RADIUS }), icon);
        this.selection.appendChild(knob);
      } else {
        const node = svgElement('g', {
          'data-redline-resize': handle.name,
          ...(handle.name === 'center' ? { 'data-redline-move-handle': '' } : {}),
          transform: at(handle),
        });
        node.appendChild(svgElement('rect', {
          x: -HANDLE_RADIUS, y: -HANDLE_RADIUS, width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
        }));
        this.selection.appendChild(node);
      }
    }
  }
}
