/** Real-browser acceptance for contour text and direct/object selection. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';

const { results, check } = createChecker();
const { server, origin } = await startServer({
  '/shape-edit': '<!doctype html><html><body style="margin:0;background:#fff"></body></html>',
});
const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });

let page;
try {
  page = context.pages()[0] ?? await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/shape-edit`);
  const access = await openRedline({ context, worker, page });
  const { evaluate } = access;
  const click = selector => evaluate(value => {
    const node = globalThis.__redlineTestRoot.querySelector(value);
    if (!node) throw new Error(`Missing ${value}`);
    node.click();
  }, selector);
  const exportJSON = async name => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      click('[data-redline-action="json"]'),
    ]);
    const file = path.join(scratch, `${name}.json`);
    await download.saveAs(file);
    return JSON.parse(await fs.readFile(file, 'utf8'));
  };
  const directPoints = () => evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('[data-redline-direct-point]')].map(node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      index: Number(node.getAttribute('data-redline-direct-point')),
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      radius: node.getAttribute('r'), fill: style.fill, stroke: style.stroke,
      selected: node.hasAttribute('data-selected'),
    };
  }));
  const lineSignature = () => evaluate(() => {
    const mark = globalThis.__redlineTestRoot.querySelector('[data-redline-type="polygon"]');
    return [...mark.querySelectorAll('text tspan')].map(node => ({ text: node.textContent, x: +node.getAttribute('x'), y: +node.getAttribute('y') }));
  });

  await click('[data-redline-tool="polygon"]');
  for (const [x, y] of [[250, 190], [650, 210], [540, 540], [330, 520]]) await page.mouse.click(x, y);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Contour-aware text follows every sloping polygon wall and wraps on words or hyphen-boundaries while the shape changes.');
  await waitUntil(() => evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]'))), 'polygon text editor opened');
  const live = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const input = root.querySelector('[data-redline-text-editor]');
    return {
      type: input.dataset.redlineShapeTextEditor,
      focused: root.activeElement === input,
      caret: Boolean(root.querySelector('[data-redline-text-caret]')),
      lines: new Set([...root.querySelectorAll('[data-redline-type="polygon"] text tspan')].map(node => node.getAttribute('y'))).size,
      controls: ['text', 'fontFamily', 'textFormat', 'textAlign', 'verticalAlign']
        .every(name => !root.querySelector(`[data-redline-control="${name === 'text' ? 'textColor' : name}"]`)?.hidden),
    };
  });
  check('typing on a selected polygon opens the focused direct-canvas editor', live.type === 'polygon' && live.focused && live.caret, JSON.stringify(live));
  check('polygon text wraps into multiple contour-aware lines', live.lines >= 3, String(live.lines));
  check('font, emphasis, text color and alignment controls are visible in the top strip', live.controls);

  await evaluate(() => {
    const input = globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]');
    input.setSelectionRange(0, 13);
    input.dispatchEvent(new Event('select'));
  });
  await click('[data-redline-text-format="bold"]');
  await click('[data-redline-text-format="italic"]');
  await click('[data-redline-color="text"]');
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]')?.open), 'text palette opened');
  await click('[data-redline-picker] [data-preset="approved"]');
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]')?.open), 'text palette closed');
  await page.keyboard.press('Control+Enter');

  let json = await exportJSON('shape-rich-text');
  let mark = json.document.annotations[0];
  check('range formatting is stored on the polygon text', mark.type === 'polygon' && mark.textRuns?.some(run => run.start === 0 && run.end >= 13
    && run.bold && run.italic && /^#[0-9A-F]{6}$/i.test(run.textColor)), JSON.stringify(mark.textRuns));

  const beforeLayout = await lineSignature();
  // Download controls do not own selection state. Re-select explicitly so the
  // V assertion exercises the documented selected-path transition.
  await click('[data-redline-tool="select"]');
  await page.mouse.click(450, 350);
  const beforeDirect = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    return {
      tool: root.querySelector('[data-redline-canvas]').dataset.tool,
      handles: root.querySelectorAll('[data-redline-resize]').length,
      target: root.querySelector('[data-redline-target]')?.textContent,
    };
  });
  check('the polygon is selected before mode switching', beforeDirect.tool === 'select' && beforeDirect.handles === 9,
    JSON.stringify(beforeDirect));
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').focus());
  await page.keyboard.press('v');
  const directChrome = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const boundary = root.querySelector('[data-redline-direct-boundary]');
    const style = boundary ? getComputedStyle(boundary) : null;
    return {
      stroke: style?.stroke, width: style?.strokeWidth, objectHandles: root.querySelectorAll('[data-redline-resize]').length,
      pressed: root.querySelector('[data-redline-selection-mode]')?.getAttribute('aria-pressed'),
    };
  });
  let points = await directPoints();
  check('V enters direct selection with an orange-yellow boundary only', directChrome.stroke === 'rgb(245, 158, 11)'
    && directChrome.objectHandles === 0, JSON.stringify(directChrome));
  check('direct vertices are white 2px dots with a thin black border', points.length === 4
    && points.every(point => point.radius === '2' && point.fill === 'rgb(255, 255, 255)' && point.stroke === 'rgb(17, 24, 39)'), JSON.stringify(points));

  const movedFrom = points[1];
  await page.mouse.move(movedFrom.x, movedFrom.y);
  await page.mouse.down();
  await page.mouse.move(movedFrom.x - 120, movedFrom.y + 70, { steps: 8 });
  await page.mouse.up();
  const afterLayout = await lineSignature();
  check('moving a vertex reflows the polygon text immediately', JSON.stringify(afterLayout) !== JSON.stringify(beforeLayout));
  json = await exportJSON('shape-point-moved');
  mark = json.document.annotations[0];
  check('vertex dragging commits the changed contour to JSON', mark.points[1].x < 600 && mark.points[1].y > 210, JSON.stringify(mark.points[1]));

  points = await directPoints();
  const midpoint = { x: (points[1].x + points[2].x) / 2, y: (points[1].y + points[2].y) / 2 };
  await page.mouse.dblclick(midpoint.x, midpoint.y);
  await waitUntil(async () => (await directPoints()).length === 5, 'double-click inserted a vertex');
  check('double-clicking a segment inserts and selects a vertex', (await directPoints()).some(point => point.selected));
  await page.keyboard.press('Delete');
  await waitUntil(async () => (await directPoints()).length === 4, 'Delete removed the selected vertex');
  check('Delete removes the selected vertex without deleting the polygon', (await directPoints()).length === 4);

  await page.keyboard.press('v');
  const objectChrome = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const handles = [...root.querySelectorAll('[data-redline-resize]')];
    const first = handles[0]?.querySelector('rect');
    const style = first ? getComputedStyle(first) : null;
    const center = root.querySelector('[data-redline-move-handle]');
    const polygon = root.querySelector('[data-redline-type="polygon"] polygon').getBoundingClientRect();
    return {
      count: handles.length, center: Boolean(center), fill: style?.fill, stroke: style?.stroke, strokeWidth: style?.strokeWidth,
      box: { x: polygon.x, y: polygon.y, width: polygon.width, height: polygon.height },
      centerPoint: center ? (() => { const r = center.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })() : null,
    };
  });
  check('V returns to object selection with eight green square handles, center move knob, and rotation knob', objectChrome.count === 9
    && objectChrome.center && objectChrome.fill === 'rgb(34, 197, 94)' && objectChrome.stroke === 'rgb(17, 24, 39)'
    && objectChrome.strokeWidth === '2px'
    && await evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('[data-redline-rotate]'))), JSON.stringify(objectChrome));

  await page.mouse.move(objectChrome.centerPoint.x, objectChrome.centerPoint.y);
  await page.mouse.down();
  await page.mouse.move(objectChrome.centerPoint.x + 35, objectChrome.centerPoint.y + 25, { steps: 5 });
  await page.mouse.up();
  const movedBox = await evaluate(() => {
    const r = globalThis.__redlineTestRoot.querySelector('[data-redline-type="polygon"] polygon').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  check('dragging the center knob moves the whole object', Math.abs(movedBox.x - objectChrome.box.x - 35) < 2
    && Math.abs(movedBox.y - objectChrome.box.y - 25) < 2, JSON.stringify([objectChrome.box, movedBox]));

  check('the scenario produces no page errors', errors.length === 0, errors.join(' | '));
  await access.dispose();
} catch (error) {
  check('suite completed without an exception', false, error.stack ?? error.message);
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}

const failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} shape editing checks passed`);
if (failed.length) process.exitCode = 1;
