export async function checkToolbarPin({ page, evaluate, worker, check, waitUntil }) {
  const state = () => evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const toolbar = sr.querySelector('[data-redline-toolbar]');
    const pin = sr.querySelector('[data-redline-pin]');
    const rect = toolbar.getBoundingClientRect();
    return { x: rect.x, y: rect.y, pinned: toolbar.hasAttribute('data-pinned'),
      positioned: toolbar.hasAttribute('data-positioned'), pressed: pin.getAttribute('aria-pressed'),
      active: pin.hasAttribute('data-active'), disabled: pin.disabled,
      background: getComputedStyle(pin).backgroundColor, label: pin.getAttribute('aria-label') };
  });
  const center = selector => evaluate(selector => {
    const element = globalThis.__redlineTestRoot.querySelector(selector);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  const clickPin = async () => {
    const point = await center('[data-redline-pin]');
    await page.mouse.click(point.x, point.y);
    await page.mouse.move(100, 400);
  };
  const drag = async () => {
    const point = await center('[data-redline-grip]');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 80, point.y + 100, { steps: 4 });
    await page.mouse.up();
  };
  await page.setViewportSize({ width: 2200, height: 1000 });
  const unpinned = await state();
  await clickPin();
  let pinned = await state();
  check('real pin click docks toolbar at the top-left', unpinned.x > 100 && pinned.x === 10 && pinned.y === 10, JSON.stringify(pinned));
  check('pin has visible and accessible pressed feedback', pinned.pressed === 'true' && pinned.active
    && pinned.background !== unpinned.background && pinned.label === 'Unpin toolbar from the top-left');
  await clickPin();
  let current = await state();
  check('unpin restores centered positioning and neutral feedback', current.x > 100 && !current.pinned
    && current.pressed === 'false' && !current.active && current.background === unpinned.background);
  await drag();
  check('toolbar can be moved before pinning', (await state()).y > 50);
  await clickPin();
  pinned = await state();
  check('pin clears a dragged position before docking', pinned.x === 10 && pinned.y === 10 && !pinned.positioned, JSON.stringify(pinned));
  await drag();
  current = await state();
  check('dragging unpins and clears the pin highlight and tooltip', !current.pinned && !current.active
    && current.pressed === 'false' && current.label === 'Pin toolbar to the top-left');
  await page.keyboard.press('F2');
  check('pin stays enabled in Page mode', !(await state()).disabled);
  await clickPin();
  pinned = await state();
  check('real pin click works in Page mode', pinned.pinned && pinned.active && pinned.x === 10 && pinned.y === 10, JSON.stringify(pinned));
  await waitUntil(async () => {
    const preferences = await worker.evaluate(async () => (await chrome.storage.local.get('redline.preferences'))['redline.preferences']);
    return preferences?.toolbarPinned === true && preferences?.toolbarPosition === null;
  }, 'pin state persisted');
  check('pinned state persists without a stale dragged position', true);
  await page.keyboard.press('F2');
  pinned = await state();
  check('pin feedback survives switching back to annotation mode', pinned.active && pinned.pressed === 'true');
  await clickPin();
  await page.setViewportSize({ width: 1200, height: 800 });
  await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]').scrollLeft = 0; });
}
