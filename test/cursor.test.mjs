import test from 'node:test';
import assert from 'node:assert/strict';
import { RedlineDocument, unsupportedFields } from '../redline/RedlineDocument.js';
import {
  CURSOR_SHAPE, PointerTrail, clampCursor, cursorHitTest, cursorInsideCrop, cursorPrimitives, moveCursor, sanitizeCursor,
} from '../redline/RedlineCursor.js';
import { drawRedlineDocument } from '../redline/RedlineCanvas.js';
import { createApproximateMeasurer } from '../redline/RedlineTextLayout.js';

const line = id => ({ id, type: 'line', start: { x: 10, y: 20 }, end: { x: 200, y: 100 } });

test('the cursor is optional, validated strictly, frozen and detached', () => {
  assert.equal(sanitizeCursor(undefined, 100, 100), null);
  assert.equal(sanitizeCursor(null, 100, 100), null);
  const input = { visible: true, x: 40, y: 60 };
  const clean = sanitizeCursor(input, 100, 100);
  input.x = 99;
  assert.deepEqual(clean, { visible: true, x: 40, y: 60 });
  assert.ok(Object.isFrozen(clean));
  for (const bad of [[], 'yes', { visible: 'true', x: 1, y: 1 }, { visible: true, x: -1, y: 1 }, { visible: true, x: 1, y: 101 },
    { visible: true, x: Number.NaN, y: 1 }, { visible: true, x: '5', y: 1 }, { visible: false, y: 1 }]) {
    assert.throws(() => sanitizeCursor(bad, 100, 100), TypeError, JSON.stringify(bad));
  }
});

test('cursor changes are export settings: serialised, revisioned, never in undo history', () => {
  const doc = new RedlineDocument({ width: 800, height: 600 });
  doc.add(line('a'));
  const revision = doc.revision;
  doc.setCursor({ visible: true, x: 300, y: 200 });
  assert.equal(doc.revision, revision + 1);
  assert.deepEqual(doc.toJSON().cursor, { visible: true, x: 300, y: 200 });
  doc.setCursor({ visible: true, x: 300, y: 200 });
  assert.equal(doc.revision, revision + 1, 'an identical cursor is not a change');
  assert.equal(doc.canUndo, true);
  doc.undo();
  assert.deepEqual(doc.toJSON().cursor, { visible: true, x: 300, y: 200 }, 'undo does not move the pointer');
  assert.equal(doc.marks.length, 0);
  doc.setCursor({ visible: false, x: 300, y: 200 });
  assert.deepEqual(doc.toJSON().cursor, { visible: false, x: 300, y: 200 }, 'a hidden pointer keeps its position');
  assert.throws(() => doc.setCursor({ visible: true, x: 900, y: 10 }), TypeError);
  assert.deepEqual(doc.cursor, { visible: false, x: 300, y: 200 }, 'a rejected cursor leaves the stored one');
});

test('documents without a cursor serialise exactly as before', () => {
  const doc = new RedlineDocument({ width: 10, height: 10 });
  assert.equal('cursor' in doc.toJSON(), false);
});

test('import validates the cursor atomically and reports unknown cursor fields', () => {
  const doc = new RedlineDocument({ width: 1000, height: 500 });
  doc.add(line('keep'));
  const before = doc.toJSON();
  assert.throws(() => doc.load({ width: 400, height: 300, annotations: [line('new')], cursor: { visible: true, x: 450, y: 10 } }), TypeError);
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(doc.canUndo, true);
  const report = doc.load({ width: 400, height: 300, annotations: [], cursor: { visible: true, x: 400, y: 300, shape: 'hand' } });
  assert.deepEqual(report.ignoredFields, ['cursor.shape']);
  assert.deepEqual(doc.cursor, { visible: true, x: 400, y: 300 });
  assert.deepEqual(unsupportedFields({ annotations: [], cursor: { visible: true, x: 1, y: 1 } }), []);
});

test('the proxy is drawn from the hotspot with a dark body and a contrasting edge', () => {
  const primitives = cursorPrimitives({ visible: true, x: 50, y: 70 });
  const body = primitives.at(-1);
  assert.deepEqual(body.points[0], { x: 50, y: 70 }, 'the first vertex is the hotspot');
  assert.equal(body.closed, true);
  assert.equal(body.fill.color, '#111827');
  assert.equal(body.stroke.color, '#FFFFFF');
  assert.ok(Math.min(...body.points.map(point => point.x)) >= 50 && Math.min(...body.points.map(point => point.y)) >= 70,
    'the arrow extends right and down from its tip');
  assert.equal(body.points.length, CURSOR_SHAPE.length);
});

test('hit testing, clamping, moving and crop checks', () => {
  const cursor = { visible: true, x: 100, y: 100 };
  assert.equal(cursorHitTest(cursor, { x: 104, y: 110 }), true);
  assert.equal(cursorHitTest(cursor, { x: 96, y: 96 }), true, 'a few screen pixels of slack');
  assert.equal(cursorHitTest(cursor, { x: 130, y: 100 }), false);
  assert.equal(cursorHitTest({ ...cursor, visible: false }, { x: 104, y: 110 }), false);
  assert.equal(cursorHitTest(cursor, { x: 96, y: 100 }, { x: 0.5, y: 0.5 }, 5), true, 'slack is in screen pixels');
  assert.deepEqual(clampCursor({ visible: true, x: -5, y: 900 }, 800, 600), { visible: true, x: 0, y: 600 });
  assert.deepEqual(moveCursor(cursor, 10, -200, 800, 600), { visible: true, x: 110, y: 0 });
  assert.equal(cursorInsideCrop(cursor, { x: 0, y: 0, width: 100, height: 100 }), true);
  assert.equal(cursorInsideCrop(cursor, { x: 101, y: 0, width: 100, height: 100 }), false);
  assert.equal(cursorInsideCrop(cursor, null), true);
});

function recordingContext() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => calls.push([name, ...args]);
    },
    set(target, name, value) {
      target[name] = value;
      calls.push(['set', name, value]);
      return true;
    },
  });
  return { ctx, calls };
}

test('export draws the proxy last, and not at all when hidden or already captured', () => {
  const snapshot = { width: 100, height: 100, annotations: [line('a')], cursor: { visible: true, x: 20, y: 30 } };
  const measurer = createApproximateMeasurer();
  const fills = calls => calls.filter(call => call[0] === 'set' && call[1] === 'fillStyle').map(call => call[2]);
  const drawn = recordingContext();
  drawRedlineDocument(drawn.ctx, snapshot, { measurer });
  assert.equal(fills(drawn.calls).at(-1), '#111827');
  const moves = drawn.calls.filter(call => call[0] === 'moveTo');
  assert.deepEqual(moves.at(-1), ['moveTo', 20, 30], 'the proxy path starts at the hotspot');
  const hidden = recordingContext();
  drawRedlineDocument(hidden.ctx, { ...snapshot, cursor: { visible: false, x: 20, y: 30 } }, { measurer });
  assert.equal(fills(hidden.calls).includes('#111827'), false);
  const captured = recordingContext();
  drawRedlineDocument(captured.ctx, snapshot, { measurer, cursor: false });
  assert.equal(fills(captured.calls).includes('#111827'), false, 'a capture with real cursor pixels gets no duplicate');
});

function fakeTimers() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, ms) => { timers.set(++id, { at: now + ms, callback }); return id; },
    clearTimer: key => timers.delete(key),
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(key)) {
          timers.delete(key);
          timer.callback();
        }
      }
    },
  };
}

test('a press counts at once; a pause counts only after resting', () => {
  const clock = fakeTimers();
  const commits = [];
  const trail = new PointerTrail({ ...clock, dwellMs: 500, tolerance: 4, onCommit: point => commits.push(point) });
  const at = (clientX, clientY) => ({ clientX, clientY, width: 1000, height: 500 });
  trail.move(at(100, 100));
  clock.advance(300);
  trail.move(at(102, 101));
  clock.advance(250);
  assert.deepEqual(trail.last && [trail.last.fx, trail.last.fy, trail.last.reason], [0.1, 0.2, 'pause'], 'small drift still counts as resting');
  trail.press(at(500, 250));
  assert.deepEqual([trail.last.fx, trail.last.fy, trail.last.reason], [0.5, 0.5, 'press']);
  assert.equal(commits.length, 2);
});

test('crossing the page to reach a control never moves the remembered position', () => {
  const clock = fakeTimers();
  const trail = new PointerTrail({ ...clock, dwellMs: 500 });
  const at = (clientX, clientY) => ({ clientX, clientY, width: 1000, height: 500 });
  trail.press(at(700, 300));
  // Travel towards the toolbar, then rest on it (Redline reports leave()).
  for (let step = 0; step < 10; step++) {
    trail.move(at(700 - step * 60, 300 - step * 28));
    clock.advance(40);
  }
  trail.leave();
  clock.advance(5000);
  assert.deepEqual([trail.last.fx, trail.last.fy], [0.7, 0.6]);
  trail.reset();
  assert.equal(trail.last, null);
});
