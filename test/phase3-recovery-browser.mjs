/**
 * Phase 3 acceptance: same-browser-session reload recovery, through real
 * reloads, navigation, tabs and pointer/keyboard input.
 *
 *   node test/phase3-recovery-browser.mjs [--headed]
 *
 * Covers Restore and Discard, the original viewport context, deciding later
 * without overwriting the waiting draft, replacing current marks, clearing,
 * the unload flush of an edit made just before reload, pausing and resuming
 * recovery, a full session store (quota), two tabs on the same address,
 * navigation away and back, closing a tab, close/reopen, a 420 px dialog, the
 * complete mixed workflow (both bullet schemes, long explanations, label
 * exhaustion, report text, reimport) and PNG parity after restoring at DPR 2.
 *
 * Browser-restart recovery is not claimed or tested: chrome.storage.session is
 * cleared when the browser session ends.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';
import { bullet, helpers, html } from './phase3-helpers.mjs';

const SHOTS = path.join('test-artifacts', 'phase3');
await fs.mkdir(SHOTS, { recursive: true });
const { results, check } = createChecker();
const SECRET = 'sk-recovery-secret';
const { server, origin } = await startServer({
  '/work': html('Recovery &lt;page&gt;', '#FFFFFF', '<div style="height:3000px"></div>'),
  '/other': html('Other page', '#F0F0F0'),
});
const WORK = `${origin}/work?token=${SECRET}#frag`;

function storage(worker) {
  const all = () => worker.evaluate(async () => {
    const entries = Object.entries(await chrome.storage.session.get(null));
    return entries.filter(([key]) => key.startsWith('redline.draft:')).map(([key, value]) => ({
      key, tabId: value.tabId, sessionId: value.sessionId, savedAt: value.savedAt, draft: value.draft,
      ids: value.draft.document.annotations.map(mark => mark.id),
    }));
  });
  const forTab = async tabId => (await all()).filter(item => item.tabId === tabId).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  const raw = () => worker.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)));
  return { all, forTab, raw };
}

async function session(context, worker, page, scratch, tabId = null) {
  const access = await openRedline({ context, worker, page, tabId });
  const h = helpers({ page, access, scratch });
  const dialog = () => access.evaluate(() => {
    const root = globalThis.__redlineTestRoot;
    const node = root.querySelector('dialog[data-redline-recovery-dialog]');
    if (!node?.open) return null;
    const box = node.getBoundingClientRect();
    return {
      items: [...node.querySelectorAll('li')].map(item => item.textContent), advice: node.querySelector('p').textContent,
      scroll: Boolean(node.querySelector('[data-redline-recovery-scroll]')),
      restoreFocused: root.activeElement?.hasAttribute('data-redline-recovery-restore') ?? false,
      inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
    };
  });
  const waitDialog = () => waitUntil(async () => Boolean(await dialog()), 'recovery dialog', 8000).then(dialog);
  const noDialog = async (ms = 1500) => {
    await page.waitForTimeout(ms);
    return !(await dialog());
  };
  const marks = () => access.evaluate(() => globalThis.__redlineTestRoot.querySelectorAll('[data-redline-marks] > [data-redline-id]').length);
  const drag = async (tool, from, to) => {
    await page.keyboard.press(tool);
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 5 });
    await page.mouse.up();
  };
  const confirmHostDialog = async label => {
    await waitUntil(() => access.evaluate(() => Boolean(globalThis.__redlineTestRoot.querySelector('dialog[data-redline-host-dialog]:not([data-redline-recovery-dialog])')?.open)), 'confirm dialog');
    const title = await access.evaluate(() => globalThis.__redlineTestRoot.querySelector('dialog[data-redline-host-dialog]:not([data-redline-recovery-dialog]) h2').textContent);
    await h.press('dialog[data-redline-host-dialog]:not([data-redline-recovery-dialog]) button[data-primary]');
    return title === label;
  };
  return { access, h, dialog, waitDialog, noDialog, marks, drag, confirmHostDialog };
}

async function reload(page, current, context, worker, scratch) {
  await current.access.dispose();
  await page.reload();
  return session(context, worker, page, scratch, current.access.tabId);
}

/** JSON with object keys sorted: extension storage returns keys in its own order. */
const canonical = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item));

/** Where two JSON strings first differ, for a readable failure. */
function firstDifference(a, b) {
  let index = 0;
  while (index < a.length && a[index] === b[index]) index++;
  return index >= a.length && a.length === b.length ? '' : `at ${index}: ${a.slice(Math.max(0, index - 80), index + 80)} ≠ ${b.slice(Math.max(0, index - 80), index + 80)}`;
}

async function recoveryRun() {
  const tag = '[recovery]';
  const { context, worker, scratch } = await launch({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  const drafts = storage(worker);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(WORK);
    const tabA = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, WORK);
    let s = await session(context, worker, page, scratch, tabA);
    check(`${tag} a fresh page offers nothing and stores no draft for an empty session`, await s.noDialog() && (await drafts.forTab(tabA)) === null);

    // Build a session through real input: fill, both bullet schemes with typed explanations, pointer, crop and output.
    await page.keyboard.press('r');
    await s.h.press('[data-treatment="outline-fill"]');
    await s.h.press('[data-fill-opacity="0.5"]');
    await s.drag('r', [150, 450], [350, 560]);
    await page.keyboard.press('u');
    await s.h.press('[data-redline-legend-toggle]');
    await page.mouse.click(700, 300);
    await page.keyboard.type('First explanation');
    await page.keyboard.press('Control+Enter');
    await page.mouse.click(760, 360);
    await page.keyboard.type('Second');
    await page.keyboard.press('Enter');
    await page.keyboard.type('  indented  ');
    await page.keyboard.press('Control+Enter');
    await s.access.evaluate(() => {
      const select = globalThis.__redlineTestRoot.querySelector('select[aria-label="Bullet labels"]');
      select.value = 'alpha';
      select.dispatchEvent(new Event('change'));
    });
    await page.mouse.click(820, 420);
    await page.keyboard.type('Lettered');
    await page.keyboard.press('Control+Enter');
    await s.h.click('[data-redline-action="cursorToggle"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await s.h.press('[data-crop-action="all"]');
    await s.access.evaluate(() => {
      const select = globalThis.__redlineTestRoot.querySelector('select[aria-label="Image output scale"]');
      select.value = '2';
      select.dispatchEvent(new Event('change'));
    });
    await s.h.press('[data-crop-action="done"]');
    await waitUntil(async () => {
      const stored = await drafts.forTab(tabA);
      const doc = stored?.draft.document;
      return doc?.annotations.length === 4 && doc.legend?.visible && doc.cursor?.visible && doc.crop && doc.outputScale === 2;
    }, 'session draft saved', 8000);
    const reference = await s.h.exportJSON();
    const stored = await drafts.forTab(tabA);
    const rawStore = await drafts.raw();
    await fs.writeFile(path.join(SHOTS, 'recovery-session-storage.json'), JSON.stringify(JSON.parse(rawStore), null, 2));
    check(`${tag} the draft holds marks, explanations, legend, pointer, crop and output, and matches the open document`,
      canonical(stored.draft.document) === canonical(reference.document), firstDifference(canonical(stored.draft.document), canonical(reference.document)));
    check(`${tag} the draft is keyed by tab and an opaque page digest, with no URL, query, fragment, title or screenshot`,
      /^redline\.draft:\d+:[A-Za-z0-9_-]{43}$/.test(stored.key) && !rawStore.includes(SECRET) && !rawStore.includes('token')
      && !rawStore.includes('frag') && !rawStore.includes('127.0.0.1') && !rawStore.includes('Recovery') && !/data:image|iVBOR/.test(rawStore)
      && JSON.stringify(Object.keys(stored.draft).sort()) === JSON.stringify(['createdAt', 'document', 'savedAt', 'schema', 'sessionId', 'ui', 'viewport']),
      stored.key);

    // Restore by keyboard
    s = await reload(page, s, context, worker, scratch);
    const offered = await s.waitDialog();
    await page.screenshot({ path: path.join(SHOTS, 'recovery-1200.png') });
    check(`${tag} after reload the matching draft is offered with contents and original viewport context`,
      offered.items[0] === '4 marks, 3 bullets (3 explained), legend shown, pointer included, crop 1200 × 800, 200% output.'
      && /^Saved at .* from this tab and page, before it reloaded\.$/.test(offered.items[1])
      && offered.items[2] === 'Drawn in a 1200 × 800 window scrolled to 0, 0, the same as this window.'
      && /screen positions/.test(offered.advice) && offered.restoreFocused && offered.inside, JSON.stringify(offered));
    await page.keyboard.press('Enter');
    await waitUntil(async () => /^Restored 4 marks/.test(await s.h.message()), 'restored');
    const restored = await s.h.exportJSON();
    check(`${tag} Restore rebuilds the identical document and session start, without undo history`,
      JSON.stringify(restored.document) === JSON.stringify(reference.document) && restored.createdAt === reference.createdAt
      && await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-action="undo"]').disabled));

    // Discard
    s = await reload(page, s, context, worker, scratch);
    await s.waitDialog();
    await s.h.press('dialog[data-redline-recovery-dialog] [data-redline-recovery-discard]');
    await waitUntil(async () => (await drafts.forTab(tabA)) === null, 'draft discarded');
    s = await reload(page, s, context, worker, scratch);
    check(`${tag} Discard deletes the draft, and the next reload offers nothing and shows no stale marks`,
      await s.noDialog() && await s.marks() === 0 && (await drafts.forTab(tabA)) === null);

    // Decide later: the waiting draft is not overwritten; restoring over new marks asks first.
    await s.drag('r', [200, 200], [300, 300]);
    await waitUntil(async () => (await drafts.forTab(tabA))?.ids.length === 1, 'one-mark draft');
    const waiting = await drafts.forTab(tabA);
    s = await reload(page, s, context, worker, scratch);
    await s.waitDialog();
    await page.keyboard.press('Escape');
    await waitUntil(async () => !(await s.dialog()), 'dialog dismissed');
    // The notice replaces the prompt once it has closed.
    await waitUntil(() => s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-control="recovery"]').checkVisibility()), 'notice shown').catch(() => {});
    const notice = await s.access.evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      const group = root.querySelector('[data-redline-control="recovery"]');
      return { visible: group.checkVisibility(), text: group.textContent, menu: !root.querySelector('[data-redline-action="restoreDraft"]').hidden };
    });
    check(`${tag} Escape decides later: a notice and the More actions item keep Restore reachable`,
      notice.visible && /Draft from .* \(1 mark\) is waiting/.test(notice.text) && notice.menu, JSON.stringify(notice));
    await s.drag('o', [500, 500], [620, 580]);
    await page.waitForTimeout(1500);
    const untouched = await drafts.forTab(tabA);
    check(`${tag} marks drawn while the decision is pending never overwrite the waiting draft`,
      untouched.sessionId === waiting.sessionId && JSON.stringify(untouched.ids) === JSON.stringify(waiting.ids) && untouched.savedAt === waiting.savedAt);
    await s.h.press('[data-redline-recovery-restore]');
    const asked = await s.confirmHostDialog('Replace the current marks?');
    await waitUntil(async () => /^Restored 1 mark/.test(await s.h.message()), 'restored over new marks');
    const replaced = (await s.h.exportJSON()).document.annotations.map(mark => mark.id);
    await waitUntil(async () => (await drafts.forTab(tabA))?.sessionId !== waiting.sessionId, 'restored session saves');
    check(`${tag} restoring over new marks asks first, then replaces them with the draft and saves it as this session`,
      asked && JSON.stringify(replaced) === JSON.stringify(waiting.ids) && JSON.stringify((await drafts.forTab(tabA)).ids) === JSON.stringify(waiting.ids));

    // Clearing removes the draft; nothing comes back.
    await s.h.click('[data-redline-action="clear"]');
    await s.confirmHostDialog('Clear redline marks?');
    await waitUntil(async () => (await drafts.forTab(tabA)) === null, 'cleared draft removed');
    s = await reload(page, s, context, worker, scratch);
    check(`${tag} clearing every mark removes the draft, so reload does not resurrect them`, await s.noDialog() && await s.marks() === 0);

    // An edit made immediately before reload is flushed as the page unloads.
    await s.drag('r', [400, 200], [520, 300]);
    s = await reload(page, s, context, worker, scratch);
    const flushed = await s.waitDialog();
    check(`${tag} an edit made just before reload is saved on unload and offered`, flushed.items[0] === '1 mark.', JSON.stringify(flushed.items));
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 1, 'flushed mark restored');

    // A history navigation without further edits: the reload uses the new address.
    await page.evaluate(() => history.pushState({}, '', '/work-moved?view=2#section'));
    s = await reload(page, s, context, worker, scratch);
    const moved = await s.waitDialog();
    check(`${tag} after a same-document navigation with no further edits, reloading the new address still offers the draft`,
      moved.items[0] === '1 mark.' && (await drafts.all()).filter(item => item.tabId === tabA).length === 1, JSON.stringify(moved.items));
    const movedSession = (await drafts.forTab(tabA)).sessionId;
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 1, 'moved draft restored');
    await waitUntil(async () => (await drafts.forTab(tabA))?.sessionId !== movedSession, 'restored session saved at the moved address');
    await page.evaluate(url => history.pushState({}, '', url), WORK.slice(origin.length));
    s = await reload(page, s, context, worker, scratch);
    const movedBack = await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 1, 'draft back at the work address');
    check(`${tag} navigating back with history and reloading offers it at the original address, leaving one draft for the tab`,
      movedBack.items[0] === '1 mark.' && (await drafts.all()).filter(item => item.tabId === tabA).length === 1);

    // Discard while working pauses recovery until resumed.
    await s.h.click('[data-redline-action="discardDraft"]');
    const pauseAsked = await s.confirmHostDialog('Discard the recovery draft?');
    await waitUntil(async () => (await drafts.forTab(tabA)) === null, 'paused discard');
    await s.drag('r', [600, 200], [700, 300]);
    await page.waitForTimeout(1500);
    const resumeVisible = await s.access.evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-action="resumeRecovery"]').hidden);
    check(`${tag} Discard draft deletes the copy and pauses saving, so new work does not recreate it`,
      pauseAsked && (await drafts.forTab(tabA)) === null && resumeVisible);
    await s.h.click('[data-redline-action="resumeRecovery"]');
    await waitUntil(async () => (await drafts.forTab(tabA))?.ids.length === 2, 'resumed save').catch(() => {});
    check(`${tag} Resume reload recovery saves the current marks again`, (await drafts.forTab(tabA))?.ids.length === 2);

    // An explanation still being typed (not yet saved) survives an immediate reload.
    await page.keyboard.press('u');
    const legendShown = () => s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-legend-toggle]').getAttribute('aria-pressed') === 'true');
    if (!await legendShown()) await s.h.press('[data-redline-legend-toggle]');
    await page.mouse.click(1000, 600);
    await waitUntil(() => s.access.evaluate(() => globalThis.__redlineTestRoot.activeElement?.hasAttribute('data-redline-legend-input')), 'explanation editing');
    await page.keyboard.type('Typed but never saved');
    s = await reload(page, s, context, worker, scratch);
    await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 3, 'unsaved explanation restored');
    const unsaved = (await s.h.exportJSON()).document.annotations.find(mark => mark.type === 'bullet');
    check(`${tag} an explanation being typed when the page reloads is kept by the draft`, unsaved?.text === 'Typed but never saved', JSON.stringify(unsaved));
    await page.keyboard.press('v');
    await page.mouse.click(1000, 600);
    await page.keyboard.press('Delete');
    await waitUntil(async () => await s.marks() === 2, 'bullet removed again');
    await waitUntil(async () => (await drafts.forTab(tabA))?.ids.length === 2, 'draft back to two marks');

    // Quota
    await worker.evaluate(async () => {
      const used = await chrome.storage.session.getBytesInUse(null);
      await chrome.storage.session.set({ 'test.fill': 'x'.repeat(chrome.storage.session.QUOTA_BYTES - used - 400) });
    });
    const beforeQuota = await drafts.forTab(tabA);
    await s.drag('r', [800, 200], [900, 300]);
    await waitUntil(async () => /session storage is full/.test(await s.h.message()), 'quota message', 8000);
    check(`${tag} a full session store is reported, the open marks stay, and the previous draft is not damaged`,
      await s.marks() === 3 && JSON.stringify((await drafts.forTab(tabA)).ids) === JSON.stringify(beforeQuota.ids), await s.h.message());
    await worker.evaluate(() => chrome.storage.session.remove('test.fill'));
    await s.drag('r', [800, 400], [900, 500]);
    await waitUntil(async () => (await drafts.forTab(tabA))?.ids.length === 4, 'saved after quota recovers', 8000);
    check(`${tag} once space is available the next change saves everything, and says so`, /saving again/.test(await s.h.message()), await s.h.message());

    // Two tabs on the same address, navigation away and back, and closing a tab.
    const pageB = await context.newPage();
    pageB.on('pageerror', error => errors.push(error.message));
    await pageB.goto(WORK);
    const tabB = await worker.evaluate(async ([url, other]) => (await chrome.tabs.query({})).find(tab => tab.url === url && tab.id !== other)?.id, [WORK, tabA]);
    const b = await session(context, worker, pageB, scratch, tabB);
    check(`${tag} another tab on the same address is not offered this tab's draft`, await b.noDialog() && await b.marks() === 0);
    await b.drag('r', [100, 600], [200, 700]);
    await b.drag('r', [300, 600], [400, 700]);
    await waitUntil(async () => (await drafts.forTab(tabB))?.ids.length === 2, 'tab B draft');
    const aDraft = await drafts.forTab(tabA);
    check(`${tag} each tab keeps its own draft for the same page`, aDraft.ids.length === 4 && (await drafts.forTab(tabB)).ids.length === 2
      && aDraft.key !== (await drafts.forTab(tabB)).key);
    await page.bringToFront();
    s = await reload(page, s, context, worker, scratch);
    const ownDraft = await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 4, 'tab A restored');
    check(`${tag} reloading tab A restores tab A's marks only`, ownDraft.items[0] === '4 marks.'
      && JSON.stringify((await s.h.exportJSON()).document.annotations.map(mark => mark.id)) === JSON.stringify(aDraft.ids)
      && JSON.stringify((await drafts.forTab(tabB)).ids.length) === '2');
    await s.access.dispose();
    await page.goto(`${origin}/other`);
    s = await session(context, worker, page, scratch, tabA);
    check(`${tag} a different page in the same tab is not offered the draft`, await s.noDialog() && await s.marks() === 0);
    await s.access.dispose();
    await page.goto(WORK);
    s = await session(context, worker, page, scratch, tabA);
    const back = await s.waitDialog();
    check(`${tag} returning to the page in the same tab offers its draft again`, back.items[0] === '4 marks.', JSON.stringify(back.items));
    await page.keyboard.press('Escape');
    await b.access.dispose();
    await pageB.close();
    await waitUntil(async () => (await drafts.forTab(tabB)) === null, 'closed tab drafts removed', 8000);
    check(`${tag} closing a tab removes its drafts`, (await drafts.forTab(tabA)) !== null);

    // Close and reopen keep the in-memory session; a waiting draft is offered again while the page is empty.
    await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-action="close"]').click());
    await s.access.inject();
    const again = await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 4, 'restored after reopen');
    await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-action="close"]').click());
    await s.access.inject();
    check(`${tag} reopening offers a still-waiting draft; after restoring, close/reopen keeps the marks without asking`,
      again.items[0] === '4 marks.' && await s.noDialog(1000) && await s.marks() === 4);
    check(`${tag} the page world has no access to drafts and its own storage is untouched`,
      await page.evaluate(() => typeof globalThis.chrome?.storage === 'undefined' && localStorage.length === 0 && sessionStorage.length === 0));

    // Narrow dialog and scroll context
    await page.setViewportSize({ width: 420, height: 720 });
    await page.evaluate(() => scrollTo(0, 0));
    await s.access.evaluate(() => {
      const root = globalThis.__redlineTestRoot;
      root.querySelector('[data-redline-mode="browse"]').click();
    });
    await page.evaluate(() => scrollTo(0, 900));
    await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-mode="annotate"]').click());
    await s.drag('r', [60, 300], [160, 400]);
    await waitUntil(async () => (await drafts.forTab(tabA))?.draft.viewport.scrollY === 900, 'scrolled draft saved');
    await s.access.dispose();
    await page.reload();
    await page.evaluate(() => scrollTo(0, 0));
    s = await session(context, worker, page, scratch, tabA);
    const narrow = await s.waitDialog();
    await page.screenshot({ path: path.join(SHOTS, 'recovery-420.png') });
    check(`${tag} at 420 px the dialog fits and names the saved scroll position with an option to return to it`,
      narrow.inside && narrow.scroll && /scrolled to 0, 900/.test(narrow.items[2]), JSON.stringify(narrow));
    await s.h.press('dialog[data-redline-recovery-dialog] [data-redline-recovery-restore]');
    await waitUntil(async () => /^Restored/.test(await s.h.message()) || (await page.evaluate(() => scrollY)) === 900, 'restore with scroll');
    check(`${tag} restoring with that option scrolls the page back`, await page.evaluate(() => scrollY) === 900);
    await page.setViewportSize({ width: 1200, height: 800 });

    // ------------------------------------------------------------------------
    // Complete workflow: mixed styles, both schemes at exhaustion, long explanation, report, reimport, recovery
    const long = Array.from({ length: 80 }, (_, index) => `Line ${index + 1} of a long explanation.`).join('\n');
    const labels = [...'123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const workflow = {
      width: 1200, height: 800,
      annotations: [
        { id: 'fill', type: 'rectangle', color: '#1D4ED8', fill: '#DC2626', fillOpacity: 0.25, width: 2.667, start: { x: 40, y: 120 }, end: { x: 200, y: 220 } },
        { id: 'only-fill', type: 'ellipse', color: '#7C3AED', fillOpacity: 0.5, outline: false, width: 2, start: { x: 220, y: 120 }, end: { x: 380, y: 220 } },
        { id: 'ends', type: 'line', color: '#111827', width: 2.667, start: { x: 40, y: 260 }, end: { x: 380, y: 260 }, startDecoration: 'filled-circle', endDecoration: 'arrow' },
        { id: 'legacy', type: 'note', color: '#B65D66', width: 1.333, point: { x: 60, y: 320 }, text: 'Legacy note ten', number: 10 },
        ...labels.map((label, index) => bullet(`w-${label}`, label, 420 + (index % 12) * 60, 140 + Math.floor(index / 12) * 60, label === '1' ? long : `Explanation ${label}`)),
      ],
    };
    const loaded = await s.h.load(workflow, 'workflow');
    await page.keyboard.press('u');
    await page.mouse.click(600, 600);
    const limit = await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-bullet-limit-text]').textContent);
    check(`${tag} workflow: import of mixed styles and all 35 labels, then placement explains exhaustion`,
      /^Imported 39 marks/.test(loaded) && /All 35 bullet labels \(1–9 and A–Z\) are in use/.test(limit) && await s.marks() === 39, limit);
    // Later editing of the 80-line explanation with the legend hidden uses the scrolling editing view.
    await page.keyboard.press('v');
    await page.mouse.dblclick(420, 140);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' (edited at the end)');
    const editView = await s.access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-legend-canvas]').getAttribute('aria-label'));
    await page.keyboard.press('Control+Enter');
    await page.mouse.dblclick(420, 200);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' — edited later');
    await page.keyboard.press('Control+Enter');
    await waitUntil(async () => (await drafts.forTab(tabA))?.draft.document.annotations.find(mark => mark.id === 'w-D')?.text === 'Explanation D — edited later', 'later edit saved');
    check(`${tag} workflow: later editing a long explanation with the legend hidden uses the scrollable card editor`,
      /not exported/.test(editView) && /scrollable editing view/.test(editView), editView);
    const fallback = await s.h.download(() => s.h.click('[data-redline-action="reportFallback"]'));
    await page.bringToFront();
    const reportText = await page.evaluate(async () => (await (await (await navigator.clipboard.read())[0].getType('text/plain')).text()).replace(/\r\n/g, '\n'));
    check(`${tag} workflow: report text lists all 35 labels in order, the whole long explanation, the later edit and the legacy note`,
      labels.every(label => reportText.includes(`\n${label}  `)) && reportText.includes('   Line 80 of a long explanation. (edited at the end)')
      && reportText.includes('D  Explanation D — edited later') && reportText.includes('Note 10:  Legacy note ten')
      && reportText.includes(`saved separately as ${fallback.name}`), reportText.slice(0, 300));
    const exported = await s.h.exportJSON();
    const file = path.join(scratch, 'workflow-export.json');
    await fs.writeFile(file, JSON.stringify(exported));
    await s.access.importFile(file);
    await waitUntil(async () => /^Imported 39 marks/.test(await s.h.message()), 'reimported');
    check(`${tag} workflow: reimporting the exported JSON gives the identical document`,
      JSON.stringify((await s.h.exportJSON()).document) === JSON.stringify(exported.document));
    await waitUntil(async () => (await drafts.forTab(tabA))?.ids.length === 39, 'workflow draft');
    s = await reload(page, s, context, worker, scratch);
    await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 39, 'workflow restored');
    check(`${tag} workflow: reload recovery restores the whole document, long text and edits included`,
      JSON.stringify((await s.h.exportJSON()).document) === JSON.stringify(exported.document));

    check(`${tag} no unexpected page errors`, errors.length === 0, errors.join(' | '));
    await s.access.dispose();
  } finally {
    await context.close();
  }
}

async function pixelParityRun() {
  const tag = '[DPR 2 restore]';
  const { context, worker, scratch } = await launch({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/work`);
    let s = await session(context, worker, page, scratch);
    await s.h.load({
      width: 1000, height: 700, legend: { visible: true, x: 640, y: 120, width: 300, fontSize: 16 }, cursor: { visible: true, x: 420, y: 330 },
      crop: { x: 50, y: 60, width: 900, height: 600 }, outputScale: 0.5,
      annotations: [bullet('p1', '1', 200, 200, 'Parity after reload'), bullet('pA', 'A', 260, 260, 'Second scheme'),
        { id: 'arrow', type: 'arrow', color: '#DC2626', width: 4, start: { x: 300, y: 400 }, end: { x: 520, y: 340 } }],
    }, 'parity');
    await s.drag('p', [100, 500], [300, 560]);
    const drafts = storage(worker);
    await waitUntil(async () => (await drafts.all()).some(item => item.ids.length === 4), 'parity draft');
    const before = await s.h.exportPNG();
    s = await reload(page, s, context, worker, scratch);
    await s.waitDialog();
    await page.keyboard.press('Enter');
    await waitUntil(async () => await s.marks() === 4, 'parity restored');
    const after = await s.h.exportPNG();
    check(`${tag} the PNG after reload and restore is pixel-identical to the PNG before reload`,
      await s.h.imageDigest(before) === await s.h.imageDigest(after), `${before.length} / ${after.length} bytes`);
    await s.access.dispose();
  } finally {
    await context.close();
  }
}

try {
  await recoveryRun();
  await pixelParityRun();
} catch (error) {
  check('Phase 3 recovery suite completed without an unhandled error', false, error.stack ?? error.message);
} finally {
  server.close();
}
const passed = results.filter(item => item.pass).length;
console.log(`\n${passed}/${results.length} phase 3 recovery checks passed`);
const failed = results.filter(item => !item.pass);
if (failed.length) console.log('Failed: ' + failed.map(item => item.name).join('; '));
process.exit(failed.length ? 1 : 0);
