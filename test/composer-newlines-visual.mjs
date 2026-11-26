/** 真实 Chromium 键盘：Shift+Enter / 多行粘贴 → Composer 发送 → 用户 Markdown 气泡。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-composer-lines-'));
const captures = process.env.UI_CAPTURE_DIR;
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import './src/renderer/src/i18n';
import {StoreProvider} from './src/renderer/src/store';
import {AgentComposer} from './src/renderer/src/components/AgentComposer';
import {ChatMessageView} from './src/renderer/src/components/ChatMessageView';
import {applyTheme} from './src/renderer/src/theme';
import {builtinTheme} from './src/shared/theme';
const defaults={'workspaces.list':{workspaces:[],activeWorkspaceId:null},'config.get':{workspaces:[],locale:'zh-CN'},'sessions.list':{sessions:[],activeId:null},'sessions.observe':{sessions:[],activeId:null},'runtimes.list':[],'notify.list':[],'agent.listSkills':{skills:[{name:'journal',description:'日志'}]}};
function api(p=''){return new Proxy(()=>{}, {get:(_,k)=>k==='then'?undefined:api(p?p+'.'+String(k):String(k)),apply:()=>p==='on'?()=>{}:Promise.resolve(defaults[p])});}
window.api=api(); window.sent=[];
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light'));
function App(){const [messages,setMessages]=React.useState([]);return <StoreProvider><main style={{padding:16,background:'var(--bg-panel)',minHeight:'100vh'}}><section>{messages.map((m,i)=><ChatMessageView key={i} message={m}/>)}</section><AgentComposer workspaceId="lines-test" surfaceKind="gui-session" busy={false} onClear={async()=>{}} onSend={async text=>{window.sent.push(text);setMessages(ms=>[...ms,{id:String(ms.length),role:'user',content:text,createdAt:Date.now()}]);return true;}}/></main></StoreProvider>}
createRoot(document.getElementById('root')).render(<App/>);`;
let server, browser;
try {
  await build({ stdin:{contents:fixture,loader:'tsx',resolveDir:root},outfile:path.join(tmp,'fixture.js'),bundle:true,format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'}, loader:{'.webp':'dataurl','.png':'dataurl','.svg':'dataurl','.ttf':'dataurl','.woff':'dataurl','.woff2':'dataurl'}, plugins:[{name:'vite-raw-assets',setup(builder){builder.onLoad({filter:/./},args=>args.suffix==='?raw'?{contents:fs.readFileSync(args.path,'utf8'),loader:'text'}:undefined);}}] });
  server=createServer((req,res)=>{
    if(req.url.startsWith('/fixture.js')) {res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(tmp,'fixture.js')));}
    else if(req.url.startsWith('/fixture.css')) {res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(tmp,'fixture.css')));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});
  for(const theme of ['light','dark']) for(const width of [780,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.stack ?? e.message));
    await page.route('https://**',route=>route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    for(const name of ['base','chat','markdown','agent-chat','float']) await page.addStyleTag({path:path.join(root,`src/renderer/src/styles/${name}.css`)});
    const editor=page.getByRole('textbox');
    try { await editor.waitFor({timeout: 5000}); } catch (error) { throw new Error(`Composer fixture did not mount: ${errors.join('\n')}\n${error}`); }
    await editor.click(); await editor.pressSequentially('/');
    await page.getByRole('option', {name: /\/skill:journal/}).click();
    await editor.press('Backspace'); await editor.press('Backspace');
    const afterSkill = await editor.evaluate(el => ({html:el.innerHTML, empty:el.dataset.empty, caret:window.getSelection()?.anchorOffset}));
    assert.equal(afterSkill.empty, 'true', JSON.stringify(afterSkill));
    if(captures){fs.mkdirSync(captures,{recursive:true});await page.screenshot({path:path.join(captures,`${theme}-${width}-skill-cleared.png`),caret:'initial'});}
    await editor.pressSequentially('a');
    assert.equal(await editor.textContent(), 'a', '删除技能后应从首行输入');
    await editor.press('ControlOrMeta+a'); await editor.press('Backspace');
    const cases=[['测试输入','1. 测试1','2. 测试2'],['第一行','第二行']];
    for(const lines of cases) {
      try { await editor.click({timeout: 5000}); } catch (error) { throw new Error(`Composer disappeared: ${errors.join('\n')}\n${error}`); }
      for(const [i,line] of lines.entries()){if(i)await editor.press('Shift+Enter');await editor.pressSequentially(i===2?line.replace(/^2\. /,''):line);}
      if(lines.length===3) {
        assert.equal(await editor.locator('[data-md="ordered"]').count(),2,'有序列表应直接在输入框呈现');
        assert.equal(await editor.locator('[data-md="ordered"]').first().getAttribute('data-prefix'),'1. ','源前缀由行属性承担（不再渲染零宽 span）');
        assert.equal(await editor.locator('[data-md="ordered"]').nth(1).getAttribute('data-marker'),'2.');
      }
      await editor.press('Enter');
      await page.waitForFunction(n=>window.sent.length===n, cases.indexOf(lines)+1);
      assert.equal(await page.evaluate(()=>window.sent.at(-1)),lines.join('\n'));
    }
    assert.equal(await page.locator('.chat-msg.user ol li').count(),2,'输入的有序列表应按列表显示');
    const paragraph=page.locator('.chat-msg.user').nth(1).locator('p');
    assert.equal(await paragraph.textContent(),'第一行\n第二行');
    assert.equal(await paragraph.evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap','普通软换行也须可见');
    const markdown='# 标题\n\n- 无序一\n- 无序二';
    await editor.click();
    await editor.evaluate((el,text)=>{const data=new DataTransfer();data.setData('text/plain',text);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},markdown);
    assert.equal(await editor.locator('[data-md="heading"]').count(),1,'标题应直接在输入框呈现');
    assert.equal(await editor.locator('[data-md="bullet"]').count(),2,'无序列表应直接在输入框呈现');
    assert(await editor.locator('[data-md="heading"]').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>parseFloat(getComputedStyle(el.parentElement).fontSize)));
    if(captures){fs.mkdirSync(captures,{recursive:true});await page.screenshot({path:path.join(captures,`${theme}-${width}-editing.png`)});}
    await editor.press('Enter');await page.waitForFunction(()=>window.sent.length===3);
    assert.equal(await page.evaluate(()=>window.sent.at(-1)),markdown,'多行粘贴须保留 Markdown 源码');
    assert.equal(await page.locator('.chat-msg.user h1').textContent(),'标题');
    assert.equal(await page.locator('.chat-msg.user ul li').count(),2);
    // Native keyboard editing after conversion, list continuation/exit and undo/redo.
    await editor.click();await editor.pressSequentially('1. xxxx');await editor.press('Shift+Enter');
    assert.deepEqual(await editor.locator('[data-md="ordered"]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-prefix'))), ['1. ', '2. ']);
    assert.equal(await editor.textContent(),'xxxx');
    await editor.pressSequentially('yyyy');await editor.press('Control+z');
    assert.equal(await editor.textContent(),'xxxx','输入续写后的正文可以撤销');
    assert.deepEqual(await editor.locator('[data-md="ordered"]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-prefix'))), ['1. ', '2. ']);
    await editor.press('Control+Shift+z');assert.equal(await editor.textContent(),'xxxxyyyy');
    await editor.press('Shift+Enter');assert.equal(await editor.locator('[data-md="ordered"]').last().getAttribute('data-marker'),'3.');
    await editor.press('Shift+Enter');assert.equal(await editor.locator('[data-md="ordered"]').count(),2,'空列表项换行退出');
    await editor.press('Enter');await page.waitForFunction(()=>window.sent.length===4);
    assert.equal(await page.evaluate(()=>window.sent.at(-1)),'1. xxxx\n2. yyyy','发送保持 Markdown 源码，无额外空项目');
    await editor.click();await editor.pressSequentially('1. 第一项');await editor.press('Home');await editor.press('Backspace');
    assert.equal(await editor.locator('[data-md]').count(),0,'正文开头退格应退出列表');
    assert.equal(await editor.textContent(),'第一项');
    await editor.press('Control+z');assert.equal(await editor.locator('[data-md="ordered"]').count(),1);
    await editor.press('ControlOrMeta+a');await editor.press('Backspace');
    assert.equal(await editor.textContent(),'','全选删除不残留空行/隐藏标记');
    assert.equal(await editor.getAttribute('data-empty'),'true', await editor.evaluate(el => el.outerHTML));
    if(captures){fs.mkdirSync(captures,{recursive:true});await page.screenshot({path:path.join(captures,`${theme}-${width}.png`)});}
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('composer-newlines-visual: OK (live blocks, list continuation/exit, undo/redo, raw send, light/dark at 2 widths)');
} finally {
  await browser?.close();
  if(server?.listening) await new Promise(resolve=>server.close(resolve));
  assert(tmp.startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(tmp,{recursive:true,force:true});
}
