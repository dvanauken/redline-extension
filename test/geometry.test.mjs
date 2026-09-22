import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constrainAxis, constrainSquare, decorationRadius, distinctPoints, endDirection, hitTestMark, isUsefulPolygon,
  markBounds, markPrimitives, snapAngle, topmostMarkAt,
} from '../redline/RedlineGeometry.js';
import { createApproximateMeasurer } from '../redline/RedlineTextLayout.js';

const measurer = createApproximateMeasurer();
const line = (extra = {}) => ({
  id: 'l', type: 'line', color: '#111827', width: 2, start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, ...extra,
});
const finite = value => JSON.stringify(value, (key, item) => {
  if (typeof item === 'number') assert.ok(Number.isFinite(item), `${key} is ${item}`);
  return item;
});

test('a plain line is one path with no decorations', () => {
  const primitives = markPrimitives(line(), measurer);
  assert.equal(primitives.length, 1);
  assert.deepEqual(primitives[0].points, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
});

test('a legacy arrow draws its arrowhead at the end only', () => {
  const primitives = markPrimitives(line({ type: 'arrow' }), measurer);
  assert.equal(primitives.length, 2);
  const head = primitives[1];
  assert.deepEqual(head.points[1], { x: 100, y: 0 });
  assert.ok(head.points[0].x < 100 && head.points[2].x < 100, 'wings trail behind the tip');
});

test('each end is decorated independently, including arrows in both directions', () => {
  const both = markPrimitives(line({ startDecoration: 'arrow', endDecoration: 'arrow' }), measurer);
  assert.equal(both.filter(item => item.kind === 'path').length, 3);
  const startOnly = markPrimitives(line({ startDecoration: 'arrow' }), measurer);
  const head = startOnly.find((item, index) => index > 0);
  assert.deepEqual(head.points[1], { x: 0, y: 0 });
  assert.ok(head.points[0].x > 0, 'a start arrow points backwards');
});

test('an open circle is hollow and the line stops at its rim; a filled circle is solid', () => {
  const r = decorationRadius(2);
  const primitives = markPrimitives(line({ startDecoration: 'open-circle', endDecoration: 'filled-circle' }), measurer);
  const path = primitives.find(item => item.kind === 'path');
  assert.ok(Math.abs(path.points[0].x - r) < 1e-9);
  const [open, filled] = primitives.filter(item => item.kind === 'ellipse');
  assert.equal(open.fill, null);
  assert.ok(open.stroke);
  assert.equal(filled.stroke, null);
  assert.equal(filled.fill.color, '#111827');
  assert.deepEqual([filled.cx, filled.cy], [100, 0]);
});

test('polyline ends use the first and last segments of nonzero length', () => {
  const points = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 50 }];
  const start = endDirection(points, 'start');
  assert.ok(Math.abs(start.x) < 1e-12 && start.y === -1, JSON.stringify(start));
  assert.deepEqual(endDirection(points, 'end'), { x: 1, y: 0 });
  const primitives = markPrimitives({
    id: 'p', type: 'polyline', color: '#000000', width: 2, points, startDecoration: 'arrow', endDecoration: 'arrow',
  }, measurer);
  finite(primitives);
  assert.equal(primitives.length, 3);
});

test('repeated points and zero-length lines never produce NaN or phantom arrowheads', () => {
  const same = { x: 40, y: 40 };
  for (const [startDecoration, endDecoration] of [['arrow', 'arrow'], ['open-circle', 'filled-circle'], ['open-circle', 'open-circle']]) {
    const zero = line({ start: same, end: same, startDecoration, endDecoration });
    const primitives = markPrimitives(zero, measurer);
    finite(primitives);
    finite(markBounds(zero, measurer));
    assert.equal(primitives.filter(item => item.kind === 'path' && item.points.length === 3).length, 0);
  }
  const polyline = { id: 'p', type: 'polyline', color: '#000', width: 2, points: [same, same, same], endDecoration: 'arrow' };
  finite(markPrimitives(polyline, measurer));
});

test('closed polygons ignore decoration fields', () => {
  const polygon = {
    id: 'g', type: 'polygon', color: '#000', width: 2, startDecoration: 'arrow', endDecoration: 'arrow',
    points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 40 }],
  };
  const primitives = markPrimitives(polygon, measurer);
  assert.equal(primitives.length, 1);
  assert.equal(primitives[0].closed, true);
});

test('bounds include decorations and stroke width', () => {
  const plain = markBounds(line(), measurer);
  const circles = markBounds(line({ startDecoration: 'open-circle', endDecoration: 'open-circle' }), measurer);
  const r = decorationRadius(2);
  assert.ok(circles.x <= -r && circles.x + circles.width >= 100 + r);
  assert.ok(circles.height > plain.height);
  const arrow = markBounds(line({ type: 'arrow' }), measurer);
  assert.ok(arrow.height > plain.height, 'arrowhead wings widen the bounds');
});

test('an outline-only shape is hit on its outline, not in its empty interior', () => {
  const box = { id: 'b', type: 'rectangle', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 600, y: 400 } };
  assert.equal(hitTestMark(box, { x: 300, y: 200 }, 6, measurer), false);
  assert.equal(hitTestMark(box, { x: 3, y: 200 }, 6, measurer), true);
  assert.equal(hitTestMark({ ...box, fillOpacity: 0.1 }, { x: 300, y: 200 }, 6, measurer), true);
  const ellipse = { ...box, type: 'ellipse' };
  assert.equal(hitTestMark(ellipse, { x: 300, y: 200 }, 6, measurer), false);
  assert.equal(hitTestMark(ellipse, { x: 300, y: 1 }, 6, measurer), true);
  assert.equal(hitTestMark({ ...ellipse, fillOpacity: 0.5, outline: false }, { x: 300, y: 200 }, 6, measurer), true);
});

test('a rectangle label is a centred rich-text run clipped to the rectangle', () => {
  const box = {
    id: 'labelled', type: 'rectangle', color: '#B65D66', width: 2, fillOpacity: 1,
    start: { x: 10, y: 20 }, end: { x: 210, y: 120 }, text: 'Room name', fontSize: 20,
  };
  const primitives = markPrimitives(box, measurer);
  assert.equal(primitives.length, 2);
  assert.equal(primitives[1].kind, 'text');
  assert.equal(primitives[1].anchor, 'start');
  assert.equal(primitives[1].font.size, 20);
  assert.deepEqual(primitives[1].clip, { x: 10, y: 20, width: 200, height: 100 });
  assert.equal(primitives[1].lines.map(line => line.text).join(' '), 'Room name');
  assert.equal(primitives[1].lines[0].runs[0].style.bold, true);
  assert.ok(primitives[1].lines[0].x > 10 && primitives[1].lines[0].x < 110, 'centering is resolved into the indexed line x');
});

test('the topmost painted mark wins; a distant outline is not picked', () => {
  const big = { id: 'big', type: 'rectangle', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 800, y: 600 } };
  const small = { id: 'small', type: 'line', color: '#000', width: 2, start: { x: 380, y: 300 }, end: { x: 420, y: 300 } };
  assert.equal(topmostMarkAt([big, small], { x: 400, y: 302 }, 6, measurer)?.id, 'small');
  assert.equal(topmostMarkAt([big, small], { x: 200, y: 200 }, 6, measurer), null);
  const text = { id: 'text', type: 'textbox', color: '#000', width: 1, fontSize: 16, backgroundOpacity: 0, text: 'x', start: { x: 10, y: 10 }, end: { x: 110, y: 58 } };
  assert.equal(topmostMarkAt([big, text], { x: 60, y: 30 }, 6, measurer)?.id, 'text');
});

test('Shift snaps segments to 45° as seen on screen, even after a nonuniform resize', () => {
  const snapped = snapAngle({ x: 0, y: 0 }, { x: 100, y: 12 });
  assert.equal(snapped.y, 0);
  const diagonal = snapAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-9);
  const scaled = snapAngle({ x: 0, y: 0 }, { x: 50, y: 95 }, { scale: { x: 2, y: 1 } });
  assert.ok(Math.abs(scaled.x * 2 - scaled.y) < 1e-9, 'equal screen distances on both axes');
});

test('Shift draws squares and circles, and keeps moves on one axis', () => {
  assert.deepEqual(constrainSquare({ x: 10, y: 10 }, { x: 60, y: 30 }), { x: 60, y: 60 });
  assert.deepEqual(constrainSquare({ x: 10, y: 10 }, { x: -20, y: 30 }), { x: -20, y: 40 });
  assert.deepEqual(constrainAxis(10, 3), { dx: 10, dy: 0 });
  assert.deepEqual(constrainAxis(2, -9), { dx: 0, dy: -9 });
});

test('duplicate trailing vertices are dropped and new polygons need an enclosed area', () => {
  assert.deepEqual(distinctPoints([{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.1 }]), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.equal(isUsefulPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }]), false);
  assert.equal(isUsefulPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]), false, 'collinear');
  assert.equal(isUsefulPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]), true);
});
