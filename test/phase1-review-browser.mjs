/** Lead-review regressions: per-object fill retention and clean captures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChecker, launch, openRedline, samplePng, startServer, waitUntil } from './harness.mjs';

const { results, check } = createChecker();
const { server, origin } = await startServer({ '/review': '<!doctype html><body style="margin:0;background:#FFFFFF">Review fixture</body>' });
const { context, worker, scratch } = await launch();
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin + '/review');
  const access = await openRedline({ context, worker, page });
  const { evaluate, importFile, inject } = access;
  const click = selector => evaluate(value => globalThis.__redlineTestRoot.querySelector(value).click(), selector);
  const openColor = async target => {
    await click(`[data-redline-color="${target}"]`);
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'color dialog opened');
  };
  const setOpacity = async (target, value) => {
    await openColor(target);
    await evaluate(opacity => {
      const root = globalThis.__redlineTestRoot;
      const slider = root.querySelector('[data-dialog="redline-color"] input[type="range"]');
      slider.value = String(Math.round(opacity * 100));
      slider.dispatchEvent(new Event('input'));
    }, value);
    await page.keyboard.press('Escape');
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'color dialog closed');
  };
  const noPaint = async target => {
    await openColor(target);
    await click('[data-redline-no-paint]');
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'color dialog closed');
  };
  const load = async doc => {
    const file = path.join(scratch, 'review.json');
    await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document: doc }));
    await importFile(file);
  };
  const exportFile = async action => {
    const [download] = await Promise.all([page.waitForEvent('download'), click('[data-redline-action="' + action + '"]')]);
    const file = path.join(scratch, download.suggestedFilename());
    await download.saveAs(file);
    return fs.readFile(file);
  };
  const documentJSON = async () => JSON.parse(await exportFile('json')).document;
  const marks = [
    { id: 'a', type: 'rectangle', color: '#1D4ED8', fill: '#FDE68A', fillOpacity: 0.35, start: { x: 250, y: 300 }, end: { x: 450, y: 420 } },
    { id: 'b', type: 'rectangle', color: '#DC2626', fill: '#16A34A', fillOpacity: 0.75, start: { x: 550, y: 300 }, end: { x: 750, y: 420 } },
  ];
  await load({ width: 1200, height: 800, annotations: marks });
  await click('[data-redline-tool="rectangle"]');
  await setOpacity('fill', 0.5);
  await noPaint('fill');
  await click('[data-redline-tool="select"]');
  await page.mouse.click(350, 350);
  await noPaint('fill');
  await page.mouse.click(650, 350);
  await setOpacity('fill', 0.1);
  const hidden = await documentJSON();
  await load(hidden);
  await click('[data-redline-action="close"]');
  await inject();
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open), 'reopened');
  await click('[data-redline-tool="select"]');
  await page.mouse.click(250, 350);
  await noPaint('stroke');
  const restored = await documentJSON();
  check('an outlined shape restores its own colour and exact opacity after editing another shape, JSON and reopen',
    restored.annotations[0].fill === '#FDE68A' && restored.annotations[0].fillOpacity === 0.35 && restored.annotations[0].outline === false,
    JSON.stringify(restored.annotations[0]));
  check('restoring one fill leaves the other shape untouched', restored.annotations[1].fillOpacity === 0.1 && restored.annotations[1].fill === '#16A34A');
  await click('[data-redline-action="undo"]');
  const undone = await documentJSON();
  await click('[data-redline-action="redo"]');
  const redone = await documentJSON();
  check('the hidden fill and restored fill survive undo and redo',
    JSON.stringify(undone.annotations[0]) === JSON.stringify(hidden.annotations[0]) && JSON.stringify(redone.annotations[0]) === JSON.stringify(restored.annotations[0]));
  await click('[data-redline-tool="rectangle"]');
  await openColor('fill');
  const defaultStrength = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"] input[type="range"]').value);
  await page.keyboard.press('Escape');
  check('editing selected objects leaves remembered drawing defaults unchanged', defaultStrength === '50', defaultStrength);

  // Trigger a real status toast, then capture while it is still visible.
  // The toast is outside the overlay dialog, but is still extension chrome.
  await page.keyboard.press('F2');
  await page.keyboard.press('F2');
  await page.waitForTimeout(200);
  const toast = await evaluate(() => {
    const node = globalThis.__redlineTestRoot.querySelector('[data-redline-toast]');
    const box = node.getBoundingClientRect();
    return { x: box.x + 15, y: box.y + 5, visible: getComputedStyle(node).opacity === '1' };
  });
  const before = await samplePng(evaluate, await page.screenshot(), [[toast.x, toast.y]]);
  const exported = await samplePng(evaluate, await exportFile('download'), [[toast.x, toast.y]]);
  check('a visible status toast is excluded from the PNG', toast.visible && before[0][0] < 255 && exported[0].slice(0, 3).every(value => value === 255),
    JSON.stringify({ toast, before, exported }));
  check('the status toast becomes visible again after capture', await evaluate(() => getComputedStyle(globalThis.__redlineTestRoot.querySelector('[data-redline-toast]')).visibility === 'visible'));
  for (const width of [1920, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    await click('[data-redline-tool="line"]');
    const controls = await evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      return [...root.querySelectorAll('[data-redline-control="ends"] button, [data-redline-control="ends"] select')].map(node => {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        return { name: node.getAttribute('aria-label'), visible: node.checkVisibility(), left: rect.left, right: rect.right };
      });
    });
    check('all endpoint presets and both endpoint selectors are scroll-reachable at ' + width + 'px',
      controls.length === 8 && controls.every(item => item.visible && item.left >= 0 && item.right <= width), JSON.stringify(controls));
  }
  for (const label of ['Start decoration', 'End decoration']) {
    const point = await evaluate(value => {
      const node = globalThis.__redlineTestRoot.querySelector('select[aria-label="' + value + '"]');
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, label);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press(label === 'Start decoration' ? 'End' : 'Home');
    if (label === 'End decoration') await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  const ends = await evaluate(() => ['Start decoration', 'End decoration'].map(label =>
    globalThis.__redlineTestRoot.querySelector('select[aria-label="' + label + '"]').value));
  check('both endpoint selectors work with mouse and keyboard at the 1200px minimum', ends[0] === 'filled-circle' && ends[1] === 'arrow', JSON.stringify(ends));
  await access.dispose();
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(results.filter(result => result.pass).length + '/' + results.length + ' lead-review checks passed');
process.exitCode = results.every(result => result.pass) ? 0 : 1;
