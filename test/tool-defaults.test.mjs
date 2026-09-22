import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolDefaults, readPreferences, storeToolDefaults, styleForTool, writePreferences,
} from '../redline/RedlineToolDefaults.js';

const isTool = name => ['select', 'pen', 'rectangle', 'crop'].includes(name);

test('preferences written from defaults read back to the same defaults', () => {
  const d = createToolDefaults();
  storeToolDefaults(d, 'rectangle', { ...styleForTool(d, 'rectangle'), color: '#16A34A', fillOpacity: 0.4, fill: '#FDE68A', bold: false });
  storeToolDefaults(d, 'arrow', { ...styleForTool(d, 'arrow'), startDecoration: 'dot' });
  const saved = writePreferences(d, { tool: 'rectangle', toolbarPinned: true, toolbarPosition: { left: 40, top: 120 } });
  const restored = createToolDefaults();
  const other = readPreferences(JSON.parse(JSON.stringify(saved)), restored, { isTool });
  assert.deepEqual(restored, d);
  // The strip keeps only its height; its left edge is fixed.
  assert.deepEqual(other, { tool: 'rectangle', toolbarPinned: true, toolbarPosition: { left: 8, top: 120 } });
});

test('invalid saved values are ignored, and crop is never restored as the tool', () => {
  const d = createToolDefaults();
  const result = readPreferences({
    tool: 'crop', color: 'red', width: -2, fillOpacity: 3, noteMarker: 'roman', textAlign: 'justify',
    lineEnds: { start: 'nope', end: 'none' }, toolbarPosition: { left: 1, top: Number.NaN },
  }, d, { isTool });
  assert.deepEqual(d, createToolDefaults());
  assert.deepEqual(result, { tool: null, toolbarPinned: false, toolbarPosition: null });
  assert.deepEqual(readPreferences(null, d), { tool: null, toolbarPinned: false, toolbarPosition: null });
});

test('each tool starts from its own remembered style', () => {
  const d = createToolDefaults();
  storeToolDefaults(d, 'brush', { ...styleForTool(d, 'brush'), width: 24, opacity: 0.5 });
  assert.equal(styleForTool(d, 'brush').width, 24);
  assert.equal(styleForTool(d, 'pen').width, createToolDefaults().width, 'the highlight width is its own');
  assert.equal(styleForTool(d, 'arrow').endDecoration, undefined, 'an arrow ends in an arrow by default');
  assert.equal(styleForTool(d, 'rectangle').bold, true, 'rectangle labels start bold');
  assert.equal(styleForTool(d, 'textbox').textAlign, 'left');
});
