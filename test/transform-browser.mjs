/**
 * Selection handles and rotation through real pointer input: eight handles and
 * a rotate knob on drawn shapes, strokes and text; end handles on lines;
 * resizing that keeps the opposite handle in place at any rotation; rotated
 * PNG export matching the preview; rotated text editing; undo and JSON.
 *
 *   node test/transform-browser.mjs [--headed]
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, samplePng, startServer, waitUntil } from './harness.mjs';

const ARTIFACTS = 'test-artifacts/transform';
const FRAME = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const { results, check } = createChecker();
const { server, origin } = await startServer({
  '/plain': '<!doctype html><html><body style="margin:0;background:#FFFFFF"></body></html>',
});
const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
await fs.mkdir(ARTIFACTS, { recursive: true });

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
const nearPoint = (a, b, tolerance = 1.5) => Boolean(a && b) && near(a.x, b.x, tolerance) && near(a.y, b.y, tolerance);
const show = point => (point ? `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})` : 'missing');
const turn = (point, center, degrees) => {
  const r = (degrees * Math.PI) / 180;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * Math.cos(r) - dy * Math.sin(r), y: center.y + dx * Math.sin(r) + dy * Math.cos(r) };
};
/** The page position of a stored box mark's upright top-left corner. */
const cornerOf = mark => {
  const x = Math.min(mark.start.x, mark.end.x);
  const y = Math.min(mark.start.y, mark.end.y);
  const center = { x: (mark.start.x + mark.end.x) / 2, y: (mark.start.y + mark.end.y) / 2 };
  return turn({ x, y }, center, mark.rotation ?? 0);
};

let page;
try {
  page = context.pages()[0] ?? await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/plain`);
  const { evaluate, importFile } = await openRedline({ context, worker, page });

  const click = selector => evaluate(value => {
    const node = globalThis.__redlineTestRoot.querySelector(value);
    if (!node) throw new Error('Missing ' + value);
    node.click();
  }, selector);
  const drag = async (from, to, { shift = false, steps = 8 } = {}) => {
    await page.mouse.move(from.x, from.y);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  /** Screen centres of the visible handles, keyed by name. */
  const handles = () => evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const centre = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    const found = {};
    for (const node of root.querySelectorAll('[data-redline-resize]')) found[node.getAttribute('data-redline-resize')] = centre(node);
    const knob = root.querySelector('[data-redline-rotate]');
    if (knob) found.rotate = centre(knob);
    return found;
  });
  const hoverAt = async point => {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(60);
    return evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').getAttribute('data-hover'));
  };
  const exportJSON = async name => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), click('[data-redline-action="json"]')]);
    const file = path.join(scratch, `${name}.json`);
    await download.saveAs(file);
    return { file, data: JSON.parse(await fs.readFile(file, 'utf8')) };
  };
  const annotations = async () => (await exportJSON('probe')).data.document.annotations;
  const exportPNG = async name => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), click('[data-redline-action="download"]')]);
    const file = path.join(scratch, `${name}.png`);
    await download.saveAs(file);
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'export finished', 20000);
    await page.waitForTimeout(600);
    return fs.readFile(file);
  };
  const message = () => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent);
  const screenshot = name => page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });

  // ---------------------------------------------------------------------------
  // A drawn rectangle: eight handles on its corners and edges, and a knob.
  await click('[data-redline-tool="rectangle"]');
  await drag({ x: 400, y: 300 }, { x: 600, y: 400 });
  await click('[data-redline-tool="select"]');
  await page.mouse.click(400, 350);
  let seen = await handles();
  const expected = {
    nw: { x: 400, y: 300 }, n: { x: 500, y: 300 }, ne: { x: 600, y: 300 }, e: { x: 600, y: 350 },
    se: { x: 600, y: 400 }, s: { x: 500, y: 400 }, sw: { x: 400, y: 400 }, w: { x: 400, y: 350 },
  };
  check('a selected rectangle shows a handle on every corner and edge midpoint',
    FRAME.every(name => nearPoint(seen[name], expected[name])), FRAME.map(name => `${name} ${show(seen[name])}`).join(' '));
  check('and a rotate knob centred above its top edge', nearPoint(seen.rotate, { x: 500, y: 270 }), show(seen.rotate));
  check('the frame is solid and sits on the shape',
    await evaluate(() => {
      const frame = globalThis.__redlineTestRoot.querySelector('[data-redline-selection][data-redline-frame]');
      const r = frame?.getBoundingClientRect();
      return Boolean(r) && getComputedStyle(frame).strokeDasharray === 'none'
        && Math.abs(r.x - 400) < 1.5 && Math.abs(r.right - 600) < 1.5 && Math.abs(r.y - 300) < 1.5 && Math.abs(r.bottom - 400) < 1.5;
    }));
  check('hovering shows resize and rotate pointers',
    (await hoverAt(expected.se)) === 'resize-se' && (await hoverAt(expected.n)) === 'resize-s' && (await hoverAt(seen.rotate)) === 'rotate');
  await screenshot('01-rectangle-selected');

  // Resize from a corner, then undo.
  await drag(expected.se, { x: 650, y: 440 });
  let [shape] = await annotations();
  check('dragging a corner handle resizes from the opposite corner',
    near(Math.min(shape.start.x, shape.end.x), 400, 0.5) && near(Math.max(shape.start.x, shape.end.x), 650, 0.5)
    && near(Math.min(shape.start.y, shape.end.y), 300, 0.5) && near(Math.max(shape.start.y, shape.end.y), 440, 0.5), JSON.stringify(shape));
  await page.keyboard.press('Control+z');
  [shape] = await annotations();
  check('a resize is one undo step', near(Math.abs(shape.end.x - shape.start.x), 200, 0.5) && near(Math.abs(shape.end.y - shape.start.y), 100, 0.5), JSON.stringify(shape));
  // Redo is still available after the undo; any new edit would clear it.
  await page.mouse.click(expected.e.x, expected.e.y);
  check('clicking a handle without dragging keeps the selection and adds no edit',
    Object.keys(await handles()).length === 10
    && await evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-action="redo"]').disabled));

  // Rotate with the knob; Shift snaps to 15° steps.
  seen = await handles();
  await drag(seen.rotate, { x: 600, y: 362 }, { shift: true });
  const rotatedMessage = await message();
  [shape] = await annotations();
  check('dragging the knob with Shift rotates to a 15° step', shape.rotation === 90, String(shape.rotation));
  check('the status names the new angle', /Rotated to 90°/.test(rotatedMessage), rotatedMessage);
  seen = await handles();
  check('handles and knob turn with the shape',
    nearPoint(seen.n, { x: 550, y: 350 }) && nearPoint(seen.e, { x: 500, y: 450 }) && nearPoint(seen.nw, { x: 550, y: 250 })
    && nearPoint(seen.rotate, { x: 580, y: 350 }),
    `n ${show(seen.n)} e ${show(seen.e)} nw ${show(seen.nw)} knob ${show(seen.rotate)}`);
  check('a turned handle shows the pointer for its on-screen direction', (await hoverAt(seen.e)) === 'resize-s');
  await screenshot('02-rectangle-rotated');

  // Resizing a rotated shape keeps the opposite handle fixed on the page.
  const anchor = seen.w;
  await drag(seen.e, { x: seen.e.x + 4, y: seen.e.y + 40 });
  seen = await handles();
  [shape] = await annotations();
  check('resizing a rotated shape keeps the opposite handle in place', nearPoint(seen.w, anchor), `${show(anchor)} → ${show(seen.w)}`);
  check('and grows it along its own width', near(Math.abs(shape.end.x - shape.start.x), 240, 0.5) && shape.rotation === 90, JSON.stringify(shape));

  // Hit testing follows the rotation.
  await page.mouse.click(1000, 700);
  await page.mouse.click(400, 350);
  check('the old upright outline no longer selects the shape', Object.keys(await handles()).length === 0);
  await page.mouse.click(450, 350);
  check('the turned outline does', Object.keys(await handles()).length === 10);

  // Preview and PNG agree on the rotated outline.
  await page.mouse.click(1000, 700);
  const box = await evaluate(() => {
    const r = globalThis.__redlineTestRoot.querySelector('[data-redline-marks] rect').getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
  });
  // Turned 90°, the 240×100 box stands 100 wide and 240 tall about its centre.
  const centre = { x: (shape.start.x + shape.end.x) / 2, y: (shape.start.y + shape.end.y) / 2 };
  check('the preview draws the rectangle turned', near(box.right - box.x, 100, 4) && near(box.bottom - box.y, 240, 4), JSON.stringify(box));
  const onOutline = { x: centre.x - 50, y: centre.y };
  const wasOutline = { x: centre.x - 120, y: centre.y };
  const png = await exportPNG('rotated');
  const inked = pixel => Math.abs(pixel[0] - 182) + Math.abs(pixel[1] - 93) + Math.abs(pixel[2] - 102) < 60;
  const [pngOn, pngWas] = await samplePng(evaluate, png, [[onOutline.x, onOutline.y], [wasOutline.x, wasOutline.y]]);
  const preview = await page.screenshot();
  const [shotOn, shotWas] = await samplePng(evaluate, preview, [[onOutline.x, onOutline.y], [wasOutline.x, wasOutline.y]]);
  check('the PNG draws the turned outline and nothing where the upright one was',
    inked(pngOn) && !inked(pngWas) && pngWas[0] > 240, JSON.stringify([pngOn, pngWas]));
  check('the preview matches the PNG there', inked(shotOn) && !inked(shotWas), JSON.stringify([shotOn, shotWas]));

  // ---------------------------------------------------------------------------
  // A pen stroke: handles surround the ink, and it rotates and stretches.
  await click('[data-redline-tool="pen"]');
  await page.mouse.move(150, 560);
  await page.mouse.down();
  for (const [x, y] of [[190, 600], [230, 560], [270, 600], [310, 560]]) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await click('[data-redline-tool="select"]');
  await page.mouse.click(150, 560);
  seen = await handles();
  check('a selected pen stroke has eight handles and a knob', FRAME.every(name => seen[name]) && Boolean(seen.rotate), Object.keys(seen).join(','));
  check('its frame surrounds the ink', seen.nw.x < 150 && seen.nw.y < 560 && seen.se.x > 310 && seen.se.y > 600, `${show(seen.nw)} ${show(seen.se)}`);
  await screenshot('03-pen-selected');
  await drag(seen.rotate, { x: seen.rotate.x + 60, y: seen.rotate.y + 20 });
  let stroke = (await annotations()).find(mark => mark.type === 'pen');
  check('a pen stroke rotates freely', stroke.rotation > 10 && stroke.rotation < 80, String(stroke.rotation));
  const widthBefore = Math.max(...stroke.points.map(p => p.x)) - Math.min(...stroke.points.map(p => p.x));
  seen = await handles();
  await drag(seen.e, { x: seen.e.x + 30 * Math.cos((stroke.rotation * Math.PI) / 180), y: seen.e.y + 30 * Math.sin((stroke.rotation * Math.PI) / 180) });
  stroke = (await annotations()).find(mark => mark.type === 'pen');
  const widthAfter = Math.max(...stroke.points.map(p => p.x)) - Math.min(...stroke.points.map(p => p.x));
  check('and stretches along its own width', near(widthAfter - widthBefore, 30, 1.5), `${widthBefore} → ${widthAfter}`);
  await screenshot('04-pen-rotated');

  // ---------------------------------------------------------------------------
  // A straight line: a handle on each end and no knob, as in PowerPoint.
  await click('[data-redline-tool="line"]');
  await drag({ x: 700, y: 560 }, { x: 900, y: 620 });
  await click('[data-redline-tool="select"]');
  await page.mouse.click(800, 590);
  seen = await handles();
  check('a selected line shows only its two end handles',
    Object.keys(seen).sort().join(',') === 'end,start' && nearPoint(seen.start, { x: 700, y: 560 }) && nearPoint(seen.end, { x: 900, y: 620 }),
    JSON.stringify(seen));
  check('an end handle shows a crosshair pointer', (await hoverAt(seen.end)) === 'endpoint');
  await drag(seen.end, { x: 960, y: 680 });
  const line = (await annotations()).find(mark => mark.type === 'line');
  check('dragging an end handle moves only that end',
    nearPoint(line.start, { x: 700, y: 560 }, 0.5) && nearPoint(line.end, { x: 960, y: 680 }, 0.5), JSON.stringify(line));
  await screenshot('05-line-selected');

  // ---------------------------------------------------------------------------
  // Text: rotate, then edit in place; growing keeps its corner on the page.
  await click('[data-redline-tool="textbox"]');
  await page.mouse.click(760, 220);
  await page.keyboard.type('Rotate me');
  await page.keyboard.press('Control+Enter');
  await waitUntil(async () => Object.keys(await handles()).length === 10, 'text box selected with handles');
  seen = await handles();
  await drag(seen.rotate, { x: seen.rotate.x + 200, y: seen.rotate.y + 80 }, { shift: true });
  let text = (await annotations()).find(mark => mark.type === 'textbox');
  check('a text box rotates with its knob', text.rotation > 0 && text.rotation % 15 === 0, String(text.rotation));
  const cornerBefore = cornerOf(text);
  const middle = { x: (text.start.x + text.end.x) / 2, y: (text.start.y + text.end.y) / 2 };
  await page.mouse.dblclick(middle.x, middle.y);
  await waitUntil(() => evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]'))), 'text editor opened');
  const editorTransform = await evaluate(() => globalThis.__redlineTestRoot
    .querySelector('[data-redline-type="textbox"] > g')?.getAttribute('transform') ?? '');
  check('the live text preview turns with the box', editorTransform.includes(`rotate(${text.rotation} `), editorTransform);
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' — and keep typing until the box has to grow wider and then wrap onto more lines of text');
  const editorCorner = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const mark = root.querySelector('[data-redline-type="textbox"]');
    const rect = mark.querySelector('rect');
    const point = new DOMPoint(+rect.getAttribute('x'), +rect.getAttribute('y')).matrixTransform(rect.getScreenCTM());
    return { x: point.x, y: point.y };
  });
  check('while typing, the growing live preview keeps its corner where the box was', nearPoint(editorCorner, cornerBefore, 2), `${show(cornerBefore)} vs ${show(editorCorner)}`);
  await screenshot('06-text-editing-rotated');
  await page.keyboard.press('Control+Enter');
  text = (await annotations()).find(mark => mark.type === 'textbox');
  check('the saved text box grew and kept its rotation and corner',
    Math.abs(text.end.x - text.start.x) > 100 && nearPoint(cornerOf(text), cornerBefore, 0.5) && text.rotation > 0,
    `${show(cornerBefore)} → ${show(cornerOf(text))} ${JSON.stringify(text)}`);
  await screenshot('07-text-rotated-saved');

  // ---------------------------------------------------------------------------
  // Bullets stay fixed-size markers: selectable and movable, without handles.
  await click('[data-redline-tool="bullet"]');
  await page.mouse.click(1000, 400);
  await click('[data-redline-tool="select"]');
  await page.mouse.click(1000, 400);
  check('a selected bullet shows its frame but no resize handles or knob',
    Object.keys(await handles()).length === 0
    && await evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('[data-redline-selection]'))));

  // ---------------------------------------------------------------------------
  // JSON round-trip, and undo/redo of a rotation.
  const { file, data } = await exportJSON('round-trip');
  await click('[data-redline-tool="rectangle"]');
  await drag({ x: 150, y: 680 }, { x: 250, y: 740 });
  await importFile(file);
  await waitUntil(async () => (await annotations()).length === data.document.annotations.length, 'round-trip imported');
  const reloaded = await annotations();
  check('JSON keeps every rotation exactly',
    JSON.stringify(reloaded.map(mark => mark.rotation ?? null)) === JSON.stringify(data.document.annotations.map(mark => mark.rotation ?? null)),
    JSON.stringify(reloaded.map(mark => mark.rotation ?? null)));
  await click('[data-redline-tool="select"]');
  await page.mouse.click(centre.x - 50, centre.y);
  seen = await handles();
  await drag(seen.rotate, { x: seen.rotate.x - 60, y: seen.rotate.y - 90 });
  const turned = (await annotations())[0].rotation;
  await page.keyboard.press('Control+z');
  const undone = (await annotations())[0].rotation;
  await page.keyboard.press('Control+y');
  const redone = (await annotations())[0].rotation;
  check('a rotation is one undo step', turned > 0 && turned !== 90 && undone === 90 && redone === turned, `${turned} / ${undone} / ${redone}`);

  // Ctrl resizes about the centre.
  const boxCentre = mark => ({ x: (mark.start.x + mark.end.x) / 2, y: (mark.start.y + mark.end.y) / 2 });
  let before = (await annotations())[0];
  // Undo and redo clear the selection; select again on the turned left edge.
  const leftEdge = turn({ x: Math.min(before.start.x, before.end.x), y: boxCentre(before).y }, boxCentre(before), before.rotation);
  await page.mouse.click(leftEdge.x, leftEdge.y);
  seen = await handles();
  await page.keyboard.down('Control');
  await drag(seen.e, { x: seen.e.x + 25, y: seen.e.y + 6 });
  await page.keyboard.up('Control');
  let after = (await annotations())[0];
  check('Ctrl+drag resizes about the centre',
    nearPoint(boxCentre(after), boxCentre(before), 0.01) && Math.abs(after.end.x - after.start.x) > Math.abs(before.end.x - before.start.x) + 20,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // After a nonuniform window resize the stretched frame still carries its handles.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(300);
  await page.mouse.move(5, 790);
  seen = await handles();
  const corners = await evaluate(() => {
    const frame = globalThis.__redlineTestRoot.querySelector('[data-redline-frame]');
    const matrix = frame.getScreenCTM();
    const x = frame.x.baseVal.value;
    const y = frame.y.baseVal.value;
    const w = frame.width.baseVal.value;
    const h = frame.height.baseVal.value;
    const at = (px, py) => {
      const point = new DOMPoint(px, py).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    return { nw: at(x, y), n: at(x + w / 2, y), se: at(x + w, y + h), w: at(x, y + h / 2) };
  });
  check('after a nonuniform resize, handles stay on the stretched frame',
    ['nw', 'n', 'se', 'w'].every(name => nearPoint(seen[name], corners[name], 1.5)),
    ['nw', 'n', 'se', 'w'].map(name => `${name} ${show(seen[name])}/${show(corners[name])}`).join(' '));
  before = (await annotations())[0];
  const fixed = seen.w;
  await drag(seen.e, { x: seen.e.x + 20, y: seen.e.y + 10 });
  seen = await handles();
  after = (await annotations())[0];
  check('and resizing there still keeps the opposite handle in place',
    nearPoint(seen.w, fixed, 1.5) && JSON.stringify(after) !== JSON.stringify(before), `${show(fixed)} → ${show(seen.w)}`);
  await screenshot('08-nonuniform-resize');

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  console.error(error);
  check('suite completed without an exception', false, error.message);
  await page?.screenshot({ path: path.join(ARTIFACTS, 'failure.png') }).catch(() => {});
} finally {
  await context.close();
  server.close();
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} transform checks passed`);
process.exit(failed.length ? 1 : 0);
