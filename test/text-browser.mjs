import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, openRedline, samplePng, startServer, waitUntil } from './harness.mjs';

await fs.mkdir('test-artifacts', { recursive: true });
const { server, origin } = await startServer({
  '/text': '<!doctype html><html><body style="margin:0;background:rgb(64,112,128)"></body></html>',
});
try {
  for (const dpr of [1, 2]) {
    const { context, worker, scratch } = await launch({ deviceScaleFactor: dpr });
    try {
      const page = context.pages()[0];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Previously saved opaque dark defaults must not override the new paper default.
      await worker.evaluate(() => chrome.storage.local.set({
        'redline.preferences': { tool: 'pen', textBoxBackgroundOpacity: 1 },
      }));
      await page.goto(origin + '/text');
      const access = await openRedline({ context, worker, page });
      const { evaluate, importFile } = access;
      const click = selector => evaluate(selector => globalThis.__redlineTestRoot.querySelector(selector).click(), selector);
      const editor = () => evaluate(() => {
        const root = globalThis.__redlineTestRoot;
        const input = root.querySelector('[data-redline-text-editor]');
        if (!input) return null;
        const r = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        return {
          x: r.x, y: r.y, width: r.width, height: r.height, value: input.value,
          background: style.backgroundColor, color: style.color,
          focused: root.activeElement === input,
          scrollHeight: input.scrollHeight, clientHeight: input.clientHeight,
          marksBehind: root.querySelectorAll('[data-redline-type="textbox"]').length,
        };
      });
      const marks = () => evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('[data-redline-type="textbox"]')].map(node => {
        const rect = node.querySelector('rect');
        const r = rect.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, fill: rect.getAttribute('fill'),
          text: [...node.querySelectorAll('tspan')].map(span => span.textContent).join('\n'),
          color: node.querySelector('text').getAttribute('fill') };
      }));
      const download = async (action, name) => {
        const [file] = await Promise.all([page.waitForEvent('download'), click('[data-redline-action="' + action + '"]')]);
        const destination = path.join(scratch, name);
        await file.saveAs(destination);
        await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'export finished');
        return fs.readFile(destination);
      };

      await click('[data-redline-tool="textbox"]');
      await page.mouse.click(160, 260);
      const empty = await editor();
      assert.ok(empty?.focused, 'one click opens and focuses text editing');
      assert.equal(empty.background, 'rgba(255, 255, 255, 0.75)');
      assert.equal(empty.color, 'rgb(41, 45, 50)');
      assert.equal(empty.marksBehind, 0, 'the translucent editor has no duplicate backing beneath it');
      assert.equal(empty.x, 160);
      assert.equal(empty.y, 260);

      await page.keyboard.type('A note about the selected control');
      const wider = await editor();
      assert.ok(wider.width > empty.width, 'background expands horizontally during typing');
      await page.keyboard.press('Enter');
      await page.keyboard.type('This explanation keeps growing as I type more details about the control and its appearance. '.repeat(5));
      const grown = await editor();
      assert.ok(grown.height > empty.height, 'wrapping and newlines expand the background vertically');
      assert.ok(grown.width <= 601, 'long text wraps at a readable width');
      assert.ok(grown.scrollHeight <= grown.clientHeight + 1, 'all typed lines fit without internal scrolling');
      await page.screenshot({ path: 'test-artifacts/text-live-dpr' + dpr + '.png' });
      const text = grown.value.trim();
      await page.keyboard.press('Control+Enter');
      const [saved] = await marks();
      assert.equal((await marks()).length, 1);
      assert.equal(saved.fill, 'rgba(255,255,255,0.75)');
      assert.equal(saved.color, '#292D32');
      assert.ok(Math.abs(saved.width - grown.width) < 1 && Math.abs(saved.height - grown.height) < 1, 'saved geometry matches the growing editor');

      await page.screenshot({ path: 'test-artifacts/text-saved-dpr' + dpr + '.png' });
      const png = await download('download', 'text.png');
      const [paper] = await samplePng(evaluate, png, [[saved.x + 4, saved.y + saved.height - 4]]);
      assert.ok([207, 219, 223].every((value, i) => Math.abs(paper[i] - value) <= 2), 'PNG blends white paper at 75% over the page: ' + paper);
      const exported = JSON.parse((await download('json', 'text.json')).toString());
      assert.equal(exported.document.annotations[0].text, text);
      assert.equal(exported.document.annotations[0].backgroundOpacity, 0.75);

      await click('[data-redline-tool="select"]');
      await page.keyboard.press('Control+z');
      assert.equal((await marks()).length, 0, 'creating and typing text is a single undo step');
      await page.keyboard.press('Control+y');
      assert.equal((await marks()).length, 1, 'redo restores the entire text annotation');

      await page.mouse.dblclick(saved.x + 20, saved.y + 20);
      assert.equal((await editor()).marksBehind, 0, 'existing text is hidden while its editor paints');
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('A later edit adds another line.');
      assert.ok((await editor()).height > saved.height, 'later edits expand live too');
      await page.keyboard.press('Escape');
      assert.equal((await marks())[0].height, saved.height, 'cancel restores original dimensions');
      assert.equal((await editor()), null);

      await page.mouse.dblclick(saved.x + 20, saved.y + 20);
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('A later edit adds another line.');
      await page.keyboard.press('Control+Enter');
      const revised = JSON.parse((await download('json', 'revised.json')).toString());
      assert.ok(revised.document.annotations[0].text.endsWith('A later edit adds another line.'));
      assert.ok(revised.document.annotations[0].end.y > exported.document.annotations[0].end.y);
      await importFile(path.join(scratch, 'text.json'));
      await waitUntil(async () => (await marks())[0]?.height === saved.height, 'JSON restores original size');
      assert.equal((await marks())[0].fill, 'rgba(255,255,255,0.75)');

      await page.setViewportSize({ width: 800, height: 600 });
      await click('[data-redline-tool="textbox"]');
      await page.mouse.click(120, 160);
      const resizedEmpty = await editor();
      await page.keyboard.type('Typing after a nonuniform viewport resize still grows and aligns.');
      const resized = await editor();
      assert.ok(Math.abs(resized.x - 120) < 1 && Math.abs(resized.y - 160) < 1);
      assert.ok(resized.width > resizedEmpty.width);
      assert.ok(resized.scrollHeight <= resized.clientHeight + 1);
      await page.keyboard.press('Control+Enter');
      const last = (await marks()).at(-1);
      assert.ok(Math.abs(last.width - resized.width) < 1 && Math.abs(last.height - resized.height) < 1);

      await click('[data-redline-tool="textbox"]');
      await page.mouse.click(795, 570);
      const atEdge = await editor();
      assert.ok(atEdge.x + atEdge.width <= 801 && atEdge.y + atEdge.height <= 601, 'a click near an edge still opens an editor inside the viewport');
      await page.keyboard.press('Escape');
      assert.equal((await marks()).length, 2, 'cancelling empty text creates no mark');
      assert.deepEqual(errors, []);
      await access.dispose();
      console.log('PASS click-to-type, paper, live sizing, PNG, history, later edits, JSON, viewport resize, and edge placement at DPR ' + dpr);
    } finally {
      await context.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
