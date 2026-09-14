import test from 'node:test';
import assert from 'node:assert/strict';
import { caretPoint, layoutLegend, legendEditingViewport } from '../redline/RedlineLegend.js';
import { createApproximateMeasurer } from '../redline/RedlineTextLayout.js';
const measurer = createApproximateMeasurer();
const frame = { visible: true, x: 250, y: 200, width: 300, height: null, fontSize: 14, fontFamily: 'sans-serif' };
const marks = [{ type: 'bullet', id: 'one', label: '1', color: '#000000', point: { x: 20, y: 20 }, text: 'Line\n'.repeat(100) }];
const area = { x: 8, y: 110, width: 984, height: 532 };
const layout = layoutLegend(frame, marks, measurer);
const caret = caretPoint(layout, layout.rows[0], marks[0].text.length, 'downstream', measurer);

test('a short on-screen legend needs no temporary editing viewport', () => {
  const short = layoutLegend(frame, [{ ...marks[0], text: 'Short' }], measurer);
  assert.equal(legendEditingViewport(short, area, null), null);
});

test('long content reveals the caret without mutating source layout or geometry', () => {
  const before = JSON.stringify(layout);
  const view = legendEditingViewport(layout, area, caret);
  assert.ok(view.scrollY > 0);
  assert.ok(caret.top + view.offsetY >= view.content.y);
  assert.ok(caret.top + view.offsetY + caret.height <= view.content.y + view.content.height + 1e-6);
  assert.equal(JSON.stringify(layout), before);
});

test('manual scrolling can leave the caret behind and clamps to content bounds', () => {
  const top = legendEditingViewport(layout, area, caret, { y: -100 }, { reveal: false });
  assert.equal(top.scrollY, 0);
  const end = legendEditingViewport(layout, area, caret, { y: 1e9 }, { reveal: false });
  assert.equal(end.scrollY, end.maxY);
});

test('source and editing view coordinates map both ways after vertical and horizontal scrolling', () => {
  const small = { x: 8, y: 150, width: 180, height: 300 };
  const view = legendEditingViewport(layout, small, caret, { x: 45, y: 200 }, { reveal: false });
  const shown = { x: caret.x + view.offsetX, y: caret.top + view.offsetY };
  assert.equal(shown.x - view.offsetX, caret.x);
  assert.equal(shown.y - view.offsetY, caret.top);
  assert.equal(view.scrollX, 45);
  assert.ok(view.box.x >= small.x && view.box.x + view.box.width <= small.x + small.width);
});

test('off-screen legend geometry gets a bounded temporary view, including extreme narrow windows', () => {
  const off = layoutLegend({ ...frame, x: -500, y: 1000 }, marks, measurer);
  for (const scale of [{ x: 1, y: 1 }, { x: 0.42, y: 0.9 }]) {
    const view = legendEditingViewport(off, area, null, {}, { scale });
    assert.ok(view.box.x >= area.x && view.box.y >= area.y);
    assert.ok(view.box.x + view.box.width <= area.x + area.width);
    assert.ok(view.box.y + view.box.height <= area.y + area.height);
    assert.ok(view.content.height > 0);
  }
});
