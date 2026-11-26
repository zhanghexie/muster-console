/** Production card: collapse, tooltip, and every visible frame of upward async Diff. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
const root = process.cwd();
const release = acquireTestLease(root);
const output = path.join(root, '.tmp/turn-changes-card-visual');
fs.mkdirSync(output, { recursive: true });
let server, browser;
try {
  const plugins = process.argv.includes('--baseline-preview') ? [{ name: 'baseline-preview', setup(builder) {
    builder.onLoad({ filter: /TurnDiffPreview\.tsx$/ }, () => ({ loader: 'tsx', resolveDir: path.join(root, 'src/renderer/src/chatSurface'),
      contents: execFileSync('git', ['show', 'HEAD:src/renderer/src/chatSurface/TurnDiffPreview.tsx'], { cwd: root, encoding: 'utf8', windowsHide: true }) }));
  } }] : [];
  await build({ plugins, stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import './src/renderer/src/i18n';
    import './src/renderer/src/styles/base.css'; import './src/renderer/src/styles/dialogs.css'; import './src/renderer/src/styles/git.css'; import './src/renderer/src/styles/turn-changes.css';
    import {applyTheme} from './src/renderer/src/theme'; import {builtinTheme} from './src/shared/theme';
    import {TurnChangesCard} from './src/renderer/src/chatSurface/TurnChangesCard';
    import {TooltipHost} from './src/renderer/src/components/Tooltip';
    const diff='diff --git a/a.ts b/a.ts\\n--- a/a.ts\\n+++ b/a.ts\\n@@ -1 +1,40 @@\\n-old\\n'+Array.from({length:40},(_,i)=>'+const row'+i+' = "new";').join('\\n')+'\\n';
    window.api={turnChanges:{diff:()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,diff}),180))}};
    window.setTheme=theme=>applyTheme(builtinTheme(theme)); window.setTheme('light');
    createRoot(document.getElementById('root')).render(<><TurnChangesCard target={{kind:'gui',id:'s',messageId:'m'}} summary={{id:'s',state:'ready',warnings:['本轮开始时文件基线尚未就绪（预热或重新校验），已按文件采集写前原文；缺少可靠写前记录的变化可能未完整覆盖，且不会自动回退'],files:Array.from({length:5},(_,i)=>i===1
      ? {path:'dist/index.html',kind:'added',diffOmitted:true,added:null,removed:null,revertible:false}
      : {path:'src/file'+i+'.ts',kind:'modified',added:i+1,removed:1,revertible:true})}}/><TooltipHost/></>);
  ` }, outfile:path.join(output,'fixture.js'), bundle:true, format:'esm', jsx:'automatic', loader:{'.woff2':'file','.woff':'file'} });
  server=createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    if(name==='/') { res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><style>body{padding:12px;background:var(--surface-canvas)}#root{width:min(640px,100%);margin-top:380px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');return; }
    const file=path.join(output,path.basename(name));
    if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});
  for(const theme of ['light','dark']) for(const width of [900,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.turn-changes-file').first().waitFor();
    await page.evaluate(theme=>window.setTheme(theme),theme);
    assert.equal(await page.locator('.turn-changes-file').count(),3);
    await page.screenshot({path:path.join(output,`${theme}-${width}-collapsed.png`)});
    await page.getByRole('button',{name:'再显示 2 个文件'}).click();
    await page.getByRole('button',{name:/src\/file4.ts/}).waitFor();
    await page.screenshot({path:path.join(output,`${theme}-${width}-expanded.png`),animations:'disabled'});
    await page.getByRole('button',{name:'收起文件'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.turn-changes-file').length===3);
    await page.getByRole('button',{name:'改动说明'}).hover();
    await page.getByRole('tooltip').waitFor();
    await page.waitForFunction(()=>{const tip=document.querySelector('[role=tooltip]');return tip&&getComputedStyle(tip).opacity==='1';});
    assert.match(await page.getByRole('tooltip').textContent(),/本轮开始时/);
    await page.screenshot({path:path.join(output,`${theme}-${width}-tooltip.png`)});
    // Move the card down so all sizes open above; keep animations enabled and
    // sample every frame from the hover through the delayed IPC result.
    await page.mouse.move(1,1);
    await page.evaluate(()=>{ document.getElementById('root').style.marginTop='570px';window.framesSeen=[];
      window.sample=true;const tick=()=>{const p=document.querySelector('.turn-diff-preview'),row=document.querySelector('.turn-changes-file');
        if(p&&getComputedStyle(p).visibility!=='hidden'&&Number(getComputedStyle(p).opacity)>0){const r=p.getBoundingClientRect(),a=row.getBoundingClientRect();window.framesSeen.push({bottom:r.bottom,top:r.top,anchor:a.top});}
        if(window.sample)requestAnimationFrame(tick);};requestAnimationFrame(tick);
    });
    await page.locator('.turn-changes-file').first().hover();
    await page.locator('.diff-code').first().waitFor();
    await page.waitForFunction(()=>window.framesSeen.length>15);
    const frames=await page.evaluate(()=>{window.sample=false;return window.framesSeen;});
    assert(frames.length>0);
    for(const frame of frames){assert(frame.bottom<=frame.anchor-5,JSON.stringify(frame));assert(frame.top>=10,JSON.stringify(frame));}
    await page.screenshot({path:path.join(output,`${theme}-${width}-preview.png`)});
    await page.getByRole('button',{name:/dist\/index.html.*新增/}).focus();
    await page.getByText('超出审阅大小上限，仅记录文件变化。').waitFor();
    await page.screenshot({path:path.join(output,`${theme}-${width}-oversized.png`),animations:'disabled'});
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('ok: production card light/dark, wide/narrow, collapse/reopen, tooltip and upward async Diff frame bounds');
} finally {await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());release();}
