/** Independent lead checks for long Canvas explanations and composition. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';
const { check, results } = createChecker();
const { server, origin } = await startServer({ '/review': '<!doctype html><body style="margin:0;background:white">Review</body>' });
await fs.mkdir('test-artifacts/phase2-review', { recursive: true });
try {
  for (const dpr of [1, 2]) {
    const { context, worker, scratch } = await launch({ viewport: { width: 1000, height: 650 }, deviceScaleFactor: dpr });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(origin + '/review');
      const access = await openRedline({ context, worker, page });
      const { evaluate, importFile } = access;
      const click = selector => evaluate(value => globalThis.__redlineTestRoot.querySelector(value).click(), selector);
      const exportFile = async action => {
        const [download] = await Promise.all([page.waitForEvent('download'), click('[data-redline-action="' + action + '"]')]);
        const file = path.join(scratch, download.suggestedFilename());
        await download.saveAs(file);
        if (action === 'download') await page.waitForTimeout(600);
        return fs.readFile(file);
      };
      const input = () => evaluate(() => {
        const field = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-input]');
        const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
        return { text: field.value, start: field.selectionStart, end: field.selectionEnd, focus: globalThis.__redlineTestRoot.activeElement === field,
          label: canvas.getAttribute('aria-label'), tool: globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').dataset.tool };
      });
      const doc = { width: 1000, height: 650, legend: { visible: true, x: 570, y: 240, width: 300, fontSize: 14 },
        annotations: [{ id: 'bullet', type: 'bullet', label: '1', color: '#1D4ED8', point: { x: 250, y: 350 }, text: 'Start' }] };
      const file = path.join(scratch, 'long.json');
      await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document: doc }));
      await importFile(file);
      await click('[data-redline-tool="select"]');
      await page.mouse.dblclick(250, 350);
      await page.keyboard.press('Control+End');
      const text = '\n' + Array.from({ length: 75 }, (_, i) => 'Line ' + (i + 1) + ': detail about this issue.').join('\n') + '  \n\n';
      await page.keyboard.insertText(text);
      // Compare on/off blink pixels. A focused caret outside the canvas has no
      // visible pixels; reading the hidden input's clamped bounds misses that.
      const blink = async () => {
        await page.keyboard.press('ArrowLeft');
        await evaluate(() => {
          const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
          globalThis.__reviewSize = [canvas.width, canvas.height];
          const field = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-input]').getBoundingClientRect();
          globalThis.__reviewCaret = { left: field.left - 3, right: field.right + 3, top: field.top - 2, bottom: field.bottom + 2 };
          globalThis.__reviewPixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        });
        await page.waitForTimeout(600);
        return evaluate(() => {
          const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
          const current = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
          // Inspect the expected caret area, so unrelated fractional-scale
          // frame/scrollbar antialiasing cannot be mistaken for a caret.
          const area = globalThis.__reviewCaret;
          for (let y = Math.max(0, Math.floor(area.top * devicePixelRatio)); y < Math.min(canvas.height, Math.ceil(area.bottom * devicePixelRatio)); y++) {
            for (let x = Math.max(0, Math.floor(area.left * devicePixelRatio)); x < Math.min(canvas.width, Math.ceil(area.right * devicePixelRatio)); x++) {
            const i = (y * canvas.width + x) * 4;
            // Compare visible colours on white, not unpremultiplied RGB in
            // nearly transparent antialias pixels along the frame border.
            const old = globalThis.__reviewPixels;
            const changed = [0, 1, 2].some(c => Math.abs(
              (current[i + c] - 255) * current[i + 3] / 255 - (old[i + c] - 255) * old[i + 3] / 255) > 16);
            if (changed) {
              left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
          }
          }
          return { beforeSize: globalThis.__reviewSize, afterSize: [canvas.width, canvas.height], left: left / devicePixelRatio, right: right / devicePixelRatio, top: top / devicePixelRatio, bottom: bottom / devicePixelRatio };
        });
      };
      const tailCaret = await blink();
      check('DPR ' + dpr + ': the caret remains visible after the legend grows past the window', tailCaret.bottom > tailCaret.top && tailCaret.bottom - tailCaret.top < 30 && tailCaret.right - tailCaret.left <= 3 && tailCaret.top >= 100 && tailCaret.bottom < 650, JSON.stringify(tailCaret));
      await page.screenshot({ path: 'test-artifacts/phase2-review/dpr' + dpr + '-long-edit.png' });
      // Wheel scrolling must change the visible text without moving the caret.
      await page.mouse.move(720, 420);
      const atTail = await input();
      await page.mouse.wheel(0, -10000);
      await page.waitForTimeout(80);
      const afterWheel = await input();
      check('DPR ' + dpr + ': wheel scrolling preserves the text and selection', afterWheel.text === atTail.text && afterWheel.start === atTail.start);
      await page.mouse.click(611, 257);
      await page.keyboard.type('X');
      check('DPR ' + dpr + ': pointer editing follows the scrolled text', (await input()).text.startsWith('XStart'));
      await page.keyboard.press('Backspace');
      await page.mouse.wheel(0, 10000);
      await page.waitForTimeout(80);
      await page.mouse.click(611, 257);
      check('DPR ' + dpr + ': scrolling to later lines updates pointer hit testing', (await input()).start > 1000);
      const rootScroll = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').scrollTop);
      check('DPR ' + dpr + ': keeping long text reachable does not scroll the page or overlay', rootScroll === 0 && await page.evaluate(() => scrollY === 0));
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('ArrowRight');
      const headCaret = await blink();
      check('DPR ' + dpr + ': navigation brings the beginning back into view', headCaret.bottom > headCaret.top && headCaret.top >= 100 && headCaret.bottom < 650, JSON.stringify(headCaret));
      await page.keyboard.press('Control+Enter');
      const [download] = await Promise.all([page.waitForEvent('download'), click('[data-redline-action="json"]')]);
      const savedPath = path.join(scratch, 'saved.json');
      await download.saveAs(savedPath);
      const saved = JSON.parse(await fs.readFile(savedPath, 'utf8')).document;
      check('DPR ' + dpr + ': editing preserves the full text and saved legend geometry', saved.annotations[0].text === 'Start' + text
        && saved.legend.x === doc.legend.x && saved.legend.y === doc.legend.y && saved.legend.width === doc.legend.width && !('height' in saved.legend));
      const normalPng = await exportFile('download');
      await page.mouse.dblclick(250, 350);
      await page.keyboard.press('Control+End');
      await page.mouse.move(720, 420);
      await page.mouse.wheel(0, -500);
      const editingPng = await exportFile('download');
      check('DPR ' + dpr + ': PNG ignores the temporary editing viewport and its scroll position', normalPng.equals(editingPng));
      const afterExport = JSON.parse(await exportFile('json')).document;
      check('DPR ' + dpr + ': save and export preserve trailing spaces and blank lines exactly', afterExport.annotations[0].text === 'Start' + text);
      await page.mouse.dblclick(250, 350);
      const before = await input();
      await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-legend-input]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', isComposing: true, bubbles: true, composed: true })));
      const composing = await input();
      check('DPR ' + dpr + ': composition keys cannot switch Browse mode or finish an explanation', composing.focus && composing.text === before.text, JSON.stringify({ before: before.focus, after: composing.focus, length: composing.text.length }));
      await click('[data-redline-legend-toggle]');
      await page.keyboard.press('Control+End');
      const cardCaret = await blink();
      check('DPR ' + dpr + ': hidden-legend cards also keep long explanations editable on-screen', cardCaret.bottom > cardCaret.top && cardCaret.bottom - cardCaret.top < 30 && /not exported/.test((await input()).label));
      await page.setViewportSize({ width: 420, height: 600 });
      await waitUntil(() => evaluate(() => {
        const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
        return canvas.width === Math.round(420 * devicePixelRatio) && canvas.height === Math.round(600 * devicePixelRatio);
      }), 'Canvas repainted at the resized dimensions');
      await page.keyboard.press('Control+End');
      const narrowCaret = await blink();
      check('DPR ' + dpr + ': the editing viewport follows a narrow nonuniform resize', narrowCaret.bottom > narrowCaret.top && narrowCaret.bottom - narrowCaret.top < 30 && narrowCaret.right - narrowCaret.left <= 3 && narrowCaret.bottom < 600 && narrowCaret.right < 420 && narrowCaret.top > 100, JSON.stringify(narrowCaret));
      await page.screenshot({ path: 'test-artifacts/phase2-review/dpr' + dpr + '-narrow-card.png' });
      await page.keyboard.press('Escape');
      await access.dispose();
    } finally { await context.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(results.filter(item => item.pass).length + '/' + results.length + ' Phase 2 lead checks passed');
process.exitCode = results.every(item => item.pass) ? 0 : 1;
