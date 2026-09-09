import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument } from '../redline/RedlineDocument.js';
import { cropFromPoints, moveCrop, resizeCrop, cropExportGeometry } from '../redline/RedlineCrop.js';

const crop = { x: 100, y: 80, width: 300, height: 200 };
const mark = { id: 'line', type: 'line', start: { x: 0, y: 100 }, end: { x: 800, y: 100 } };

test('crop and scale round-trip without changing marks or their undo/redo history', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  doc.add(mark);
  doc.undo();
  doc.setCrop(crop);
  doc.setOutputScale(2);
  assert.equal(doc.canRedo, true);
  doc.redo();
  const saved = doc.toJSON();
  const imported = new RedlineDocument();
  imported.load(saved);
  assert.deepEqual(imported.toJSON(), saved);
  imported.crop.x = -1;
  saved.crop.y = -1;
  assert.deepEqual(imported.crop, crop);
  doc.setCrop(null);
  doc.undo();
  assert.deepEqual(doc.annotations, []);
  assert.equal(doc.crop, null);
});

for (const [label, settings] of [
  ['negative origin', { crop: { ...crop, x: -1 } }],
  ['empty rectangle', { crop: { ...crop, width: 0 } }],
  ['outside viewport', { crop: { ...crop, width: 900 } }],
  ['nonfinite coordinate', { crop: { ...crop, y: Infinity } }],
  ['missing height', { crop: { x: 10, y: 10, width: 20 } }],
  ['array instead of rectangle', { crop: [] }],
  ['unsupported output scale', { outputScale: 99 }],
]) {
  test('invalid crop import is atomic: ' + label, () => {
    const doc = new RedlineDocument({ width: 800, height: 600, crop, outputScale: 2 });
    doc.add(mark);
    doc.undo();
    const before = doc.toJSON();
    assert.throws(() => doc.load({ width: 800, height: 600, annotations: [], ...settings }), TypeError);
    assert.deepEqual(doc.toJSON(), before);
    assert.equal(doc.canRedo, true);
  });
}

test('legacy v1 imports restore full-screen export at native size', () => {
  const doc = new RedlineDocument({ width: 800, height: 600, crop, outputScale: 2 });
  doc.load({ width: 400, height: 300, annotations: [] });
  assert.equal(doc.crop, null);
  assert.equal(doc.outputScale, 1);
  assert.deepEqual(doc.toJSON(), { width: 400, height: 300, annotations: [] });
});

test('reverse drawing and movement clamp to document edges', () => {
  assert.deepEqual(cropFromPoints({ x: 900, y: 650 }, { x: 100, y: 80 }, 800, 600),
    { x: 100, y: 80, width: 700, height: 520 });
  assert.deepEqual(moveCrop(crop, -1000, 1000, 800, 600),
    { ...crop, x: 0, y: 400 });
});

test('all eight resize handles keep the opposite edges anchored and respect limits', () => {
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const resized = resizeCrop(crop, handle, 15, 10, 800, 600);
    assert.equal(resized.x, crop.x + (handle.includes('w') ? 15 : 0));
    assert.equal(resized.y, crop.y + (handle.includes('n') ? 10 : 0));
    assert.equal(resized.x + resized.width, 400 + (handle.includes('e') ? 15 : 0));
    assert.equal(resized.y + resized.height, 280 + (handle.includes('s') ? 10 : 0));
  }
  assert.deepEqual(resizeCrop(crop, 'nw', -1000, -1000, 800, 600),
    { x: 0, y: 0, width: 400, height: 280 });
  assert.deepEqual(resizeCrop(crop, 'se', -1000, -1000, 800, 600, 8, 8),
    { x: 100, y: 80, width: 8, height: 8 });
});

test('export maps crop to actual screenshot pixels even after nonuniform viewport resizing', () => {
  const doc = new RedlineDocument({ width: 1000, height: 500,
    crop: { x: 250, y: 150, width: 500, height: 87.5 }, outputScale: 2 });
  const result = cropExportGeometry(doc, 1200, 1600);
  assert.deepEqual(result.source, { x: 300, y: 480, width: 600, height: 280 });
  assert.equal(result.width, 1200);
  assert.equal(result.height, 560);
  doc.setOutputScale(0.5);
  assert.equal(cropExportGeometry(doc, 1200, 1600).width, 300);
});
