import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPrimitive } from '../redline/RedlineCanvas.js';
import { RedlineDocument, sanitizeAnnotation, translateAnnotation } from '../redline/RedlineDocument.js';
import { hitTestMark, markBounds, markFrame, markPrimitives } from '../redline/RedlineGeometry.js';
import { createApproximateMeasurer, TEXTBOX_MIN_HEIGHT, TEXTBOX_MIN_WIDTH } from '../redline/RedlineTextLayout.js';
import {
  FRAME_HANDLES, ROTATE_KNOB_OFFSET, handleAt, handleCursor, keepCornerInPlace, resizeMark, rotateMark, selectionFrame,
  selectionHandles,
} from '../redline/RedlineTransform.js';

const measurer = createApproximateMeasurer();
const rect = (extra = {}) => ({
  id: 'r', type: 'rectangle', color: '#111827', width: 2, start: { x: 100, y: 200 }, end: { x: 300, y: 300 }, ...extra,
});
const pen = (extra = {}) => ({
  id: 'p', type: 'pen', color: '#111827', width: 4, opacity: 1,
  points: [{ x: 10, y: 10 }, { x: 60, y: 40 }, { x: 110, y: 20 }], ...extra,
});
const textbox = (extra = {}) => ({
  id: 't', type: 'textbox', color: '#111827', width: 1, text: 'Short note', fontSize: 16, backgroundOpacity: 0.75,
  start: { x: 200, y: 200 }, end: { x: 400, y: 260 }, ...extra,
});
const near = (actual, expected, epsilon = 1e-6, message = '') => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, got ${actual}`);
};
const nearPoint = (actual, expected, epsilon = 1e-6, message = '') => {
  near(actual.x, expected.x, epsilon, `${message} x:`);
  near(actual.y, expected.y, epsilon, `${message} y:`);
};
const handleMap = (mark, options) => Object.fromEntries(selectionHandles(mark, options).map(handle => [handle.name, handle]));
const OPPOSITE = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
const DIRECTION = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };

test('rotation is kept on framed marks as clockwise degrees in [0, 360) and omitted when upright', () => {
  assert.equal(sanitizeAnnotation(rect({ rotation: 90 })).rotation, 90);
  assert.equal(sanitizeAnnotation(rect({ rotation: -90 })).rotation, 270);
  assert.equal(sanitizeAnnotation(rect({ rotation: 450 })).rotation, 90);
  assert.equal('rotation' in sanitizeAnnotation(rect({ rotation: 360 })), false);
  assert.equal('rotation' in sanitizeAnnotation(rect({ rotation: 0 })), false);
  assert.equal('rotation' in sanitizeAnnotation(rect()), false, 'existing marks serialise exactly as before');
  for (const mark of [pen({ rotation: 30 }), textbox({ rotation: 30 }), { ...rect({ rotation: 30 }), type: 'ellipse' },
    { ...pen({ rotation: 30 }), type: 'brush' }, { ...pen({ rotation: 30 }), type: 'polyline' }, { ...pen({ rotation: 30 }), type: 'polygon' }]) {
    assert.equal(sanitizeAnnotation(mark).rotation, 30, mark.type);
  }
});

test('a malformed rotation rejects the whole import and leaves state and history untouched', () => {
  for (const rotation of ['45', Infinity, true, { degrees: 45 }]) {
    const doc = new RedlineDocument({ width: 800, height: 600 });
    doc.add(rect({ id: 'kept' }));
    const before = doc.toJSON();
    assert.throws(() => doc.load({ width: 800, height: 600, annotations: [rect({ rotation })] }), /rotation/);
    assert.deepEqual(doc.toJSON(), before);
    assert.equal(doc.canUndo, true);
  }
});

test('rotation round-trips through JSON, moves with the mark and is reported on marks that cannot rotate', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  doc.add(rect({ rotation: 33.5 }));
  const reloaded = new RedlineDocument({ width: 1, height: 1 });
  const report = reloaded.load(doc.toJSON());
  assert.deepEqual(report.ignoredFields, []);
  assert.equal(reloaded.marks[0].rotation, 33.5);
  assert.equal(translateAnnotation(reloaded.marks[0], 5, 5).rotation, 33.5);

  const lineReport = reloaded.load({
    width: 800, height: 600,
    annotations: [{ id: 'l', type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, rotation: 45 }],
  });
  assert.deepEqual(lineReport.ignoredFields, ['line.rotation']);
  assert.equal('rotation' in reloaded.marks[0], false);
});

test('rotated primitives turn about the centre of the upright frame; upright ones carry nothing', () => {
  assert.ok(markPrimitives(rect(), measurer).every(primitive => !('rotation' in primitive)));
  for (const mark of [rect({ rotation: 20 }), textbox({ rotation: 20 }), pen({ rotation: 20 })]) {
    const frame = markFrame(mark);
    for (const primitive of markPrimitives(mark, measurer)) {
      assert.deepEqual(primitive.rotation, { angle: 20, cx: frame.x + frame.width / 2, cy: frame.y + frame.height / 2 }, mark.type);
    }
  }
});

test('bounds and hit testing follow the rotation', () => {
  const turned = rect({ rotation: 90 });
  const bounds = markBounds(turned, measurer);
  // A 200×100 box centred on (200, 250) stands 100 wide and 200 tall, plus half the stroke.
  near(bounds.x, 149, 1e-6);
  near(bounds.y, 149, 1e-6);
  near(bounds.width, 102, 1e-6);
  near(bounds.height, 202, 1e-6);

  const ellipse = markBounds({ ...turned, type: 'ellipse' }, measurer);
  near(ellipse.width, 102, 1e-6);
  near(ellipse.height, 202, 1e-6);
  const diagonal = markBounds({ ...rect({ rotation: 45 }), type: 'ellipse', width: 0 }, measurer);
  near(diagonal.width, 2 * Math.hypot(100 * Math.SQRT1_2, 50 * Math.SQRT1_2), 1e-6, 'ellipse extent at 45°');

  assert.equal(hitTestMark(turned, { x: 150, y: 250 }, 3, measurer), true, 'on the turned outline');
  assert.equal(hitTestMark(turned, { x: 100, y: 250 }, 3, measurer), false, 'where the upright outline was');
  assert.equal(hitTestMark(rect(), { x: 100, y: 250 }, 3, measurer), true);
});

test('the Canvas renderer turns a rotated primitive about its centre and restores the context', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => calls.push([name, ...args])),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  const [primitive] = markPrimitives(rect({ rotation: 90 }), measurer);
  drawPrimitive(ctx, primitive);
  const names = calls.map(([name]) => name);
  assert.deepEqual(calls.slice(0, 4).map(call => call.slice(0, 3)), [['save'], ['translate', 200, 250], ['rotate', Math.PI / 2], ['translate', -200, -250]]);
  assert.equal(names.at(-1), 'restore');
  assert.ok(names.includes('rect') && names.includes('stroke'));
});

test('a framed mark has eight handles on its frame and a rotate knob above the top edge', () => {
  const handles = handleMap(rect());
  assert.deepEqual(Object.keys(handles), [...FRAME_HANDLES, 'center', 'rotate']);
  const expected = {
    nw: [100, 200], n: [200, 200], ne: [300, 200], e: [300, 250], se: [300, 300], s: [200, 300], sw: [100, 300], w: [100, 250],
  };
  for (const [name, [x, y]] of Object.entries(expected)) nearPoint(handles[name], { x, y }, 1e-9, name);
  nearPoint(handles.center, { x: 200, y: 250 }, 1e-9, 'center move handle');
  nearPoint(handles.rotate, { x: 200, y: 200 - ROTATE_KNOB_OFFSET }, 1e-9, 'knob');
  nearPoint(handles.rotate.from, { x: 200, y: 200 }, 1e-9, 'stem');

  // Constant on-screen size: at 2× the knob is half as far in document units.
  nearPoint(handleMap(rect(), { scale: { x: 2, y: 2 } }).rotate, { x: 200, y: 200 - ROTATE_KNOB_OFFSET / 2 }, 1e-9);
});

test('handles turn with the mark, and the knob moves below when above would leave the surface', () => {
  const handles = handleMap(rect({ rotation: 90 }));
  // Turned clockwise, the top edge faces right.
  nearPoint(handles.n, { x: 250, y: 250 }, 1e-9, 'n');
  nearPoint(handles.nw, { x: 250, y: 150 }, 1e-9, 'nw');
  nearPoint(handles.rotate, { x: 250 + ROTATE_KNOB_OFFSET, y: 250 }, 1e-9, 'knob');

  const nearTop = rect({ start: { x: 100, y: 10 }, end: { x: 300, y: 110 } });
  nearPoint(handleMap(nearTop, { bounds: { width: 800, height: 600 } }).rotate, { x: 200, y: 110 + ROTATE_KNOB_OFFSET }, 1e-9);
  nearPoint(handleMap(nearTop).rotate, { x: 200, y: 10 - ROTATE_KNOB_OFFSET }, 1e-9, 'without bounds');
});

test('the frame of a stroke surrounds its ink, and a flat stroke offers no handles that cannot stretch it', () => {
  const frame = selectionFrame(pen());
  assert.deepEqual(frame.box, { x: 8, y: 8, width: 104, height: 34 });
  const brush = selectionFrame({ ...pen(), type: 'brush', width: 4 });
  assert.equal(brush.pad, 8, 'the highlighter paints four times its stored width');

  const underline = pen({ points: [{ x: 10, y: 50 }, { x: 200, y: 50 }] });
  assert.deepEqual(Object.keys(handleMap(underline)), ['nw', 'ne', 'e', 'se', 'sw', 'w', 'center', 'rotate']);
});

test('straight lines have a handle on each end; bullets and notes have none', () => {
  const line = { id: 'l', type: 'arrow', color: '#000', width: 2, start: { x: 10, y: 20 }, end: { x: 110, y: 70 } };
  assert.deepEqual(selectionHandles(line), [{ name: 'start', x: 10, y: 20 }, { name: 'end', x: 110, y: 70 }]);
  assert.deepEqual(selectionHandles({ id: 'b', type: 'bullet', color: '#000', width: 2, point: { x: 5, y: 5 }, label: '1' }), []);
  assert.deepEqual(selectionHandles({ id: 'n', type: 'note', color: '#000', width: 2, point: { x: 5, y: 5 }, text: 'x', number: 1 }), []);
});

test('the nearest handle within reach is picked, measured on screen', () => {
  assert.equal(handleAt(rect(), { x: 303, y: 303 }), 'se');
  assert.equal(handleAt(rect(), { x: 320, y: 320 }), null);
  assert.equal(handleAt(rect(), { x: 204, y: 200 - ROTATE_KNOB_OFFSET + 3 }), 'rotate');
  assert.equal(handleAt(rect(), { x: 304, y: 304 }, { scale: { x: 3, y: 3 } }), null, '12 screen px away at 3×');
});

test('resize pointers follow the direction each handle faces on screen', () => {
  assert.equal(handleCursor(rect(), 'e'), 'resize-e');
  assert.equal(handleCursor(rect(), 'nw'), 'resize-se');
  assert.equal(handleCursor(rect(), 'ne'), 'resize-sw');
  assert.equal(handleCursor(rect({ rotation: 90 }), 'e'), 'resize-s');
  assert.equal(handleCursor(rect({ rotation: 45 }), 'e'), 'resize-se');
  assert.equal(handleCursor(rect({ rotation: 45 }), 'n'), 'resize-sw');
  assert.equal(handleCursor(rect(), 'rotate'), 'rotate');
  assert.equal(handleCursor(rect(), 'end'), 'endpoint');
});

for (const angle of [0, 30, 90, 135, 250]) {
  test(`resizing at ${angle}° keeps the opposite handle in place and moves the dragged one with the pointer`, () => {
    for (const mark of [rect({ rotation: angle }), pen({ rotation: angle }), { ...rect({ rotation: angle }), type: 'ellipse' }]) {
      for (const name of FRAME_HANDLES) {
        const before = handleMap(mark);
        // Travel outward along the handle's own direction, turned with the mark.
        const radians = (angle * Math.PI) / 180;
        const [ux, uy] = DIRECTION[name];
        const travel = { x: (ux * 17) * Math.cos(radians) - (uy * 11) * Math.sin(radians), y: (ux * 17) * Math.sin(radians) + (uy * 11) * Math.cos(radians) };
        const to = { x: before[name].x + travel.x, y: before[name].y + travel.y };
        const after = handleMap(resizeMark(mark, name, before[name], to));
        nearPoint(after[OPPOSITE[name]], before[OPPOSITE[name]], 1e-6, `${mark.type} ${name} anchor`);
        nearPoint(after[name], to, 1e-6, `${mark.type} ${name} follows`);
        assert.equal(markFrame(resizeMark(mark, name, before[name], to)) !== null, true);
      }
    }
  });
}

test('Shift on a corner keeps proportions and Ctrl resizes about the centre', () => {
  const mark = rect({ rotation: 40 });
  const proportional = resizeMark(mark, 'se', { x: 0, y: 0 }, { x: 60, y: 5 }, { keepAspect: true });
  const frame = markFrame(proportional);
  near(frame.width / frame.height, 2, 1e-9, 'aspect');

  const centred = resizeMark(mark, 'e', { x: 0, y: 0 }, { x: 30, y: 0 }, { fromCenter: true });
  nearPoint(selectionFrame(centred).center, selectionFrame(mark).center, 1e-9, 'centre');
  const turnedTravel = 30 * Math.cos((40 * Math.PI) / 180);
  near(markFrame(centred).width, 200 + 2 * turnedTravel, 1e-9, 'both sides grow');
});

test('dragging an edge past the opposite one mirrors a stroke, but never collapses a shape', () => {
  const mark = pen();
  const before = handleMap(mark);
  const flipped = resizeMark(mark, 'e', before.e, { x: before.w.x - 50, y: before.e.y });
  assert.ok(flipped.points[0].x > flipped.points[2].x, 'the first point is now on the right');

  const flat = resizeMark(rect(), 'e', { x: 300, y: 250 }, { x: 100, y: 250 }, { scale: { x: 2, y: 2 } });
  near(markFrame(flat).width, 0.5, 1e-9, 'one screen pixel at 2×');

  const underline = pen({ points: [{ x: 10, y: 50 }, { x: 200, y: 50 }] });
  const stretched = resizeMark(underline, 'se', { x: 0, y: 0 }, { x: 40, y: 40 });
  assert.deepEqual(stretched.points.map(point => point.y), [50, 50], 'no height to scale');
  assert.ok(stretched.points[1].x > 200);
});

test('a text box keeps its minimum size and the height its text needs, at any rotation', () => {
  for (const angle of [0, 60]) {
    const mark = textbox({ rotation: angle, text: 'A sentence long enough to wrap onto several lines when the box is narrow' });
    const before = handleMap(mark);
    const narrowed = resizeMark(mark, 'e', before.e, before.w, { measurer });
    const frame = markFrame(narrowed);
    near(frame.width, TEXTBOX_MIN_WIDTH, 1e-9, `${angle}° width`);
    assert.ok(frame.height > TEXTBOX_MIN_HEIGHT, `${angle}° wrapped text needs more height: ${frame.height}`);
    nearPoint(handleMap(narrowed).nw, before.nw, 1e-6, `${angle}° upright top-left corner`);
    const squashed = resizeMark(mark, 's', before.s, before.n, { measurer });
    assert.ok(markFrame(squashed).height >= TEXTBOX_MIN_HEIGHT);
    assert.ok(squashed.end.y > squashed.start.y);
  }
});

test('the knob rotates by the angle the pointer sweeps about the centre; Shift snaps to 15°', () => {
  const mark = rect();
  const quarter = rotateMark(mark, { x: 300, y: 250 }, { x: 200, y: 350 });
  near(quarter.rotation, 90, 1e-9);
  assert.equal(rotateMark(rect({ rotation: 350 }), { x: 300, y: 250 }, { x: 300, y: 270 }).rotation > 0, true);
  const snapped = rotateMark(mark, { x: 300, y: 250 }, { x: 300, y: 270 }, { snap: true });
  assert.equal(snapped.rotation, 15);
  const back = rotateMark(quarter, { x: 200, y: 350 }, { x: 300, y: 250 });
  assert.equal('rotation' in back, false, 'a full return omits the field');
  near(rotateMark(mark, { x: 300, y: 250 }, { x: 200, y: 150 }).rotation, 270, 1e-9, 'counter-clockwise');
  const line = { id: 'l', type: 'line', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
  assert.equal(rotateMark(line, { x: 0, y: 0 }, { x: 5, y: 5 }), line);
});

test('dragging a line end moves only that end; Shift snaps it to 45° from the other end', () => {
  const line = { id: 'l', type: 'line', color: '#000', width: 2, start: { x: 100, y: 100 }, end: { x: 200, y: 100 } };
  const moved = resizeMark(line, 'end', { x: 200, y: 100 }, { x: 220, y: 140 });
  assert.deepEqual(moved.start, line.start);
  assert.deepEqual(moved.end, { x: 220, y: 140 });
  const snapped = resizeMark(line, 'end', { x: 200, y: 100 }, { x: 205, y: 190 }, { keepAspect: true });
  near(snapped.end.x - 100, snapped.end.y - 100, 1e-9, '45°');
});

test('a rotated text box that grows keeps its upright top-left corner in place', () => {
  const mark = textbox({ rotation: 35 });
  const grown = { ...mark, end: { x: mark.end.x + 80, y: mark.end.y + 120 } };
  const kept = keepCornerInPlace(mark, grown);
  nearPoint(handleMap(kept).nw, handleMap(mark).nw, 1e-9);
  assert.equal(keepCornerInPlace(textbox(), grown), grown, 'upright boxes already grow from their corner');
});
