/**
 * Redline extension acceptance suite.
 *
 * Drives a real Chromium with the extension loaded. Static checks cannot cover
 * shadow-DOM isolation, tab capture, or the keyboard behaviour, so this suite
 * exercises all of them through the actual UI.
 *
 * Run with:  node test/run.mjs        (needs playwright installed)
 */
let chromium;
try {
  ({ chromium } = (await import('playwright')).default ?? await import('playwright'));
} catch {
  console.error('This suite needs Playwright. Install it with: npm i -D playwright');
  process.exit(2);
}
import { fileURLToPath } from 'node:url';
import { createOverlayAccess } from './browser-access.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(HERE);
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-test-'));

/**
 * Build a test copy of the extension.
 *
 * Playwright cannot click a toolbar icon or fire a browser command, so it
 * cannot trigger the activeTab grant that the shipped extension relies on.
 * The test copy asks for a broad host permission to stand in for that grant.
 * Nothing else differs, and the shipped manifest keeps activeTab.
 */
const EXT = path.join(SCRATCH, 'ext-test');
await fs.cp(SOURCE, EXT, {
  recursive: true,
  filter: src => !['test', '.git', '.chrome-redline-profile', 'node_modules', '.codestring'].some(name => path.relative(SOURCE, src).split(path.sep).includes(name)),
});
const manifestPath = path.join(EXT, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['<all_urls>'];
manifest.name = 'Redline (test build)';
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

// Content scripts and <all_urls> do not cover file:// without an explicit
// per-extension opt-in, so the fixture is served over http.
const fixtureHtml = await fs.readFile(path.join(HERE, 'fixture.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const FIXTURE = `http://127.0.0.1:${server.address().port}/fixture`;
// A URL carrying exactly the kind of secret that must not reach an export.
const SECRET = 'sk-live-do-not-export';
const FIXTURE_WITH_SECRET = `${FIXTURE}?token=${SECRET}#section-4`;

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + message);
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
}


const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  acceptDownloads: true,
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 2,
  args: [
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--force-device-scale-factor=2',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  check('service worker registered', !!worker);

  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [page error]', msg.text()); });
  page.on('pageerror', error => console.log('  [page exception]', error.message));
  await page.goto(FIXTURE_WITH_SECRET);
  await page.waitForTimeout(400);

  const pagePreference = JSON.stringify({ tool: 'eraser', color: '#00ff00' });
  await page.evaluate(value => localStorage.setItem('redline.preferences', value), pagePreference);
  const bodyBefore = await page.evaluate(() => document.body.innerHTML);

  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  const inject = () => worker.evaluate(async id => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
  }, tabId);

  await inject();
  await page.waitForTimeout(1200);
  let access = await createOverlayAccess(context, page);
  let { evaluate, importFile } = access;
  check('page cannot access the closed shadow root',
    await page.evaluate(() => document.querySelector('[data-redline-extension]').shadowRoot === null));
  check('page preferences cannot control extension tools',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').dataset.tool) === 'pen');

  check('shadow host mounted',
    await evaluate(() => document.querySelectorAll('div[data-redline-extension]').length) === 1);
  check('shadow root attached',
    await evaluate(() => !!globalThis.__redlineTestRoot));
  check('brush tool exists',
    await evaluate(() => !!globalThis.__redlineTestRoot
      .querySelector('[data-redline-tool="brush"]')));
  check('toolbar icons render inline',
    await evaluate(() => globalThis.__redlineTestRoot
      .querySelectorAll('[data-redline-tool] svg').length === 11));
  check('toolbar pin control toggles',
    await evaluate(() => {
      const toolbar = globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]');
      const pin = toolbar.querySelector('[data-redline-action="pin"]');
      pin.click();
      return toolbar.hasAttribute('data-pinned') && pin.getAttribute('aria-pressed') === 'true';
    }));
  const toolbarBeforeDrag = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const toolbar = sr.querySelector('[data-redline-toolbar]').getBoundingClientRect();
    const grip = sr.querySelector('[data-redline-grip]').getBoundingClientRect();
    return { toolbar: { x: toolbar.x, y: toolbar.y }, grip: { x: grip.x, y: grip.y, width: grip.width, height: grip.height } };
  });
  await page.mouse.move(toolbarBeforeDrag.grip.x + toolbarBeforeDrag.grip.width / 2, toolbarBeforeDrag.grip.y + toolbarBeforeDrag.grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(toolbarBeforeDrag.grip.x + 180, toolbarBeforeDrag.grip.y + 90, { steps: 4 });
  await page.mouse.up();
  const toolbarAfterDrag = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const toolbar = sr.querySelector('[data-redline-toolbar]');
    const rect = toolbar.getBoundingClientRect();
    return { x: rect.x, y: rect.y, pinned: toolbar.hasAttribute('data-pinned') };
  });
  check('toolbar grip moves the menu',
    toolbarAfterDrag.y > toolbarBeforeDrag.toolbar.y + 40
      && !toolbarAfterDrag.pinned,
    JSON.stringify({ before: toolbarBeforeDrag.toolbar, after: toolbarAfterDrag }));
  check('overlay dialog is open',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open));
  check('page scroll locked while active',
    await evaluate(() => getComputedStyle(document.body).overflow === 'hidden'),
    await evaluate(() => getComputedStyle(document.body).overflow));

  const btn = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const b = sr.querySelector('[data-redline-toolbar] button');
    const cs = getComputedStyle(b);
    return {
      fontSize: cs.fontSize, background: cs.backgroundColor,
      border: cs.borderTopStyle, box: cs.boxSizing,
    };
  });
  check('hostile page button styles do not leak',
    btn.fontSize !== '44px' && btn.border !== 'dashed' && !btn.background.includes('0, 255, 0'),
    JSON.stringify(btn));
  check('border-box survives the page content-box !important rule',
    btn.box === 'border-box', btn.box);

  const marks = () => evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-id]').length);
  const clickAction = action => evaluate(name => globalThis.__redlineTestRoot
    .querySelector(`[data-redline-action="${name}"]`).click(), action);

  const box = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const r = sr.querySelector('[data-redline-canvas]').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  await page.mouse.move(box.x + 120, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 120 + i * 18, box.y + 200 + i * 9);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('pen stroke creates a mark', await marks() === 1, `count=${await marks()}`);

  for (const key of ['a', 'r']) {
    await page.keyboard.press(key);
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 560, box.y + 400, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  check('arrow and rectangle draw', await marks() === 3, `count=${await marks()}`);

  await page.keyboard.press('l');
  await page.mouse.move(box.x + 650, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 760, box.y + 360, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check('line draws', await evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-type="line"]').length) === 1, `count=${await marks()}`);

  await evaluate(() => globalThis.__redlineTestRoot
    .querySelector('[data-redline-tool="polyline"]').click());
  for (const [x, y] of [[700, 450], [760, 410], [820, 470]]) await page.mouse.click(box.x + x, box.y + y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check('polyline draws', await evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-type="polyline"]').length) === 1, `count=${await marks()}`);

  await evaluate(() => globalThis.__redlineTestRoot
    .querySelector('[data-redline-tool="polygon"]').click());
  for (const [x, y] of [[900, 450], [960, 410], [1020, 450]]) await page.mouse.click(box.x + x, box.y + y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check('polygon draws', await evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-type="polygon"]').length) === 1, `count=${await marks()}`);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const afterUndo = await marks();
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  const afterRedo = await marks();
  check('redline undo and redo work', afterUndo === 5 && afterRedo === 6, `${afterUndo} then ${afterRedo}`);

  await page.keyboard.press('b');
  await page.mouse.move(box.x + 180, box.y + 500);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 520, { steps: 5 });
  const liveBrush = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const brush = sr.querySelector('[data-redline-type="brush"] polyline');
    return { count: sr.querySelectorAll('[data-redline-type="brush"]').length, points: brush?.getAttribute('points') ?? '' };
  });
  check('brush stroke previews while dragging', liveBrush.count === 1 && liveBrush.points.split(' ').length > 2, JSON.stringify(liveBrush));
  await page.mouse.up();
  await page.waitForTimeout(100);
  check('brush stroke commits on release', await marks() === 7, `count=${await marks()}`);
  check('brush cursor is active',
    await evaluate(() => getComputedStyle(globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]')).cursor.includes('url(')));
  await page.keyboard.press('e');
  await page.mouse.click(box.x + 240, box.y + 510);
  await page.waitForTimeout(100);
  check('eraser removes a nearby mark', await marks() === 6, `count=${await marks()}`);

  await page.keyboard.press('n');
  await page.mouse.click(box.x + 700, box.y + 250);
  await page.waitForTimeout(600);
  const noteDialog = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const d = sr.querySelector('dialog[data-redline-host-dialog]');
    return { inShadow: !!d, open: !!d?.open, inPage: !!document.querySelector('dialog[data-redline-host-dialog]') };
  });
  check('note dialog opens inside the shadow root',
    noteDialog.inShadow && noteDialog.open && !noteDialog.inPage, JSON.stringify(noteDialog));
  await page.keyboard.type('Contrast is too low here');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(400);
  check('note saved through the host dialog', await marks() === 7);
  check('page DOM cannot read annotation text', await page.evaluate(() =>
    !document.body.textContent.includes('Contrast is too low here')
    && document.querySelector('[data-redline-extension]').shadowRoot === null));

  await page.keyboard.press('t');
  await page.mouse.move(box.x + 200, box.y + 500);
  await page.mouse.down();
  await page.mouse.move(box.x + 480, box.y + 610, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  // Regression: every one of these letters is also a tool shortcut. With a
  // window-level key handler and a shadow root, event.target retargets to the
  // host, so an unguarded handler swallows them instead of typing them.
  const TYPED = 'Prevent another vapid rant';
  await page.keyboard.type(TYPED, { delay: 20 });
  await page.waitForTimeout(200);
  const editorValue = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]')?.value);
  check('tool-shortcut letters type into the text box instead of switching tools',
    editorValue === TYPED, JSON.stringify(editorValue));

  // Backspace inside the editor must edit text, not delete the selected mark.
  const marksDuringEdit = await marks();
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  const afterBackspace = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]')?.value);
  check('Backspace edits the text rather than deleting a mark',
    afterBackspace === TYPED.slice(0, -1) && await marks() === marksDuringEdit,
    JSON.stringify(afterBackspace));

  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(300);
  check('text box created', await marks() === 8, `count=${await marks()}`);

  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-color]').click());
  await page.waitForTimeout(700);
  const color = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const d = sr.querySelector('dialog[data-dialog="redline-color"]');
    return {
      inShadow: !!d, open: !!d?.open,
      inPage: !!document.querySelector('dialog[data-dialog="redline-color"]'),
      swatches: d?.querySelectorAll('[data-redline-picker] button[data-color]').length ?? 0,
      customInput: !!d?.querySelector('[data-redline-picker] input[type="color"]'),
      registry: globalThis.customElements === null ? 'null' : typeof customElements,
    };
  });
  check('color dialog mounts in the shadow root (patch 1)',
    color.inShadow && color.open && !color.inPage, JSON.stringify(color));
  check('replacement colour picker renders without a custom-element registry',
    color.swatches === 32 && color.customInput, JSON.stringify(color));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar] button').focus());
  const focusPath = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    focusPath.push(await evaluate(() => {
      const sr = globalThis.__redlineTestRoot;
      const list = [...sr.querySelectorAll('[data-redline-toolbar] button:not(:disabled), [data-redline-toolbar] input:not([hidden]):not(:disabled)')];
      return list.indexOf(sr.activeElement);
    }));
  }
  check('Tab advances through the toolbar (patch 2)',
    focusPath[0] === 1 && focusPath[1] === 2 && focusPath[2] === 3, JSON.stringify(focusPath));

  // Traverse actual controls, including the closed/open Paths menu and every select.
  await evaluate(() => {
    globalThis.__redlineTestRoot.querySelector('details').open = false;
    globalThis.__redlineTestRoot.querySelector('[data-redline-tool="textbox"]').focus();
  });
  const focusedControl = () => evaluate(() => {
    const element = globalThis.__redlineTestRoot.activeElement;
    return element?.getAttribute('aria-label') || element?.dataset.redlineTool
      || element?.dataset.redlineAction || element?.tagName;
  });
  const closedPath = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); closedPath.push(await focusedControl()); }
  check('Tab skips hidden paths and reaches all dropdowns', JSON.stringify(closedPath) === JSON.stringify([
    'SUMMARY', 'Annotation color', 'Line weight', 'Brush width', 'Brush opacity', 'Text box background',
  ]), JSON.stringify(closedPath));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab includes dropdowns', await focusedControl() === 'Brush opacity');
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('summary').focus());
  await page.keyboard.press('Enter');
  const openPath = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); openPath.push(await focusedControl()); }
  check('Paths menu opens by keyboard and its tools are reachable',
    JSON.stringify(openPath) === JSON.stringify(['polyline', 'polygon', 'eraser', 'Annotation color']), JSON.stringify(openPath));
  await evaluate(() => {
    globalThis.__redlineTestRoot.querySelector('details').open = false;
    globalThis.__redlineTestRoot.querySelector('[data-redline-grip]').focus();
  });
  await page.keyboard.press('Shift+Tab');
  check('reverse Tab wraps to Close', await focusedControl() === 'close');
  await page.keyboard.press('Tab');
  check('forward Tab wraps to the first control', await focusedControl() === 'Move toolbar');

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    clickAction('json'),
  ]);
  const jsonPath = path.join(SCRATCH, 'export.json');
  await jsonDownload.saveAs(jsonPath);
  const exported = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  check('JSON export uses open-redline v1',
    exported.format === 'open-redline' && exported.version === 1,
    `${exported.format} v${exported.version}`);
  check('JSON export carries every mark', exported.document?.annotations?.length === 8,
    `n=${exported.document?.annotations?.length}`);
  const serialised = JSON.stringify(exported);
  check('export never contains the URL secret', !serialised.includes(SECRET));
  check('page.url is redacted to origin and path',
    exported.page?.url === FIXTURE && !exported.page.url.includes('?') && !exported.page.url.includes('#'),
    exported.page?.url);
  check('export flags that the URL was redacted', exported.context?.urlRedacted === true,
    JSON.stringify(exported.context));

  const [pngDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 40000 }),
    clickAction('download'),
  ]);
  const pngPath = path.join(SCRATCH, 'export.png');
  await pngDownload.saveAs(pngPath);
  const png = await fs.readFile(pngPath);
  const pngWidth = png.readUInt32BE(16);
  const pngHeight = png.readUInt32BE(20);
  const view = await evaluate(() => ({
    dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight,
  }));
  check('PNG capture succeeded with no share picker',
    png.subarray(1, 4).toString() === 'PNG' && pngWidth > 0);
  check('PNG matches the viewport at device pixel ratio',
    Math.abs(pngWidth - view.w * view.dpr) <= 2 && Math.abs(pngHeight - view.h * view.dpr) <= 2,
    `png=${pngWidth}x${pngHeight} expected=${view.w * view.dpr}x${view.h * view.dpr}`);
  check('overlay visibility restored after capture',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').style.visibility) !== 'hidden');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes the overlay',
    await evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open));
  check('page scroll restored on close',
    await evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'));

  await inject();
  await page.waitForTimeout(800);
  check('reopen resumes the same session', await marks() === 8, `count=${await marks()}`);
  check('only one shadow host after re-injection',
    await evaluate(() => document.querySelectorAll('div[data-redline-extension]').length) === 1);

  await clickAction('clear');
  await page.waitForTimeout(600);
  check('clear asks for confirmation',
    await evaluate(() => !!globalThis.__redlineTestRoot.querySelector('dialog[data-redline-host-dialog]')?.open));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('cancelled clear keeps the marks', await marks() === 8, `count=${await marks()}`);

  const badPath = path.join(SCRATCH, 'bad.json');
  await fs.writeFile(badPath, '{"format":"not-redline","annotations":"nope"}');
  await importFile(badPath);
  await page.waitForTimeout(700);
  check('malformed import rejected without losing marks', await marks() === 8, `count=${await marks()}`);

  const invalidDocumentPath = path.join(SCRATCH, 'invalid-document.json');
  await fs.writeFile(invalidDocumentPath, JSON.stringify({
    format: 'open-redline', version: 1, createdAt: 'must-not-replace-session',
    document: { width: 10, height: 10, annotations: [{ type: 'unsupported' }] },
  }));
  await importFile(invalidDocumentPath);
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent.includes('Unsupported')), 'invalid document rejected');
  const [afterRejectedDownload] = await Promise.all([page.waitForEvent('download'), clickAction('json')]);
  const afterRejectedPath = path.join(SCRATCH, 'after-rejected.json');
  await afterRejectedDownload.saveAs(afterRejectedPath);
  const afterRejected = JSON.parse(await fs.readFile(afterRejectedPath, 'utf8'));
  check('rejected inner document preserves dimensions, annotations and session',
    JSON.stringify(afterRejected.document) === JSON.stringify(exported.document)
    && afterRejected.createdAt === exported.createdAt);

  await importFile(jsonPath);
  await page.waitForTimeout(900);
  check('JSON round-trip restores the marks', await marks() === 8, `count=${await marks()}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const bodyAfter = await evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('div[data-redline-extension]').forEach(n => n.remove());
    return clone.innerHTML;
  });
  check('page DOM unchanged apart from the overlay host', bodyAfter === bodyBefore);
  check('no leftover body attribute',
    await evaluate(() => !document.body.hasAttribute('data-redline-active')));

  await page.setViewportSize({ width: 420, height: 720 });
  await inject();
  await page.waitForTimeout(800);
  const narrow = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const tb = sr.querySelector('[data-redline-toolbar]');
    return { w: Math.round(tb.getBoundingClientRect().width), inner: window.innerWidth };
  });
  check('toolbar fits a narrow viewport', narrow.w <= narrow.inner + 1, JSON.stringify(narrow));

  // Start a differently sized imported document and draw after changing aspect ratio.
  const resizePath = path.join(SCRATCH, 'resize.json');
  await fs.writeFile(resizePath, JSON.stringify({ format: 'open-redline', version: 1,
    document: { width: 1000, height: 500, annotations: [] } }));
  await importFile(resizePath);
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').getAttribute('viewBox') === '0 0 1000 500'), 'imported viewport applied');
  check('import updates the SVG coordinate system', await marks() === 0);
  await page.setViewportSize({ width: 600, height: 800 });
  await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const width = sr.querySelector('select[aria-label="Line weight"]');
    width.value = '8';
    width.dispatchEvent(new Event('change'));
    sr.querySelector('[data-redline-tool="line"]').click();
  });
  await clickAction('color');
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'color dialog opened');
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('button[data-color="#dc2626"]').click());
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'color applied');
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 4 });
  await page.mouse.up();
  const resizedLine = await evaluate(() => {
    const line = globalThis.__redlineTestRoot.querySelector('[data-redline-type="line"] line');
    const matrix = line.getScreenCTM();
    const start = new DOMPoint(+line.getAttribute('x1'), +line.getAttribute('y1')).matrixTransform(matrix);
    const end = new DOMPoint(+line.getAttribute('x2'), +line.getAttribute('y2')).matrixTransform(matrix);
    return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
  });
  check('resized drawing follows the pointer at both endpoints',
    Math.abs(resizedLine.start.x - 200) < 1 && Math.abs(resizedLine.start.y - 300) < 1
    && Math.abs(resizedLine.end.x - 400) < 1 && Math.abs(resizedLine.end.y - 300) < 1,
    JSON.stringify(resizedLine));
  const [resizedDownload] = await Promise.all([page.waitForEvent('download'), clickAction('download')]);
  const resizedPngPath = path.join(SCRATCH, 'resized.png');
  await resizedDownload.saveAs(resizedPngPath);
  const pixel = await evaluate(async base64 => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(Math.round(300 * image.width / innerWidth), Math.round(300 * image.height / innerHeight), 1, 1).data];
  }, (await fs.readFile(resizedPngPath)).toString('base64'));
  check('PNG paints the resized stroke at the same screen location',
    Math.abs(pixel[0] - 220) < 5 && Math.abs(pixel[1] - 38) < 5 && Math.abs(pixel[2] - 38) < 5, JSON.stringify(pixel));

  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]').hasAttribute('data-busy')), 'export finished');
  await page.keyboard.press('t');
  check('keyboard shortcuts still work after PNG export',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').dataset.tool) === 'textbox');
  await page.mouse.move(100, 500); await page.mouse.down();
  await page.mouse.move(350, 650, { steps: 4 }); await page.mouse.up();
  const editorBounds = await evaluate(() => {
    const rect = globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  check('text editor aligns with the resized drawing surface',
    Math.abs(editorBounds.x - 100) < 1 && Math.abs(editorBounds.y - 500) < 1
    && Math.abs(editorBounds.width - 250) < 1 && Math.abs(editorBounds.height - 150) < 1, JSON.stringify(editorBounds));
  await page.keyboard.type('Private test text');
  await page.keyboard.press('Control+Enter');
  check('text editing still saves inside a closed shadow root after resize', await marks() === 2);

  check('website storage remains untouched', await page.evaluate(() => localStorage.getItem('redline.preferences')) === pagePreference);
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-tool="pen"]').click());
  await waitUntil(async () => {
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('redline.preferences'))['redline.preferences']);
    return saved?.tool === 'pen' && saved?.color === '#dc2626' && saved?.width === 8;
  }, 'preferences saved to extension storage');
  check('preferences persist in extension storage', true);
  await access.dispose();
  await page.goto(FIXTURE.replace('127.0.0.1', 'localhost'));
  await inject();
  await page.waitForTimeout(800);
  access = await createOverlayAccess(context, page);
  ({ evaluate, importFile } = access);
  const restored = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    return { tool: sr.querySelector('[data-redline-canvas]').dataset.tool,
      color: sr.querySelector('[data-redline-color]').title,
      width: sr.querySelector('select[aria-label="Line weight"]').value };
  });
  check('preferences restore on another website', restored.tool === 'pen' && restored.color.includes('#dc2626') && restored.width === '8', JSON.stringify(restored));
  check('another website gets no Redline storage entry', await page.evaluate(() => localStorage.getItem('redline.preferences')) === null);
  check('closed shadow isolation survives navigation', await page.evaluate(() => document.querySelector('[data-redline-extension]').shadowRoot === null));
  await access.dispose();
} catch (error) {
  check('test run completed without an unhandled error', false, error.message);
  console.error(error);
} finally {
  await context.close().catch(() => {});
  server.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('Failed: ' + failed.map(f => f.name).join('; '));
  process.exit(failed.length ? 1 : 0);
}
