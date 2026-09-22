import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument, unsupportedFields } from '../redline/RedlineDocument.js';
import { drawRedlineDocument } from '../redline/RedlineCanvas.js';
import {
  BULLET_LABELS, EXPLANATION_MAX_LENGTH, LEGEND_MIN_WIDTH, bulletLabelStatus, bulletLimit, caretLineIndex, caretPoint,
  drawLegend, explanationCardFrame, indexAtPoint, layoutLegend, legendBullets, legendClipping, legendHitTest,
  lineEdge, nextBulletLabel, paragraphRangeAt, sanitizeLegend, selectionRects, verticalCaretMove, wordRangeAt,
} from '../redline/RedlineLegend.js';
import { fontString, layoutPreservedText } from '../redline/RedlineTextLayout.js';
import { markBounds, hitTestMark } from '../redline/RedlineGeometry.js';
import { bulletGlyphColor } from '../redline/RedlineStyles.js';

/** Every character is 0.5em wide: predictable wraps and caret columns. */
const measurer = {
  width: (text, font) => Array.from(String(text)).length * Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]) * 0.5,
  metrics: font => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
    return { ascent: size * 0.9, descent: size * 0.2 };
  },
};

const bullet = (label, extra = {}) => ({
  id: `b-${label}`, type: 'bullet', color: '#2563EB', point: { x: 100, y: 100 }, label, ...extra,
});
const bullets = labels => labels.map(label => bullet(label));

// ---------------------------------------------------------------------------
// Labels

test('the next label is the lowest unused one in each independent scheme', () => {
  const marks = bullets(['1', '3', 'A', 'B']);
  assert.equal(nextBulletLabel(marks, 'numeric'), '2');
  assert.equal(nextBulletLabel(marks, 'alpha'), 'C');
  assert.equal(nextBulletLabel([], 'alpha'), 'A');
  assert.deepEqual(bulletLabelStatus(marks, 'numeric'), { scheme: 'numeric', next: '2', used: 2, total: 9 });
});

test('legacy notes, including 10 and AA, never consume bullet labels', () => {
  const marks = [
    { id: 'n10', type: 'note', point: { x: 0, y: 0 }, number: 10, text: 'ten' },
    { id: 'naa', type: 'note', point: { x: 0, y: 0 }, number: 27, marker: 'alpha', text: 'AA' },
    { id: 'n1', type: 'note', point: { x: 0, y: 0 }, number: 1, text: 'one' },
  ];
  assert.equal(nextBulletLabel(marks, 'numeric'), '1');
  assert.equal(nextBulletLabel(marks, 'alpha'), 'A');
});

test('a full scheme explains the limit, offers the other scheme only when it has room, and never invents 10 or AA', () => {
  const numbersFull = bullets(BULLET_LABELS.numeric);
  assert.equal(nextBulletLabel(numbersFull, 'numeric'), null);
  const limit = bulletLimit(numbersFull, 'numeric');
  assert.equal(limit.scheme, 'numeric');
  assert.equal(limit.otherAvailable, true);
  assert.match(limit.message, /All 9 numbered bullets \(1–9\) are in use/);
  assert.match(limit.message, /A–Z/);
  assert.equal(bulletLimit(numbersFull, 'alpha'), null, 'letters are still available');

  const everything = bullets([...BULLET_LABELS.numeric, ...BULLET_LABELS.alpha]);
  const both = bulletLimit(everything, 'alpha');
  assert.equal(both.otherAvailable, false);
  assert.match(both.message, /All 35 bullet labels/);
  assert.doesNotMatch(both.message, /switch/);
  assert.equal(nextBulletLabel(everything, 'alpha'), null);
});

test('legend rows are ordered 1–9 then A–Z regardless of creation or array order', () => {
  const marks = bullets(['C', '2', 'A', '9', '1']);
  assert.deepEqual(legendBullets(marks).map(mark => mark.label), ['1', '2', '9', 'A', 'C']);
});

test('bullet glyphs stay legible on dark and light fills', () => {
  assert.equal(bulletGlyphColor('#1D4ED8'), '#FFFFFF');
  assert.equal(bulletGlyphColor('#B65D66'), '#FFFFFF');
  assert.notEqual(bulletGlyphColor('#FDE047'), '#FFFFFF');
  assert.notEqual(bulletGlyphColor('#FFFFFF'), '#FFFFFF');
});

// ---------------------------------------------------------------------------
// Validation and serialisation

test('a bullet round-trips its id, label, point and multiline explanation', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  const added = doc.add(bullet('7', { text: 'First line\r\nSecond line\n\n  indented', intent: 'issue' }));
  assert.equal(added.text, 'First line\nSecond line\n\n  indented');
  assert.equal(added.label, '7');
  const reloaded = new RedlineDocument();
  reloaded.load(doc.toJSON());
  assert.deepEqual(reloaded.annotations, doc.annotations);
  assert.equal('text' in doc.add(bullet('8', { text: '' })), false, 'an empty explanation is omitted');
});

for (const [label, value, pattern] of [
  ['two-digit label', bullet('10'), /label/],
  ['double-letter label', bullet('AA'), /label/],
  ['lowercase label', bullet('a'), /label/],
  ['zero', bullet('0'), /label/],
  ['numeric label', { ...bullet('1'), label: 1 }, /label/],
  ['missing label', { ...bullet('1'), label: undefined }, /label/],
  ['non-finite point', bullet('1', { point: { x: Infinity, y: 2 } }), /point/],
  ['missing point', { ...bullet('1'), point: null }, /point/],
  ['non-text explanation', bullet('1', { text: { html: '<b>' } }), /text/],
  ['over-long explanation', bullet('1', { text: 'x'.repeat(EXPLANATION_MAX_LENGTH + 1) }), /limited/],
]) {
  test('a malformed bullet rejects the import atomically: ' + label, () => {
    const doc = new RedlineDocument({ width: 400, height: 300 });
    doc.add(bullet('1', { text: 'keep' }));
    doc.setLegend({ visible: true });
    doc.undo();
    const before = doc.toJSON();
    assert.throws(() => doc.load({ width: 400, height: 300, annotations: [value] }), pattern);
    assert.deepEqual(doc.toJSON(), before);
    assert.equal(doc.canUndo, true);
    assert.equal(doc.canRedo, true);
  });
}

test('duplicate bullet labels are rejected on import, add, replace and construction', () => {
  const doc = new RedlineDocument({ width: 400, height: 300 });
  doc.add(bullet('1'));
  doc.add({ ...bullet('2'), id: 'second' });
  const before = doc.toJSON();
  assert.throws(() => doc.load({ width: 400, height: 300, annotations: [bullet('4'), { ...bullet('4'), id: 'other' }] }), /Duplicate bullet label: 4/);
  assert.throws(() => doc.add({ ...bullet('1'), id: 'again' }), /Duplicate bullet label/);
  assert.throws(() => doc.replace('second', { ...bullet('1') }), /Duplicate bullet label/);
  assert.throws(() => new RedlineDocument({ annotations: [bullet('Z'), { ...bullet('Z'), id: 'z2' }] }), /Duplicate bullet label/);
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(doc.canUndo, true);
});

test('legacy notes with repeated or large ordinals still load beside bullets', () => {
  const doc = new RedlineDocument();
  doc.load({
    width: 500, height: 400, annotations: [
      { id: 'n1', type: 'note', point: { x: 1, y: 1 }, number: 10, text: 'ten' },
      { id: 'n2', type: 'note', point: { x: 1, y: 1 }, number: 10, text: 'ten again' },
      { id: 'n3', type: 'note', point: { x: 1, y: 1 }, number: 27, marker: 'alpha', text: 'AA' },
      bullet('1', { text: 'bullet' }),
    ],
  });
  assert.deepEqual(doc.annotations.map(mark => mark.number ?? mark.label), [10, 10, 27, '1']);
});

test('a legend validates every field and defaults missing geometry from the document size', () => {
  const legend = sanitizeLegend({ visible: true }, 1200, 800);
  assert.deepEqual({ ...legend }, { visible: true, x: 864, y: 16, width: 320, height: null, fontSize: 14, fontFamily: 'sans-serif' });
  assert.ok(Object.isFrozen(legend));
  assert.equal(sanitizeLegend(null), null);
  assert.equal(sanitizeLegend({ visible: false, x: 1, y: 2, width: 200, height: 90, fontSize: 18, fontFamily: 'serif' }).height, 90);
  for (const bad of [
    [], 'yes', { visible: 'true' }, { visible: true, x: '4' }, { visible: true, width: LEGEND_MIN_WIDTH - 1 },
    { visible: true, height: 0 }, { visible: true, fontSize: 9 }, { visible: true, fontSize: 49 },
    { visible: true, fontFamily: 'Comic Sans' }, { visible: true, y: Number.NaN },
  ]) {
    assert.throws(() => sanitizeLegend(bad, 100, 100), TypeError, JSON.stringify(bad));
  }
});

test('a malformed legend rejects the whole import without touching marks or history', () => {
  const doc = new RedlineDocument({ width: 400, height: 300 });
  doc.add(bullet('1', { text: 'keep' }));
  doc.setLegend({ visible: true, x: 10, y: 10 });
  const before = doc.toJSON();
  assert.throws(() => doc.load({ width: 400, height: 300, annotations: [], legend: { visible: true, fontSize: 'big' } }), /fontSize/);
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(doc.canUndo, true);
});

test('legacy documents without a legend serialise exactly as before', () => {
  const data = { width: 300, height: 200, annotations: [{ id: 'r', type: 'rectangle', color: '#DC2626', width: 2, start: { x: 1, y: 2 }, end: { x: 30, y: 40 } }] };
  const doc = new RedlineDocument();
  doc.load(data);
  assert.equal('legend' in doc.toJSON(), false);
  assert.equal(doc.legend, null);
});

test('the legend serialises with its entries owned by bullets, and an automatic height is omitted', () => {
  const doc = new RedlineDocument({ width: 1000, height: 700 });
  doc.add(bullet('2', { text: 'Second' }));
  doc.add({ ...bullet('1', { text: 'First' }), id: 'first' });
  doc.setLegend({ visible: true, x: 20, y: 30, width: 260, fontSize: 16, fontFamily: 'monospace' });
  const json = doc.toJSON();
  assert.deepEqual(json.legend, { visible: true, x: 20, y: 30, width: 260, fontSize: 16, fontFamily: 'monospace' });
  doc.setLegend({ ...doc.legend, height: 120 });
  assert.equal(doc.toJSON().legend.height, 120);
  const reloaded = new RedlineDocument();
  reloaded.load(JSON.parse(JSON.stringify(doc.toJSON())));
  assert.deepEqual(reloaded.toJSON(), doc.toJSON());
});

test('unknown legend fields are named in the import report', () => {
  assert.deepEqual(unsupportedFields({ width: 1, height: 1, annotations: [], legend: { visible: true, title: 'Key', theme: 'x' } }),
    ['legend.theme', 'legend.title']);
  assert.deepEqual(unsupportedFields({ annotations: [{ ...bullet('1'), number: 4 }] }), ['bullet.number']);
});

test('a failed render preparation leaves the previous document, crop and history untouched', () => {
  const doc = new RedlineDocument({ width: 400, height: 300 });
  doc.add(bullet('1', { text: 'keep' }));
  doc.setCrop({ x: 1, y: 1, width: 100, height: 100 });
  const before = doc.toJSON();
  let prepared = null;
  assert.throws(() => doc.load({ width: 900, height: 700, annotations: [bullet('2', { text: 'new' })], legend: { visible: true } }, {
    prepare: snapshot => { prepared = snapshot; throw new Error('layout failed'); },
  }), /layout failed/);
  assert.equal(prepared.width, 900);
  assert.equal(prepared.annotations[0].label, '2');
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(doc.width, 400);
  assert.equal(doc.canUndo, true);
});

// ---------------------------------------------------------------------------
// History

test('deleting a bullet removes its explanation in one step and undo restores the identical bullet', () => {
  const doc = new RedlineDocument({ width: 400, height: 300 });
  const original = doc.add(bullet('3', { text: 'Line one\nLine two' }));
  doc.add(bullet('4', { text: 'Other' }));
  doc.remove(original.id);
  assert.deepEqual(legendBullets(doc.marks).map(mark => mark.label), ['4']);
  doc.undo();
  assert.deepEqual(doc.find(original.id), original);
  assert.deepEqual(doc.annotations.map(mark => mark.label), ['3', '4'], 'array (z) order is restored too');
  doc.redo();
  assert.equal(doc.find(original.id), null);
});

test('placing a bullet and typing its explanation share one undo step; a later edit is its own', () => {
  const doc = new RedlineDocument({ width: 400, height: 300 });
  doc.add(bullet('1'), { mergeKey: 'place:b-1' });
  doc.replace('b-1', bullet('1', { text: 'Explained' }), { mergeKey: 'place:b-1' });
  doc.add(bullet('2'), { mergeKey: 'place:b-2' });
  doc.undo();
  assert.deepEqual(doc.annotations.map(mark => [mark.label, mark.text]), [['1', 'Explained']]);
  doc.replace('b-1', bullet('1', { text: 'Revised' }));
  doc.undo();
  assert.equal(doc.find('b-1').text, 'Explained');
  doc.undo();
  assert.deepEqual(doc.annotations, []);
});

test('legend changes are undoable without touching marks, and marks without touching the legend', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  doc.add(bullet('1', { text: 'keep' }));
  const marks = doc.marks;
  doc.setLegend({ visible: true, x: 10, y: 10 });
  const shown = doc.legend;
  doc.setLegend({ ...shown, x: 200 });
  assert.equal(doc.marks, marks, 'a legend move shares the unchanged marks');
  doc.undo();
  assert.equal(doc.legend, shown);
  doc.undo();
  assert.equal(doc.legend, null);
  doc.redo();
  doc.redo();
  assert.equal(doc.legend.x, 200);
  doc.add(bullet('2'));
  assert.equal(doc.legend.x, 200);
  doc.clear();
  assert.equal(doc.legend.visible, true, 'clearing marks keeps the legend settings');
  doc.undo();
  assert.equal(doc.marks.length, 2);
});

test('moving a bullet keeps its label and legend row order', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  doc.add(bullet('2', { text: 'b' }));
  doc.add(bullet('1', { text: 'a', point: { x: 500, y: 500 } }));
  doc.replace('b-1', { ...doc.find('b-1'), point: { x: 5, y: 5 } });
  assert.deepEqual(legendBullets(doc.marks).map(mark => [mark.id, mark.label]), [['b-1', '1'], ['b-2', '2']]);
});

// ---------------------------------------------------------------------------
// Geometry and layout

test('bullet marks are hit on their circle and bounded by their halo', () => {
  const mark = bullet('5');
  assert.equal(hitTestMark(mark, { x: 100, y: 100 }, 1, measurer), true);
  assert.equal(hitTestMark(mark, { x: 130, y: 100 }, 1, measurer), false);
  const bounds = markBounds(mark, measurer);
  assert.ok(bounds.width > 26 && bounds.width < 34, JSON.stringify(bounds));
});

test('preserved layout keeps every source index, hangs spaces, breaks long words and honours newlines', () => {
  const text = 'hello   wonderful world\n\nSupercalifragilistic';
  const lines = layoutPreservedText(text, { maxWidth: 80, font: fontString(10), measurer });
  // 10px font at 0.5em: 16 characters fit in 80.
  assert.deepEqual(lines.map(line => text.slice(line.start, line.end)),
    ['hello   ', 'wonderful world', '', 'Supercalifragili', 'stic']);
  // Joining the lines with their separators reproduces the source exactly.
  let rebuilt = '';
  lines.forEach((line, index) => {
    rebuilt += text.slice(line.start, line.end);
    const next = lines[index + 1];
    if (next && next.start > line.end) rebuilt += text.slice(line.end, next.start);
  });
  assert.equal(rebuilt, text);
  assert.deepEqual(layoutPreservedText('', { maxWidth: 80, font: fontString(10), measurer }), [{ start: 0, end: 0 }]);
});

const legendDoc = () => {
  const doc = new RedlineDocument({ width: 1000, height: 800 });
  doc.add(bullet('B', { text: 'Letter row' }));
  doc.add(bullet('1', { text: 'A long explanation that wraps onto more than one line of the legend' }));
  doc.add(bullet('2'));
  doc.setLegend({ visible: true, x: 100, y: 50, width: 240, fontSize: 20 });
  return doc;
};

test('legend layout orders rows by label, wraps inside the text column and grows to fit when height is automatic', () => {
  const doc = legendDoc();
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  assert.deepEqual(layout.rows.map(row => row.label), ['1', '2', 'B']);
  assert.ok(layout.rows[0].lines.length > 1);
  for (const row of layout.rows) {
    for (const line of row.lines) {
      assert.ok(measurer.width(row.text.slice(line.start, line.end).trimEnd(), layout.font) <= layout.textWidth + 1e-9);
    }
  }
  assert.equal(layout.box.height, layout.contentHeight);
  assert.equal(layout.overflows, false);
  assert.ok(layout.rows.every((row, i) => i === 0 || row.top > layout.rows[i - 1].bottom));
});

test('a fixed legend height clips whole lines, counts them, and never loses the stored text', () => {
  const doc = legendDoc();
  doc.setLegend({ ...doc.legend, height: 70 });
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  assert.equal(layout.overflows, true);
  assert.ok(layout.hiddenLines > 0);
  const visible = layout.rows.flatMap(row => row.lines.filter(line => line.visible));
  assert.ok(visible.every(line => line.top + layout.metrics.lineHeight <= layout.box.y + layout.box.height));
  assert.equal(doc.find('b-1').text, 'A long explanation that wraps onto more than one line of the legend');
});

test('draft text replaces a row while editing without changing the document', () => {
  const doc = legendDoc();
  const layout = layoutLegend(doc.legend, doc.marks, measurer, { texts: new Map([['b-2', 'Draft\nwith two lines']]) });
  assert.equal(layout.rows[1].text, 'Draft\nwith two lines');
  assert.equal(layout.rows[1].lines.length, 2);
  assert.equal(doc.find('b-2').text, undefined);
});

test('caret geometry maps indices to points and back, with wrap affinity, Home/End and vertical moves', () => {
  const doc = new RedlineDocument({ width: 1000, height: 800 });
  doc.add(bullet('1', { text: 'aaaa bbbb cccc\nxy' }));
  // 20px font: 10 units per character; a text column of 100 fits "aaaa bbbb " minus the hanging space.
  doc.setLegend({ visible: true, x: 0, y: 0, width: 15 + 32 + 12 + 100 + 15, fontSize: 20 });
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  const [row] = layout.rows;
  assert.deepEqual(row.lines.map(line => row.text.slice(line.start, line.end)), ['aaaa bbbb ', 'cccc', 'xy']);

  const soft = row.lines[0].end;
  assert.equal(caretLineIndex(row, soft, 'downstream'), 1);
  assert.equal(caretLineIndex(row, soft, 'upstream'), 0);
  assert.equal(caretPoint(layout, row, 2, 'downstream', measurer).x, layout.textX + 20);

  const clicked = indexAtPoint(layout, row, { x: layout.textX + 31, y: row.lines[1].top + 5 }, measurer);
  assert.deepEqual(clicked, { index: soft + 3, affinity: 'downstream' });
  const end = lineEdge(row, 2, 'downstream', 'end');
  assert.deepEqual(end, { index: soft, affinity: 'upstream' });
  assert.deepEqual(lineEdge(row, soft + 2, 'downstream', 'start'), { index: soft, affinity: 'downstream' });

  const down = verticalCaretMove(layout, row, 3, 'downstream', 1, null, measurer);
  assert.equal(down.index, soft + 3);
  const downAgain = verticalCaretMove(layout, row, down.index, down.affinity, 1, down.goalX, measurer);
  assert.equal(downAgain.index, row.text.length, 'a short last line keeps the column as far as it can');
  assert.equal(verticalCaretMove(layout, row, downAgain.index, 'downstream', 1, downAgain.goalX, measurer).index, row.text.length);
  assert.equal(verticalCaretMove(layout, row, 2, 'downstream', -1, null, measurer).index, 0);
});

test('word, paragraph and selection helpers cover multiline selections', () => {
  assert.deepEqual(wordRangeAt('alpha beta', 7), { start: 6, end: 10 });
  assert.deepEqual(paragraphRangeAt('one\ntwo\nthree', 5), { start: 4, end: 7 });
  assert.deepEqual(paragraphRangeAt('\nsecond', 0), { start: 0, end: 0 });
  const doc = new RedlineDocument({ width: 1000, height: 800 });
  doc.add(bullet('1', { text: 'abc\ndef' }));
  doc.setLegend({ visible: true, x: 0, y: 0, width: 400, fontSize: 20 });
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  const rects = selectionRects(layout, layout.rows[0], 1, 6, measurer);
  assert.equal(rects.length, 2);
  assert.equal(rects[0].width, 20 + 10, 'the selected newline shows as a space-width tail');
  assert.equal(rects[1].width, 20);
});

test('hit testing finds handles, the grip, rows and the body in screen-sized tolerances', () => {
  const doc = legendDoc();
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  const scale = { x: 2, y: 2 };
  const { box } = layout;
  assert.deepEqual(legendHitTest(layout, { x: box.x + box.width + 3, y: box.y + box.height / 2 }, scale), { kind: 'handle', handle: 'e' });
  assert.equal(legendHitTest(layout, { x: box.x + box.width / 2, y: box.y - 6 }, scale).kind, 'grip');
  assert.equal(legendHitTest(layout, { x: box.x + 40, y: layout.rows[2].cy }, scale).id, 'b-B');
  assert.equal(legendHitTest(layout, { x: box.x - 50, y: box.y }, scale), null);
  assert.equal(legendHitTest(layout, { x: box.x + box.width / 2, y: box.y - 6 }, scale, { handles: false }), null);
});

test('clipping reports the viewport and crop edges a legend extends past', () => {
  const box = { x: 900, y: 20, width: 200, height: 100 };
  assert.deepEqual(legendClipping(box, 1000, 800, null), { viewport: true, crop: false });
  assert.deepEqual(legendClipping({ ...box, x: 100 }, 1000, 800, { x: 0, y: 0, width: 250, height: 800 }), { viewport: false, crop: true });
});

test('the hidden-legend editing card sits beside its bullet and stays inside the document', () => {
  const frame = explanationCardFrame(bullet('1', { point: { x: 980, y: 790 } }), null, 1000, 800);
  assert.ok(frame.x + frame.width <= 992 && frame.x >= 8);
  assert.ok(frame.y <= 790 - 13 && frame.y >= 8);
});

// ---------------------------------------------------------------------------
// Drawing

function recordingContext() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return text => ({ width: measurer.width(text, target.font ?? '10px x') });
      return (...args) => calls.push([key, ...args]);
    },
    set(target, key, value) {
      target[key] = value;
      if (key === 'fillStyle' || key === 'font') calls.push([`set:${key}`, value]);
      return true;
    },
  });
  return ctx;
}

test('the export path draws legend text and glyphs but no caret, selection, placeholder or handles', () => {
  const doc = legendDoc();
  const ctx = recordingContext();
  drawRedlineDocument(ctx, doc.toJSON(), { measurer });
  const texts = ctx.calls.filter(call => call[0] === 'fillText').map(call => call[1]);
  assert.ok(texts.includes('Letter row'));
  assert.ok(texts.includes('B') && texts.includes('1') && texts.includes('2'));
  assert.equal(texts.includes('Add an explanation') || texts.includes('Type an explanation'), false, 'no placeholder text');
  assert.equal(texts.some(text => /more line/.test(text)), false, 'nothing is clipped, so no overflow badge');
  assert.equal(ctx.calls.some(call => call[0] === 'setLineDash'), false, 'no dashed frame');
  assert.equal(ctx.calls.some(call => call[0] === 'set:fillStyle' && /37,99,235/.test(call[1])), false, 'no selection tint');
});

test('live decorations add the placeholder, selection, caret and handles on the same layout', () => {
  const doc = legendDoc();
  const layout = layoutLegend(doc.legend, doc.marks, measurer);
  const ctx = recordingContext();
  drawLegend(ctx, layout, {
    measurer,
    decorations: {
      scale: { x: 1, y: 1 }, active: true, placeholders: true,
      editing: { id: 'b-1', selectionStart: 2, selectionEnd: 9, caretVisible: true, affinity: 'downstream', composition: null },
    },
  });
  const texts = ctx.calls.filter(call => call[0] === 'fillText').map(call => call[1]);
  assert.ok(texts.includes('Add an explanation'));
  assert.ok(ctx.calls.some(call => call[0] === 'setLineDash'));
  assert.ok(ctx.calls.some(call => call[0] === 'set:fillStyle' && /37,99,235,0.28/.test(call[1])));
});

test('a hidden legend or one without bullets is not drawn in the export', () => {
  const doc = legendDoc();
  doc.setLegend({ ...doc.legend, visible: false });
  const hidden = recordingContext();
  drawRedlineDocument(hidden, doc.toJSON(), { measurer });
  assert.equal(hidden.calls.some(call => call[0] === 'fillText' && call[1] === 'Letter row'), false);
  const empty = new RedlineDocument({ width: 100, height: 100 });
  empty.setLegend({ visible: true });
  const blank = recordingContext();
  drawRedlineDocument(blank, empty.toJSON(), { measurer });
  assert.equal(blank.calls.some(call => call[0] === 'roundRect' || call[0] === 'fillText'), false);
});
