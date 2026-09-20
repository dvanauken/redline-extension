import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, openRedline, startServer, waitUntil } from './harness.mjs';

await fs.mkdir('test-artifacts', { recursive: true });
const { server, origin } = await startServer({
  '/rectangle-label': '<!doctype html><html><body style="margin:0;background:#f7f8fa"></body></html>',
});

try {
  const { context, worker, scratch } = await launch();
  try {
    const page = context.pages()[0];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/rectangle-label');
    const access = await openRedline({ context, worker, page });
    const { evaluate } = access;
    const click = selector => evaluate(selector => globalThis.__redlineTestRoot.querySelector(selector).click(), selector);
    const editor = () => evaluate(() => {
      const input = globalThis.__redlineTestRoot.querySelector('[data-redline-rectangle-label-editor]');
      if (!input) return null;
      const box = input.getBoundingClientRect();
      return { value: input.value, x: box.x, y: box.y, width: box.width, height: box.height, focused: globalThis.__redlineTestRoot.activeElement === input };
    });
    const label = () => evaluate(() => {
      const mark = globalThis.__redlineTestRoot.querySelector('[data-redline-type="rectangle"]');
      const text = mark?.querySelector('text');
      const box = text?.getBoundingClientRect();
      return text ? {
        value: [...text.querySelectorAll('tspan')].map(node => node.textContent).join(' '),
        x: box.x, y: box.y, color: text.getAttribute('fill'), anchor: text.getAttribute('text-anchor'),
      } : null;
    });
    const downloadJSON = async name => {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        click('[data-redline-action="json"]'),
      ]);
      const target = path.join(scratch, name);
      await file.saveAs(target);
      return JSON.parse(await fs.readFile(target, 'utf8'));
    };

    await click('[data-redline-tool="rectangle"]');
    await page.mouse.move(200, 200);
    await page.mouse.down();
    await page.mouse.move(500, 350);
    await page.mouse.up();
    await click('[data-redline-tool="select"]');
    await page.mouse.click(200, 275);

    await page.keyboard.type('Conference room');
    const live = await editor();
    assert.equal(live?.value, 'Conference room', 'typing on a selected rectangle opens its inline editor');
    assert.ok(live.focused, 'the direct editor owns keyboard focus');
    assert.ok(Math.abs(live.x - 200) < 1 && Math.abs(live.y - 200) < 1, 'the editor sits inside the rectangle');
    await page.keyboard.press('Control+Enter');

    const painted = await label();
    assert.equal(painted?.value, 'Conference room');
    assert.equal(painted?.anchor, 'middle');
    await page.screenshot({ path: 'test-artifacts/rectangle-direct-label.png' });
    let json = await downloadJSON('rectangle-label.json');
    assert.equal(json.document.annotations[0].type, 'rectangle');
    assert.equal(json.document.annotations[0].text, 'Conference room');

    await page.mouse.move(350, 275);
    await page.mouse.down();
    await page.mouse.move(410, 315);
    await page.mouse.up();
    const moved = await label();
    assert.ok(Math.abs(moved.x - painted.x - 60) < 1 && Math.abs(moved.y - painted.y - 40) < 1,
      'the label moves with its rectangle');

    await page.keyboard.press('Enter');
    assert.equal((await editor())?.value, 'Conference room', 'Enter edits an existing rectangle label');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Review area');
    await page.keyboard.press('Control+Enter');
    assert.equal((await label())?.value, 'Review area');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+Enter');
    assert.equal(await label(), null, 'saving an empty label removes it without removing the rectangle');
    await page.keyboard.press('Control+z');
    await waitUntil(async () => (await label())?.value === 'Review area', 'undo restores rectangle label');
    json = await downloadJSON('rectangle-label-restored.json');
    assert.equal(json.document.annotations[0].text, 'Review area');
    assert.deepEqual(errors, []);

    await access.dispose();
    console.log('PASS selected rectangle direct typing, attached movement, editing, clearing, undo, SVG and JSON');
  } finally {
    await context.close();
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
