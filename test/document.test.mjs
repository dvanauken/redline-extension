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

const box = (extra = {}) => ({
  id: 'box', type: 'rectangle', start: { x: 0, y: 0 }, end: { x: 40, y: 30 }, ...extra,
});

test('a fill survives the round-trip on a shape that encloses an area', () => {
  const doc = new RedlineDocument();
  const added = doc.add(box({ color: '#7C3AED', fill: '#7C3AED', fillOpacity: 0.25, intent: 'suggestion' }));
  assert.equal(added.fillOpacity, 0.25);
  assert.equal(added.intent, 'suggestion');
  // `fill` matching the stroke is redundant, so it is not stored.
  assert.equal('fill' in added, false);
  const reloaded = new RedlineDocument();
  reloaded.load(doc.toJSON());
  assert.deepEqual(reloaded.annotations[0], added);
});

test('a fill differing from the stroke is kept, as the solid style needs', () => {
  const doc = new RedlineDocument();
  const added = doc.add(box({ color: '#5B21B6', fill: '#7C3AED', fillOpacity: 1 }));
  assert.equal(added.fill, '#7C3AED');
  assert.equal(added.fillOpacity, 1);
});

test('an unfilled mark serialises exactly as it did before fills existed', () => {
  const doc = new RedlineDocument();
  const added = doc.add(box({ color: '#DC2626', fillOpacity: 0 }));
  assert.deepEqual(Object.keys(added).sort(), ['color', 'end', 'id', 'start', 'type', 'width']);
});

test('fill is refused on marks that enclose no area', () => {
  const doc = new RedlineDocument();
  const added = doc.add({ ...mark('open'), fill: '#DC2626', fillOpacity: 0.5 });
  assert.equal('fillOpacity' in added, false);
  assert.equal('fill' in added, false);
});

test('fill opacity is clamped and non-numbers fall back to unfilled', () => {
  const doc = new RedlineDocument();
  assert.equal(doc.add(box({ id: 'a', fillOpacity: 9 })).fillOpacity, 1);
  assert.equal('fillOpacity' in doc.add(box({ id: 'b', fillOpacity: -3 })), false);
  assert.equal('fillOpacity' in doc.add(box({ id: 'c', fillOpacity: 'lots' })), false);
});

test('a lettered note stores its ordinal and only the non-default marker', () => {
  const doc = new RedlineDocument();
  const base = { type: 'note', point: { x: 5, y: 5 }, text: 'step' };
  const lettered = doc.add({ ...base, id: 'l', number: 3, marker: 'alpha' });
  assert.equal(lettered.number, 3);
  assert.equal(lettered.marker, 'alpha');
  const numbered = doc.add({ ...base, id: 'n', number: 3 });
  assert.equal('marker' in numbered, false);
  assert.equal(doc.add({ ...base, id: 'x', number: 1, marker: 'roman' }).marker, undefined);
});

test('a filled shape may drop its outline', () => {
  const doc = new RedlineDocument();
  const added = doc.add(box({ color: '#16A34A', fillOpacity: 0.5, outline: false }));
  assert.equal(added.outline, false);
  assert.equal(added.fillOpacity, 0.5);
});

test('an unfilled shape keeps its outline, so it is never invisible', () => {
  const doc = new RedlineDocument();
  const added = doc.add(box({ color: '#16A34A', outline: false }));
  assert.equal('outline' in added, false);
});

test('an outline is only dropped when asked for explicitly', () => {
  const doc = new RedlineDocument();
  for (const [id, outline] of [['a', true], ['b', undefined], ['c', 'false'], ['d', 0]]) {
    assert.equal('outline' in doc.add(box({ id, fillOpacity: 0.5, outline })), false);
  }
});
