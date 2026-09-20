/**
 * Visual review captures at 1920, 1200, 800 and 420 CSS pixels.
 *
 *   node test/screenshots.mjs [output-directory]
 *
 * Output defaults to test-artifacts/screenshots (ignored by Git). Each width
 * records the full command strip, its far end on narrow viewports, the colour
 * popover, a selected shape's style
 * row, line-end controls, Browse mode, pinned and dragged positions, plus the
 * demo document's live preview and its exported PNG.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { SOURCE, launch, openRedline, startServer, waitUntil } from './harness.mjs';
import { demoDocument } from './demo-document.mjs';

const OUT = path.resolve(process.argv[2] ?? path.join(SOURCE, 'test-artifacts', 'screenshots'));
await fs.mkdir(OUT, { recursive: true });
const WIDTHS = [1920, 1200, 800, 420];
const HEIGHT = 900;
const { server, origin } = await startServer();
const { context, worker, scratch } = await launch({ viewport: { width: 1920, height: HEIGHT } });
const written = [];

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  written.push(file);
}

try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => console.log('  [page exception]', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('  [console error]', message.text()); });
  await page.goto(`${origin}/fixture`);
  const { evaluate, importFile } = await openRedline({ context, worker, page });
  const root = () => evaluate(() => Boolean(globalThis.__redlineTestRoot));
  await waitUntil(root, 'root');
  const q = (selector, fn = 'click') => evaluate(({ selector, fn }) => {
    const node = globalThis.__redlineTestRoot.querySelector(selector);
    if (fn === 'click') node.click();
    return Boolean(node);
  }, { selector, fn });

  const demoPath = path.join(scratch, 'demo.json');
  const demo = demoDocument();
  await fs.writeFile(demoPath, JSON.stringify(demo));

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.waitForTimeout(250);
    await importFile(demoPath);
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-id]').length > 10), 'demo imported');
    await q('[data-redline-tool="pen"]');
    await page.mouse.move(width - 5, HEIGHT - 5);
    await shot(page, `${width}-01-toolbar-pen`);

    await evaluate(() => {
      const bar = globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]');
      bar.scrollLeft = bar.scrollWidth;
    });
    await page.waitForTimeout(100);
    await shot(page, `${width}-02-command-strip-end`);
    await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]').scrollLeft = 0; });

    await q('[data-redline-tool="select"]');
    const rect = await evaluate(() => {
      const node = globalThis.__redlineTestRoot.querySelector('[data-redline-id="rect-2"] rect');
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y + box.height / 2 };
    });
    await page.mouse.click(rect.x + 1, rect.y);
    await page.waitForTimeout(150);
    await shot(page, `${width}-04-selected-rectangle`);

    await q('[data-redline-color="fill"]');
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('dialog[data-dialog="redline-color"]').open), 'palette open');
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-tab="presets"]').click());
    await page.waitForTimeout(100);
    await shot(page, `${width}-05-palette-presets`);
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-tab="more"]').click());
    await page.waitForTimeout(100);
    await shot(page, `${width}-06-palette-more-colors`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await q('[data-redline-tool="line"]');
    await page.waitForTimeout(100);
    await shot(page, `${width}-07-line-ends`);

    await page.keyboard.press('F2');
    await page.waitForTimeout(150);
    await shot(page, `${width}-08-browse-mode`);
    await page.keyboard.press('F2');

    await q('[data-redline-pin]');
    await page.waitForTimeout(100);
    await shot(page, `${width}-09-pinned`);
    const grip = await evaluate(() => {
      const box = globalThis.__redlineTestRoot.querySelector('[data-redline-grip]').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + Math.min(300, width / 4), grip.y + 380, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    await shot(page, `${width}-10-dragged`);
    await q('[data-redline-pin]');
    await q('[data-redline-pin]');

    if (width === 1200) {
      const [download] = await Promise.all([page.waitForEvent('download'), q('[data-redline-action="download"]')]);
      const file = path.join(OUT, `${width}-11-demo-export.png`);
      await download.saveAs(file);
      written.push(file);
      await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'export done');
      await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-dock]').style.visibility = 'hidden'; });
      await shot(page, `${width}-12-demo-preview`);
      await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-dock]').style.visibility = ''; });
    }
  }
  console.log(`Wrote ${written.length} screenshots to ${OUT}`);
} catch (error) {
  const page = context.pages()[0];
  if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await context.close();
  server.close();
}
