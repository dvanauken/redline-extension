import test from 'node:test';
import assert from 'node:assert/strict';
import { redlineNoteGlyph, redlineMarkFill, redlineMarkStroked } from '../redline/RedlineCanvas.js';
import { edgeFor, variantFor } from '../color-picker.js';

test('numbered markers read as their ordinal', () => {
  assert.equal(redlineNoteGlyph(1), '1');
  assert.equal(redlineNoteGlyph(9), '9');
  assert.equal(redlineNoteGlyph(10, 'numeric'), '10');
});

test('lettered markers cover A-Z, then keep going like spreadsheet columns', () => {
  assert.equal(redlineNoteGlyph(1, 'alpha'), 'A');
  assert.equal(redlineNoteGlyph(26, 'alpha'), 'Z');
  assert.equal(redlineNoteGlyph(27, 'alpha'), 'AA');
  assert.equal(redlineNoteGlyph(28, 'alpha'), 'AB');
  assert.equal(redlineNoteGlyph(52, 'alpha'), 'AZ');
});

test('a marker falls back to a usable glyph rather than blank', () => {
  assert.equal(redlineNoteGlyph(0, 'alpha'), 'A');
  assert.equal(redlineNoteGlyph(undefined, 'alpha'), 'A');
  assert.equal(redlineNoteGlyph(NaN), '1');
});

test('fill paint defaults to the stroke colour and ignores an absent fill', () => {
  assert.equal(redlineMarkFill({ color: '#DC2626' }), null);
  assert.equal(redlineMarkFill({ color: '#DC2626', fillOpacity: 0 }), null);
  assert.deepEqual(redlineMarkFill({ color: '#DC2626', fillOpacity: 0.5 }), { color: '#DC2626', opacity: 0.5 });
  assert.deepEqual(redlineMarkFill({ color: '#5B21B6', fill: '#7C3AED', fillOpacity: 1 }), { color: '#7C3AED', opacity: 1 });
});

test('a swatch gets an edge only when it cannot be told from the panel', () => {
  // The rule is panel-relative. On a dark panel, Ink is 1.03:1 against #181b22
  // and would read as a hole without one.
  const dark = '#181b22';
  assert.equal(edgeFor('#111827', dark), 'rgba(255, 255, 255, 0.5)');
  // These already separate themselves.
  assert.equal(edgeFor('#FFFFFF', dark), null);
  assert.equal(edgeFor('#DC2626', dark), null);
  assert.equal(edgeFor('#2563EB', dark), null);
  // A swatch lighter than the panel but still too close takes a dark edge.
  assert.equal(edgeFor('#22262e', dark), 'rgba(41, 45, 50, 0.32)');
});

test('the tint ramp runs light to dark and keeps its hue', () => {
  const ramp = [0, 1, 2, 3, 4].map(row => variantFor('#DC2626', row));
  assert.equal(new Set(ramp).size, 5);
  const luma = ramp.map(hex => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16));
  assert.deepEqual(luma, [...luma].sort((a, b) => b - a), 'row 0 is lightest, row 4 deepest');
  for (const hex of ramp) assert.match(hex, /^#[0-9A-F]{6}$/);
});

test('a near-neutral ramps on lightness instead of drifting in hue', () => {
  const ink = [0, 4].map(row => variantFor('#111827', row));
  for (const hex of ink) assert.match(hex, /^#[0-9A-F]{6}$/);
  assert.notEqual(ink[0], ink[1]);
});

test('a mark strokes unless a fill can carry it alone', () => {
  assert.equal(redlineMarkStroked({ color: '#DC2626' }), true);
  assert.equal(redlineMarkStroked({ color: '#DC2626', fillOpacity: 0.5 }), true);
  assert.equal(redlineMarkStroked({ color: '#DC2626', fillOpacity: 0.5, outline: false }), false);
  // Nothing would be painted, so the outline survives regardless of the flag.
  assert.equal(redlineMarkStroked({ color: '#DC2626', outline: false }), true);
  assert.equal(redlineMarkStroked({ color: '#DC2626', fillOpacity: 0, outline: false }), true);
});
