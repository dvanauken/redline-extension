import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument } from '../redline/RedlineDocument.js';
import { createApproximateMeasurer } from '../redline/RedlineTextLayout.js';
import {
  applyTextRangeStyle, layoutShapeText, measureStyledRange, remapTextRuns, shapeTextIntervals,
} from '../redline/RedlineShapeText.js';
import {
  directPointAt, directSegmentAt, directSelectionPoints, insertDirectPoint, moveDirectPoint, removeDirectPoint,
} from '../redline/RedlineTransform.js';
import { applyStyleChange } from '../redline/RedlineStyles.js';

const measurer = createApproximateMeasurer({ advance: 0.5 });
const polygon = overrides => ({
  id: 'p', type: 'polygon', color: '#B65D66', width: 2,
  points: [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 130, y: 180 }, { x: 70, y: 180 }],
  text: 'A shape-aware sentence that wraps at word boundaries and stays inside every sloping wall.',
  fontSize: 16, ...overrides,
});

test('polygon text slots narrow against sloping walls and every laid-out line fits its live interval', () => {
  const mark = polygon();
  const top = shapeTextIntervals(mark, 32, 52)[0];
  const bottom = shapeTextIntervals(mark, 142, 162)[0];
  assert.ok(bottom[1] - bottom[0] < top[1] - top[0]);
  const layout = layoutShapeText(mark, measurer);
  assert.ok(layout.lines.length >= 3);
  for (const line of layout.lines) {
    assert.ok(line.width <= line.available.width + 1e-9);
    assert.ok(line.x >= line.available.x - 1e-9);
    assert.ok(line.x + line.width <= line.available.x + line.available.width + 1e-9);
  }
});

test('wrapping prefers whitespace and hyphen boundaries before grapheme fallback', () => {
  const mark = {
    id: 'r', type: 'rectangle', color: '#000000', width: 1,
    start: { x: 0, y: 0 }, end: { x: 92, y: 100 }, fontSize: 16,
    textAlign: 'left', verticalAlign: 'top', text: 'alpha-beta gamma',
  };
  const lines = layoutShapeText(mark, measurer).lines.map(line => mark.text.slice(line.start, line.end));
  assert.equal(lines[0], 'alpha-');
  assert.equal(lines.join(''), mark.text);
});

test('range formatting produces measurable rich runs and survives native text insertion', () => {
  let mark = polygon({ text: 'bold and color', bold: false });
  mark = applyTextRangeStyle(mark, 'bold', true, 0, 4);
  mark = applyTextRangeStyle(mark, 'textColor', '#D02020', 9, 14);
  const layout = layoutShapeText(mark, measurer);
  const runs = layout.lines.flatMap(line => line.runs);
  assert.equal(runs.find(run => run.start === 0).style.bold, true);
  assert.equal(runs.find(run => run.start <= 9 && run.end > 9).style.color, '#D02020');
  assert.ok(measureStyledRange(mark, 0, 4, measurer) > 0);

  const edited = remapTextRuns(mark, 'bold new and color', { italic: true });
  assert.equal(edited.text, 'bold new and color');
  assert.ok(edited.textRuns.some(run => run.italic && edited.text.slice(run.start, run.end) === 'new '));
  assert.ok(edited.textRuns.some(run => run.textColor === '#D02020' && edited.text.slice(run.start, run.end) === 'color'));
});

test('whole-shape formatting replaces the same property in selected character runs', () => {
  const mark = polygon({
    text: 'mixed styles', bold: false, textColor: '#111111',
    textRuns: [{ start: 0, end: 5, bold: true, italic: true, textColor: '#D02020' }],
  });
  const bold = applyStyleChange(mark, { property: 'bold', value: true });
  assert.equal(bold.bold, true);
  assert.equal(bold.textRuns[0].bold, undefined);
  assert.equal(bold.textRuns[0].italic, true);
  const colored = applyStyleChange(bold, { property: 'textColor', value: '#2040D0' });
  assert.equal(colored.textColor, '#2040D0');
  assert.equal(colored.textRuns[0].textColor, undefined);
});

test('rich text on polygons round-trips through JSON and undo with no unsupported fields', () => {
  const doc = new RedlineDocument({ width: 300, height: 220 });
  doc.add(polygon({
    text: 'Editable polygon text', fontFamily: 'Georgia, serif', textColor: '#123456', italic: true,
    textAlign: 'right', verticalAlign: 'bottom',
    textRuns: [{ start: 0, end: 8, bold: true, underline: true }],
  }));
  const saved = doc.toJSON();
  const restored = new RedlineDocument();
  const report = restored.load(saved);
  assert.deepEqual(report.ignoredFields, []);
  assert.deepEqual(restored.toJSON(), saved);
  restored.replace('p', { ...restored.find('p'), textAlign: 'left' });
  assert.equal(restored.undo(), true);
  assert.equal(restored.find('p').textAlign, 'right');
});

test('changing a polygon vertex recomputes contour wrapping immediately', () => {
  const before = layoutShapeText(polygon(), measurer);
  const changed = polygon({ points: [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 95, y: 180 }, { x: 70, y: 180 }] });
  const after = layoutShapeText(changed, measurer);
  assert.notDeepEqual(after.lines.map(line => [line.available.x, line.available.width]),
    before.lines.map(line => [line.available.x, line.available.width]));
});

test('direct selection finds, moves, inserts and removes points, including on a rotated path', () => {
  const mark = polygon({ text: '', rotation: 90 });
  const shown = directSelectionPoints(mark);
  assert.equal(directPointAt(mark, shown[1], { scale: { x: 1, y: 1 } }), 1);
  const moved = moveDirectPoint(mark, 1, shown[1], { x: shown[1].x + 10, y: shown[1].y });
  assert.notDeepEqual(moved.points[1], mark.points[1]);

  const midpoint = {
    x: (shown[0].x + shown[1].x) / 2,
    y: (shown[0].y + shown[1].y) / 2,
  };
  assert.equal(directSegmentAt(mark, midpoint)?.index, 1);
  const inserted = insertDirectPoint(mark, midpoint);
  assert.equal(inserted.mark.points.length, mark.points.length + 1);
  assert.equal(removeDirectPoint(inserted.mark, inserted.index).points.length, mark.points.length);
  assert.equal(removeDirectPoint({ ...mark, points: mark.points.slice(0, 3) }, 0), null,
    'a polygon cannot be reduced below three vertices');
});
