/**
 * Phase 2 acceptance: 1–9 / A–Z bullets, label exhaustion, legacy notes, the
 * optional legend and its Canvas-rendered explanation editor, through real
 * pointer and keyboard input at DPR 2 (full) and DPR 1 (editing, parity and
 * scaling).
 *
 *   node test/phase2-browser.mjs [--headed]
 *
 * Click targets inside the canvas legend are computed by importing the
 * extension's own DOM-free layout module into the DevTools test world, so
 * they use the same code and font metrics as the editor. Production code gains
 * no hooks. Screenshots go to test-artifacts/phase2.
 *
 * Clipboard shortcuts here use Chromium's in-browser clipboard, and
 * composition uses DevTools Input.imeSetComposition; neither is a real
 * operating-system clipboard or input method.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';

const SHOTS = path.join('test-artifacts', 'phase2');
await fs.mkdir(SHOTS, { recursive: true });
const { results, check } = createChecker();
const { server, origin } = await startServer({
  '/plain': '<!doctype html><html><head><title>Phase 2 fixture</title></head><body style="margin:0;background:#FFFFFF">'
    + '<button id="page-button" style="position:absolute;left:600px;top:740px;font:16px sans-serif">Page button</button></body></html>',
});

const bulletMark = (label, x, y, extra = {}) => ({ id: `b-${label}`, type: 'bullet', color: '#1D4ED8', point: { x, y }, label, ...extra });
const LABELS = [...'123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

async function run(dpr, { full }) {
  const tag = `[DPR ${dpr}]`;
  const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr });
  const errors = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !/Could not import|Duplicate bullet|bullet label|bullet explanation|legend\.|not a supported/.test(message.text())) {
        errors.push(message.text());
      }
    });
    await page.goto(`${origin}/plain`);
    // Page-world observers, installed before Redline runs.
    await page.evaluate(() => {
      const seen = globalThis.__pageSeen = { keydowns: 0, nodes: [], details: [] };
      window.addEventListener('keydown', () => { seen.keydowns += 1; });
      for (const type of ['input', 'change', 'redline:changed']) {
        window.addEventListener(type, event => {
          if (event.detail !== undefined && event.detail !== null && typeof event.detail !== 'number') seen.details.push(JSON.stringify(event.detail));
        }, true);
      }
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element) || node.matches('[data-redline-extension]')) continue;
            seen.nodes.push(node.outerHTML.slice(0, 80));
          }
        }
      }).observe(document, { childList: true, subtree: true });
      document.getElementById('page-button').addEventListener('click', () => { seen.pageClicked = true; });
    });

    const redline = await openRedline({ context, worker, page });
    const { evaluate, importFile, inject } = redline;
    const base = worker.url().replace(/service-worker\.js$/, '');
    const cdp = await context.newCDPSession(page);

    const rect = selector => evaluate(value => {
      const node = globalThis.__redlineTestRoot.querySelector(value);
      if (!node) throw new Error('Missing ' + value);
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, left: box.left, right: box.right, visible: node.checkVisibility() };
    }, selector);
    /** A real mouse click on a control's centre. */
    const press = async selector => {
      const box = await rect(selector);
      if (!box.visible || !box.width) throw new Error(`Not clickable: ${selector}`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const programmaticClick = selector => evaluate(value => globalThis.__redlineTestRoot.querySelector(value).click(), selector);
    /** Open a native select with the mouse and choose with the keyboard. */
    const choose = async (selector, value) => {
      const info = await evaluate(({ selector, value }) => {
        const node = globalThis.__redlineTestRoot.querySelector(selector);
        return [...node.options].findIndex(option => option.value === String(value));
      }, { selector, value });
      if (info < 0) throw new Error(`No option ${value} in ${selector}`);
      await press(selector);
      await page.keyboard.press('Home');
      for (let i = 0; i < info; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await waitUntil(() => evaluate(({ selector, value }) => globalThis.__redlineTestRoot.querySelector(selector).value === String(value)
        || globalThis.__redlineTestRoot.querySelector(selector).value === '', { selector, value }), `${selector} = ${value}`);
    };
    const state = () => evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      const input = root.querySelector('[data-redline-legend-input]');
      const canvas = root.querySelector('[data-redline-legend-canvas]');
      const style = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      return {
        focused: root.activeElement === input,
        activeTag: root.activeElement?.tagName?.toLowerCase() ?? null,
        label: input.getAttribute('aria-label'),
        value: input.value, start: input.selectionStart, end: input.selectionEnd,
        canvas: canvas.getAttribute('aria-label'), overflow: canvas.dataset.overflow, clipped: canvas.dataset.clipped ?? '',
        canvasDisplay: getComputedStyle(canvas).display,
        tool: root.querySelector('[data-redline-canvas]').dataset.tool,
        target: root.querySelector('[data-redline-target]').textContent,
        message: root.querySelector('[data-redline-message]').textContent,
        limit: root.querySelector('[data-redline-control="bulletLimit"]').hidden ? null : root.querySelector('[data-redline-bullet-limit-text]').textContent,
        switchVisible: !root.querySelector('[data-redline-bullet-switch]').hidden && !root.querySelector('[data-redline-control="bulletLimit"]').hidden,
        scheme: root.querySelector('select[aria-label="Bullet labels"]').value,
        open: root.querySelector('[data-redline-root]').open,
        marks: root.querySelectorAll('[data-redline-marks] > [data-redline-id]').length,
        input: { width: box.width, height: box.height, opacity: style.opacity, pointer: style.pointerEvents, color: style.color },
      };
    });
    const exportFile = async (action, name, timeout = 40000) => {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout }), programmaticClick(`[data-redline-action="${action}"]`)]);
      const file = path.join(scratch, name);
      await download.saveAs(file);
      await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'export finished', 20000);
      return fs.readFile(file);
    };
    const exportJSON = async (name = 'probe') => JSON.parse(await exportFile('json', `${name}.json`)).document;
    const exportPNG = async name => {
      const png = await exportFile('download', `${name}.png`);
      await page.waitForTimeout(600); // captureVisibleTab allows two captures per second
      return png;
    };
    const load = async (name, document) => {
      const file = path.join(scratch, `${name}.json`);
      await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document }));
      await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent = ''; });
      await importFile(file);
      await waitUntil(async () => (await state()).marks === document.annotations.length
        && /Imported/.test((await state()).message), `${name} imported`);
    };
    const bullets = doc => doc.annotations.filter(mark => mark.type === 'bullet');
    const labelsOf = doc => bullets(doc).map(mark => mark.label);
    /** Legend layout in CSS pixels from the extension's own layout code. */
    const layoutOf = (doc, draft = null) => evaluate(async ({ base, doc, draft }) => {
      const L = await import(base + 'redline/RedlineLegend.js');
      const T = await import(base + 'redline/RedlineTextLayout.js');
      const measurer = T.createCanvasMeasurer();
      const texts = draft ? new Map([[draft.id, draft.text]]) : null;
      const layout = L.layoutLegend({ ...doc.legend, height: doc.legend.height ?? null }, doc.annotations, measurer, { texts });
      const sx = innerWidth / doc.width;
      const sy = innerHeight / doc.height;
      const lh = layout.metrics.lineHeight;
      return {
        sx, sy, overflows: layout.overflows, contentHeight: layout.contentHeight,
        box: { x: layout.box.x * sx, y: layout.box.y * sy, width: layout.box.width * sx, height: layout.box.height * sy },
        text: { x: layout.textX * sx, width: layout.textWidth * sx },
        rows: layout.rows.map(row => ({
          id: row.id, label: row.label, text: row.text,
          glyph: { x: row.cx * sx, y: row.cy * sy },
          top: row.top * sy, bottom: row.bottom * sy,
          lines: row.lines.map(line => ({ start: line.start, end: line.end, y: (line.top + lh / 2) * sy })),
          carets: row.text.length > 400 ? [] : Array.from({ length: row.text.length + 1 }, (_, index) => {
            const caret = L.caretPoint(layout, row, index, 'downstream', measurer);
            return { x: caret.x * sx, y: (caret.top + lh / 2) * sy };
          }),
        })),
      };
    }, { base, doc, draft });
    const decode = `async base64 => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return { ctx, width: image.width, height: image.height };
    }`;
    /** Dark and non-white pixels inside a CSS rectangle of a full-viewport image. */
    const inkIn = (buffer, area) => evaluate(async ({ base64, area, decode }) => {
      const { ctx, width, height } = await (0, eval)(`(${decode})`)(base64);
      const sx = width / innerWidth;
      const sy = height / innerHeight;
      const x = Math.max(0, Math.round(area.x * sx));
      const y = Math.max(0, Math.round(area.y * sy));
      const w = Math.max(1, Math.min(width - x, Math.round(area.width * sx)));
      const h = Math.max(1, Math.min(height - y, Math.round(area.height * sy)));
      const data = ctx.getImageData(x, y, w, h).data;
      let dark = 0;
      let nonWhite = 0;
      let blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (luma < 150) dark += 1;
        if (luma < 245) nonWhite += 1;
        if (data[i + 2] > 150 && data[i] < 120) blue += 1;
      }
      return { dark, nonWhite, blue };
    }, { base64: buffer.toString('base64'), area, decode });
    const pixelAt = (buffer, point) => evaluate(async ({ base64, point, decode }) => {
      const { ctx, width } = await (0, eval)(`(${decode})`)(base64);
      const scale = width / innerWidth;
      return [...ctx.getImageData(Math.round(point.x * scale), Math.round(point.y * scale), 1, 1).data];
    }, { base64: buffer.toString('base64'), point, decode });
    const rowProfile = (buffer, area) => evaluate(async ({ base64, area, decode }) => {
      const { ctx, width, height } = await (0, eval)(`(${decode})`)(base64);
      const sx = width / innerWidth;
      const sy = height / innerHeight;
      const x = Math.round(area.x * sx);
      const y = Math.round(area.y * sy);
      const w = Math.min(width - x, Math.round(area.width * sx));
      const h = Math.min(height - y, Math.round(area.height * sy));
      const data = ctx.getImageData(x, y, w, h).data;
      const rows = [];
      for (let row = 0; row < h; row++) {
        let count = 0;
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4;
          if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 120) count += 1;
        }
        rows.push(count);
      }
      return rows;
    }, { base64: buffer.toString('base64'), area, decode });
    const hideChrome = hidden => evaluate(value => {
      for (const node of globalThis.__redlineTestRoot.querySelectorAll('[data-redline-dock], [data-redline-toast], [data-redline-crop-panel]')) {
        node.style.visibility = value ? 'hidden' : '';
      }
    }, hidden);
    const drag = async (from, to, steps = 8) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps });
      await page.mouse.up();
    };

    // =========================================================================
    // Bullet tool, hidden-legend placement, schemes, reuse of freed labels
    await press('[data-redline-tool="select"]');
    await page.mouse.click(700, 650);
    await page.keyboard.press('u');
    let s = await state();
    const toolInfo = await evaluate(() => {
      const button = globalThis.__redlineTestRoot.querySelector('[data-redline-tool="bullet"]');
      return { icon: Boolean(button.querySelector('svg')), label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed') };
    });
    check(`${tag} the Bullet tool is on the bar with an icon, accessible name and the U shortcut`,
      s.tool === 'bullet' && toolInfo.icon && toolInfo.label === 'Bullet (U)' && toolInfo.pressed === 'true', JSON.stringify(toolInfo));
    check(`${tag} a new session starts with the legend hidden`, s.canvas === 'Legend hidden' && s.target === 'New bullets');

    await page.mouse.click(300, 300);
    s = await state();
    check(`${tag} with the legend hidden, a click places a bullet with no dialog and no typing`,
      !s.focused && s.marks === 1 && s.tool === 'bullet' && !(await evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('dialog[data-redline-host-dialog]')].some(node => node.open))), JSON.stringify(s));
    await page.mouse.click(360, 300);
    let doc = await exportJSON('first');
    check(`${tag} successive clicks place 1 then 2 with no explanation text`,
      JSON.stringify(labelsOf(doc)) === '["1","2"]' && bullets(doc).every(mark => !('text' in mark)), JSON.stringify(bullets(doc)));

    if (full) {
      const firstIds = bullets(doc).map(mark => mark.id);
      await choose('select[aria-label="Bullet labels"]', 'alpha');
      await page.mouse.click(420, 300);
      await choose('select[aria-label="Bullet labels"]', 'numeric');
      await page.mouse.click(480, 300);
      doc = await exportJSON('schemes');
      check('numbers and letters are independent sequences; changing scheme affects only future bullets',
        JSON.stringify(labelsOf(doc)) === '["1","2","A","3"]' && JSON.stringify(bullets(doc).slice(0, 2).map(mark => mark.id)) === JSON.stringify(firstIds),
        JSON.stringify(labelsOf(doc)));

      await press('[data-redline-tool="select"]');
      await page.mouse.click(360, 300);
      s = await state();
      check('selecting a bullet names it in the style row', s.target === 'Selected bullet 2', s.target);
      const three = bullets(doc).find(mark => mark.label === '3');
      await page.keyboard.press('Delete');
      await press('[data-redline-tool="bullet"]');
      await page.mouse.click(540, 300);
      doc = await exportJSON('reuse');
      const reused = bullets(doc).find(mark => mark.label === '2');
      check('a deleted label is the next one allocated, without renumbering the others',
        reused && reused.point.x === 540 && JSON.stringify(bullets(doc).find(mark => mark.id === three.id)) === JSON.stringify(three),
        JSON.stringify(labelsOf(doc)));

      // -----------------------------------------------------------------------
      // Exhaustion
      await load('nine', {
        width: 1200, height: 800,
        annotations: [...LABELS.slice(0, 9).map((label, i) => bulletMark(label, 100 + i * 60, 200)), bulletMark('A', 100, 260)],
      });
      await press('[data-redline-tool="bullet"]');
      await page.mouse.click(600, 600);
      s = await state();
      doc = await exportJSON('nine-after');
      check('a full 1–9 range places nothing, explains the limit and offers A–Z without switching',
        s.marks === 10 && /All 9 numbered bullets \(1–9\) are in use/.test(s.limit ?? '') && /A–Z/.test(s.limit ?? '')
        && s.switchVisible && s.scheme === 'numeric' && !labelsOf(doc).includes('10'), JSON.stringify(s));
      await press('[data-redline-bullet-switch]');
      s = await state();
      await page.mouse.click(600, 600);
      doc = await exportJSON('nine-switched');
      check('choosing the offered A–Z switch places the next free letter',
        s.scheme === 'alpha' && s.limit === null && labelsOf(doc).at(-1) === 'B', JSON.stringify(labelsOf(doc)));

      await load('all', {
        width: 1200, height: 800,
        annotations: LABELS.map((label, i) => bulletMark(label, 60 + (i % 12) * 80, 120 + Math.floor(i / 12) * 60)),
      });
      await press('[data-redline-tool="bullet"]');
      await page.mouse.click(600, 650);
      s = await state();
      check('with all 35 labels used, placement explains that and offers no switch',
        s.marks === 35 && /All 35 bullet labels/.test(s.limit ?? '') && !s.switchVisible, JSON.stringify(s));
      await press('[data-redline-tool="select"]');
      await page.mouse.click(380, 120);
      await page.keyboard.press('Control+d');
      s = await state();
      check('duplicating a bullet respects exhaustion: nothing is added and the reason is given',
        s.marks === 35 && /Cannot duplicate bullet 5/.test(s.message), s.message);

      // -----------------------------------------------------------------------
      // Legacy notes beside bullets
      const legacyNotes = [
        { id: 'n10', type: 'note', color: '#B65D66', width: 1.333, point: { x: 120, y: 500 }, number: 10, text: 'Legacy ten' },
        { id: 'naa', type: 'note', color: '#B65D66', width: 1.333, point: { x: 120, y: 580 }, number: 27, marker: 'alpha', text: 'Legacy AA' },
      ];
      await load('legacy', { width: 1200, height: 800, annotations: [...legacyNotes, bulletMark('1', 500, 500, { text: 'New bullet' })] });
      const glyphs = await evaluate(() => ['n10', 'naa', 'b-1'].map(id => globalThis.__redlineTestRoot.querySelector(`[data-redline-id="${id}"] text`).textContent));
      doc = await exportJSON('legacy');
      check('legacy 10 and AA notes keep their glyphs and fields beside bullets',
        JSON.stringify(glyphs) === '["10","AA","1"]'
        && JSON.stringify(doc.annotations.slice(0, 2).map(({ number, marker }) => ({ number, marker }))) === '[{"number":10},{"number":27,"marker":"alpha"}]',
        JSON.stringify(glyphs));
    }

    // =========================================================================
    // Legend on: immediate typing, canvas-only editing, commit and continue
    await load('empty', { width: 1200, height: 800, annotations: [] });
    await press('[data-redline-tool="bullet"]');
    if (full) await choose('select[aria-label="Bullet labels"]', 'numeric');
    await press('[data-redline-legend-toggle]');
    s = await state();
    check(`${tag} the Legend button shows the legend (pressed state)`,
      await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-legend-toggle]').getAttribute('aria-pressed')) === 'true');
    await page.mouse.click(250, 400);
    s = await state();
    check(`${tag} with the legend shown, placing a bullet focuses its explanation for typing at once`,
      s.focused && s.label === 'Explanation for bullet 1' && s.canvas === 'Legend with 1 explanation' && s.target === 'Bullet 1 explanation', JSON.stringify(s));
    const editorDom = await evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      const visibleEditors = [...root.querySelectorAll('textarea, input:not([type=file]), [contenteditable]')].filter(node => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return node.checkVisibility() && Number(style.opacity) > 0 && box.width > 2 && box.height > 2;
      }).map(node => node.outerHTML.slice(0, 60));
      return { visibleEditors, contentEditable: root.querySelectorAll('[contenteditable]').length, pageEditors: document.querySelectorAll('textarea, [contenteditable]').length };
    });
    check(`${tag} no visible HTML editor exists: the only text input is a transparent 1px textarea that takes no pointer, inside the closed root`,
      editorDom.visibleEditors.length === 0 && editorDom.contentEditable === 0 && editorDom.pageEditors === 0
      && s.input.opacity === '0' && s.input.width <= 1.5 && s.input.pointer === 'none', JSON.stringify({ editorDom, input: s.input }));

    doc = await exportJSON('legend-on');
    let layout = await layoutOf(doc);
    const legendArea = { x: layout.text.x, y: layout.box.y, width: layout.text.width, height: layout.box.height + 60 };
    const blank = await inkIn(await page.screenshot(), legendArea);
    const keydownsBefore = await page.evaluate(() => globalThis.__pageSeen.keydowns);
    await page.keyboard.type('Header misaligned');
    await page.keyboard.press('Enter');
    await page.keyboard.type('vpbrtenc shortcuts typed');
    s = await state();
    const typedShot = await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-editing.png`) });
    const typedInk = await inkIn(typedShot, legendArea);
    check(`${tag} typed multiline text is drawn on the canvas as it is typed`, typedInk.dark > blank.dark + 150, JSON.stringify({ blank, typedInk }));
    check(`${tag} typing tool shortcut letters and Enter edits text: no tool change, no new marks`,
      s.value === 'Header misaligned\nvpbrtenc shortcuts typed' && s.tool === 'bullet' && s.marks === 1, JSON.stringify(s));
    check(`${tag} keystrokes in the explanation never reach the page's own keyboard handlers`,
      await page.evaluate(() => globalThis.__pageSeen.keydowns) === keydownsBefore);
    await page.keyboard.press('Control+Enter');
    s = await state();
    doc = await exportJSON('committed');
    check(`${tag} Ctrl+Enter saves, returns focus to the drawing surface and keeps the Bullet tool`,
      !s.focused && s.activeTag === 'svg' && s.tool === 'bullet' && bullets(doc)[0].text === 'Header misaligned\nvpbrtenc shortcuts typed', JSON.stringify(s));

    await page.mouse.click(250, 480);
    await page.keyboard.type('Two');
    await page.mouse.click(250, 560);
    s = await state();
    check(`${tag} click, explain, click: clicking elsewhere saves and immediately explains the next bullet`,
      s.focused && s.label === 'Explanation for bullet 3', JSON.stringify(s));
    await page.keyboard.press('Escape');
    s = await state();
    doc = await exportJSON('flow');
    check(`${tag} Escape cancels only the text edit; Redline stays open and the placed bullet stays`,
      s.open && !s.focused && JSON.stringify(bullets(doc).map(mark => [mark.label, mark.text ?? null])) === '[["1","Header misaligned\\nvpbrtenc shortcuts typed"],["2","Two"],["3",null]]',
      JSON.stringify(bullets(doc)));
    await page.keyboard.press('Control+z');
    const afterOneUndo = labelsOf(await exportJSON('undo1'));
    await page.keyboard.press('Control+z');
    const afterTwoUndos = await exportJSON('undo2');
    await page.keyboard.press('Control+y');
    doc = await exportJSON('redo');
    check(`${tag} placing and typing is one undo step, and redo restores the bullet with its text`,
      JSON.stringify(afterOneUndo) === '["1","2"]' && JSON.stringify(labelsOf(afterTwoUndos)) === '["1"]'
      && bullets(doc).find(mark => mark.label === '2')?.text === 'Two', JSON.stringify({ afterOneUndo, afterTwo: labelsOf(afterTwoUndos) }));

    // =========================================================================
    // Caret, selection, navigation, clipboard, composition
    layout = await layoutOf(doc);
    let row = layout.rows.find(item => item.label === '1');
    await page.mouse.click(row.carets[0].x + 1, row.carets[0].y);
    s = await state();
    check(`${tag} clicking a legend row edits that bullet with the caret where it was clicked`,
      s.focused && s.label === 'Explanation for bullet 1' && s.start === 0 && s.end === 0, JSON.stringify(s));
    await page.keyboard.type('X');
    s = await state();
    layout = await layoutOf(doc, { id: row.id, text: s.value });
    row = layout.rows.find(item => item.label === '1');
    await page.mouse.click(row.carets[7].x, row.carets[7].y);
    await page.keyboard.type('_');
    s = await state();
    check(`${tag} a pointer click inside the text places the caret between the right characters`, s.value.startsWith('XHeader_ misaligned'), s.value);
    await page.keyboard.press('Shift+Home');
    s = await state();
    const homeSelection = [s.start, s.end];
    await page.keyboard.type('Y');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    s = await state();
    check(`${tag} Shift+Home selects to the line start, typing replaces the selection, End reaches the line end`,
      JSON.stringify(homeSelection) === '[0,8]' && s.value.split('\n')[0] === 'Y misaligned!', JSON.stringify({ homeSelection, value: s.value }));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.type('>');
    await page.keyboard.press('ArrowUp');
    s = await state();
    check(`${tag} ArrowDown/ArrowUp move between the drawn lines and Home follows the current line`,
      s.value.split('\n')[1].startsWith('>vpbrtenc') && s.start <= s.value.indexOf('\n'), JSON.stringify(s));

    layout = await layoutOf(doc, { id: row.id, text: s.value });
    row = layout.rows.find(item => item.label === '1');
    const wordAt = s.value.indexOf('shortcuts') + 3;
    await page.mouse.dblclick(row.carets[wordAt].x, row.carets[wordAt].y);
    s = await state();
    const doubleClicked = s.value.slice(s.start, s.end);
    await page.keyboard.type('keys');
    s = await state();
    check(`${tag} double-clicking a word selects it and typing replaces it`,
      doubleClicked === 'shortcuts' && s.value.includes('>vpbrtenc keys typed'), JSON.stringify({ doubleClicked, value: s.value }));

    layout = await layoutOf(doc, { id: row.id, text: s.value });
    row = layout.rows.find(item => item.label === '1');
    const typedAt = s.value.indexOf('typed');
    await drag(row.carets[typedAt], row.carets[typedAt + 5], 6);
    s = await state();
    const dragged = s.value.slice(s.start, s.end);
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' ');
    await page.keyboard.press('Control+v');
    s = await state();
    const pasted = s.value;
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Control+x');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+v');
    s = await state();
    const cutPasted = s.value;
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Delete');
    s = await state();
    check(`${tag} dragging selects text; copy, cut and paste (browser clipboard) and Backspace/Delete edit it`,
      dragged === 'typed' && pasted.endsWith('keys typed typed') && cutPasted.startsWith('typedY misaligned!') && s.value === 'Y misaligned!\n>vpbrtenc keys typed',
      JSON.stringify({ dragged, pasted, cutPasted, value: s.value }));
    await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-caret.png`) });
    await press('[data-redline-explanation-save]');
    doc = await exportJSON('caret');
    s = await state();
    check(`${tag} the Save button saves the edit (and keeps marks unchanged)`,
      bullets(doc).find(mark => mark.label === '1').text === 'Y misaligned!\n>vpbrtenc keys typed' && s.marks === 2 && !s.focused, JSON.stringify(bullets(doc)));

    layout = await layoutOf(doc);
    row = layout.rows.find(item => item.label === '2');
    await page.mouse.click(row.carets.at(-1).x + 2, row.carets.at(-1).y);
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    const composing = await state();
    const composingShot = await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-composition.png`) });
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '日本' });
    s = await state();
    const composed = s.value;
    await page.keyboard.press('Control+Enter');
    doc = await exportJSON('ime');
    check(`${tag} synthetic IME composition shows its text while composing and commits the result`,
      composing.value === 'Twoにほ' && composing.tool === 'bullet' && composed === 'Two日本'
      && bullets(doc).find(mark => mark.label === '2').text === 'Two日本'
      && (await inkIn(composingShot, { x: layout.text.x, y: row.top, width: layout.text.width, height: row.bottom - row.top })).dark > 20,
      JSON.stringify({ composing: composing.value, composed }));

    await page.mouse.click(row.carets.at(-1).x + 2, row.carets.at(-1).y);
    await page.keyboard.type(' zzz');
    await page.keyboard.press('Escape');
    const cancelled = await exportJSON('cancelled');
    s = await state();
    check(`${tag} Escape during a later edit restores the saved explanation`,
      bullets(cancelled).find(mark => mark.label === '2').text === 'Two日本' && s.open && !s.focused);

    if (full) {
      await page.mouse.click(row.carets.at(-1).x + 2, row.carets.at(-1).y);
      await page.keyboard.press('End');
      const beforeNativeUndo = (await state()).value;
      await page.keyboard.type(' undo-me');
      await page.keyboard.press('Control+z');
      const nativeUndo = (await state()).value;
      const long = 'lorem ipsum dolor sit amet '.repeat(370);
      await cdp.send('Input.insertText', { text: long });
      const started = Date.now();
      await page.keyboard.type('abcd');
      const typingMs = Date.now() - started;
      const nearLimit = await state();
      await page.keyboard.type('efghij');
      const atLimit = await state();
      const unscrolled = await evaluate(() => {
        const root = globalThis.__redlineTestRoot.querySelector('[data-redline-root]');
        return root.scrollTop === 0 && root.scrollLeft === 0
          && globalThis.__redlineTestRoot.querySelector('[data-redline-canvas]').getBoundingClientRect().top === 0;
      });
      check('a caret far below the window never scrolls the overlay (the hidden input stays inside the viewport)', unscrolled);
      await page.screenshot({ path: path.join(SHOTS, 'dpr2-long-explanation.png') });
      await page.keyboard.press('Escape');
      const afterLimit = await exportJSON('limit');
      check('inside the editor Ctrl+Z is the text field\'s own undo and leaves annotation history alone',
        nativeUndo === beforeNativeUndo && (await evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-action="undo"]').disabled)),
        JSON.stringify({ beforeNativeUndo, nativeUndo }));
      check('a near-10,000-character explanation stays responsive; past the limit input is refused with a message, not truncated',
        typingMs < 4000 && nearLimit.value.length === 5 + long.length + 4 && atLimit.value.length === 10000
        && /limited to 10,000 characters/.test(atLimit.message) && bullets(afterLimit).find(mark => mark.label === '2').text === 'Two日本',
        JSON.stringify({ typingMs, near: nearLimit.value.length, at: atLimit.value.length, message: atLimit.message }));

      await page.mouse.click(row.carets.at(-1).x + 2, row.carets.at(-1).y);
      await page.keyboard.press('End');
      await page.keyboard.type(' ok');
      await page.keyboard.press('Tab');
      s = await state();
      doc = await exportJSON('tab');
      check('Tab saves the explanation and leaves the editor', !s.focused && bullets(doc).find(mark => mark.label === '2').text === 'Two日本 ok');
    }

    // =========================================================================
    // Later editing, hiding the legend, editing while hidden
    await press('[data-redline-tool="select"]');
    await page.mouse.dblclick(250, 480);
    s = await state();
    check(`${tag} double-clicking a bullet on the page edits its explanation`, s.focused && s.label === 'Explanation for bullet 2', JSON.stringify(s));
    await page.keyboard.press('Escape');
    layout = await layoutOf(doc);
    const legendBox = { ...layout.box };
    await press('[data-redline-legend-toggle]');
    s = await state();
    doc = await exportJSON('hidden');
    const hiddenPng = await exportPNG(`dpr${dpr}-legend-hidden`);
    const hiddenInk = await inkIn(hiddenPng, legendBox);
    const bulletInk = await inkIn(hiddenPng, { x: 238, y: 392, width: 24, height: 16 });
    check(`${tag} hiding the legend keeps every explanation and exports markers only`,
      s.canvas === 'Legend hidden' && doc.legend.visible === false && bullets(doc).every(mark => mark.text)
      && hiddenInk.nonWhite === 0 && bulletInk.nonWhite > 60, JSON.stringify({ hiddenInk, bulletInk, texts: bullets(doc).map(mark => mark.text) }));

    await page.mouse.click(250, 400);
    await press('[data-redline-explain]');
    s = await state();
    const cardShot = await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-hidden-legend-card.png`) });
    const cardArea = { x: 280, y: 385, width: 300, height: 40 };
    const cardInk = await inkIn(cardShot, cardArea);
    await page.keyboard.press('End');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' (card)');
    await page.keyboard.press('Control+Enter');
    doc = await exportJSON('card');
    const cardPng = await exportPNG(`dpr${dpr}-card-export`);
    check(`${tag} with the legend hidden, Edit explanation opens a canvas card beside the bullet that is never exported`,
      /beside its marker; not exported/.test(s.canvas) && s.focused && cardInk.dark > 100
      && bullets(doc).find(mark => mark.label === '1').text.endsWith('(card)') && (await inkIn(cardPng, cardArea)).nonWhite === 0,
      JSON.stringify({ canvas: s.canvas, cardInk }));
    await page.keyboard.press('Enter');
    s = await state();
    check(`${tag} Enter on a selected bullet opens its explanation from the keyboard`, s.focused && s.label === 'Explanation for bullet 1', JSON.stringify(s));
    await page.keyboard.press('Escape');
    await press('[data-redline-legend-toggle]');
    s = await state();
    check(`${tag} showing the legend again restores both rows`, s.canvas === 'Legend with 2 explanations', s.canvas);

    const beforeMidEdit = await exportJSON('mid-edit');
    layout = await layoutOf(beforeMidEdit);
    await page.mouse.click(layout.rows[1].carets.at(-1).x + 2, layout.rows[1].carets.at(-1).y);
    await page.keyboard.press('End');
    await page.keyboard.type(' mid');
    await press('[data-redline-legend-toggle]');
    const midCard = await state();
    await page.keyboard.type('-edit');
    await press('[data-redline-legend-toggle]');
    const midRow = await state();
    await page.keyboard.press('Escape');
    const afterMidEdit = await exportJSON('mid-edit-after');
    check(`${tag} hiding and showing the legend mid-edit moves the open explanation between card and row without saving or losing text`,
      midCard.focused && /beside its marker/.test(midCard.canvas) && midRow.focused && midRow.value.endsWith(' mid-edit')
      && /Legend with 2/.test(midRow.canvas) && JSON.stringify(bullets(afterMidEdit)) === JSON.stringify(bullets(beforeMidEdit)),
      JSON.stringify({ midCard: [midCard.focused, midCard.canvas], midRow: [midRow.focused, midRow.value, midRow.canvas] }));

    if (full) {
      // -----------------------------------------------------------------------
      // Delete, undo, duplicate, move
      await page.mouse.click(250, 480);
      const beforeDelete = bullets(await exportJSON('before-delete')).find(mark => mark.label === '2');
      await page.keyboard.press('Delete');
      const deleted = await exportJSON('deleted');
      const deletedCanvas = (await state()).canvas;
      await page.keyboard.press('Control+z');
      const restored = bullets(await exportJSON('restored')).find(mark => mark.label === '2');
      check('deleting a bullet removes its legend row; one undo restores the identical id, label, point and text',
        !labelsOf(deleted).includes('2') && deletedCanvas === 'Legend with 1 explanation' && JSON.stringify(restored) === JSON.stringify(beforeDelete),
        JSON.stringify({ beforeDelete, restored }));

      await page.mouse.click(250, 400);
      await page.keyboard.press('Control+d');
      doc = await exportJSON('duplicate');
      const original = bullets(doc).find(mark => mark.label === '1');
      const copy = bullets(doc).at(-1);
      check('duplicating a bullet gives a new id and the next free label and keeps its explanation',
        copy.label === '3' && copy.id !== original.id && copy.text === original.text && copy.point.x > original.point.x, JSON.stringify(copy));

      // Press left of centre: the offset duplicate overlaps bullet 1's right side.
      await drag({ x: 240, y: 400 }, { x: 320, y: 440 });
      doc = await exportJSON('moved-bullet');
      const moved = bullets(doc).find(mark => mark.id === original.id);
      const rowOrder = (await layoutOf(doc)).rows.map(item => item.label).join('');
      check('moving a bullet keeps its label and the legend row order',
        moved.label === '1' && Math.round(moved.point.x) === 330 && rowOrder === '123', JSON.stringify({ moved, rowOrder }));

      // -----------------------------------------------------------------------
      // Moving, resizing and styling the legend
      layout = await layoutOf(doc);
      const oldLegend = doc.legend;
      const grab = layout.rows[1].carets[1];
      await drag(grab, { x: grab.x - 300, y: grab.y + 200 });
      doc = await exportJSON('legend-moved');
      s = await state();
      check('dragging the legend moves it as a unit and selects it without starting an edit',
        Math.abs(doc.legend.x - (oldLegend.x - 300)) < 2 && Math.abs(doc.legend.y - (oldLegend.y + 200)) < 2 && !s.focused && s.target === 'Legend',
        JSON.stringify({ old: oldLegend, legend: doc.legend, target: s.target }));
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');
      const nudged = (await exportJSON('legend-nudged')).legend;
      await page.keyboard.press('Control+z');
      const unNudged = (await exportJSON('legend-unnudged')).legend;
      await page.keyboard.press('Control+z');
      const unMoved = (await exportJSON('legend-unmoved')).legend;
      check('arrow keys nudge the selected legend; move and nudge each undo as one step',
        nudged.x === doc.legend.x + 1 && nudged.y === doc.legend.y + 10 && unNudged.x === doc.legend.x && unMoved.x === oldLegend.x && unMoved.y === oldLegend.y,
        JSON.stringify({ nudged, unNudged, unMoved }));
      await page.keyboard.press('Control+y');
      await page.keyboard.press('Control+y');
      doc = await exportJSON('legend-redo');

      await press('[data-redline-tool="bullet"]');
      await press('[data-redline-legend-options]');
      layout = await layoutOf(doc);
      const east = { x: layout.box.x + layout.box.width, y: layout.box.y + layout.box.height / 2 };
      await drag(east, { x: east.x + 80, y: east.y });
      doc = await exportJSON('legend-wide');
      check('the east handle resizes the legend width and keeps its height automatic',
        Math.abs(doc.legend.width - 400) < 2 && !('height' in doc.legend), JSON.stringify(doc.legend));
      layout = await layoutOf(doc);
      const south = { x: layout.box.x + layout.box.width / 2, y: layout.box.y + layout.box.height };
      await drag(south, { x: south.x, y: layout.box.y + 40 });
      doc = await exportJSON('legend-short');
      s = await state();
      const shortShot = await page.screenshot({ path: path.join(SHOTS, 'dpr2-legend-overflow.png') });
      check('dragging the bottom handle fixes a shorter height and the legend marks its clipped lines',
        typeof doc.legend.height === 'number' && s.overflow === 'true' && /clipped by its height/.test(s.canvas), JSON.stringify({ legend: doc.legend, canvas: s.canvas }));
      const shortPng = await exportPNG('dpr2-legend-overflow-export');
      layout = await layoutOf(doc);
      const badgeArea = { x: layout.box.x + layout.box.width * 0.55, y: layout.box.y + layout.box.height - 22, width: layout.box.width * 0.44, height: 20 };
      check('the exported PNG shows the "more lines" badge too, so clipping is never silent',
        (await inkIn(shortPng, badgeArea)).nonWhite > 50 && (await inkIn(shortShot, badgeArea)).nonWhite > 50);
      check('a clipped legend still shows its first row above the badge',
        layout.rows[0].bottom <= layout.box.y + layout.box.height && (await inkIn(shortPng, {
          x: layout.text.x, y: layout.rows[0].top, width: layout.text.width * 0.5, height: layout.rows[0].bottom - layout.rows[0].top,
        })).dark > 40);
      await page.mouse.click(layout.rows[0].carets[2].x, layout.rows[0].carets[2].y);
      s = await state();
      const expandedShot = await page.screenshot({ path: path.join(SHOTS, 'dpr2-legend-overflow-editing.png') });
      const belowClip = { x: layout.text.x, y: layout.box.y + layout.box.height + 24, width: layout.text.width, height: 60 };
      check('while editing a clipped legend, the hidden lines are shown below a marked clip line (preview only)',
        s.focused && (await inkIn(expandedShot, belowClip)).dark > 100 && (await inkIn(shortPng, belowClip)).nonWhite === 0);
      await page.keyboard.press('Escape');
      await press('[data-redline-legend-options]');
      await choose('select[aria-label="Legend height"]', 'auto');
      doc = await exportJSON('legend-fit');
      s = await state();
      check('Height: Fit text grows the legend back to show everything', !('height' in doc.legend) && s.overflow === 'false', JSON.stringify(doc.legend));
      const heightBefore = (await layoutOf(doc)).contentHeight;
      await choose('select[aria-label="Legend font size"]', 20);
      await choose('select[aria-label="Legend font"]', 'serif');
      doc = await exportJSON('legend-font');
      check('font size and font controls restyle the legend, which grows for the larger text',
        doc.legend.fontSize === 20 && doc.legend.fontFamily === 'serif' && (await layoutOf(doc)).contentHeight > heightBefore * 1.2, JSON.stringify(doc.legend));
      await choose('select[aria-label="Move legend to a corner"]', 'bottom-left');
      doc = await exportJSON('legend-corner');
      layout = await layoutOf(doc);
      check('Place moves the legend to a corner inside the window',
        doc.legend.x === 16 && Math.abs(doc.legend.y + (layout.box.height / layout.sy) + 16 - 800) < 1, JSON.stringify(doc.legend));
      await choose('select[aria-label="Legend font"]', 'sans-serif');
      await choose('select[aria-label="Legend font size"]', 14);
      doc = await exportJSON('legend-restyled');
    }

    // =========================================================================
    // Preview and PNG parity
    await press('[data-redline-tool="bullet"]');
    await page.mouse.move(1195, 795);
    doc = await exportJSON('parity');
    layout = await layoutOf(doc);
    await hideChrome(true);
    const preview = await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-legend-preview.png`) });
    await hideChrome(false);
    const exported = await exportPNG(`dpr${dpr}-legend-export`);
    await fs.copyFile(path.join(scratch, `dpr${dpr}-legend-export.png`), path.join(SHOTS, `dpr${dpr}-legend-export.png`));
    const parityArea = { x: layout.box.x + 2, y: layout.box.y + 2, width: layout.box.width - 4, height: layout.box.height - 4 };
    const [previewRows, exportRows] = [await rowProfile(preview, parityArea), await rowProfile(exported, parityArea)];
    const sum = values => values.reduce((a, b) => a + b, 0);
    const mismatch = previewRows.filter((value, index) => (value > 0) !== (exportRows[index] > 0)).length;
    const diff = Math.abs(sum(previewRows) - sum(exportRows)) / Math.max(1, sum(previewRows));
    check(`${tag} the live legend and the PNG draw the same lines of text in the same rows`,
      sum(previewRows) > 200 && diff < 0.08 && mismatch <= 4, JSON.stringify({ preview: sum(previewRows), exported: sum(exportRows), diff, mismatch }));

    // A placeholder shows live but never in the export.
    await load('placeholder', {
      width: 1200, height: 800, annotations: [bulletMark('1', 300, 300)],
      legend: { visible: true, x: 700, y: 300, width: 320 },
    });
    await press('[data-redline-tool="select"]');
    await page.mouse.move(1195, 795);
    doc = await exportJSON('placeholder');
    layout = await layoutOf(doc);
    const placeholderArea = { x: layout.text.x, y: layout.rows[0].top, width: layout.text.width, height: layout.rows[0].bottom - layout.rows[0].top };
    await hideChrome(true);
    const placeholderPreview = await page.screenshot();
    await hideChrome(false);
    const placeholderPng = await exportPNG(`dpr${dpr}-placeholder`);
    check(`${tag} an empty row's placeholder is drawn live and excluded from the PNG`,
      (await inkIn(placeholderPreview, placeholderArea)).nonWhite > 40 && (await inkIn(placeholderPng, placeholderArea)).nonWhite === 0);

    // =========================================================================
    // Viewport resize, crop and output scale
    await load('scaling', {
      width: 1200, height: 800,
      annotations: [bulletMark('1', 200, 200, { text: 'First explanation' }), bulletMark('2', 260, 260, { text: 'Second explanation' })],
      legend: { visible: true, x: 60, y: 520, width: 300 },
    });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(300);
    doc = await exportJSON('scaled');
    layout = await layoutOf(doc);
    const scaledPng = await exportPNG(`dpr${dpr}-resized-export`);
    const scaledGlyph = await inkIn(scaledPng, { x: layout.rows[1].glyph.x - 8, y: layout.rows[1].glyph.y - 8, width: 16, height: 16 });
    const scaledBox = await evaluate(() => {
      const canvas = globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]');
      return { width: canvas.width, height: canvas.height, css: canvas.getBoundingClientRect().width, dpr: devicePixelRatio };
    });
    check(`${tag} after a nonuniform resize the canvas backing matches device pixels and the PNG legend lands where the preview draws it`,
      scaledBox.width === Math.round(900 * dpr) && scaledBox.height === Math.round(700 * dpr)
      && scaledGlyph.blue > 40, JSON.stringify({ scaledGlyph, scaledBox, glyph: layout.rows[1].glyph }));
    await page.mouse.click(layout.rows[1].carets[6].x, layout.rows[1].carets[6].y);
    s = await state();
    check(`${tag} legend hit-testing and caret placement follow the resized transform`,
      s.focused && s.label === 'Explanation for bullet 2' && s.start === 6, JSON.stringify(s));
    await page.keyboard.press('Escape');

    await page.keyboard.press('c');
    const cropTo = { x: layout.box.x + layout.box.width * 0.5, y: 690 };
    await drag({ x: 5, y: 5 }, cropTo);
    await evaluate(() => {
      const select = globalThis.__redlineTestRoot.querySelector('[data-redline-crop-panel] select');
      select.focus();
    });
    await page.keyboard.press('End');
    await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-crop-panel] select').value === '2'), 'output 200%');
    await press('[data-crop-action="done"]');
    s = await state();
    doc = await exportJSON('cropped');
    const croppedPng = await exportPNG(`dpr${dpr}-crop-export`);
    const cropInfo = await evaluate(async ({ base64, glyph, crop, doc }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const cropCss = { x: crop.x * innerWidth / doc.width, y: crop.y * innerHeight / doc.height, width: crop.width * innerWidth / doc.width, height: crop.height * innerHeight / doc.height };
      const scale = image.width / cropCss.width;
      const size = Math.round(16 * scale);
      const data = ctx.getImageData(Math.round((glyph.x - 8 - cropCss.x) * scale), Math.round((glyph.y - 8 - cropCss.y) * scale), size, size).data;
      let blue = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 150 && data[i] < 120) blue += 1;
      return { width: image.width, height: image.height, expected: [Math.round(cropCss.width * devicePixelRatio * 2), Math.round(cropCss.height * devicePixelRatio * 2)], blue, size };
    }, { base64: croppedPng.toString('base64'), glyph: layout.rows[0].glyph, crop: doc.crop, doc });
    check(`${tag} with a crop that cuts the legend and 200% output, the PNG keeps the legend at its crop-relative place and the preview says it is clipped`,
      Math.abs(cropInfo.width - cropInfo.expected[0]) <= 2 && Math.abs(cropInfo.height - cropInfo.expected[1]) <= 2
      && cropInfo.blue > cropInfo.size * cropInfo.size * 0.15 && /crop/.test(s.clipped) && /outside the crop/.test(s.canvas), JSON.stringify({ cropInfo, clipped: s.clipped, canvas: s.canvas }));
    await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-crop-clipped-preview.png`) });
    await page.keyboard.press('c');
    await press('[data-crop-action="reset"]');
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-crop-panel] select').focus());
    await page.keyboard.press('Home');
    await press('[data-crop-action="done"]');
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(300);

    await load('past-edge', {
      width: 1200, height: 800,
      annotations: [bulletMark('1', 200, 200, { text: 'This legend runs past the right edge of the window' })],
      legend: { visible: true, x: 1000, y: 300, width: 400 },
    });
    s = await state();
    const edgePng = await exportPNG(`dpr${dpr}-past-edge`);
    const edgeSize = await evaluate(async base64 => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      return [image.width, image.height];
    }, edgePng.toString('base64'));
    await page.screenshot({ path: path.join(SHOTS, `dpr${dpr}-legend-past-edge.png`) });
    check(`${tag} a legend past the window edge is flagged in the preview and clipped, not moved or enlarged, in the PNG`,
      /viewport/.test(s.clipped) && /past the window edge/.test(s.canvas)
      && edgeSize[0] === 1200 * dpr && edgeSize[1] === 800 * dpr && (await exportJSON('past-edge')).legend.x === 1000,
      JSON.stringify({ clipped: s.clipped, canvas: s.canvas, edgeSize }));

    // =========================================================================
    // Browse mode
    await press('[data-redline-tool="select"]');
    await page.mouse.click(1100, 100);
    await page.keyboard.press('F2');
    s = await state();
    await page.mouse.click(660, 752);
    const clicked = await page.evaluate(() => Boolean(globalThis.__pageSeen.pageClicked));
    await page.keyboard.press('F2');
    const resumed = await state();
    check(`${tag} Browse mode hides the legend and releases page input; F2 brings it back`,
      s.canvasDisplay === 'none' && clicked && resumed.canvasDisplay === 'block' && /Legend with 1 explanation/.test(resumed.canvas), JSON.stringify({ s: s.canvasDisplay, clicked, resumed: resumed.canvas }));

    if (full) {
      // -----------------------------------------------------------------------
      // Invalid imports leave document and history untouched
      await page.mouse.click(600, 600);
      await press('[data-redline-tool="bullet"]');
      await page.mouse.click(700, 150);
      await page.keyboard.press('Escape');
      const beforeBad = await exportJSON('before-bad');
      const undoEnabled = () => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-action="undo"]').disabled);
      const bad = {
        'duplicate labels': [bulletMark('4', 10, 10), { ...bulletMark('4', 20, 20), id: 'other' }],
        'two-digit label': [bulletMark('10', 10, 10)],
        'double-letter label': [bulletMark('AA', 10, 10)],
        'non-text explanation': [bulletMark('1', 10, 10, { text: 42 })],
      };
      const outcomes = [];
      for (const [name, annotations] of [...Object.entries(bad), ['malformed legend', [bulletMark('1', 10, 10)]]]) {
        const file = path.join(scratch, `bad-${outcomes.length}.json`);
        const document = { width: 1200, height: 800, annotations, ...(name === 'malformed legend' ? { legend: { visible: 'yes' } } : {}) };
        await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document }));
        await importFile(file);
        await waitUntil(async () => /Could not import/.test((await state()).message), `${name} rejected`);
        outcomes.push({ name, message: (await state()).message, undo: await undoEnabled() });
        await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent = ''; });
      }
      const afterBad = await exportJSON('after-bad');
      check('invalid bullet and legend imports are rejected atomically, keeping the document and undo history',
        JSON.stringify(afterBad) === JSON.stringify(beforeBad) && outcomes.every(item => item.undo), JSON.stringify(outcomes));
      await page.keyboard.press('Control+z');
      check('undo still works after rejected imports', labelsOf(await exportJSON('after-bad-undo')).length === labelsOf(beforeBad).length - 1);

      const { demoDocument } = await import('./demo-document.mjs');
      await load('legacy-demo', demoDocument().document);
      doc = await exportJSON('legacy-demo');
      check('a Phase 1 document with no legend loads, stays legend-free and serialises without a legend field',
        !('legend' in doc) && (await state()).canvas === 'Legend hidden' && doc.annotations.length === demoDocument().document.annotations.length);

      // -----------------------------------------------------------------------
      // Layout of the new controls at the review widths
      for (const width of [1920, 1200, 800, 420]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(250);
        // A session sized to this window, as one started here would be.
        const bulletX = Math.round(width * 0.17);
        await load(`widths-${width}`, {
          width, height: 800,
          annotations: [bulletMark('1', bulletX, 300, { text: 'Price column is truncated at narrow widths' }), bulletMark('A', bulletX + 60, 360, { text: 'Legend rows wrap' })],
          legend: { visible: true, x: width - 316, y: 360, width: 300 },
        });
        const fits = async selector => evaluate(({ selector, width }) => [...globalThis.__redlineTestRoot.querySelectorAll(selector)]
          .filter(node => node.checkVisibility())
          .map(node => {
            const box = node.getBoundingClientRect();
            return { name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 24), left: box.left, right: box.right, ok: box.left >= 0 && box.right <= width };
          }), { selector, width });
        await programmaticClick('[data-redline-tool="bullet"]');
        await page.mouse.move(width - 3, 790);
        const defaults = await fits('[data-redline-control="stroke"] button, [data-redline-control="bulletScheme"] select, [data-redline-control="bulletNext"] span, [data-redline-control="legendToggle"] button');
        await page.screenshot({ path: path.join(SHOTS, `${width}-bullet-defaults.png`) });
        await programmaticClick('[data-redline-legend-options]');
        const legendControls = await fits('[data-redline-control="legendStyle"] select, [data-redline-control="legendToggle"] button');
        await page.screenshot({ path: path.join(SHOTS, `${width}-legend-options.png`) });
        await programmaticClick('[data-redline-tool="select"]');
        await page.mouse.dblclick(bulletX, 300);
        const editing = await fits('[data-redline-control="explanationActions"] button, [data-redline-control="legendStyle"] select');
        const editingState = await state();
        await page.screenshot({ path: path.join(SHOTS, `${width}-explanation-editing.png`) });
        await page.keyboard.press('Escape');
        check(`at ${width}px the bullet, legend and explanation controls are visible and inside the window`,
          defaults.length === 5 && legendControls.length === 6 && editing.length === 7 && editingState.focused
          && [...defaults, ...legendControls, ...editing].every(item => item.ok),
          JSON.stringify({ defaults: defaults.filter(item => !item.ok), legendControls: legendControls.filter(item => !item.ok), editing: editing.filter(item => !item.ok), counts: [defaults.length, legendControls.length, editing.length] }));
      }
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(250);

      // -----------------------------------------------------------------------
      // Close and reopen keep bullets, explanations and the legend
      const beforeClose = await exportJSON('before-close');
      await programmaticClick('[data-redline-action="close"]');
      await inject();
      await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open), 'reopened');
      const afterReopen = await exportJSON('after-reopen');
      check('closing and reopening Redline keeps bullets, explanations and the legend',
        JSON.stringify(afterReopen) === JSON.stringify(beforeClose) && /Legend with 2/.test((await state()).canvas));

      const seen = await page.evaluate(() => globalThis.__pageSeen);
      check('the page DOM gains no editor nodes and no page event carries explanation text',
        seen.nodes.length === 0 && !seen.details.some(detail => /explanation|misaligned|日本/i.test(detail)), JSON.stringify({ nodes: seen.nodes, details: seen.details.slice(0, 3) }));
    }

    check(`${tag} no page errors`, errors.length === 0, JSON.stringify(errors.slice(0, 5)));
    await redline.dispose();
  } finally {
    await context.close();
  }
}

try {
  await run(2, { full: true });
  await run(1, { full: false });
} catch (error) {
  console.error(error);
  results.push({ name: 'suite completed without an exception', pass: false, detail: error.message });
} finally {
  await new Promise(resolve => server.close(resolve));
}
const passed = results.filter(result => result.pass).length;
console.log(`${passed}/${results.length} phase 2 checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
