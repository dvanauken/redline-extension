import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkCropAndPageMode({ page, evaluate, importFile, clickAction, check, waitUntil, marks, scratch, baselinePath, inject }) {
  const near = (a, b) => Math.abs(a - b) < 2;
  const frame = () => evaluate(() => {
    const element = globalThis.__redlineTestRoot.querySelector('[data-redline-crop-frame]');
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, hidden: element.hidden };
  });
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 5 }); await page.mouse.up();
  };
  const action = name => evaluate(name => globalThis.__redlineTestRoot.querySelector('[data-crop-action="' + name + '"]').click(), name);
  const selectCrop = () => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-tool="crop"]').click());
  const handleCenter = name => evaluate(name => {
    const r = globalThis.__redlineTestRoot.querySelector('[data-redline-crop-handle="' + name + '"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  const exportJSON = async name => {
    const [download] = await Promise.all([page.waitForEvent('download'), clickAction('json')]);
    const file = path.join(scratch, name + '.json');
    await download.saveAs(file);
    return { data: JSON.parse(await fs.readFile(file, 'utf8')), file };
  };
  const original = (await exportJSON('before-crop')).data;
  await selectCrop();
  await drag(150, 240, 450, 380);
  let rect = await frame();
  check('crop follows the pointer after a nonuniform document resize',
    near(rect.x, 150) && near(rect.y, 240) && near(rect.width, 300) && near(rect.height, 140), JSON.stringify(rect));
  check('crop offers eight resize handles', await evaluate(() =>
    [...globalThis.__redlineTestRoot.querySelectorAll('[data-redline-crop-handle]')].filter(el => el.checkVisibility()).length === 8));

  let point = await handleCenter('se');
  await drag(point.x, point.y, point.x + 30, point.y + 20);
  rect = await frame();
  check('crop corner resizes both dimensions', near(rect.width, 330) && near(rect.height, 160), JSON.stringify(rect));
  point = await handleCenter('w');
  await drag(point.x, point.y, point.x - 20, point.y);
  rect = await frame();
  check('crop edge keeps the opposite edge anchored', near(rect.x, 130) && near(rect.width, 350), JSON.stringify(rect));
  await drag(250, 280, 270, 300);
  rect = await frame();
  check('drag inside crop moves the frame', near(rect.x, 150) && near(rect.y, 260), JSON.stringify(rect));
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowDown');
  rect = await frame();
  check('crop keyboard nudges use screen pixels', near(rect.x, 160) && near(rect.y, 261), JSON.stringify(rect));
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-crop-handle="e"]').focus());
  await page.keyboard.press('Shift+ArrowRight');
  rect = await frame();
  check('focused crop handle resizes by keyboard', near(rect.width, 360), JSON.stringify(rect));
  await page.mouse.move(250, 290); await page.mouse.down();
  await page.mouse.move(280, 320);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  check('Escape cancels an unfinished crop gesture', JSON.stringify(await frame()) === JSON.stringify(rect));
  await page.keyboard.press('Escape');
  check('Escape leaves crop editing without closing Redline', await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    return sr.querySelector('[data-redline-root]').open
      && sr.querySelector('[data-redline-canvas]').dataset.tool !== 'crop'
      && !sr.querySelector('[data-redline-crop-frame]').hidden;
  }));

  // Verify the page really receives events while the dimmed toolbar stays open.
  await page.evaluate(() => {
    globalThis.__redlinePageClicks = 0;
    document.querySelector('#page-button').addEventListener('click', () => globalThis.__redlinePageClicks++);
    const input = document.createElement('input');
    input.id = 'page-mode-input';
    input.setAttribute('aria-label', 'Page mode test input');
    input.style.cssText = 'position:fixed;left:50px;top:420px;width:220px;height:30px;';
    document.body.appendChild(input);
  });
  await clickAction('page-mode');
  const paused = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    const root = sr.querySelector('[data-redline-root]');
    const toolbar = sr.querySelector('[data-redline-toolbar]');
    return { open: root.open, modal: root.matches(':modal'), page: root.hasAttribute('data-page-mode'),
      opacity: getComputedStyle(toolbar).opacity,
      cropVisible: sr.querySelector('[data-redline-crop-layer]').checkVisibility(),
      locked: getComputedStyle(document.body).overflow === 'hidden' };
  });
  check('Page mode is nonmodal, dimmed, and removes crop interception',
    paused.open && !paused.modal && paused.page && Number(paused.opacity) < 1 && !paused.cropVisible && !paused.locked, JSON.stringify(paused));
  check('Annotate label fits the paused toolbar switch', await evaluate(() => {
    const button = globalThis.__redlineTestRoot.querySelector('[data-redline-mode]');
    return button.scrollWidth <= button.clientWidth + 1;
  }));
  await page.locator('#page-button').click();
  check('the underlying page button receives real clicks', await page.evaluate(() => globalThis.__redlinePageClicks) === 1);
  await page.locator('#page-mode-input').fill('page typing vaprnt');
  await page.keyboard.press('Backspace');
  await page.mouse.move(570, 500);
  await page.screenshot({ path: path.join(scratch, 'page-mode-ui.png') });
  check('page typing and Backspace are not annotation shortcuts',
    await page.locator('#page-mode-input').inputValue() === 'page typing vaprn' && await marks() === 2);
  await page.mouse.move(570, 500);
  await page.mouse.wheel(0, 250);
  await waitUntil(() => page.evaluate(() => scrollY > 0), 'page scrolls in Page mode');
  check('page scrolling works with the toolbar open', true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.keyboard.press('F2');
  const resumed = await evaluate(() => {
    const sr = globalThis.__redlineTestRoot;
    return { modal: sr.querySelector('[data-redline-root]').matches(':modal'),
      border: getComputedStyle(sr.querySelector('[data-redline-toolbar]')).borderTopColor,
      opacity: getComputedStyle(sr.querySelector('[data-redline-toolbar]')).opacity,
      locked: getComputedStyle(document.body).overflow === 'hidden',
      cropVisible: sr.querySelector('[data-redline-crop-layer]').checkVisibility() };
  });
  check('F2 from the page restores annotation mode and its green border',
    resumed.modal && resumed.border === 'rgb(74, 222, 128)' && resumed.opacity === '1' && resumed.locked && resumed.cropVisible, JSON.stringify(resumed));
  check('mode switching preserves crop and marks', JSON.stringify(await frame()) === JSON.stringify(rect) && await marks() === 2);
  await page.keyboard.press('F2');
  await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-mode]').scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const resumeButton = await evaluate(() => {
    const r = globalThis.__redlineTestRoot.querySelector('[data-redline-mode]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(resumeButton.x, resumeButton.y);
  check('the dimmed toolbar can resume annotation with a real click',
    await evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').matches(':modal')));
  await page.evaluate(() => document.querySelector('#page-mode-input').remove());

  // Return to a known region to independently check PNG dimensions and pixels.
  await selectCrop();
  await action('reset');
  await action('all');
  rect = await frame();
  check('Select all supports keyboard-only crop creation', near(rect.x, 0) && near(rect.y, 0)
    && near(rect.width, 600) && near(rect.height, 800));
  await action('reset');
  await drag(450, 380, 150, 240);
  rect = await frame();
  check('crop can be drawn in reverse', near(rect.x, 150) && near(rect.y, 240)
    && near(rect.width, 300) && near(rect.height, 140));
  await page.screenshot({ path: path.join(scratch, 'crop-ui.png') });
  console.log('Crop preview: ' + path.join(scratch, 'crop-ui.png'));
  const cropJSON = await exportJSON('crop-roundtrip');
  check('JSON retains all marks, including those outside the crop',
    JSON.stringify(cropJSON.data.document.annotations) === JSON.stringify(original.document.annotations));
  check('JSON crop uses document coordinates', JSON.stringify(cropJSON.data.document.crop)
    === JSON.stringify({ x: 250, y: 150, width: 500, height: 87.5 }), JSON.stringify(cropJSON.data.document.crop));

  for (const [scale, expectedWidth, expectedHeight] of [[1, 600, 280], [2, 1200, 560], [0.5, 300, 140]]) {
    await evaluate(scale => {
      const select = globalThis.__redlineTestRoot.querySelector('[aria-label="Image output scale"]');
      select.value = String(scale);
      select.dispatchEvent(new Event('change'));
    }, scale);
    const [download] = await Promise.all([page.waitForEvent('download'), clickAction('download')]);
    const file = path.join(scratch, 'crop-' + scale + '.png');
    await download.saveAs(file);
    const png = await fs.readFile(file);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    check('cropped PNG output at ' + scale * 100 + '%', width === expectedWidth && height === expectedHeight, width + '×' + height);
    const samples = await evaluate(async ({ base64, baseline, scale }) => {
      const decode = async value => {
        const img = new Image(); img.src = 'data:image/png;base64,' + value;
        await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx;
      };
      const actual = await decode(base64), reference = await decode(baseline);
      return {
        line: [...actual.getImageData(Math.round(150 * 2 * scale), Math.round(60 * 2 * scale), 1, 1).data],
        edge: [...actual.getImageData(0, 0, 1, 1).data],
        reference: [...reference.getImageData(300, 480, 1, 1).data],
      };
    }, { base64: png.toString('base64'), baseline: (await fs.readFile(baselinePath)).toString('base64'), scale });
    check('cropped annotations align at ' + scale * 100 + '%', Math.abs(samples.line[0] - 220) < 5
      && Math.abs(samples.line[1] - 38) < 5 && Math.abs(samples.line[2] - 38) < 5, JSON.stringify(samples.line));
    check('crop chrome is excluded at ' + scale * 100 + '%',
      samples.edge.every((value, i) => Math.abs(value - samples.reference[i]) < 5), JSON.stringify(samples));
    await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-toolbar]').hasAttribute('data-busy')), 'crop export complete');
    // captureVisibleTab permits two captures per second.
    await page.waitForTimeout(600);
  }
  const scaledJSON = await exportJSON('scaled-crop-roundtrip');
  check('JSON preserves output scaling', scaledJSON.data.document.outputScale === 0.5);
  await action('reset');
  await importFile(scaledJSON.file);
  await waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-crop-frame]').hidden), 'crop restored');
  check('JSON import restores crop and scale', near((await frame()).width, 300)
    && await evaluate(() => globalThis.__redlineTestRoot.querySelector('[aria-label="Image output scale"]').value) === '0.5');
  await action('done');
  await page.keyboard.press('Escape');
  await inject();
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]').open
    && globalThis.__redlineTestRoot.querySelector('[data-redline-crop-frame]').getBoundingClientRect().width > 0), 'crop session reopened');
  check('close/reopen retains the crop', near((await frame()).width, 300));
  await page.setViewportSize({ width: 900, height: 600 });
  rect = await frame();
  check('crop follows document scaling when the viewport changes again',
    near(rect.x, 225) && near(rect.y, 180) && near(rect.width, 450) && near(rect.height, 105), JSON.stringify(rect));
  await page.setViewportSize({ width: 600, height: 800 });
  const invalid = path.join(scratch, 'invalid-crop.json');
  await fs.writeFile(invalid, JSON.stringify({ ...scaledJSON.data,
    document: { ...scaledJSON.data.document, crop: { x: -1, y: 0, width: 20, height: 20 } } }));
  await importFile(invalid);
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent.includes('Crop must')), 'invalid crop rejected');
  check('invalid crop import preserves the existing document',
    JSON.stringify((await exportJSON('after-invalid-crop')).data.document) === JSON.stringify(scaledJSON.data.document));
  await importFile(path.join(scratch, 'before-crop.json'));
  await waitUntil(() => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-crop-panel]').hidden), 'legacy full-screen document restored');
  check('legacy JSON and Reset restore full-screen export without losing annotations', await marks() === 2);
}
