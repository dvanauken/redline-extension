import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument } from '../redline/RedlineDocument.js';
const mark = id => ({ id, type: 'line', start: { x: 10, y: 20 }, end: { x: 200, y: 100 } });

for (const [label, data] of [
  ['invalid annotation', { width: 10, height: 10, annotations: [{ type: 'invalid' }] }],
  ['non-array annotations', { width: 10, height: 10, annotations: {} }],
  ['missing annotations', { width: 10, height: 10 }],
  ['duplicate IDs', { width: 10, height: 10, annotations: [mark('same'), mark('same')] }],
  ['zero width', { width: 0, height: 10, annotations: [] }],
  ['nonfinite height', { width: 10, height: Infinity, annotations: [] }],
  ['non-object document', 'invalid'],
]) {
  test('rejected import preserves state and both history stacks: ' + label, () => {
    const doc = new RedlineDocument({ width: 1200, height: 800 });
    doc.add(mark('first'));
    doc.add(mark('second'));
    doc.undo();
    const before = doc.toJSON();
    assert.throws(() => doc.load(data), TypeError);
    assert.deepEqual(doc.toJSON(), before);
    assert.equal(doc.canUndo, true);
    assert.equal(doc.canRedo, true);
    doc.redo();
    assert.deepEqual(doc.annotations.map(item => item.id), ['first', 'second']);
    doc.undo();
    doc.undo();
    assert.deepEqual(doc.annotations, []);
  });
}
test('successful import replaces dimensions and marks and clears history', () => {
  const doc = new RedlineDocument();
  doc.add(mark('old'));
  const incoming = { width: 900, height: 600, annotations: [mark('new')] };
  doc.load(incoming);
  incoming.annotations[0].start.x = -100;
  assert.equal(doc.width, 900);
  assert.equal(doc.height, 600);
  assert.equal(doc.annotations[0].start.x, 10);
  assert.equal(doc.canUndo, false);
  assert.equal(doc.canRedo, false);
});
test('duplicate add cannot discard redo history', () => {
  const doc = new RedlineDocument();
  doc.add(mark('first'));
  doc.add(mark('second'));
  doc.undo();
  assert.throws(() => doc.add(mark('first')), /Duplicate/);
  assert.equal(doc.canRedo, true);
  doc.redo();
  assert.equal(doc.annotations.length, 2);
});
