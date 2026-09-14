/** Lead regressions: closing child dialogs/capture and failed recovery operations. */
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';
import { bullet, helpers, html, setCaptureDelay } from './phase3-helpers.mjs';
const { check, results } = createChecker();
const { server, origin } = await startServer({ '/review': html('Lead recovery review', '#FFFFFF') });
const { context, worker, scratch } = await launch();
const errors = [];
try {
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/review');
  let access = await openRedline({ context, worker, page });
  const tabId = access.tabId;
  let h = helpers({ page, access, scratch });
  const draft = () => worker.evaluate(async id => Object.entries(await chrome.storage.session.get(null))
    .find(([key, value]) => key.startsWith('redline.draft:') && value.tabId === id)?.[1]?.draft ?? null, tabId);
  const dialogs = () => access.evaluate(() => [...globalThis.__redlineTestRoot.querySelectorAll('dialog[open]')]
    .map(node => node.getAttribute('aria-label') ?? node.dataset.dialog ?? 'preview'));
  const isOpen = selector => access.evaluate(value => Boolean(globalThis.__redlineTestRoot.querySelector(value)?.open), selector);
  const waitRecovery = () => waitUntil(async () => {
    const box = await h.rect('dialog[data-redline-recovery-dialog] [data-redline-recovery-restore]');
    return await isOpen('[data-redline-recovery-dialog]') && box?.visible && box.width > 0;
  }, 'visible recovery offer');
  const reload = async () => {
    await access.dispose();
    await page.reload();
    access = await openRedline({ context, worker, page, tabId });
    h = helpers({ page, access, scratch });
    await waitRecovery();
  };
  // Dismiss leftover dialogs only to let the remaining regressions run on broken builds.
  const cleanup = () => access.evaluate(() => {
    for (const node of globalThis.__redlineTestRoot.querySelectorAll('dialog[open]:not([data-redline-root])')) {
      node.dispatchEvent(new Event('cancel'));
      node.close();
    }
  });
  const assertClosed = async label => {
    await page.waitForTimeout(100);
    const open = await dialogs();
    check(label, open.length === 0, JSON.stringify(open));
    if (open.length) { await cleanup(); await page.waitForTimeout(100); }
  };
  const reference = { width: 1200, height: 800, annotations: [bullet('kept', '1', 500, 400, 'Keep this explanation')] };
  await h.load(reference);
  await waitUntil(async () => (await draft())?.document.annotations.length === 1, 'initial draft');
  const saved = await draft();
  await reload();
  await access.inject(); // extension toggle, as used by the browser command
  await assertClosed('closing Redline dismisses Restore and every other modal');
  check('closing the recovery prompt keeps the draft unchanged', JSON.stringify(await draft()) === JSON.stringify(saved));
  await access.inject();
  await waitRecovery();
  await h.press('dialog[data-redline-recovery-dialog] [data-redline-recovery-restore]');
  await waitUntil(async () => /Restored 1 mark/.test(await h.message()), 'restored');
  check('reopening after cancelled Restore offers the same explanation', (await h.exportJSON()).document.annotations[0]?.text === 'Keep this explanation');

  await h.click('[data-redline-action="preview"]');
  await waitUntil(() => isOpen('[data-redline-preview]'), 'preview');
  await access.inject();
  await assertClosed('closing Redline dismisses an open export preview');
  await access.inject();
  await setCaptureDelay(worker, 900);
  await h.click('[data-redline-action="preview"]');
  await waitUntil(() => access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'preview capture started');
  await access.inject();
  await h.idle();
  await assertClosed('a delayed preview capture cannot reopen a dialog after Redline closes');
  await access.inject();
  await h.click('[data-redline-action="preview"]');
  await waitUntil(() => access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'second capture started');
  await access.inject();
  await page.waitForTimeout(60);
  await access.inject();
  await h.idle();
  check('closing and reopening during capture does not resurrect the previous preview',
    await isOpen('[data-redline-root]') && !(await isOpen('[data-redline-preview]')));
  await setCaptureDelay(worker, 0);
  await page.keyboard.press('r');
  await h.press('[data-redline-color="stroke"]');
  await access.inject();
  await assertClosed('closing Redline dismisses the color picker');
  await access.inject();
  await h.click('[data-redline-action="clear"]');
  await waitUntil(() => isOpen('[data-redline-host-dialog]'), 'clear confirmation');
  await access.inject();
  await assertClosed('closing Redline cancels Clear without deleting marks');
  await access.inject();
  check('cancelled Clear retains the saved mark', (await h.exportJSON()).document.annotations.length === 1);

  await waitUntil(async () => Boolean(await draft()), 'draft before failed discard');
  await reload();
  await worker.evaluate(() => {
    const remove = chrome.storage.session.remove.bind(chrome.storage.session);
    chrome.storage.session.remove = async keys => {
      if (globalThis.__failReviewRemove && [keys].flat().some(key => String(key).startsWith('redline.draft:'))) {
        globalThis.__reviewRemoveFailures = (globalThis.__reviewRemoveFailures ?? 0) + 1;
        throw new Error('Simulated recovery storage failure');
      }
      return remove(keys);
    };
    globalThis.__failReviewRemove = true;
  });
  await h.press('dialog[data-redline-recovery-dialog] [data-redline-recovery-discard]');
  await page.waitForTimeout(650);
  const failure = await h.message();
  const restoreVisible = await access.evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-action="restoreDraft"]').hidden);
  check('failed Discard reports failure and retains the waiting draft and Restore action',
    /could not|failed|unable/i.test(failure) && restoreVisible && Boolean(await draft()), failure);
  if (restoreVisible) {
    await h.click('[data-redline-action="discardDraft"]');
    await waitUntil(() => isOpen('[data-redline-host-dialog]'), 'retry confirmation');
    await h.press('dialog[data-redline-host-dialog] button[data-primary]');
    await waitUntil(() => worker.evaluate(() => globalThis.__reviewRemoveFailures >= 2), 'second failed deletion');
    await h.idle();
    check('a repeated failed Discard still reports failure instead of remaining at Discarding', /Could not discard/.test(await h.message()), await h.message());
  }
  await worker.evaluate(() => { globalThis.__failReviewRemove = false; });
  if (!restoreVisible) await reload();
  else await access.inject().then(() => access.inject()).then(waitRecovery);
  await h.press('dialog[data-redline-recovery-dialog] [data-redline-recovery-discard]');
  await waitUntil(async () => (await draft()) === null, 'successful discard retry');
  check('retrying Discard after storage recovers removes the draft', (await draft()) === null);
  check('no uncaught browser errors', errors.length === 0, errors.join(' | '));
  await access.dispose();
} catch (error) {
  check('review run completed', false, error.stack);
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(`${results.filter(result => result.pass).length}/${results.length} Phase 3 lead-review checks passed`);
process.exitCode = results.every(result => result.pass) ? 0 : 1;
