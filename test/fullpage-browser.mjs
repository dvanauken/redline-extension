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

const { check, results } = createChecker();
const { server, origin } = await startServer({ '/full-page': PAGE });
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
} finally {
  await access?.dispose();
  await context.close();
  await new Promise(resolve => server.close(resolve));
}

if (results.some(result => !result.pass)) process.exitCode = 1;
