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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  filter: src => !src.includes(`${path.sep}test`) && !src.includes(`${path.sep}.git`),
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

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
}

const shadow = () => document.querySelector('div[data-redline-extension]').shadowRoot;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1200, height: 800 },
  args: [
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
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

  check('shadow host mounted',
    await page.evaluate(() => document.querySelectorAll('div[data-redline-extension]').length) === 1);
  check('shadow root attached',
    await page.evaluate(() => !!document.querySelector('div[data-redline-extension]')?.shadowRoot));
  check('overlay dialog is open',
    await page.evaluate(() => document.querySelector('div[data-redline-extension]')
      .shadowRoot.querySelector('[data-redline-root]').open));
  check('page scroll locked while active',
    await page.evaluate(() => getComputedStyle(document.body).overflow === 'hidden'),
    await page.evaluate(() => getComputedStyle(document.body).overflow));

  const btn = await page.evaluate(() => {
    const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
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

  const marks = () => page.evaluate(() => document.querySelector('div[data-redline-extension]')
    .shadowRoot.querySelectorAll('[data-redline-id]').length);
  const clickAction = action => page.evaluate(name => document
    .querySelector('div[data-redline-extension]').shadowRoot
    .querySelector(`[data-redline-action="${name}"]`).click(), action);

  const box = await page.evaluate(() => {
    const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
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

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const afterUndo = await marks();
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  const afterRedo = await marks();
  check('redline undo and redo work', afterUndo === 2 && afterRedo === 3, `${afterUndo} then ${afterRedo}`);

  await page.keyboard.press('n');
  await page.mouse.click(box.x + 700, box.y + 250);
  await page.waitForTimeout(600);
  const noteDialog = await page.evaluate(() => {
    const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
    const d = sr.querySelector('dialog[data-redline-host-dialog]');
    return { inShadow: !!d, open: !!d?.open, inPage: !!document.querySelector('dialog[data-redline-host-dialog]') };
  });
  check('note dialog opens inside the shadow root',
    noteDialog.inShadow && noteDialog.open && !noteDialog.inPage, JSON.stringify(noteDialog));
  await page.keyboard.type('Contrast is too low here');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(400);
  check('note saved through the host dialog', await marks() === 4, `count=${await marks()}`);

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
  const editorValue = await page.evaluate(() => document.querySelector('div[data-redline-extension]')
    .shadowRoot.querySelector('[data-redline-text-editor]')?.value);
  check('tool-shortcut letters type into the text box instead of switching tools',
    editorValue === TYPED, JSON.stringify(editorValue));

  // Backspace inside the editor must edit text, not delete the selected mark.
  const marksDuringEdit = await marks();
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  const afterBackspace = await page.evaluate(() => document.querySelector('div[data-redline-extension]')
    .shadowRoot.querySelector('[data-redline-text-editor]')?.value);
  check('Backspace edits the text rather than deleting a mark',
    afterBackspace === TYPED.slice(0, -1) && await marks() === marksDuringEdit,
    JSON.stringify(afterBackspace));

  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(300);
  check('text box created', await marks() === 5, `count=${await marks()}`);

  await page.evaluate(() => document.querySelector('div[data-redline-extension]')
    .shadowRoot.querySelector('[data-redline-color]').click());
  await page.waitForTimeout(700);
  const color = await page.evaluate(() => {
    const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
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

  await page.evaluate(() => document.querySelector('div[data-redline-extension]')
    .shadowRoot.querySelector('[data-redline-toolbar] button').focus());
  const focusPath = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    focusPath.push(await page.evaluate(() => {
      const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
      const list = [...sr.querySelectorAll('[data-redline-toolbar] button:not(:disabled), [data-redline-toolbar] input:not([hidden]):not(:disabled)')];
      return list.indexOf(sr.activeElement);
    }));
  }
  check('Tab advances through the toolbar (patch 2)',
    focusPath[0] === 1 && focusPath[1] === 2 && focusPath[2] === 3, JSON.stringify(focusPath));

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
  check('JSON export carries every mark', exported.document?.annotations?.length === 5,
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
  const view = await page.evaluate(() => ({
    dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight,
  }));
  check('PNG capture succeeded with no share picker',
    png.subarray(1, 4).toString() === 'PNG' && pngWidth > 0);
  check('PNG matches the viewport at device pixel ratio',
    Math.abs(pngWidth - view.w * view.dpr) <= 2 && Math.abs(pngHeight - view.h * view.dpr) <= 2,
    `png=${pngWidth}x${pngHeight} expected=${view.w * view.dpr}x${view.h * view.dpr}`);
  check('overlay visibility restored after capture',
    await page.evaluate(() => document.querySelector('div[data-redline-extension]')
      .shadowRoot.querySelector('[data-redline-root]').style.visibility) !== 'hidden');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes the overlay',
    await page.evaluate(() => !document.querySelector('div[data-redline-extension]')
      .shadowRoot.querySelector('[data-redline-root]').open));
  check('page scroll restored on close',
    await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'));

  await inject();
  await page.waitForTimeout(800);
  check('reopen resumes the same session', await marks() === 5, `count=${await marks()}`);
  check('only one shadow host after re-injection',
    await page.evaluate(() => document.querySelectorAll('div[data-redline-extension]').length) === 1);

  await clickAction('clear');
  await page.waitForTimeout(600);
  check('clear asks for confirmation',
    await page.evaluate(() => !!document.querySelector('div[data-redline-extension]')
      .shadowRoot.querySelector('dialog[data-redline-host-dialog]')?.open));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('cancelled clear keeps the marks', await marks() === 5, `count=${await marks()}`);

  const badPath = path.join(SCRATCH, 'bad.json');
  await fs.writeFile(badPath, '{"format":"not-redline","annotations":"nope"}');
  await page.locator('input[type=file][aria-label="Import redline data"]').setInputFiles(badPath);
  await page.waitForTimeout(700);
  check('malformed import rejected without losing marks', await marks() === 5, `count=${await marks()}`);

  await page.locator('input[type=file][aria-label="Import redline data"]').setInputFiles(jsonPath);
  await page.waitForTimeout(900);
  check('JSON round-trip restores the marks', await marks() === 5, `count=${await marks()}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const bodyAfter = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('div[data-redline-extension]').forEach(n => n.remove());
    return clone.innerHTML;
  });
  check('page DOM unchanged apart from the overlay host', bodyAfter === bodyBefore);
  check('no leftover body attribute',
    await page.evaluate(() => !document.body.hasAttribute('data-redline-active')));

  await page.setViewportSize({ width: 420, height: 720 });
  await inject();
  await page.waitForTimeout(800);
  const narrow = await page.evaluate(() => {
    const sr = document.querySelector('div[data-redline-extension]').shadowRoot;
    const tb = sr.querySelector('[data-redline-toolbar]');
    return { w: Math.round(tb.getBoundingClientRect().width), inner: window.innerWidth };
  });
  check('toolbar fits a narrow viewport', narrow.w <= narrow.inner + 1, JSON.stringify(narrow));
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
