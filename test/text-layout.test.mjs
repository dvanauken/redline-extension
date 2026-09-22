import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineOffset, fitTextBoxContent, fitTextBoxHeight, fontString, layoutNote, layoutRectangleLabel, layoutTextBox,
  wrapText, TEXTBOX_MIN_HEIGHT,
} from '../redline/RedlineTextLayout.js';

/**
 * Proportional widths close to Arial at 16px: W is wide, i is narrow. Enough to
 * reproduce the reported case, where character counting kept "WWW WWW" on one
 * line that measured text cannot fit.
 */
const ADVANCES = { W: 0.944, i: 0.222, l: 0.222, ' ': 0.278, M: 0.833 };
const measurer = {
  width: (text, font) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
    return Array.from(text).reduce((sum, char) => sum + (ADVANCES[char] ?? 0.556) * size, 0);
  },
  metrics: font => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
    return { ascent: size * 0.905, descent: size * 0.212 };
  },
};
const font = fontString(16);
const box = (text, width = 100, height = 48, extra = {}) => ({
  id: 't', type: 'textbox', color: '#000000', width: 1, fontSize: 16, backgroundOpacity: 1,
  start: { x: 10, y: 20 }, end: { x: 10 + width, y: 20 + height }, text, ...extra,
});

test('measured wrapping splits the reported WWW WWW case into two lines', () => {
  const layout = layoutTextBox(box('WWW WWW'), measurer);
  assert.deepEqual(layout.lines.map(line => line.text), ['WWW', 'WWW']);
  assert.equal(layout.overflows, true, 'two 20px lines plus padding exceed 48px');
  assert.equal(layout.requiredHeight, 60);
});

test('every line is placed on the same baseline rhythm for both renderers', () => {
  const layout = layoutTextBox(box('one two three four five six', 100, 200), measurer);
  const offset = baselineOffset(font, 20, measurer);
  layout.lines.forEach((line, index) => {
    assert.equal(line.x, 20);
    assert.ok(Math.abs(line.y - (20 + 10 + index * 20 + offset)) < 1e-9);
  });
  assert.deepEqual(layout.clip, { x: 10, y: 20, width: 100, height: 200 });
});

test('explicit newlines and blank lines are kept; runs of spaces collapse', () => {
  assert.deepEqual(
    wrapText('first\n\nthird   line\r\nfourth', { maxWidth: 500, font, measurer }),
    ['first', '', 'third line', 'fourth'],
  );
});

test('a word wider than the box breaks between graphemes instead of overflowing', () => {
  const lines = wrapText('Supercalifragilisticexpialidocious', { maxWidth: 80, font, measurer });
  assert.ok(lines.length > 1);
  assert.equal(lines.join(''), 'Supercalifragilisticexpialidocious');
  for (const line of lines) assert.ok(measurer.width(line, font) <= 80 || Array.from(line).length === 1);
});

test('breaking a long word never splits a grapheme', () => {
  const family = '👩‍👩‍👧‍👦';
  const lines = wrapText(family.repeat(6), { maxWidth: 20, font, measurer });
  assert.equal(lines.join(''), family.repeat(6));
  for (const line of lines) assert.equal(line.length % family.length, 0);
});

test('realistic multiline text wraps within the inner width', () => {
  const text = 'The checkout total is wrong after applying the coupon.\nExpected $42.00 but saw $24.00.';
  const layout = layoutTextBox(box(text, 220, 60), measurer);
  for (const line of layout.lines) assert.ok(measurer.width(line.text, font) <= 200, line.text);
  assert.equal(layout.lines.map(line => line.text).join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('fitting a text box grows it just enough and never shrinks it', () => {
  const grown = fitTextBoxHeight(box('WWW WWW'), measurer);
  assert.equal(grown.end.y - grown.start.y, 60);
  const roomy = box('WWW', 100, 90);
  assert.equal(fitTextBoxHeight(roomy, measurer), roomy);
  assert.ok(fitTextBoxHeight(box('', 100, 10), measurer).end.y - 20 >= TEXTBOX_MIN_HEIGHT);
});

test('a long legacy note wraps inside a capped label instead of running past it', () => {
  const layout = layoutNote({ point: { x: 100, y: 100 }, text: 'word '.repeat(40) }, '10', measurer);
  assert.ok(layout.label.width <= 420 && layout.label.width > 380, String(layout.label.width));
  assert.ok(layout.lines.length > 1);
  for (const line of layout.lines) assert.ok(line.x + measurer.width(line.text, fontString(14, 600)) <= layout.label.x + layout.label.width);
  assert.equal(layout.label.height, 32 + (layout.lines.length - 1) * 18);
  assert.equal(layout.glyph.text, '10', 'legacy two-character glyphs still render');
});

test('live fitting expands width to keep short text on one line', () => {
  const original = box('WWW WWW');
  const fitted = fitTextBoxContent(original, measurer);
  assert.ok(fitted.end.x > original.end.x);
  assert.equal(fitted.start.x, original.start.x);
  assert.equal(fitted.start.y, original.start.y);
  assert.equal(layoutTextBox(fitted, measurer).lines.length, 1);
  assert.equal(fitted.end.y - fitted.start.y, TEXTBOX_MIN_HEIGHT);
  assert.equal(original.end.x, 110, 'fitting does not mutate the original');
});

test('live fitting wraps at its width limit and grows to fit every line', () => {
  const fitted = fitTextBoxContent(box('Wide words '.repeat(50)), measurer, { maxWidth: 240 });
  assert.equal(fitted.end.x - fitted.start.x, 240);
  const layout = layoutTextBox(fitted, measurer);
  assert.ok(layout.lines.length > 1);
  assert.equal(layout.overflows, false);
});

test('live fitting respects explicit line breaks and manually sized boxes', () => {
  const fitted = fitTextBoxContent(box('One\nTwo\nThree', 220, 48), measurer);
  assert.equal(fitted.end.x - fitted.start.x, 220);
  assert.equal(fitted.end.y - fitted.start.y, 80);
  assert.deepEqual(layoutTextBox(fitted, measurer).lines.map(line => line.text), ['One', 'Two', 'Three']);
});

test('live fitting uses the remaining viewport width near the right edge', () => {
  const fitted = fitTextBoxContent(box('LongWord'.repeat(20)), measurer, { maxWidth: 120 });
  assert.equal(fitted.end.x - fitted.start.x, 120);
  assert.equal(layoutTextBox(fitted, measurer).overflows, false);
});

test('rectangle labels wrap and remain centred inside the existing geometry', () => {
  const mark = { ...box('Direct text inside this rectangle', 180, 100), type: 'rectangle' };
  const layout = layoutRectangleLabel(mark, measurer);
  assert.equal(layout.box.width, 180);
  assert.ok(layout.lines.length >= 2);
  assert.ok(layout.lines.every(line => line.x === 100));
  assert.ok(layout.lines[0].y > mark.start.y);
  assert.deepEqual(layout.clip, { x: 10, y: 20, width: 180, height: 100 });
});
