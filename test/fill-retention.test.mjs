import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument } from '../redline/RedlineDocument.js';
import { applyStyleChange, redlineMarkFill } from '../redline/RedlineStyles.js';

const shape = type => ({ id: type, type, color: '#1D4ED8', fill: '#FDE68A', fillOpacity: 0.35,
  start: { x: 10, y: 10 }, end: { x: 150, y: 100 }, points: [{ x: 10, y: 10 }, { x: 150, y: 10 }, { x: 80, y: 100 }] });
const treatment = (mark, value) => applyStyleChange(mark, { property: 'treatment', value });

for (const type of ['rectangle', 'ellipse', 'polygon']) {
  test(type + ' remembers its own fill through Outline, JSON, undo and redo', () => {
    const doc = new RedlineDocument({ width: 300, height: 200 });
    doc.add(shape(type));
    doc.replace(type, treatment(doc.find(type), 'outline'));
    assert.equal(redlineMarkFill(doc.find(type)), null, 'Outline paints no fill');
    assert.deepEqual(doc.find(type).savedFill, { color: '#FDE68A', opacity: 0.35 });
    assert.ok(Object.isFrozen(doc.find(type).savedFill));
    doc.undo();
    assert.equal(doc.find(type).fillOpacity, 0.35);
    doc.redo();
    const imported = new RedlineDocument();
    assert.deepEqual(imported.load(doc.toJSON()).ignoredFields, []);
    const restored = treatment(imported.find(type), { treatment: 'fill', fillOpacity: 0.75 });
    assert.equal(restored.fillOpacity, 0.35, 'the mark wins over drawing defaults');
    assert.equal(restored.fill, '#FDE68A');
    assert.equal(restored.outline, false);
    assert.equal(restored.savedFill, undefined);
  });
}

test('changing the outline while fill is hidden preserves the previous fill colour', () => {
  const mark = { ...shape('rectangle'), fill: undefined };
  const outline = treatment(mark, 'outline');
  const recoloured = applyStyleChange(outline, { property: 'strokeColor', value: { color: '#DC2626' } });
  const restored = treatment(recoloured, 'outline-fill');
  assert.equal(restored.fill, '#1D4ED8');
  assert.equal(restored.color, '#DC2626');
  assert.equal(mark.fillOpacity, 0.35, 'source remains untouched');
});

test('explicit fill strength and colour edits restore the other remembered setting', () => {
  const outline = treatment(shape('rectangle'), 'outline');
  const opacity = applyStyleChange(outline, { property: 'fillOpacity', value: 0.1 });
  assert.equal(opacity.fillOpacity, 0.1);
  assert.equal(opacity.fill, '#FDE68A');
  const colour = applyStyleChange(outline, { property: 'fillColor', value: { color: '#16A34A' } });
  assert.equal(colour.fillOpacity, 0.35);
  assert.equal(colour.fill, '#16A34A');
});

test('malformed saved fill rejects an import atomically without losing history', () => {
  const doc = new RedlineDocument({ width: 300, height: 200 });
  doc.add(shape('rectangle'));
  doc.add({ ...shape('ellipse') });
  doc.undo();
  const before = doc.toJSON();
  for (const savedFill of [{ color: '#FFFFFF', opacity: 0 }, { color: '#FFFFFF', opacity: 2 },
    { color: {}, opacity: 0.5 }, { opacity: 0.5 }, 'invalid']) {
    assert.throws(() => doc.load({ ...before, annotations: [{ ...shape('polygon'), fillOpacity: 0, savedFill }] }), /saved fill/i);
    assert.deepEqual(doc.toJSON(), before);
    assert.equal(doc.canUndo, true);
    assert.equal(doc.canRedo, true);
  }
});
