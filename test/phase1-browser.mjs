/**
 * Phase 1 acceptance: the four reproduced review bugs, the light workspace,
 * style targeting, treatments, shapes, line ends, constraints, duplicate,
 * nudge and eraser geometry — all through real pointer and keyboard input.
 *
 *   node test/phase1-browser.mjs [--headed]
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, samplePng, startServer, waitUntil } from './harness.mjs';

const { results, check } = createChecker();
const { server, origin } = await startServer();
const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
let page;

try {
  page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => console.log('  [page exception]', error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Unsupported|not a supported|decoration/.test(message.text())) console.log('  [console error]', message.text());
  });
  await page.goto(`${origin}/fixture`);

  // An ordinary page-world observer, installed before Redline ever runs.
  await page.evaluate(() => {
    const leaks = globalThis.__pageLeaks = { nodes: [], fetched: [], events: [], clicks: [] };
    const inspect = node => {
      if (!(node instanceof Element)) return;
      for (const element of [node, ...node.querySelectorAll('*')]) {
        for (const attribute of ['href', 'src', 'download']) {
          const value = element.getAttribute(attribute);
          if (value === null) continue;
          leaks.nodes.push(`${element.tagName}.${attribute}=${value.slice(0, 60)}`);
          if (/^(blob|data):/.test(value)) {
            fetch(value).then(response => response.text()).then(text => leaks.fetched.push(text.slice(0, 40))).catch(() => {});
          }
        }
      }
    };
    new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(inspect);
        if (record.type === 'attributes') inspect(record.target);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'download'] });
    for (const type of ['click', 'change', 'input', 'wb-change', 'redline:changed', 'cancel', 'close']) {
      window.addEventListener(type, event => {
        const detail = event.detail === undefined || event.detail === null || typeof event.detail === 'number'
          ? '' : JSON.stringify(event.detail);
        const target = event.composedPath()[0];
        leaks.events.push({ type, detail, target: target?.tagName ?? String(target), href: target?.href ?? null });
      }, true);
    }
  });

  const redline = await openRedline({ context, worker, page });
  const { evaluate, importFile, inject } = redline;
  const click = selector => evaluate(value => {
    const node = globalThis.__redlineTestRoot.querySelector(value);
    if (!node) throw new Error('Missing ' + value);
    node.click();
  }, selector);
  const marks = () => evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-marks] > [data-redline-id]').length);
  const drag = async (x1, y1, x2, y2, { shift = false, steps = 6 } = {}) => {
    await page.mouse.move(x1, y1);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  const exportJSON = async name => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), click('[data-redline-action="json"]')]);
    const file = path.join(scratch, `${name}.json`);
    await download.saveAs(file);
    return JSON.parse(await fs.readFile(file, 'utf8'));
  };
  const exportPNG = async name => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), click('[data-redline-action="download"]')]);
    const file = path.join(scratch, `${name}.png`);
    await download.saveAs(file);
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'export finished', 20000);
    // captureVisibleTab allows two captures per second.
    await page.waitForTimeout(600);
    return fs.readFile(file);
  };
  const loadDocument = async (name, annotations, size = { width: 1200, height: 800 }) => {
    const file = path.join(scratch, `${name}.json`);
    await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document: { ...size, annotations } }));
    await importFile(file);
    await waitUntil(async () => (await marks()) === annotations.length, `${name} imported`);
  };
  const byId = async id => (await exportJSON('probe')).document.annotations.find(mark => mark.id === id);
  const target = () => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-target]').textContent);
  const pickPreset = async (colorTarget, preset) => {
    await click(`[data-redline-color="${colorTarget}"]`);
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette opened');
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-picker] [data-tab="presets"]').click());
    await click(`[data-redline-picker] [data-preset="${preset}"]`);
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette closed');
  };
  const hideChrome = hidden => evaluate(value => {
    for (const node of globalThis.__redlineTestRoot.querySelectorAll('[data-redline-dock], [data-redline-crop-panel]')) node.style.visibility = value ? 'hidden' : '';
  }, hidden);

  // ---------------------------------------------------------------------------
  // Bug 1: export privacy
  const bodyBefore = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('[data-redline-extension]').forEach(node => node.remove());
    return clone.innerHTML;
  });
  await loadDocument('privacy', [
    { id: 'p1', type: 'rectangle', color: '#DC2626', start: { x: 300, y: 300 }, end: { x: 500, y: 400 } },
    { id: 'p2', type: 'textbox', color: '#B65D66', text: 'Private annotation text', start: { x: 600, y: 300 }, end: { x: 900, y: 360 } },
  ]);
  await page.evaluate(() => { globalThis.__pageLeaks.nodes.length = 0; globalThis.__pageLeaks.events.length = 0; });
  const privateJson = await exportJSON('privacy');
  const privatePng = await exportPNG('privacy');
  const [copyDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 40000 }).catch(() => null),
    click('[data-redline-action="copy"]'),
  ]);
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'copy finished', 20000);
  await page.waitForTimeout(800);
  const leaks = await page.evaluate(() => globalThis.__pageLeaks);
  const bodyAfter = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('[data-redline-extension]').forEach(node => node.remove());
    return clone.innerHTML;
  });
  check('JSON and PNG downloads still work', privateJson.document.annotations.length === 2
    && privatePng.subarray(1, 4).toString() === 'PNG', `${privatePng.length} bytes`);
  check('Copy image still produces an image (clipboard or download fallback)',
    copyDownload !== null || await evaluate(() => /copied/.test(globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent)),
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent));
  check('a page MutationObserver sees no export link and fetches no export bytes',
    leaks.nodes.length === 0 && leaks.fetched.length === 0, JSON.stringify({ nodes: leaks.nodes, fetched: leaks.fetched }));
  const leakedEvents = leaks.events.filter(event => event.href || /blob:|data:|Private annotation|open-redline|#DC2626/i.test(event.detail) || event.type === 'wb-change');
  check('page-world event listeners receive no export URL or annotation payload',
    leakedEvents.length === 0, JSON.stringify(leakedEvents.slice(0, 5)));
  check('the page DOM is unchanged apart from the overlay host', bodyAfter === bodyBefore);

  // The file chooser's own cancel event must not be mistaken for Escape.
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('input[type=file]').dispatchEvent(new Event('cancel', { bubbles: true })));
  check('dismissing the import file chooser keeps Redline open',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open));

  // ---------------------------------------------------------------------------
  // Bug 2: text layout parity between preview and PNG
  const longText = 'Checkout total is wrong\n\nSupercalifragilisticexpialidociousandthensome\nLast line';
  await loadDocument('text', [
    { id: 'www', type: 'textbox', color: '#B65D66', width: 1.333, fontSize: 16, backgroundOpacity: 1, start: { x: 500, y: 300 }, end: { x: 600, y: 348 }, text: 'WWW WWW' },
    { id: 'multi', type: 'textbox', color: '#B65D66', width: 1.333, fontSize: 16, backgroundOpacity: 1, start: { x: 660, y: 300 }, end: { x: 880, y: 470 }, text: longText },
    { id: 'legacy10', type: 'note', color: '#2563EB', width: 1.333, point: { x: 120, y: 560 }, number: 10, text: 'A legacy note label long enough that it has to wrap inside the four hundred and twenty pixel label' },
  ]);
  const svgLines = await evaluate(() => Object.fromEntries(['www', 'multi'].map(id => [id,
    [...globalThis.__redlineTestRoot.querySelectorAll(`[data-redline-id="${id}"] tspan`)].map(node => node.textContent)])));
  check('the preview wraps WWW WWW by measured width, as the PNG does',
    JSON.stringify(svgLines.www) === JSON.stringify(['WWW', 'WWW']), JSON.stringify(svgLines.www));
  check('long words break and blank lines survive in the preview',
    svgLines.multi.length >= 5 && svgLines.multi[1] === '' && svgLines.multi.join('').replace(/\s/g, '') === longText.replace(/\s/g, ''),
    JSON.stringify(svgLines.multi));
  check('a legacy 10 note keeps its two-character glyph', await evaluate(() =>
    globalThis.__redlineTestRoot.querySelector('[data-redline-id="legacy10"] text').textContent === '10'));

  await hideChrome(true);
  await page.mouse.move(1190, 790);
  const previewShot = await page.screenshot();
  await hideChrome(false);
  const textPng = await exportPNG('text');
  const profiles = await evaluate(async ({ preview, exported, boxes }) => {
    const decode = async base64 => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return { ctx, scale: image.width / innerWidth };
    };
    const images = [await decode(preview), await decode(exported)];
    // Dark text pixels per device-pixel row inside each white text box.
    return boxes.map(({ x, y, width, height, light }) => images.map(({ ctx, scale }) => {
      const data = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), Math.round(width * scale), Math.round(height * scale));
      const rows = [];
      for (let row = 0; row < data.height; row++) {
        let count = 0;
        for (let col = 0; col < data.width; col++) {
          const i = (row * data.width + col) * 4;
          const luma = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / 3;
          if (light ? luma > 150 : luma < 110) count++;
        }
        rows.push(count);
      }
      return rows;
    }));
  }, {
    preview: previewShot.toString('base64'), exported: textPng.toString('base64'),
    boxes: [
      { x: 503, y: 303, width: 94, height: 43, light: false },
      { x: 663, y: 303, width: 214, height: 164, light: false },
      { x: 144, y: 546, width: 396, height: 60, light: false },
    ],
  });
  const compare = ([preview, exported]) => {
    const total = values => values.reduce((sum, value) => sum + value, 0);
    const lines = values => values.map(value => value > 0);
    const rowMismatch = lines(preview).filter((on, index) => on !== lines(exported)[index]).length;
    return { preview: total(preview), exported: total(exported), diff: Math.abs(total(preview) - total(exported)) / Math.max(1, total(preview), total(exported)), rowMismatch };
  };
  const [wwwCompare, multiCompare, noteCompare] = profiles.map(compare);
  const secondLine = profiles[0].map(rows => rows.slice(Math.round(27 * 2), Math.round(43 * 2)).reduce((a, b) => a + b, 0));
  check('the PNG draws the second WWW line that the preview shows',
    secondLine[0] > 20 && secondLine[1] > 20, JSON.stringify(secondLine));
  for (const [name, result] of [['WWW text box', wwwCompare], ['multiline text box with a long word', multiCompare], ['wrapped legacy note', noteCompare]]) {
    check(`preview and PNG text match for the ${name}`, result.diff < 0.2 && result.rowMismatch <= 6, JSON.stringify(result));
  }

  // Click-to-type expands the initial box horizontally for short text.
  await click('[data-redline-tool="textbox"]');
  await page.mouse.click(300, 620);
  await waitUntil(() => evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('[data-redline-text-editor]'))), 'editor open');
  await page.keyboard.type('WWW WWW');
  await page.keyboard.press('Control+Enter');
  const typed = (await exportJSON('typed')).document.annotations.at(-1);
  check('a committed text box grows to fit its text instead of hiding a line',
    typed.text === 'WWW WWW' && typed.end.y - typed.start.y >= 48 && typed.end.x - typed.start.x > 100, JSON.stringify(typed));

  // ---------------------------------------------------------------------------
  // Bug 3: palette keyboard navigation
  await loadDocument('palette', [
    { id: 'kbd', type: 'rectangle', color: '#475569', start: { x: 300, y: 300 }, end: { x: 600, y: 500 } },
  ]);
  await click('[data-redline-tool="select"]');
  await page.mouse.click(301, 400);
  await waitUntil(async () => (await target()) === 'Selected rectangle', 'selected for palette');
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-color="stroke"]').focus());
  await page.keyboard.press('Enter');
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette opened by keyboard');
  const focused = () => evaluate(() => {
    const element = globalThis.__redlineTestRoot.activeElement;
    return { tab: element?.dataset.tab ?? null, color: element?.dataset.color ?? null, label: element?.getAttribute('aria-label') ?? element?.textContent,
      selected: globalThis.__redlineTestRoot.querySelector('[data-tabs] [aria-selected="true"]')?.dataset.tab };
  });
  const opened = await focused();
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-tabs] [aria-selected="true"]').focus());
  const tabTrail = [];
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'End', 'Home', 'ArrowLeft']) {
    await page.keyboard.press(key);
    const state = await focused();
    tabTrail.push(`${state.tab}/${state.selected}`);
  }
  check('palette tabs move focus and selection with arrows, Home and End',
    JSON.stringify(tabTrail) === JSON.stringify(['more/more', 'custom/custom', 'presets/presets', 'custom/custom', 'presets/presets', 'custom/custom']),
    JSON.stringify({ opened, tabTrail }));
  check('only the selected tab is a Tab stop', await evaluate(() =>
    [...globalThis.__redlineTestRoot.querySelectorAll('[data-tabs] button')].map(node => node.tabIndex).join() === '-1,-1,0'));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Tab');
  const firstSwatch = await focused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const moved = await focused();
  check('Tab enters the More colors grid and arrows move across swatches',
    firstSwatch.color && moved.color && moved.color !== firstSwatch.color, JSON.stringify({ firstSwatch, moved }));
  await page.keyboard.press('Enter');
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'swatch picked by keyboard');
  const keyboardPick = await byId('kbd');
  check('Enter picks the focused swatch for the named target',
    keyboardPick.color.toUpperCase() === moved.color.toUpperCase(), JSON.stringify({ keyboardPick, moved }));
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-color="stroke"]').focus());
  await page.keyboard.press('Enter');
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'palette reopened');
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-tabs] [aria-selected="true"]').focus());
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const hexFocused = await evaluate(() => globalThis.__redlineTestRoot.activeElement?.hasAttribute('data-hex'));
  await page.keyboard.press('Control+a');
  await page.keyboard.type('#1F6FEB');
  await page.keyboard.press('Enter');
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-dialog="redline-color"]').open), 'hex applied');
  check('a custom hex colour can be entered entirely from the keyboard',
    hexFocused && (await byId('kbd')).color.toUpperCase() === '#1F6FEB');

  // ---------------------------------------------------------------------------
  // Bug 4: unfinished geometry and interruptions
  await loadDocument('gestures', [
    { id: 'kept', type: 'line', color: '#111827', start: { x: 100, y: 700 }, end: { x: 300, y: 700 } },
  ]);
  const draftCount = () => evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-marks] > [data-redline-type="polyline"], [data-redline-marks] > [data-redline-type="polygon"]').length);
  await click('[data-redline-tool="polyline"]');
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 260);
  await page.mouse.move(560, 330);
  const drafting = await draftCount();
  await click('[data-redline-tool="select"]');
  await page.mouse.move(700, 500, { steps: 4 });
  check('switching to Select by click cancels an unfinished polyline and keeps completed marks',
    drafting === 1 && await draftCount() === 0 && await marks() === 1, JSON.stringify({ drafting, after: await draftCount() }));
  await click('[data-redline-tool="polyline"]');
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 260);
  await page.keyboard.press('v');
  await page.mouse.move(700, 520, { steps: 4 });
  check('switching tools by keyboard cancels an unfinished polyline', await draftCount() === 0 && await marks() === 1);
  await click('[data-redline-tool="polygon"]');
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 260);
  await page.keyboard.press('F2');
  await page.keyboard.press('F2');
  await page.mouse.move(700, 520, { steps: 4 });
  check('Browse mode cancels an unfinished polygon', await draftCount() === 0 && await marks() === 1);

  await click('[data-redline-tool="polyline"]');
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 260);
  await page.keyboard.press('Escape');
  const afterEscape = { open: await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open), drafts: await draftCount() };
  await page.keyboard.press('Escape');
  const afterSecondEscape = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open);
  check('Escape cancels unfinished geometry first, and only a second Escape closes Redline',
    afterEscape.open && afterEscape.drafts === 0 && !afterSecondEscape, JSON.stringify({ afterEscape, afterSecondEscape }));
  await inject();
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open), 'reopened');

  await click('[data-redline-tool="pen"]');
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(460, 430, { steps: 4 });
  await page.keyboard.press('r');
  await page.mouse.move(520, 470, { steps: 4 });
  await page.mouse.up();
  check('a tool shortcut during a pen drag discards the stroke and draws nothing else', await marks() === 1);
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(480, 450, { steps: 4 });
  await evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(520, 480, { steps: 2 });
  await page.mouse.up();
  check('losing window focus mid-drag cancels the shape', await marks() === 1);

  await click('[data-redline-tool="polyline"]');
  await page.mouse.click(400, 300);
  await page.mouse.click(500, 250);
  await page.mouse.dblclick(620, 320);
  const finished = (await exportJSON('dblclick')).document.annotations.at(-1);
  check('double-click finishes a polyline without a duplicate trailing vertex',
    finished?.type === 'polyline' && finished.points.length === 3, JSON.stringify(finished?.points));
  await click('[data-redline-tool="polyline"]');
  for (const [x, y] of [[400, 550], [450, 520], [450, 520], [520, 560]]) await page.mouse.click(x, y);
  await page.keyboard.press('Backspace');
  await page.mouse.click(560, 600);
  await page.keyboard.press('Enter');
  const entered = (await exportJSON('enter')).document.annotations.at(-1);
  check('Enter finishes a path; repeated clicks collapse and Backspace removes the last vertex',
    entered?.type === 'polyline' && JSON.stringify(entered.points) === JSON.stringify([{ x: 400, y: 550 }, { x: 450, y: 520 }, { x: 560, y: 600 }]),
    JSON.stringify(entered?.points));
  const beforePolygon = await marks();
  const pathsBeforePolygon = await draftCount();
  await click('[data-redline-tool="polygon"]');
  await page.mouse.click(700, 300);
  await page.mouse.click(800, 300);
  await page.keyboard.press('Enter');
  const refused = { marks: await marks(), drafts: await draftCount(),
    message: await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent) };
  await page.mouse.click(750, 380);
  await page.keyboard.press('Enter');
  const polygon = (await exportJSON('polygon')).document.annotations.at(-1);
  check('a new polygon needs three distinct points; fewer keeps drafting with an explanation',
    refused.marks === beforePolygon + 1 && refused.drafts === pathsBeforePolygon + 1 && /three/.test(refused.message)
    && polygon.type === 'polygon' && polygon.points.length === 3, JSON.stringify({ refused, points: polygon.points }));

  // ---------------------------------------------------------------------------
  // Toolbar layout at the review widths
  const layoutAt = async width => {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    return evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      const rect = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }; };
      const bar = root.querySelector('[data-redline-toolbar]');
      const essentials = ['[data-redline-action="undo"]', '[data-redline-action="redo"]', '[data-redline-action="clear"]', '[data-redline-action="close"]',
        '[data-redline-action="fullPage"]', '[data-redline-action="copy"]', '[data-redline-pin]', '[data-redline-grip]', '[data-redline-mode-toggle]',
        '[data-redline-toolbar] [data-redline-tool="select"]', '[data-redline-toolbar] [data-redline-tool="eraser"]']
        .map(selector => {
          const node = root.querySelector(selector);
          const box = rect(node);
          return { selector, visible: node.checkVisibility(), inside: box.left >= 0 && box.right <= innerWidth };
        });
      const tools = ['select', 'pen', 'brush', 'line', 'arrow', 'rectangle', 'ellipse', 'note', 'textbox', 'polyline', 'polygon', 'eraser', 'crop'];
      const reachable = tools.filter(tool => [...root.querySelectorAll(`[data-redline-tool="${tool}"]`)]
        .some(node => node.closest('[data-redline-menu]') ? !node.hidden : node.checkVisibility()));
      const context = root.querySelector('[data-redline-context]');
      return {
        width: innerWidth, bar: rect(bar), overflow: bar.scrollWidth - bar.clientWidth, essentials, reachable: reachable.length,
        context: context.hidden ? null : rect(context),
      };
    });
  };
  const layouts = [];
  for (const width of [1920, 1200]) {
    const layout = await layoutAt(width);
    layouts.push(layout);
    check(`at ${width}px the bar fits without scrolling and essential actions are visible`,
      layout.bar.left >= 0 && layout.bar.right <= width && layout.overflow <= 1
      && layout.essentials.every(item => item.visible && item.inside) && layout.reachable === 13
      && (!layout.context || (layout.context.left >= 0 && layout.context.right <= width)),
      JSON.stringify({ bar: layout.bar, overflow: layout.overflow, bad: layout.essentials.filter(item => !item.visible || !item.inside), reachable: layout.reachable, context: layout.context }));
  }
  check('the single strip spans the viewport at both supported review widths',
    layouts.every(layout => Math.abs(layout.bar.width - (layout.width - 16)) <= 1), JSON.stringify(layouts.map(layout => layout.bar)));

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(200);
  const stripLayout = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const bar = root.querySelector('[data-redline-toolbar]');
    const capture = root.querySelector('[data-redline-strip-section="capture"]');
    return {
      menuCount: root.querySelectorAll('[data-redline-menu]').length,
      barWidth: bar.getBoundingClientRect().width,
      fits: bar.scrollWidth <= bar.clientWidth + 1,
      captureActions: [...capture.querySelectorAll('[data-redline-tool], [data-redline-action]')]
        .map(node => node.dataset.redlineTool || node.dataset.redlineAction),
    };
  });
  check('the full-width strip has no overflow menu and fits at 1200px',
    stripLayout.menuCount === 0 && stripLayout.fits && stripLayout.barWidth >= 1180, JSON.stringify(stripLayout));
  check('Capture keeps Crop, Full page, Copy image and Copy report together on the strip',
    ['crop', 'fullPage', 'copy', 'report'].every(action => stripLayout.captureActions.includes(action)),
    JSON.stringify(stripLayout.captureActions));

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(200);
  await loadDocument('stable', [{ id: 'stable-rect', type: 'rectangle', color: '#16A34A', start: { x: 300, y: 300 }, end: { x: 600, y: 500 } }]);
  const essentialRects = () => evaluate(() => ['undo', 'redo', 'clear', 'close'].map(action => {
    const box = globalThis.__redlineTestRoot.querySelector(`[data-redline-action="${action}"]`).getBoundingClientRect();
    return [Math.round(box.left), Math.round(box.top)];
  }));
  await click('[data-redline-tool="pen"]');
  const penRects = await essentialRects();
  await click('[data-redline-tool="select"]');
  await page.mouse.click(301, 400);
  await waitUntil(async () => (await target()) === 'Selected rectangle', 'selected for stability');
  const selectedRects = await essentialRects();
  await click('[data-redline-tool="line"]');
  const lineRects = await essentialRects();
  check('essential actions keep their positions as the tool and selection change',
    JSON.stringify(penRects) === JSON.stringify(selectedRects) && JSON.stringify(penRects) === JSON.stringify(lineRects),
    JSON.stringify({ penRects, selectedRects, lineRects }));

  // ---------------------------------------------------------------------------
  // Style targeting: selection versus drawing defaults
  await loadDocument('targeting', []);
  await click('[data-redline-tool="rectangle"]');
  await click('[data-treatment="outline"]');
  await drag(100, 300, 250, 400);
  const first = (await exportJSON('first')).document.annotations[0];
  check('the style row names new-mark defaults while a drawing tool is active', await target() === 'New rectangles');
  await evaluate(() => {
    const select = globalThis.__redlineTestRoot.querySelector('select[aria-label="Line weight"]');
    select.value = select.options[6].value;
    select.dispatchEvent(new Event('change'));
  });
  await click('[data-treatment="outline-fill"]');
  await click('[data-fill-opacity="0.75"]');
  const untouched = (await exportJSON('untouched')).document.annotations[0];
  check('drawing presets never restyle the last-created mark', JSON.stringify(untouched) === JSON.stringify(first), JSON.stringify({ first, untouched }));
  await drag(300, 300, 450, 400);
  const second = (await exportJSON('second')).document.annotations[1];
  check('the next mark uses the new defaults', second.fillOpacity === 0.75 && Math.abs(second.width - 4) < 1e-9, JSON.stringify(second));

  await click('[data-redline-tool="select"]');
  await page.mouse.click(100, 350);
  await waitUntil(async () => (await target()) === 'Selected rectangle', 'first selected');
  const selectionControls = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    return { treatment: root.querySelector('[data-treatment][aria-pressed="true"]')?.dataset.treatment,
      width: root.querySelector('select[aria-label="Line weight"]').value, context: root.querySelector('[data-redline-context]').getAttribute('aria-label') };
  });
  check('selecting a mark shows that mark\'s own style, labelled as the selection',
    selectionControls.treatment === 'outline' && Number(selectionControls.width) === first.width && /selected rectangle/.test(selectionControls.context),
    JSON.stringify(selectionControls));
  await click('[data-treatment="fill"]');
  await click('[data-fill-opacity="0.1"]');
  await pickPreset('fill', 'question');
  const styled = (await exportJSON('styled')).document.annotations;
  check('selection edits change only the selected mark',
    styled[0].fillOpacity === 0.1 && styled[0].outline === false && styled[0].fill.toUpperCase() === '#D97706'
    && JSON.stringify(styled[1]) === JSON.stringify(second), JSON.stringify(styled));
  await click('[data-redline-tool="rectangle"]');
  const defaultsAfter = await evaluate(() => ({
    treatment: globalThis.__redlineTestRoot.querySelector('[data-treatment][aria-pressed="true"]')?.dataset.treatment,
    opacity: globalThis.__redlineTestRoot.querySelector('[data-fill-opacity][aria-pressed="true"]')?.dataset.fillOpacity,
  }));
  check('selection edits leave the drawing defaults alone',
    defaultsAfter.treatment === 'outline-fill' && defaultsAfter.opacity === '0.75', JSON.stringify(defaultsAfter));
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const undone = (await exportJSON('undone')).document.annotations[0];
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  const redone = (await exportJSON('redone')).document;
  check('undo restores the exact original style and redo reapplies each edit',
    JSON.stringify(undone) === JSON.stringify(first) && JSON.stringify(redone.annotations[0]) === JSON.stringify(styled[0]),
    JSON.stringify({ undone, redone: redone.annotations[0] }));
  await loadDocument('roundtrip', redone.annotations.map(mark => (mark.id === styled[1].id ? { ...mark, fillOpacity: 0.35, width: 7 } : mark)));
  await click('[data-redline-tool="select"]');
  await page.mouse.click(375, 350);
  await waitUntil(async () => (await target()) === 'Selected rectangle', 'imported mark selected');
  const exact = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const custom = root.querySelector('[data-fill-opacity="custom"]');
    return { customHidden: custom.hidden, customPressed: custom.getAttribute('aria-pressed'), customText: custom.textContent.trim(),
      width: root.querySelector('select[aria-label="Line weight"]').value };
  });
  check('an imported mark\'s unlisted opacity and weight are shown exactly, not rounded',
    !exact.customHidden && exact.customPressed === 'true' && exact.customText === '35%' && exact.width === '7', JSON.stringify(exact));

  // ---------------------------------------------------------------------------
  // Graduated fill opacity: preview and PNG
  const opacities = [0.1, 0.25, 0.5, 0.75, 1];
  await loadDocument('opacity', opacities.map((fillOpacity, index) => ({
    id: `o${index}`, type: 'rectangle', color: '#000000', fill: '#000000', fillOpacity, outline: false,
    start: { x: 100 + index * 200, y: 300 }, end: { x: 260 + index * 200, y: 420 },
  })));
  const centres = opacities.map((_, index) => [180 + index * 200, 360]);
  const background = [[180, 480]];
  await hideChrome(true);
  await page.mouse.move(1190, 790);
  const opacityShot = await page.screenshot();
  await hideChrome(false);
  const previewPixels = await samplePng(evaluate, opacityShot, [...centres, ...background]);
  const pngPixels = await samplePng(evaluate, await exportPNG('opacity'), [...centres, ...background]);
  const ground = previewPixels.at(-1)[0];
  const expected = opacities.map(alpha => Math.round(ground * (1 - alpha)));
  check('each graduated opacity paints its own transparency in the preview',
    previewPixels.slice(0, 5).every((pixel, index) => Math.abs(pixel[0] - expected[index]) <= 6), JSON.stringify({ expected, preview: previewPixels.map(pixel => pixel[0]) }));
  check('the PNG paints the same graduated opacities as the preview',
    pngPixels.slice(0, 5).every((pixel, index) => Math.abs(pixel[0] - previewPixels[index][0]) <= 6), JSON.stringify({ png: pngPixels.map(pixel => pixel[0]) }));
  await click('[data-redline-tool="select"]');
  await page.mouse.click(180, 360);
  await waitUntil(async () => (await target()) === 'Selected rectangle', 'opacity mark selected');
  const swatches = await evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('[data-fill-opacity]:not([data-fill-opacity="custom"])')].map(node => ({
    value: node.dataset.fillOpacity,
    paint: getComputedStyle(node.querySelector('[data-redline-opacity-swatch] > span')).opacity,
    ground: getComputedStyle(node.querySelector('[data-redline-opacity-swatch]')).backgroundImage.includes('conic-gradient'),
  })));
  check('fill opacity choices preview real transparency over a checkerboard',
    swatches.map(item => item.value).join() === '0.1,0.25,0.5,0.75,1' && swatches.every(item => item.ground && Number(item.paint) === Number(item.value)),
    JSON.stringify(swatches));

  // ---------------------------------------------------------------------------
  // Shapes, Shift constraints, and line ends
  await loadDocument('shapes', []);
  await click('[data-redline-tool="ellipse"]');
  await drag(100, 300, 260, 360, { shift: true });
  await click('[data-redline-tool="rectangle"]');
  await drag(300, 300, 380, 420, { shift: true });
  await click('[data-redline-tool="line"]');
  await drag(450, 300, 600, 330, { shift: true });
  await click('[data-redline-tool="polyline"]');
  await page.mouse.click(700, 300);
  await page.keyboard.down('Shift');
  await page.mouse.click(820, 390);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  const shapes = (await exportJSON('shapes')).document.annotations;
  const size = mark => [Math.abs(mark.end.x - mark.start.x), Math.abs(mark.end.y - mark.start.y)];
  check('Shift draws a circle with the ellipse tool', shapes[0].type === 'ellipse' && Math.abs(size(shapes[0])[0] - size(shapes[0])[1]) < 0.01, JSON.stringify(shapes[0]));
  check('Shift draws a square with the rectangle tool', shapes[1].type === 'rectangle' && Math.abs(size(shapes[1])[0] - size(shapes[1])[1]) < 0.01, JSON.stringify(shapes[1]));
  check('Shift snaps a line to 45° increments', Math.abs(shapes[2].end.y - shapes[2].start.y) < 0.01, JSON.stringify(shapes[2]));
  const [p0, p1] = shapes[3].points;
  check('Shift snaps polyline segments too', Math.abs(Math.abs(p1.x - p0.x) - Math.abs(p1.y - p0.y)) < 0.01, JSON.stringify(shapes[3].points));

  await loadDocument('ends', []);
  await click('[data-redline-tool="line"]');
  check('Line and Arrow offer pictorial end presets with Start and End controls', await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    return root.querySelectorAll('[data-end-preset] svg[data-redline-ends-icon]').length === 6
      && root.querySelector('select[aria-label="Start decoration"]').checkVisibility()
      && root.querySelector('select[aria-label="End decoration"]').checkVisibility();
  }));
  await click('[data-end-preset="dot-arrow"]');
  await drag(200, 320, 500, 320);
  await click('[data-end-preset="arrow-both"]');
  await drag(200, 420, 500, 420);
  await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    root.querySelector('select[aria-label="Start decoration"]').value = 'open-circle';
    root.querySelector('select[aria-label="Start decoration"]').dispatchEvent(new Event('change'));
    root.querySelector('select[aria-label="End decoration"]').value = 'filled-circle';
    root.querySelector('select[aria-label="End decoration"]').dispatchEvent(new Event('change'));
  });
  await drag(200, 520, 500, 520);
  await click('[data-redline-tool="arrow"]');
  const arrowDefault = await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-end-preset][aria-pressed="true"]')?.dataset.endPreset);
  await drag(600, 320, 900, 320);
  await click('[data-end-preset="arrow-start"]');
  await drag(600, 420, 900, 420);
  const ends = (await exportJSON('ends')).document.annotations;
  const decorations = mark => `${mark.type}:${mark.startDecoration ?? '-'}:${mark.endDecoration ?? '-'}`;
  check('line ends are independent and serialise canonically',
    JSON.stringify(ends.map(decorations)) === JSON.stringify(['line:filled-circle:arrow', 'line:arrow:arrow', 'line:open-circle:filled-circle', 'arrow:-:-', 'line:arrow:-']),
    JSON.stringify(ends.map(decorations)));
  check('the Arrow tool remains a one-ended arrow preset', arrowDefault === 'arrow-end', String(arrowDefault));
  const decorationNodes = await evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('[data-redline-marks] > g')].map(group => ({
    circles: group.querySelectorAll('circle').length, heads: group.querySelectorAll('polyline').length,
  })));
  check('the preview draws each decoration',
    JSON.stringify(decorationNodes) === JSON.stringify([{ circles: 1, heads: 1 }, { circles: 0, heads: 2 }, { circles: 2, heads: 0 }, { circles: 0, heads: 1 }, { circles: 0, heads: 1 }]),
    JSON.stringify(decorationNodes));
  const endPixels = await samplePng(evaluate, await exportPNG('ends'), [[200, 320], [500, 520], [200, 520], [203, 420], [350, 520]]);
  // Default ink is #B65D66; the hollow circle's centre must show the page instead.
  const inked = pixel => Math.abs(pixel[0] - 182) + Math.abs(pixel[1] - 93) + Math.abs(pixel[2] - 102) < 60;
  check('the PNG draws filled circles, hollow circles and arrowheads',
    inked(endPixels[0]) && inked(endPixels[1]) && !inked(endPixels[2]) && endPixels[2][1] > 200 && inked(endPixels[3]) && inked(endPixels[4]),
    JSON.stringify(endPixels));
  await click('[data-redline-tool="select"]');
  await page.mouse.click(350, 520);
  await waitUntil(async () => (await target()) === 'Selected line', 'decorated line selected');
  const selectionBox = await evaluate(() => {
    const box = globalThis.__redlineTestRoot.querySelector('[data-redline-selection]').getBoundingClientRect();
    return { left: box.left, right: box.right };
  });
  check('selection bounds include end decorations', selectionBox.left < 196 && selectionBox.right > 504, JSON.stringify(selectionBox));

  // ---------------------------------------------------------------------------
  // Duplicate, nudge, and history units
  const beforeDuplicate = (await exportJSON('before-duplicate')).document.annotations;
  const selectedLine = beforeDuplicate[2];
  await page.keyboard.press('Control+d');
  const duplicated = (await exportJSON('duplicated')).document.annotations;
  const copy = duplicated.at(-1);
  check('Ctrl+D duplicates the selected mark with a new id, offset, and selects the copy',
    duplicated.length === beforeDuplicate.length + 1 && copy.id !== selectedLine.id && Math.abs(copy.start.x - selectedLine.start.x - 12) < 0.01
    && copy.startDecoration === 'open-circle' && await target() === 'Selected line', JSON.stringify(copy));
  await click('[data-redline-action="duplicate"]');
  check('the style row Duplicate button duplicates too', (await exportJSON('duplicated-button')).document.annotations.length === duplicated.length + 1);
  const beforeNudge = (await exportJSON('before-nudge')).document.annotations.at(-1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const nudged = (await exportJSON('nudged')).document.annotations.at(-1);
  check('arrow keys nudge one screen pixel and Shift nudges ten',
    Math.abs(nudged.start.x - beforeNudge.start.x - 2) < 0.01 && Math.abs(nudged.start.y - beforeNudge.start.y - 10) < 0.01, JSON.stringify({ beforeNudge, nudged }));
  await page.keyboard.press('Control+z');
  const nudgeUndone = (await exportJSON('nudge-undone')).document.annotations.at(-1);
  check('a quick run of nudges is one undo step', JSON.stringify(nudgeUndone) === JSON.stringify(beforeNudge), JSON.stringify(nudgeUndone));
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('select[aria-label="Line weight"]').focus());
  await page.keyboard.press('ArrowDown');
  const afterSelectKey = (await exportJSON('select-key')).document.annotations.at(-1);
  check('arrow keys in a dropdown do not move the mark', JSON.stringify(afterSelectKey.start) === JSON.stringify(nudgeUndone.start));
  await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    root.querySelector('[data-redline-tool="pen"]').click();
    root.querySelector('[data-redline-tool="pen"]').focus();
    globalThis.__ctrlD = null;
    window.addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 'd' && !globalThis.__ctrlD) globalThis.__ctrlD = { reached: true, prevented: event.defaultPrevented };
    });
  });
  const marksBeforeCtrlD = await marks();
  await page.keyboard.press('Control+d');
  const ctrlD = await evaluate(() => globalThis.__ctrlD);
  check('Ctrl+D with nothing selected is not intercepted, so the browser keeps its shortcut',
    ctrlD?.reached && !ctrlD.prevented && await marks() === marksBeforeCtrlD, JSON.stringify(ctrlD));

  // ---------------------------------------------------------------------------
  // Eraser geometry
  await loadDocument('eraser', [
    { id: 'big-outline', type: 'rectangle', color: '#16A34A', width: 2, start: { x: 100, y: 250 }, end: { x: 1100, y: 750 } },
    { id: 'l1', type: 'line', color: '#111827', start: { x: 300, y: 400 }, end: { x: 300, y: 600 } },
    { id: 'l2', type: 'line', color: '#111827', start: { x: 360, y: 400 }, end: { x: 360, y: 600 } },
  ]);
  await click('[data-redline-tool="eraser"]');
  await page.mouse.click(700, 500);
  check('clicking empty space inside a large outline does not erase it', await marks() === 3);
  await drag(260, 500, 400, 500, { steps: 12 });
  check('dragging the eraser across marks erases each of them', await marks() === 1);
  await page.keyboard.press('Control+z');
  check('one undo restores everything a single erasing drag removed', await marks() === 3);
  await page.mouse.click(101, 500);
  check('clicking the outline itself erases it', (await exportJSON('erased')).document.annotations.every(mark => mark.id !== 'big-outline'));

  // ---------------------------------------------------------------------------
  // Import reporting and atomic rejection of new fields
  const importPath = path.join(scratch, 'future.json');
  await fs.writeFile(importPath, JSON.stringify({ format: 'open-redline', version: 1, document: {
    // Phase 2 made `legend` a supported field; `theme` stands in as the unknown one.
    width: 1200, height: 800, theme: { dark: true },
    annotations: [{ id: 'future', type: 'rectangle', color: '#000000', start: { x: 10, y: 300 }, end: { x: 90, y: 380 }, shadow: 'soft' }],
  } }));
  await importFile(importPath);
  await waitUntil(() => evaluate(() => /not kept/.test(globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent)), 'ignored fields reported');
  check('unsupported imported fields are named, not silently dropped', await evaluate(() =>
    /document\.theme/.test(globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent)
    && /rectangle\.shadow/.test(globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent)));
  const beforeBad = (await exportJSON('before-bad')).document;
  const badPath = path.join(scratch, 'bad-decoration.json');
  await fs.writeFile(badPath, JSON.stringify({ format: 'open-redline', version: 1, document: {
    width: 1200, height: 800, annotations: [{ id: 'bad', type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, endDecoration: 'rocket' }],
  } }));
  await importFile(badPath);
  await waitUntil(() => evaluate(() => /decoration/.test(globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent)), 'bad decoration rejected');
  check('an invalid decoration is rejected without touching the current document',
    JSON.stringify((await exportJSON('after-bad')).document) === JSON.stringify(beforeBad));

  // ---------------------------------------------------------------------------
  // Light theme: rendered contrast, and annotations independent of the theme
  await click('[data-redline-tool="rectangle"]');
  const contrast = await evaluate(() => {
    const parse = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = ([r, g, b]) => [r, g, b].map(channel => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const root = globalThis.__redlineTestRoot;
    const opaqueBackground = node => {
      for (let el = node; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (!/rgba\(.*, 0\)$/.test(color) && color !== 'transparent') return parse(color);
      }
      return [255, 255, 255];
    };
    const pairs = [
      ['[data-redline-target]', 'style row label'],
      ['[data-redline-field] > span', 'field caption'],
      ['[data-redline-strip-section="capture"] [data-redline-action="copy"]', 'Copy image'],
      ['[data-redline-strip-section="drawing"] [data-redline-tool][data-active]', 'active tool'],
    ];
    return pairs.map(([selector, name]) => {
      const node = [...root.querySelectorAll(selector)].find(element => element.checkVisibility());
      return { name, ratio: node ? Math.round(ratio(parse(getComputedStyle(node).color), opaqueBackground(node)) * 100) / 100 : null };
    });
  });
  check('rendered interface text meets 4.5:1 contrast', contrast.every(item => item.ratio >= 4.5), JSON.stringify(contrast));
  await loadDocument('theme', [
    { id: 'note-theme', type: 'note', color: '#0F766E', point: { x: 200, y: 400 }, number: 2, text: 'Theme check' },
    { id: 'text-theme', type: 'textbox', color: '#7C3AED', text: 'Theme', start: { x: 400, y: 380 }, end: { x: 520, y: 430 } },
  ]);
  const markPaint = await evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    return {
      noteCircle: root.querySelector('[data-redline-id="note-theme"] circle').getAttribute('fill'),
      noteLabel: root.querySelector('[data-redline-id="note-theme"] rect').getAttribute('stroke'),
      textStroke: root.querySelector('[data-redline-id="text-theme"] rect').getAttribute('stroke'),
      textFill: root.querySelector('[data-redline-id="text-theme"] rect').getAttribute('fill'),
      computedStroke: getComputedStyle(root.querySelector('[data-redline-id="text-theme"] rect')).stroke,
    };
  });
  check('imported annotations keep their own colours under the light theme',
    markPaint.noteCircle === '#0F766E' && markPaint.noteLabel === '#0F766E' && markPaint.textStroke === '#7C3AED'
    && markPaint.textFill === 'rgba(255,255,255,0.75)' && markPaint.computedStroke === 'rgb(124, 58, 237)', JSON.stringify(markPaint));

  await redline.dispose();
} catch (error) {
  check('phase 1 suite completed without an unhandled error', false, error.message);
  console.error(error);
  if (page) {
    const file = path.join(scratch, 'phase1-failure.png');
    await page.screenshot({ path: file }).catch(() => {});
    console.error('Failure screenshot: ' + file);
  }
} finally {
  await context.close().catch(() => {});
  server.close();
  const failed = results.filter(result => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} phase 1 checks passed`);
  if (failed.length) console.log('Failed: ' + failed.map(result => result.name).join('; '));
  process.exit(failed.length ? 1 : 0);
}
