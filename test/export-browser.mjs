/**
 * Pointer proxy, Copy report and its clipboard fallbacks,
 * export preview, capture tab isolation, narrow layouts and privacy, through
 * real pointer and keyboard input at DPR 2 and DPR 1.
 *
 *   node test/export-browser.mjs [--headed]
 *
 * Clipboard checks use headless Chromium's own clipboard (read back in the page
 * world with granted permissions) and a page served with
 * `Permissions-Policy: clipboard-write=()` for the refusal path. They do not
 * touch or verify the operating-system clipboard, and no paste into another
 * application is attempted.
 *
 * The capture race tests delay chrome.tabs.captureVisibleTab inside the test
 * build's service worker (from the test, at run time) so a tab switch or
 * navigation can land deterministically mid-capture; production code gains no
 * hook. Tabs are activated with chrome.tabs.update, a real browser tab switch.
 * Screenshots go to test-artifacts/export.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';
import {
  EXPLANATION, activate, bullet, dark, helpers, html, near, setCaptureDelay, tabIdFor, white,
} from './ui-helpers.mjs';

const SHOTS = path.join('test-artifacts', 'export');
await fs.mkdir(SHOTS, { recursive: true });
const { results, check } = createChecker();

const { server, origin } = await startServer({
  '/work': html('Checkout &lt;b&gt; &amp; "report"', '#FFFFFF',
    '<button id="page-button" style="position:absolute;left:240px;top:520px;width:160px;height:40px">Page button</button>'),
  '/tab-a': html('Tab A', 'rgb(220, 40, 40)'),
  '/tab-b': html('Tab B', 'rgb(30, 80, 220)'),
  '/blocked': { body: html('Blocked clipboard', '#FFFFFF'), headers: { 'Permissions-Policy': 'clipboard-write=()' } },
});
const SECRET = 'sk-phase3-secret';

async function run(dpr, { full }) {
  const tag = `[DPR ${dpr}]`;
  const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr });
  const errors = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.goto(`${origin}/work?token=${SECRET}#section-9`);
    await page.evaluate(() => {
      const seen = globalThis.__pageSeen = { nodes: [], details: [], urls: [] };
      for (const type of ['input', 'change', 'copy', 'paste', 'redline:changed', 'message']) {
        window.addEventListener(type, event => {
          const detail = event.detail ?? event.data;
          if (detail !== undefined && detail !== null && typeof detail !== 'number') seen.details.push(String(JSON.stringify(detail)).slice(0, 200));
        }, true);
      }
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && !node.matches('[data-redline-extension]')) seen.nodes.push(node.outerHTML.slice(0, 80));
          }
          if (record.type === 'attributes' && /blob:|data:/.test(record.target.getAttribute?.(record.attributeName) ?? '')) seen.urls.push(record.attributeName);
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    const access = await openRedline({ context, worker, page });
    const h = helpers({ page, access, scratch });
    const { evaluate } = access;
    await page.bringToFront();

    // -----------------------------------------------------------------------
    // Pointer proxy: off by default, keyboard placement, pixels and hotspot
    check(`${tag} Include cursor is off by default and the document has no cursor`,
      await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-cursor-toggle]').getAttribute('aria-pressed')) === 'false'
      && !('cursor' in (await h.exportJSON()).document) && await h.cursorAt() === null);

    // Regression: a colour dialog's close event
    // arrives a task later and used to cancel a request reopened before it ran.
    await h.click('[data-redline-tool="rectangle"]');
    await h.click('[data-redline-color="stroke"]');
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette open');
    const reopened = await evaluate(async () => {
      const root = globalThis.__redlineTestRoot;
      root.querySelector('[data-redline-picker] [data-preset="issue"]').click();
      root.querySelector('[data-redline-color="stroke"]').click();
      await new Promise(resolve => setTimeout(resolve, 300));
      return root.querySelector('[data-dialog="redline-color"]').open;
    });
    check(`${tag} a palette reopened right after a pick stays open (stale close event ignored)`, reopened);
    await page.keyboard.press('Escape');
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette closed');
    await h.click('[data-redline-tool="pen"]');

    await h.menuByKeyboard('cursorToggle');
    const placing = { target: await h.target(), cursor: await h.cursorAt(), active: await h.active() };
    check(`${tag} with no known pointer position, Include cursor asks for placement at the centre`,
      placing.target === 'Placing pointer' && placing.cursor?.x === 600 && placing.cursor?.y === 400, JSON.stringify(placing));
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const placed = { target: await h.target(), cursor: await h.cursorAt(), active: await h.active(),
      checked: await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-cursor-toggle]').getAttribute('aria-pressed')) };
    check(`${tag} keyboard placement: arrows move screen pixels, Enter finishes and focus returns to Include cursor`,
      placed.target === 'Pointer' && placed.cursor.x === 700 && placed.cursor.y === 405 && placed.checked === 'true'
      && placed.active === 'cursorToggle', JSON.stringify(placed));
    if (full) await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-pointer-selected.png`) });

    const pointerPng = await h.exportPNG();
    if (full) await fs.writeFile(path.join(SHOTS, `dpr${dpr}-export-pointer.png`), pointerPng);
    const tip = await h.pixels(pointerPng, [[(700 + 3) * dpr, (405 + 9) * dpr], [(700 - 6) * dpr, (405 - 6) * dpr], [(700 + 5) * dpr, (405 + 7) * dpr], [(700 + 12) * dpr, (405 + 4) * dpr]]);
    check(`${tag} the PNG draws a dark arrow whose tip is the hotspot, with page pixels beside it`,
      tip.width === 1200 * dpr && dark(tip.samples[0]) && white(tip.samples[1]) && dark(tip.samples[2]) && white(tip.samples[3]),
      JSON.stringify(tip));
    const json = await h.exportJSON();
    if (full) await fs.writeFile(path.join(SHOTS, 'export-with-pointer.json'), JSON.stringify(json, null, 2));
    check(`${tag} JSON records the pointer as a document export setting`,
      JSON.stringify(json.document.cursor) === JSON.stringify({ visible: true, x: 700, y: 405 }));
    check(`${tag} the proxy selection frame and placement are not in the PNG`,
      white((await h.pixels(pointerPng, [[(700 - 4) * dpr, (405 + 25) * dpr]])).samples[0]));

    // Dragging with Select
    await page.keyboard.press('v');
    await page.mouse.move(704, 416);
    await page.mouse.down();
    await page.mouse.move(804, 466, { steps: 6 });
    await page.mouse.up();
    const dragged = await h.cursorAt();
    check(`${tag} dragging the proxy moves its hotspot exactly`, near(dragged.x, 800) && near(dragged.y, 455), JSON.stringify(dragged));
    check(`${tag} a dragged pointer is frozen`, await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-cursor-follow]').getAttribute('aria-pressed')) === 'false');

    // Follow, then move the real mouse to Copy image
    await h.press('[data-redline-cursor-follow]');
    check(`${tag} Follow can be switched on`, await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-cursor-follow]').getAttribute('aria-pressed')) === 'true');
    await page.keyboard.press('r');
    await page.mouse.move(300, 610, { steps: 4 });
    await page.mouse.down();
    await page.mouse.move(420, 690, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const followed = await h.cursorAt();
    check(`${tag} a following pointer moves to where the mouse pressed and then rested`, near(followed.x, 420, 1) && near(followed.y, 690, 1), JSON.stringify(followed));
    const copy = await h.rect('[data-redline-strip-section="capture"] [data-redline-action="copy"]');
    await page.mouse.move(copy.x + copy.width / 2, copy.y + copy.height / 2, { steps: 30 });
    await page.waitForTimeout(900);
    const afterHover = await h.cursorAt();
    check(`${tag} moving the real mouse to Copy image and resting there does not move the pointer`,
      near(afterHover.x, 420, 1) && near(afterHover.y, 690, 1), JSON.stringify({ afterHover, copy }));
    const copied = await Promise.all([
      page.waitForEvent('download', { timeout: 4000 }).catch(() => null),
      page.mouse.click(copy.x + copy.width / 2, copy.y + copy.height / 2),
    ]).then(([file]) => file);
    await h.idle();
    const afterCopy = await h.cursorAt();
    let copiedPixels = null;
    if (!copied) {
      copiedPixels = await page.evaluate(async ({ x, y }) => {
        const [item] = await navigator.clipboard.read();
        const blob = await item.getType('image/png');
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return [...ctx.getImageData(x, y, 1, 1).data];
      }, { x: (420 + 3) * dpr, y: (690 + 9) * dpr });
    }
    check(`${tag} clicking Copy image leaves the pointer in place, and the copied image shows it there`,
      near(afterCopy.x, 420, 1) && near(afterCopy.y, 690, 1) && (copied || dark(copiedPixels)) && /copied/.test(await h.message()),
      JSON.stringify({ afterCopy, copiedPixels, downloaded: Boolean(copied), message: await h.message() }));
    // Select the proxy (which freezes it); later presses no longer move it.
    await page.keyboard.press('v');
    await page.mouse.click(424, 700);
    const frozen = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-cursor-follow]').getAttribute('aria-pressed'));
    await page.keyboard.press('p');
    await page.mouse.move(900, 600);
    await page.mouse.down();
    await page.mouse.move(980, 640, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const stillFrozen = await h.cursorAt();
    check(`${tag} selecting the pointer freezes it, so later drawing does not move it`,
      frozen === 'false' && near(stillFrozen.x, 420, 1) && near(stillFrozen.y, 690, 1), JSON.stringify({ frozen, stillFrozen }));

    // Initialise from a pause over the page in Browse mode, ignoring a pause on the toolbar.
    await h.load({ width: 1200, height: 800, annotations: [] }, 'fresh');
    await page.keyboard.press('F2');
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-page-mode')), 'browse mode');
    await page.mouse.move(320, 540, { steps: 8 });
    await page.waitForTimeout(800);
    const grip = await h.rect('[data-redline-grip]');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 20 });
    await page.waitForTimeout(800);
    await page.keyboard.press('F2');
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-page-mode')), 'annotate mode');
    await h.menuByKeyboard('cursorToggle');
    const initial = { cursor: await h.cursorAt(), message: await h.message(), target: await h.target() };
    check(`${tag} Include cursor starts where the pointer last paused over the page, not over the toolbar`,
      near(initial.cursor?.x, 320, 1) && near(initial.cursor?.y, 540, 1) && /paused/.test(initial.message) && initial.target === 'Pointer',
      JSON.stringify(initial));

    // Crop, 200% output and a nonuniform resize.
    await h.load({
      width: 1200, height: 800, annotations: [], crop: { x: 400, y: 200, width: 400, height: 300 }, outputScale: 2,
      cursor: { visible: true, x: 500, y: 300 },
    }, 'crop');
    const cropped = await h.exportPNG();
    const scale = dpr * 2;
    const cropTip = await h.pixels(cropped, [[(100 + 3) * scale, (100 + 9) * scale], [(100 - 6) * scale, (100 - 6) * scale]]);
    check(`${tag} crop and 200% output place and scale the pointer like the marks`,
      cropTip.width === 400 * scale && cropTip.height === 300 * scale && dark(cropTip.samples[0]) && white(cropTip.samples[1]), JSON.stringify(cropTip));
    await page.setViewportSize({ width: 900, height: 800 });
    await waitUntil(async () => near((await h.cursorAt())?.screenX ?? 0, 375, 1), 'pointer layer follows the resize');
    const resizedCursor = await h.cursorAt();
    const resizedPng = await h.exportPNG();
    const sx = 900 * dpr / 1200 * 2;
    const sy = 800 * dpr / 800 * 2;
    const resizedTip = await h.pixels(resizedPng, [[(100 + 4) * sx, (100 + 10) * sy], [(100 - 8) * sx, (100 - 6) * sy]]);
    check(`${tag} after a nonuniform resize the live proxy and PNG keep the same hotspot`,
      near(resizedCursor.screenX, 375, 1) && near(resizedCursor.screenY, 300, 1)
      && resizedTip.width === Math.round(400 * sx) && dark(resizedTip.samples[0]) && white(resizedTip.samples[1]), JSON.stringify({ resizedCursor, resizedTip }));
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(200);

    // Round trip, atomic rejection, and exclusion when disabled.
    const beforeInvalid = (await h.exportJSON()).document;
    const rejected = await h.load({ width: 1200, height: 800, annotations: [], cursor: { visible: 'yes', x: 1, y: 1 } }, 'bad-cursor');
    const afterInvalid = (await h.exportJSON()).document;
    check(`${tag} an invalid cursor rejects the whole import and keeps the current document`,
      /cursor\.visible/.test(rejected) && JSON.stringify(afterInvalid) === JSON.stringify(beforeInvalid), rejected);
    await h.load({ width: 1200, height: 800, annotations: [], cursor: { visible: true, x: 650, y: 350 } }, 'visible');
    await page.keyboard.press('v');
    await page.mouse.click(654, 362);
    await page.keyboard.press('Delete');
    const removed = await h.exportPNG();
    const removedJson = (await h.exportJSON()).document.cursor;
    check(`${tag} Delete leaves the selected pointer out of exports but keeps its position`,
      white((await h.pixels(removed, [[(650 + 3) * dpr, (350 + 9) * dpr]])).samples[0])
      && JSON.stringify(removedJson) === JSON.stringify({ visible: false, x: 650, y: 350 }), JSON.stringify(removedJson));

    // -----------------------------------------------------------------------
    // Export preview: exact crop, legend and pointer; no editing chrome; focus
    const previewDoc = {
      width: 1200, height: 800,
      legend: { visible: true, x: 760, y: 160, width: 300, fontSize: 14 },
      crop: { x: 100, y: 120, width: 1000, height: 600 },
      cursor: { visible: true, x: 520, y: 420 },
      annotations: [
        { id: 'rect', type: 'rectangle', color: '#16A34A', fill: '#FDE68A', fillOpacity: 0.5, width: 2.667, start: { x: 200, y: 260 }, end: { x: 460, y: 420 } },
        bullet('b1', '1', 300, 300, 'Total is wrong'),
        bullet('bA', 'A', 400, 380, 'Lettered note'),
      ],
    };
    await h.load(previewDoc, 'preview');
    await h.press('[data-redline-pin]');
    const dockBefore = await h.rect('[data-redline-dock]');
    // Show editing chrome on screen: an explanation edited with a selection, then
    // the selected bullet's legend with its resize handles.
    await page.keyboard.press('v');
    await page.mouse.dblclick(300, 300);
    await page.keyboard.press('Shift+Home');
    const editing = await evaluate(() => {
      const input = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-input]');
      return { focused: globalThis.__redlineTestRoot.activeElement === input, selected: input.selectionEnd - input.selectionStart };
    });
    await page.keyboard.press('Control+Enter');
    await page.mouse.click(300, 300);
    await h.press('[data-redline-legend-options]');
    // The bluest pixel across the handle's left edge (antialiasing differs by pixel ratio).
    const handleOnScreen = await evaluate(({ dpr }) => {
      const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
      const row = canvas.getContext('2d').getImageData(Math.floor(753 * dpr), Math.round(160 * dpr), Math.ceil(5 * dpr), 1).data;
      let best = [0, 0, 0, 0];
      const blueness = pixel => (pixel[2] - pixel[0]) * pixel[3];
      for (let i = 0; i < row.length; i += 4) if (blueness(row.slice(i, i + 4)) > blueness(best)) best = [...row.slice(i, i + 4)];
      return best;
    }, { dpr });
    check(`${tag} editing chrome was on screen before previewing: a text selection, then legend resize handles`,
      editing.focused && editing.selected > 0 && handleOnScreen[3] > 200 && handleOnScreen[2] > handleOnScreen[0] + 60, JSON.stringify({ editing, handleOnScreen }));
    await h.menuByKeyboard('preview');
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]')?.open), 'preview open', 20000);
    const preview = await evaluate(() => {
      const dialog = globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]');
      const canvas = dialog.querySelector('canvas');
      const box = dialog.getBoundingClientRect();
      return { summary: dialog.querySelector('[data-redline-preview-summary]').textContent, width: canvas.width, height: canvas.height,
        warnings: dialog.querySelector('[data-redline-preview-warnings]').textContent, focus: globalThis.__redlineTestRoot.activeElement?.dataset.previewAction,
        inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, cursorBox: dialog.querySelector('input[type=checkbox]').checked };
    });
    check(`${tag} the preview shows the actual crop, output size, legend and pointer`,
      preview.width === 1000 * dpr && preview.height === 600 * dpr && preview.summary.includes(`${1000 * dpr} × ${600 * dpr} PNG`)
      && /crop 1000 × 600 CSS px/.test(preview.summary) && /legend with 2 explanations/.test(preview.summary) && /pointer included/.test(preview.summary)
      && preview.cursorBox && preview.focus === 'copy' && preview.inside, JSON.stringify(preview));
    if (full) await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-export-preview.png`) });
    const previewDigest = await h.canvasDigest('dialog[data-redline-preview] canvas');
    const fromPreview = await h.download(() => h.press('dialog[data-redline-preview] [data-preview-action="download"]'));
    await fs.writeFile(path.join(SHOTS, `dpr${dpr}-export-from-preview.png`), fromPreview.buffer);
    check(`${tag} Download from the preview is pixel-identical to the preview`, await h.imageDigest(fromPreview.buffer) === previewDigest);
    await h.press('dialog[data-redline-preview] input[type=checkbox]');
    const withoutCursor = await evaluate(() => {
      const canvas = globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview] canvas');
      return { summary: globalThis.__redlineTestRoot.querySelector('[data-redline-preview-summary]').textContent };
    });
    const toggledDigest = await h.canvasDigest('dialog[data-redline-preview] canvas');
    check(`${tag} Include cursor in the preview recomposes the same capture without the pointer`,
      toggledDigest !== previewDigest && /no pointer/.test(withoutCursor.summary), JSON.stringify(withoutCursor));
    await h.press('dialog[data-redline-preview] input[type=checkbox]');
    check(`${tag} turning it back on restores the identical image`, await h.canvasDigest('dialog[data-redline-preview] canvas') === previewDigest);
    await page.keyboard.press('Escape');
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]').open), 'preview closed');
    const closed = { active: await h.active(), dock: await h.rect('[data-redline-dock]'),
      pinned: await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-dock]').hasAttribute('data-pinned')) };
    check(`${tag} closing the preview returns focus and leaves toolbar placement and pinning alone`,
      closed.active === 'preview' && closed.pinned && near(closed.dock.x, dockBefore.x, 0.5) && near(closed.dock.y, dockBefore.y, 0.5), JSON.stringify(closed));
    const regular = await h.exportPNG();
    const handleInPng = (await h.pixels(regular, [[(760 - 4.4 - 100) * dpr, (160 - 120) * dpr]])).samples[0];
    check(`${tag} preview/export parity: the ordinary PNG matches the previewed pixels, and neither shows the handles`,
      await h.imageDigest(regular) === previewDigest && white(handleInPng), JSON.stringify(handleInPng));
    const savedText = (await h.exportJSON()).document.annotations.find(mark => mark.id === 'b1').text;
    check(`${tag} the explanation that was open is saved unchanged`, savedText === 'Total is wrong', savedText);

    if (full) {
      // ---------------------------------------------------------------------
      // Copy report: combined clipboard item, explicit fallback, blocked clipboard
      await h.load({
        width: 1200, height: 800,
        annotations: [
          bullet('r1', '1', 300, 300, EXPLANATION), bullet('r2', '2', 360, 340), bullet('rA', 'A', 420, 380, 'Lettered explanation'),
          { id: 'n10', type: 'note', color: '#B65D66', width: 1.333, point: { x: 600, y: 600 }, text: 'Legacy note text', number: 10 },
        ],
      }, 'report');
      await page.bringToFront();
      const reportButton = await h.rect('[data-redline-strip-section="capture"] [data-redline-action="report"]');
      check(`${tag} Copy report is visible with Copy image in Capture at 1200 px`, reportButton?.visible && reportButton.width > 0, JSON.stringify(reportButton));
      const downloads = [];
      const onDownload = file => downloads.push(file.suggestedFilename());
      page.on('download', onDownload);
      await h.press('[data-redline-strip-section="capture"] [data-redline-action="report"]');
      await h.idle();
      await page.waitForTimeout(400);
      const clip = await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        const text = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : null;
        const markup = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : null;
        let image = null;
        if (item.types.includes('image/png')) {
          const bitmap = await createImageBitmap(await item.getType('image/png'));
          image = [bitmap.width, bitmap.height];
        }
        return { types: item.types, text: text?.replace(/\r\n/g, '\n'), html: markup, image };
      });
      const reportMessage = await h.message();
      await fs.writeFile(path.join(SHOTS, 'report-clipboard.txt'), clip.text ?? '');
      await fs.writeFile(path.join(SHOTS, 'report-clipboard.html'), clip.html ?? '');
      await fs.writeFile(path.join(SHOTS, 'report-clipboard-status.txt'), `${JSON.stringify(clip.types)}\n${reportMessage}\n`);
      check(`${tag} Copy report puts screenshot, HTML and plain text in one clipboard item and says so`,
        clip.types.includes('image/png') && clip.types.includes('text/html') && clip.types.includes('text/plain')
        && clip.image?.[0] === 1200 * dpr && /^Report copied: the screenshot and 3 explanations and 1 note together/.test(reportMessage) && downloads.length === 0,
        JSON.stringify({ types: clip.types, image: clip.image, reportMessage, downloads }));
      check(`${tag} report text keeps the page title, redacted URL and every label with its full explanation`,
        clip.text.includes('Page: Checkout <b> & "report"') && clip.text.includes(`URL: ${origin}/work (query string and fragment removed)`)
        && clip.text.includes('\n1  Hostile <script>alert("x")</script> & \'quotes\'\n     second line keeps spaces  \n   \n   after a blank line\n')
        && clip.text.includes('\n2  (no explanation)\n') && clip.text.includes('\nA  Lettered explanation\n') && clip.text.includes('\nNote 10:  Legacy note text\n')
        && !clip.text.includes(SECRET) && !clip.text.includes('section-9'), clip.text);
      check(`${tag} report text says the explanations are included while the legend is hidden on the image`,
        clip.text.includes('The legend is hidden on the image; the explanations below are included as text only.'));
      // Chromium sanitises and re-serialises clipboard HTML, so check what it parses to.
      const parsed = await page.evaluate(markup => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        const spans = [...doc.querySelectorAll('span')];
        return {
          elements: [...doc.body.querySelectorAll('*')].map(node => node.localName).filter(name => !['div', 'h2', 'h3', 'p', 'strong', 'br', 'em', 'span', 'img'].includes(name)),
          script: doc.querySelectorAll('script, b').length,
          explanation: spans.map(span => span.textContent).find(text => text.startsWith('Hostile')) ?? null,
          preWrap: spans.some(span => /pre-wrap/.test(span.getAttribute('style') ?? '')),
          title: doc.querySelector('p')?.textContent ?? '',
          image: doc.querySelector('img')?.getAttribute('src')?.slice(0, 22) ?? null,
          raw: markup.includes('<script'),
        };
      }, clip.html);
      check(`${tag} report HTML escapes page and annotation text, keeps whitespace and embeds the PNG`,
        parsed.script === 0 && !parsed.raw && parsed.elements.length === 0 && parsed.explanation === EXPLANATION && parsed.preWrap
        && parsed.title.includes('Page: Checkout <b> & "report"') && parsed.image === 'data:image/png;base64,' && !clip.html.includes(SECRET),
        JSON.stringify(parsed));

      const fallback = await h.download(() => h.menuByKeyboard('reportFallback'));
      await page.waitForTimeout(300);
      const fallbackClip = await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        return { types: item.types, text: (await (await item.getType('text/plain')).text()).replace(/\r\n/g, '\n') };
      });
      const fallbackMessage = await h.message();
      await fs.writeFile(path.join(SHOTS, 'report-fallback-clipboard.txt'), `${fallbackClip.text}\n--- status ---\n${fallbackMessage}\n`);
      check(`${tag} Copy report text + download PNG copies text naming the downloaded file, and reports exactly that`,
        fallback.buffer.subarray(1, 4).toString() === 'PNG' && !fallbackClip.types.includes('image/png')
        && fallbackClip.text.includes(`saved separately as ${fallback.name}`) && fallbackClip.text.includes('A  Lettered explanation')
        && fallbackMessage === `Report text copied; screenshot downloaded as ${fallback.name}.`, JSON.stringify({ types: fallbackClip.types, fallbackMessage, name: fallback.name }));
      page.off('download', onDownload);

      // A page whose Permissions-Policy blocks the clipboard.
      const blocked = await context.newPage();
      await blocked.goto(`${origin}/blocked`);
      const blockedAccess = await openRedline({ context, worker, page: blocked });
      const b = helpers({ page: blocked, access: blockedAccess, scratch });
      await b.load({ width: 1200, height: 800, annotations: [bullet('x1', '1', 300, 300, 'Explained on a blocked page')] }, 'blocked');
      const blockedFiles = [];
      blocked.on('download', file => blockedFiles.push(file));
      await b.press('[data-redline-strip-section="capture"] [data-redline-action="report"]');
      await b.idle();
      await waitUntil(() => blockedFiles.length >= 2, 'fallback downloads', 10000);
      const textFile = blockedFiles.find(file => file.suggestedFilename().endsWith('-report.txt'));
      const pngFile = blockedFiles.find(file => file.suggestedFilename().endsWith('.png'));
      const textPath = path.join(scratch, 'blocked-report.txt');
      await textFile?.saveAs(textPath);
      const reportText = textFile ? await fs.readFile(textPath, 'utf8') : '';
      const blockedMessage = await b.message();
      await fs.writeFile(path.join(SHOTS, 'report-blocked-clipboard.txt'), `${reportText}\n--- status ---\n${blockedMessage}\n`);
      check(`${tag} when the page blocks the clipboard, Copy report downloads the PNG and the text and says nothing was copied`,
        Boolean(pngFile) && reportText.includes('1  Explained on a blocked page') && reportText.includes(`saved separately as ${pngFile?.suggestedFilename()}`)
        && /^Clipboard unavailable \(.*permissions policy.*\): downloaded the screenshot as .*\.png and the report text as .*-report\.txt\. Nothing was copied\.$/.test(blockedMessage),
        JSON.stringify({ files: blockedFiles.map(file => file.suggestedFilename()), blockedMessage }));
      const imageFallback = await b.download(() => b.press('[data-redline-strip-section="capture"] [data-redline-action="copy"]'));
      check(`${tag} Copy image on that page downloads instead and reports the refusal`,
        imageFallback.buffer.subarray(1, 4).toString() === 'PNG' && /^The clipboard refused the image \(.*\); downloaded PNG instead\.$/.test(await b.message()), await b.message());
      await blockedAccess.dispose();
      await blocked.close();
      await page.bringToFront();
      const untouched = await page.evaluate(async () => (await (await (await navigator.clipboard.read())[0].getType('text/plain')).text()));
      check(`${tag} the blocked page's attempts did not change the clipboard`, untouched.includes(`saved separately as ${fallback.name}`));

      // ---------------------------------------------------------------------
      // Capture tab isolation with a second, real tab in the same window
      const other = await context.newPage();
      await other.goto(`${origin}/tab-b`);
      const workUrl = `${origin}/work?token=${SECRET}#section-9`;
      const workTab = await tabIdFor(worker, workUrl);
      const otherTab = await tabIdFor(worker, `${origin}/tab-b`);
      const windows = await worker.evaluate(async ids => Promise.all(ids.map(async id => (await chrome.tabs.get(id)).windowId)), [workTab, otherTab]);
      check(`${tag} the two tabs share one window, so captureVisibleTab could capture either`, windows[0] === windows[1], JSON.stringify(windows));
      await h.load({ width: 1200, height: 800, annotations: [bullet('iso', '1', 600, 400, 'Only on the work page')] }, 'isolation');
      await activate(worker, workTab);
      const noDownload = async (trigger, expected, label) => {
        const files = [];
        const listener = file => files.push(file);
        page.on('download', listener);
        await trigger();
        await h.idle();
        await page.waitForTimeout(700);
        page.off('download', listener);
        const text = await h.message();
        check(label, files.length === 0 && expected.test(text), JSON.stringify({ files: files.length, text }));
      };
      await activate(worker, otherTab);
      await noDownload(() => h.click('[data-redline-action="download"]'), /not the active tab/, `${tag} a capture requested from a background tab is refused and nothing is exported`);
      await activate(worker, workTab);
      await setCaptureDelay(worker, 1200);
      await noDownload(async () => {
        await h.click('[data-redline-action="download"]');
        await page.waitForTimeout(300);
        await activate(worker, otherTab);
      }, /Another tab became active while capturing/, `${tag} switching tabs mid-capture discards the other page's screenshot`);
      await activate(worker, workTab);
      await noDownload(async () => {
        await h.click('[data-redline-action="report"]');
        await page.waitForTimeout(250);
        await activate(worker, otherTab);
        await page.waitForTimeout(250);
        await activate(worker, workTab);
      }, /Another tab became active while capturing/, `${tag} switching away and back mid-capture is still rejected`);
      await noDownload(async () => {
        await h.click('[data-redline-action="download"]');
        await page.waitForTimeout(300);
        await page.evaluate(() => history.pushState({}, '', location.pathname + '-moved' + location.search + location.hash));
      }, /navigat|changed address/, `${tag} a navigation mid-capture discards the screenshot`);
      await page.evaluate(() => history.back());
      await page.waitForTimeout(300);
      // An in-app route change before capturing is not a navigation during capture.
      await page.evaluate(() => history.pushState({}, '', location.pathname + '/route' + location.search + '#view'));
      await setCaptureDelay(worker, 0);
      const afterRoute = await h.exportPNG();
      check(`${tag} capture still works after an in-app history navigation made before it`, afterRoute.subarray(1, 4).toString() === 'PNG');
      await page.evaluate(() => history.back());
      await page.waitForTimeout(300);
      await setCaptureDelay(worker, 1200);
      const failed = await evaluate(() => ({
        hostHidden: document.querySelector('[data-redline-extension]').style.visibility === 'hidden',
        rootHidden: globalThis.__redlineTestRoot.querySelector('[data-redline-root]').style.visibility === 'hidden',
        busy: globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy'),
      }));
      check(`${tag} after refused captures the overlay and toast host are visible again`, !failed.hostHidden && !failed.rootHidden && !failed.busy, JSON.stringify(failed));
      await setCaptureDelay(worker, 0);
      await activate(worker, otherTab);
      await h.click('[data-redline-action="preview"]');
      await h.idle();
      await page.waitForTimeout(400);
      const previewFailure = { message: await h.message(), open: await evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]')?.open)),
        focus: await h.active() };
      check(`${tag} a refused preview capture reports the reason, opens nothing and keeps keyboard focus in Redline`,
        /Could not preview the export: .*not the active tab/.test(previewFailure.message) && !previewFailure.open && previewFailure.focus !== null, JSON.stringify(previewFailure));
      await activate(worker, workTab);
      await page.bringToFront();
      const good = await h.exportPNG();
      const center = await h.pixels(good, [[100 * dpr, 700 * dpr]]);
      check(`${tag} once the tab is active again, capture works and shows this page`, white(center.samples[0]), JSON.stringify(center));
      await other.close();
    }

    {
      // ---------------------------------------------------------------------
      // Widths, keyboard reach and screenshots (both pixel ratios)
      await h.load({
        width: 1200, height: 800, legend: { visible: true, x: 820, y: 180, width: 300, fontSize: 14 }, cursor: { visible: true, x: 500, y: 420 },
        annotations: [bullet('w1', '1', 300, 320, 'Width check'), bullet('wA', 'A', 360, 380, 'Lettered')],
      }, 'widths');
      await h.press('[data-redline-pin]');
      for (const width of [1920, 1200]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(250);
        const layout = await evaluate(() => {
          const root = globalThis.__redlineTestRoot;
          const toolbar = root.querySelector('[data-redline-toolbar]');
          const bar = toolbar.getBoundingClientRect();
          const items = [...toolbar.querySelectorAll('[data-redline-tool], [data-redline-action]')]
            .filter(node => !node.hidden).map(node => node.dataset.redlineTool ?? node.dataset.redlineAction);
          return {
            fits: bar.left >= 0 && bar.right <= innerWidth + 0.5,
            noOverflow: toolbar.scrollWidth <= toolbar.clientWidth + 1,
            noMenus: root.querySelectorAll('[data-redline-menu]').length === 0,
            items,
          };
        });
        await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-${width}-command-strip.png`) });
        check(`${tag} at ${width}px one strip contains every capture and pointer command`,
          layout.fits && layout.noMenus && (width < 1200 || layout.noOverflow)
          && ['undo', 'redo', 'clear', 'close', 'preview', 'report', 'reportFallback', 'cursorToggle', 'cursorPlace']
            .every(item => layout.items.includes(item)), JSON.stringify(layout));
        await page.keyboard.press('v');
        const proxy = await h.cursorAt();
        await page.mouse.click(proxy.screenX + 3, proxy.screenY + 8);
        const row = await evaluate(() => {
          const context = globalThis.__redlineTestRoot.querySelector('[data-redline-context]');
          const box = context.getBoundingClientRect();
          const buttons = [...context.querySelectorAll('[data-redline-control="cursor"] button')];
          return { target: context.querySelector('[data-redline-target]').textContent, inside: box.left >= 0 && box.right <= innerWidth + 0.5,
            buttons: buttons.every(button => { const r = button.getBoundingClientRect(); return button.checkVisibility() && r.left >= 0 && r.right <= innerWidth + 0.5; }) };
        });
        await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-${width}-pointer-row.png`) });
        check(`${tag} at ${width}px the Pointer controls fit and are visible`, row.target === 'Pointer' && row.inside && row.buttons, JSON.stringify(row));
        await h.click('[data-redline-action="preview"]');
        await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]')?.open), 'preview at width', 20000);
        const dialog = await evaluate(() => {
          const dialog = globalThis.__redlineTestRoot.querySelector('dialog[data-redline-preview]');
          const box = dialog.getBoundingClientRect();
          const canvas = dialog.querySelector('canvas').getBoundingClientRect();
          const buttons = [...dialog.querySelectorAll('footer button')].every(button => button.checkVisibility());
          return { inside: box.left >= 0 && box.right <= innerWidth + 0.5 && box.top >= 0 && box.bottom <= innerHeight + 0.5,
            canvasInside: canvas.left >= box.left && canvas.right <= box.right + 0.5, buttons };
        });
        await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-${width}-export-preview.png`) });
        await page.keyboard.press('Escape');
        check(`${tag} at ${width}px the export preview fits the window with its actions visible`, dialog.inside && dialog.canvasInside && dialog.buttons, JSON.stringify(dialog));
      }
      await page.setViewportSize({ width: 1200, height: 800 });

      // ---------------------------------------------------------------------
      // Privacy
      const leaks = await page.evaluate(() => ({ ...globalThis.__pageSeen, storage: localStorage.length + sessionStorage.length, cookie: document.cookie,
        chromeStorage: typeof globalThis.chrome?.storage }));
      check(`${tag} page-world observers see no preview, report, pointer or export nodes, URLs or payloads`,
        leaks.nodes.length === 0 && leaks.urls.length === 0 && !leaks.details.some(detail => /redline|explanation|Hostile|data:|blob:/i.test(detail)),
        JSON.stringify(leaks));
      check(`${tag} the page's own storage is untouched and it cannot reach extension storage`, leaks.storage === 0 && leaks.cookie === '' && leaks.chromeStorage === 'undefined', JSON.stringify(leaks));
      const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
      const sessionText = JSON.stringify(stored.session);
      check(`${tag} extension storage keeps no screenshot, raw URL, query, fragment or title`,
        !/data:image|base64,iVBOR/.test(sessionText) && !sessionText.includes(SECRET) && !sessionText.includes('section-9') && !sessionText.includes('/work')
        && !sessionText.includes('Checkout') && !JSON.stringify(stored.local).includes('draft'), sessionText.slice(0, 300));
      const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
      check(`${tag} the shipped manifest keeps its permission boundary`,
        JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'clipboardWrite', 'storage']) && !manifest.host_permissions && !manifest.externally_connectable,
        JSON.stringify(manifest.permissions));
      check(`${tag} the production overlay still uses a closed shadow root`, await page.evaluate(() => document.querySelector('[data-redline-extension]').shadowRoot === null));
    }
    check(`${tag} no unexpected page errors`, errors.length === 0, errors.join(' | '));
    await access.dispose();
  } finally {
    await context.close();
  }
}

try {
  await run(2, { full: true });
  await run(1, { full: false });
} catch (error) {
  check('export browser suite completed without an unhandled error', false, error.stack ?? error.message);
} finally {
  server.close();
}
const passed = results.filter(item => item.pass).length;
console.log(`\n${passed}/${results.length} phase 3 checks passed`);
const failed = results.filter(item => !item.pass);
if (failed.length) console.log('Failed: ' + failed.map(item => item.name).join('; '));
process.exit(failed.length ? 1 : 0);
