import fs from 'node:fs/promises';
import path from 'node:path';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { width: 800px; height: 1600px; background:
    linear-gradient(#f7eee0 0 400px, #e2f1f6 400px 800px, #edf5df 800px 1200px, #eee6f6 1200px);
  }
</style>
<button id="page-button">page control</button>`;

// A fixed header (blue) and a sticky bar (green) that would repeat in every
// stitched tile if captured as they appear on screen.
const PINNED = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { width: 800px; height: 1600px; background: #ffffff; }
  #header { position: fixed; top: 0; left: 0; width: 800px; height: 40px; background: #0000ff; }
  #spacer { height: 600px; }
  #sticky { position: sticky; top: 64px; height: 30px; background: #00ff00; }
</style>
<div id="header" style="z-index: 5"></div>
<div id="spacer"></div>
<div id="sticky"></div>`;

const { check, results } = createChecker();
const { server, origin } = await startServer({ '/full-page': PAGE, '/pinned': PINNED });
  const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 500 } });
let access;
try {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  await page.goto(`${origin}/full-page`);
  await page.evaluate(() => scrollTo(0, 600));
  access = await openRedline({ context, worker, page });
  const { evaluate } = access;

  const structure = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const capture = root.querySelector('[data-redline-strip-section="capture"]');
    const bar = root.querySelector('[data-redline-toolbar]');
    const box = bar.getBoundingClientRect();
    return {
      menus: root.querySelectorAll('[data-redline-menu]').length,
      width: box.width,
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
      fits: bar.scrollWidth <= bar.clientWidth + 1,
      eraserOnBar: Boolean(root.querySelector('[data-redline-toolbar] [data-redline-tool="eraser"]')),
      clearOnBar: Boolean(root.querySelector('[data-redline-toolbar] [data-redline-action="clear"]')),
      modeWidth: root.querySelector('[data-redline-mode-toggle]').getBoundingClientRect().width,
      captureItems: [...capture.querySelectorAll('[data-redline-tool], [data-redline-action]')]
        .map(node => node.dataset.redlineTool ?? node.dataset.redlineAction),
    };
  });
  check('one full-width strip has no overflow menu and keeps drawing and Capture commands visible',
    structure.menus === 0 && structure.width >= 1180 && structure.fits
      && structure.eraserOnBar && structure.clearOnBar && structure.modeWidth <= 36
      && ['crop', 'fullPage', 'copy'].every(item => structure.captureItems.includes(item)),
    JSON.stringify(structure));

  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-tool="pen"]').click());
  check('drawing tools are selected directly from the strip',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-tool="pen"]').hasAttribute('data-active')));

  await page.setViewportSize({ width: 800, height: 500 });
  await page.evaluate(() => scrollTo(0, 600));

  const documentFile = path.join(scratch, 'full-page.redline.json');
  await fs.writeFile(documentFile, JSON.stringify({
    format: 'open-redline', version: 1,
    document: {
      width: 800, height: 500, outputScale: 0.5,
      annotations: [{
        id: 'full-page-line', type: 'line', color: '#e21f26', width: 8,
        start: { x: 100, y: 100 }, end: { x: 300, y: 100 },
      }],
    },
  }));
  await access.importFile(documentFile);
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-marks] [data-redline-id]').length > 0),
    'annotation imported');

  await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    root.querySelector('[data-redline-action="fullPage"]').click();
  });
  try {
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')),
      'full page copied', 45000);
  } catch (error) {
    const state = await evaluate(() => ({
      busy: globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy'),
      message: globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent,
    }));
    throw new Error(`${error.message}; ${JSON.stringify(state)}`);
  }
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const blob = await item.getType('image/png');
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixel = [...ctx.getImageData(200, 700, 1, 1).data];
    return { width: bitmap.width, height: bitmap.height, pixel, scrollY };
  });
  copied.status = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent);
  check('Full Page preserves native pixels despite a 50% export setting and aligns the annotation',
    copied.width === 800 && copied.height === 1600 && copied.scrollY === 600
      && copied.pixel[0] > 180 && copied.pixel[1] < 90 && copied.pixel[2] < 90
      && /800 × 1600 native pixels/.test(copied.status),
    JSON.stringify(copied));

  // Fixed and sticky elements appear once, where the page puts them.
  await access.dispose();
  await page.goto(`${origin}/pinned`);
  await page.evaluate(() => scrollTo(0, 900));
  access = await openRedline({ context, worker, page });
  const styleBefore = await page.evaluate(() => [document.getElementById('header'), document.getElementById('sticky')].map(node => [node.hasAttribute('style'), node.style.cssText]));
  await access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-action="fullPage"]').click());
  await waitUntil(() => access.evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')),
    'pinned page copied', 45000);
  const pinned = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const at = y => [...ctx.getImageData(400, y, 1, 1).data].slice(0, 3).join(',');
    // 520 and 1020 are where the header would repeat in the second and third
    // tiles; 564 and 1064 are where the sticky bar would stick in them.
    return {
      height: bitmap.height, top: at(20), second: at(520), third: at(1020),
      stickyInPlace: at(615), stuckSecond: at(579), stuckThird: at(1079), scrollY,
      style: [document.getElementById('header'), document.getElementById('sticky')].map(node => [node.hasAttribute('style'), node.style.cssText]),
    };
  });
  check('a fixed header appears once, at the top of a full-page capture',
    pinned.height === 1600 && pinned.top === '0,0,255' && pinned.second === '255,255,255' && pinned.third === '255,255,255',
    JSON.stringify(pinned));
  check('a sticky element is captured where it sits in the page, not repeated where it would stick',
    pinned.stickyInPlace === '0,255,0' && pinned.stuckSecond === '255,255,255' && pinned.stuckThird === '255,255,255',
    JSON.stringify(pinned));
  check('the page gets its own inline styles and scroll position back after capture',
    JSON.stringify(pinned.style) === JSON.stringify(styleBefore) && pinned.scrollY === 900,
    JSON.stringify({ before: styleBefore, after: pinned.style, scrollY: pinned.scrollY }));
} finally {
  await access?.dispose();
  await context.close();
  await new Promise(resolve => server.close(resolve));
}

if (results.some(result => !result.pass)) process.exitCode = 1;
