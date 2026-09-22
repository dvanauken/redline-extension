/** Preserve page layout when Annotate hides a classic scrollbar. */
import {createChecker,launch,openRedline,startServer} from './harness.mjs';
import {helpers} from './ui-helpers.mjs';
const {check,results}=createChecker();
const fixture='<!doctype html><style>body{margin:0;height:1600px}.stage{height:600px;margin-left:255px;background:#DDEEDD}canvas{width:100%;height:100%;display:block}</style><div class="stage"><canvas></canvas></div><script>window.resets=0;window.view=0;const s=document.querySelector(".stage");new ResizeObserver(()=>{window.resets++;window.view=0}).observe(s);s.onpointermove=e=>{if(e.buttons===1)window.view+=e.movementX};</script>';
const {server,origin}=await startServer({'/stage':fixture});
const {context,worker,scratch}=await launch({viewport:{width:1400,height:880},showScrollbars:true});
try {
 const page=context.pages()[0];await page.goto(origin+'/stage');await page.waitForTimeout(100);
 const access=await openRedline({context,worker,page});const h=helpers({page,access,scratch});
 const state=()=>page.evaluate(()=>({width:document.querySelector('.stage').getBoundingClientRect().width,resets:window.resets,view:window.view,scroll:scrollY}));
 await page.keyboard.press('F2');await page.waitForTimeout(100);
 check('the fixture has a real desktop scrollbar',await page.evaluate(()=>innerWidth-document.documentElement.clientWidth>0));
 await page.mouse.move(500,300);await page.mouse.down();await page.mouse.move(650,340,{steps:8});await page.mouse.up();
 const arranged=await state();check('Browse allows the user to arrange the scene',arranged.view!==0);
 const annotate=await access.evaluate(()=>{const b=globalThis.__redlineTestRoot.querySelector('[data-redline-mode-toggle]').getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
 await page.mouse.click(annotate.x,annotate.y);await page.waitForTimeout(150);
 check('clicking Annotate preserves the arranged view and canvas size',JSON.stringify(await state())===JSON.stringify(arranged),JSON.stringify(await state()));
 check('Annotate still locks page scrolling',await page.evaluate(()=>getComputedStyle(document.body).overflow==='hidden'));
 await h.exportPNG();
 check('export does not resize or reset the arranged scene',JSON.stringify(await state())===JSON.stringify(arranged));
 await page.keyboard.press('F2');await page.waitForTimeout(100);
 check('returning to Browse preserves the arranged view',JSON.stringify(await state())===JSON.stringify(arranged));
 check('Browse removes the temporary scrollbar rule',await page.evaluate(()=>!document.documentElement.hasAttribute('data-redline-scrollbar')));
 await page.keyboard.press('F2');await page.waitForTimeout(100);
 check('keyboard Annotate also preserves the view',JSON.stringify(await state())===JSON.stringify(arranged));
 await access.inject();await page.waitForTimeout(100);
 check('closing Redline restores scrolling without resizing the scene',JSON.stringify(await state())===JSON.stringify(arranged) && await page.evaluate(()=>getComputedStyle(document.body).overflow!=='hidden'));

 // A page with no scrollbar must not gain a reserved gutter.
 await page.addStyleTag({content:'body{height:650px}'});
 await page.waitForTimeout(100);
 const noScroll=await state();
 await access.inject();await page.waitForTimeout(100);
 check('pages without scrollbars keep their original width',JSON.stringify(await state())===JSON.stringify(noScroll));
 await page.keyboard.press('F2');await page.waitForTimeout(100);
 check('Browse keeps a scrollbar-free page unchanged',JSON.stringify(await state())===JSON.stringify(noScroll));

 // Respect sites that already reserve both gutters.
 await page.addStyleTag({content:'html{scrollbar-gutter:stable both-edges}body{height:1600px}'});
 await page.waitForTimeout(100);
 const stable=await state();await page.keyboard.press('F2');await page.waitForTimeout(100);
 check('a site-owned stable both-edges gutter is preserved',JSON.stringify(await state())===JSON.stringify(stable) && await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarGutter==='stable both-edges'));
 await access.dispose();
} catch(error){check('layout run completed',false,error.stack);}
finally{await context.close();await new Promise(r=>server.close(r));}
console.log(results.filter(r=>r.pass).length+'/'+results.length+' mode-layout checks passed');
process.exitCode=results.every(r=>r.pass)?0:1;
