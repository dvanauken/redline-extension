import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyStyleChange, markDecorations, treatmentOf } from '../redline/RedlineStyles.js';
import { contrastRatio, edgeFor } from '../color-picker.js';

const rect = (extra = {}) => ({
  id: 'r', type: 'rectangle', color: '#1D4ED8', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, ...extra,
});

test('three explicit treatments; Outline means no fill', () => {
  const outline = rect();
  assert.equal(treatmentOf(outline), 'outline');
  const withFill = applyStyleChange(outline, { property: 'treatment', value: { treatment: 'outline-fill', fillOpacity: 0.75 } });
  assert.equal(treatmentOf(withFill), 'outline-fill');
  assert.equal(withFill.fillOpacity, 0.75);
  const fillOnly = applyStyleChange(withFill, { property: 'treatment', value: 'fill' });
  assert.equal(treatmentOf(fillOnly), 'fill');
  assert.equal(fillOnly.fillOpacity, 0.75, 'switching treatment keeps the chosen strength');
  const back = applyStyleChange(fillOnly, { property: 'treatment', value: 'outline' });
  assert.equal(treatmentOf(back), 'outline');
  assert.equal('fillOpacity' in back || 'outline' in back || 'fill' in back, false);
});

test('an invisible no-outline, no-fill state cannot be produced', () => {
  const fillOnly = rect({ fillOpacity: 0.5, outline: false });
  const cleared = applyStyleChange(fillOnly, { property: 'fillOpacity', value: 0 });
  assert.equal(treatmentOf(cleared), 'outline');
  assert.equal(cleared.outline, undefined);
});

test('changing the outline colour pins a fill that followed it, preserving the treatment', () => {
  const shared = rect({ color: '#DC2626', fillOpacity: 0.25 });
  const recoloured = applyStyleChange(shared, { property: 'strokeColor', value: { color: '#1D4ED8' } });
  assert.equal(recoloured.color, '#1D4ED8');
  assert.equal(recoloured.fill, '#DC2626');
  assert.equal(recoloured.fillOpacity, 0.25);
  const unfilled = applyStyleChange(rect(), { property: 'strokeColor', value: { color: '#16A34A' } });
  assert.equal('fill' in unfilled, false);
});

test('fill and outline colours are targeted independently', () => {
  const next = applyStyleChange(rect({ fillOpacity: 0.5 }), { property: 'fillColor', value: { color: '#FDE68A' } });
  assert.equal(next.color, '#1D4ED8');
  assert.equal(next.fill, '#FDE68A');
  const same = applyStyleChange(next, { property: 'fillColor', value: { color: '#1D4ED8' } });
  assert.equal('fill' in same, false, 'a fill equal to the outline is stored as following it');
});

test('named presets carry intent; plain colours clear it only when asked', () => {
  const tagged = applyStyleChange(rect(), { property: 'strokeColor', value: { color: '#16A34A', intent: 'approved' } });
  assert.equal(tagged.intent, 'approved');
  assert.equal(applyStyleChange(tagged, { property: 'fillColor', value: { color: '#FFFFFF' } }).intent, 'approved');
  assert.equal('intent' in applyStyleChange(tagged, { property: 'strokeColor', value: { color: '#000000', intent: null } }), false);
});

test('line ends normalise: one end arrow is an arrow, anything else is a decorated line', () => {
  const line = { id: 'l', type: 'line', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 9, y: 0 } };
  const arrow = applyStyleChange(line, { property: 'ends', value: { start: 'none', end: 'arrow' } });
  assert.equal(arrow.type, 'arrow');
  assert.equal('endDecoration' in arrow, false);
  const reversed = applyStyleChange(arrow, { property: 'ends', value: { start: 'arrow', end: 'none' } });
  assert.equal(reversed.type, 'line');
  assert.deepEqual(markDecorations(reversed), { start: 'arrow', end: 'none' });
  const dotted = applyStyleChange(line, { property: 'ends', value: { start: 'filled-circle', end: 'arrow' } });
  assert.deepEqual(markDecorations(dotted), { start: 'filled-circle', end: 'arrow' });
  assert.equal(applyStyleChange(rect(), { property: 'ends', value: { start: 'arrow', end: 'arrow' } }).startDecoration, undefined);
});

test('changes that do not apply to a mark return it unchanged', () => {
  const pen = { id: 'p', type: 'pen', color: '#000', width: 2, points: [] };
  assert.equal(applyStyleChange(pen, { property: 'treatment', value: 'fill' }), pen);
  assert.equal(applyStyleChange(pen, { property: 'fontSize', value: 20 }), pen);
  assert.equal(applyStyleChange(pen, { property: 'strokeColor', value: { color: 'red' } }), pen);
});

/** Interface tokens, read from the stylesheet the extension ships. */
function tokens() {
  const css = fs.readFileSync(new URL('../redline/redline.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('--rl-chrome'), css.indexOf('}', css.indexOf('--rl-chrome')));
  return Object.fromEntries([...block.matchAll(/--rl-([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(match => [match[1], match[2]]));
}

test('the paper theme uses the requested starting tokens', () => {
  const t = tokens();
  assert.equal(t.chrome, '#F7F5F0');
  assert.equal(t.control, '#FFFFFF');
  assert.equal(t.text, '#292D32');
  assert.equal(t.divider, '#D9D5CC');
  assert.equal(t.accent, '#B65D66');
});

test('interface text meets WCAG AA contrast on every surface it sits on', () => {
  const t = tokens();
  const pairs = [
    ['text', 'chrome'], ['text', 'control'], ['text', 'hover'], ['text', 'accent-soft'],
    ['muted', 'chrome'], ['muted', 'control'], ['muted', 'hover'],
    ['accent-text', 'accent-soft'], ['accent-text', 'control'], ['accent-text', 'chrome'],
  ];
  for (const [foreground, background] of pairs) {
    const ratio = contrastRatio(t[foreground], t[background]);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
  }
  assert.ok(contrastRatio('#FFFFFF', t['accent-text']) >= 4.5, 'primary button label');
  assert.ok(contrastRatio('#FFFFFF', t.text) >= 4.5, 'pressed mode label');
});

test('focus rings, state indicators and selection are visible against the chrome', () => {
  const t = tokens();
  for (const [name, background] of [['focus', 'chrome'], ['focus', 'control'], ['accent', 'chrome'], ['accent', 'control'],
    ['idle-indicator', 'control'], ['selection', 'control']]) {
    const ratio = contrastRatio(t[name], t[background]);
    assert.ok(ratio >= 3, `${name} on ${background}: ${ratio.toFixed(2)}`);
  }
});

test('on the light panel, only swatches that would vanish get an edge', () => {
  assert.ok(edgeFor('#FFFFFF'), 'Paper needs an edge on white');
  assert.ok(edgeFor('#FFFF00'), 'pure yellow is too close to white');
  assert.equal(edgeFor('#DC2626'), null);
  assert.equal(edgeFor('#111827'), null);
});
