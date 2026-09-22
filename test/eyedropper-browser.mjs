/** Eyedropper: real viewport pixels, DPR, styles, cancellation and capture failure. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChecker, launch, openRedline, startServer, waitUntil } from './harness.mjs';
import { helpers, setCaptureDelay } from './ui-helpers.mjs';
const { check, results } = createChecker();
const { server, origin } = await startServer({
  '/colors': '<!doctype html><body style="margin:0;background:#336699;min-height:1600px"><button id="green" style="position:absolute;left:500px;top:300px;width:400px;height:300px;background:#12AB34;border:0" onclick="window.clicked=(window.clicked||0)+1"></button><canvas id="pixels" width="100" height="80" style="position:absolute;left:100px;top:300px"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#E47A22";c.fillRect(0,0,100,80);</script></body>',
});
await fs.mkdir('test-artifacts/eyedropper', { recursive: true });
try {
  for (const dpr of [1, 2]) {
    const { context, worker, scratch } = await launch({ deviceScaleFactor: dpr });
    const tag = 'DPR ' + dpr + ': ';
    try {
      const page = context.pages()[0];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/colors');
      const access = await openRedline({ context, worker, page });
      const h = helpers({ page, access, scratch });
      const state = () => access.evaluate(() => {
        const r = globalThis.__redlineTestRoot;
        const eye = r.querySelector('[data-redline-eyedropper]');
        return { open: Boolean(eye?.open), ready: Boolean(eye?.querySelector('[data-eyedropper-image]')),
          palette: r.querySelector('[data-dialog="redline-color"]').open,
          color: r.querySelector('[data-eyedropper-loupe] output')?.value,
          focused: r.activeElement?.hasAttribute('data-redline-eyedropper-button') };
      });
      const start = async (role = 'stroke') => {
        if (!(await state()).palette) await h.press('[data-redline-color="' + role + '"]');
        await h.press('[data-redline-eyedropper-button]');
        await waitUntil(async () => (await state()).ready, 'eyedropper pixels', 15000);
      };
      const pick = async (x,y) => {
        await page.mouse.move(x,y);
        const color = (await state()).color;
        await page.mouse.click(x,y);
        await waitUntil(async () => !(await state()).palette, 'applied sample');
        return color;
      };
      const mark = { id:'shape',type:'rectangle',width:4,color:'#D97706',intent:'question',fill:'#AA0000',fillOpacity:.35,start:{x:510,y:310},end:{x:880,y:580} };
      await h.load({ width:1200,height:800,annotations:[mark] });
      await page.keyboard.press('p');
      await start();
      check(tag+'the sampler shows a full viewport capture at the actual pixel ratio',
        await access.evaluate(expected => {
          const canvas=globalThis.__redlineTestRoot.querySelector('[data-eyedropper-image]');
          return canvas.width===1200*expected && canvas.height===800*expected;
        },dpr));
      check(tag+'sampling through a filled annotation returns the underlying page color', await pick(700,450)==='#12AB34');
      await page.mouse.move(250,500);await page.mouse.down();await page.mouse.move(350,520);await page.mouse.up();
      let doc=(await h.exportJSON()).document;
      check(tag+'sampled color applies to the next drawn mark',doc.annotations.at(-1).color==='#12AB34');
      check(tag+'picking never activates the underlying page button', await page.evaluate(()=>!window.clicked));

      await page.keyboard.press('v');await page.mouse.click(510,450);
      await start('fill');
      check(tag+'canvas-rendered page content can be sampled',await pick(150,340)==='#E47A22');
      doc=(await h.exportJSON()).document;
      const filled=doc.annotations.find(n=>n.id==='shape');
      check(tag+'selected fill sampling preserves outline, opacity, and meaning',
        filled.fill==='#E47A22' && filled.fillOpacity===.35 && filled.color===mark.color && filled.intent===mark.intent);
      await h.click('[data-redline-action="undo"]');
      check(tag+'one undo restores the previous fill',(await h.exportJSON()).document.annotations.find(n=>n.id==='shape').fill===mark.fill);
      await h.click('[data-redline-action="redo"]');
      await page.keyboard.press('v');await page.mouse.click(510,450);
      await start('stroke');
      check(tag+'the toolbar and toast do not contaminate sampled page pixels', await pick(200,150)==='#336699');
      const outlined=(await h.exportJSON()).document.annotations.find(n=>n.id==='shape');
      check(tag+'outline sampling preserves independent fill/opacity and clears a named intent',
        outlined.color==='#336699' && outlined.fill==='#E47A22' && outlined.fillOpacity===.35 && !outlined.intent);
      await page.keyboard.press('p');await start();
      await page.keyboard.press('Escape');
      await waitUntil(async()=>!(await state()).open,'sample cancelled');
      check(tag+'Escape returns to the palette and focuses Pick from page',(await state()).palette && (await state()).focused);
      await page.keyboard.press('Escape');
      await page.mouse.move(250,550);await page.mouse.down();await page.mouse.move(350,570);await page.mouse.up();
      check(tag+'cancelling and selected-object edits preserve new-tool defaults',(await h.exportJSON()).document.annotations.at(-1).color==='#12AB34');

      await start();
      await page.mouse.move(149,340);await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+ArrowLeft');
      check(tag+'keyboard movement samples page pixels and Enter applies them',(await state()).color==='#E47A22');
      await page.keyboard.press('Enter');await waitUntil(async()=>!(await state()).palette,'keyboard pick');
      await start();
      await page.mouse.move(1199,799);
      const bounds=await access.evaluate(()=>{
        const box=globalThis.__redlineTestRoot.querySelector('[data-eyedropper-loupe]').getBoundingClientRect();
        return box.x>=0 && box.y>=0 && box.right<=innerWidth && box.bottom<=innerHeight;
      });
      check(tag+'magnifier stays inside the window at the bottom-right corner',bounds);
      await page.screenshot({path:path.join('test-artifacts/eyedropper','dpr'+dpr+'-sample.png')});
      await page.keyboard.press('Escape');await page.keyboard.press('Escape');

      await page.setViewportSize({width:420,height:800});await page.waitForTimeout(100);
      // The strip is horizontally scrollable below the supported 1200px
      // baseline. Open the palette directly here; this assertion is about the
      // palette's own narrow layout, not the strip's scroll position.
      await access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-color="stroke"]').click());
      await waitUntil(async()=>(await state()).palette,'narrow palette opened');
      const button=await h.rect('[data-redline-eyedropper-button]');
      check(tag+'Pick from page stays reachable at 420px',button.visible && button.x>=0 && button.right<=420);
      await page.screenshot({path:path.join('test-artifacts/eyedropper','dpr'+dpr+'-palette-420.png')});
      await start();await page.mouse.move(410,790);
      await page.screenshot({path:path.join('test-artifacts/eyedropper','dpr'+dpr+'-sample-420.png')});
      await page.setViewportSize({width:1200,height:800});
      await waitUntil(async()=>!(await state()).open,'resize cancels');
      check(tag+'resize cancels the snapshot instead of sampling misaligned pixels',(await state()).palette);
      await page.keyboard.press('Escape');
      await start();
      await access.inject();await waitUntil(async()=>!(await state()).open,'closing cancels');
      check(tag+'closing Redline removes the eyedropper and its captured image',!(await state()).ready && !(await state()).palette);
      await access.inject();await page.waitForTimeout(100);

      if(dpr===1) {
        await setCaptureDelay(worker,650);
        await h.press('[data-redline-color="stroke"]');await h.press('[data-redline-eyedropper-button]');
        await access.inject();await page.waitForTimeout(850);
        check(tag+'a late capture cannot resurrect a cancelled sampler',!(await state()).open && !(await state()).ready);
        await setCaptureDelay(worker,0);await access.inject();await page.waitForTimeout(100);
        await worker.evaluate(()=>{
          const capture=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
          chrome.tabs.captureVisibleTab=(...args)=>globalThis.failEyeCapture ? Promise.reject(new Error('Simulated capture failure')) : capture(...args);
          globalThis.failEyeCapture=true;
        });
        await h.press('[data-redline-color="stroke"]');await h.press('[data-redline-eyedropper-button]');
        await waitUntil(async()=>/Could not pick a page color/.test(await h.message()),'capture error');
        check(tag+'capture failures restore the palette without changing a color',(await state()).palette && !(await state()).open && (await state()).focused);
        await worker.evaluate(()=>{globalThis.failEyeCapture=false;});
        await start();await page.keyboard.press('Escape');await page.keyboard.press('Escape');
      }
      check(tag+'sample canvases and pixels are not exposed in the ordinary page',
        await page.evaluate(()=>document.querySelector('[data-redline-extension]').shadowRoot===null && !document.querySelector('[data-eyedropper-image]')));
      check(tag+'no uncaught page errors',errors.length===0,errors.join(' | '));
      await access.dispose();
    } finally { await context.close(); }
  }
} catch(error) { check('eyedropper run completed',false,error.stack); }
finally { await new Promise(resolve=>server.close(resolve)); }
console.log(results.filter(r=>r.pass).length+'/'+results.length+' eyedropper checks passed');
process.exitCode=results.every(r=>r.pass)?0:1;
