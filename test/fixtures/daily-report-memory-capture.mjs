// Real shipped panel + production theme resolver; deterministic host boundary.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {createSharedCompiler} from '../helpers/shared-compile.mjs';
const out=path.resolve('.tmp/daily-report-memory-capture');fs.mkdirSync(out,{recursive:true});
const compile=createSharedCompiler(process.cwd(),path.join(out,'compiled'));
const {resolveAppearance}=await import(pathToFileURL(compile('shared/resolvedAppearance.ts')));
const {builtinTheme}=await import(pathToFileURL(compile('shared/theme.ts')));
const source=fs.readFileSync('resources/extensions/daily-report/ui/panel.html','utf8');
const script=source.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const html=source.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
const css=fs.readFileSync('src/main/extensions/sdk/theme.css','utf8').replace(/@font-face\s*\{[^}]*\}/g,'');
const browser=await chromium.launch({channel:process.env.MEMORY_CAPTURE_BROWSER||'msedge',headless:true});
try{
 for(const [theme,width] of [['dark',1000],['light',1000],['dark',520]]){
  const page=await browser.newPage({viewport:{width,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.abort());
  await page.setContent(html);await page.addStyleTag({content:css+'\n'+fs.readFileSync('resources/extensions/daily-report/ui/panel.css','utf8')});
  await page.evaluate(vars=>{for(const [key,value] of Object.entries(vars))document.documentElement.style.setProperty(key,value);},resolveAppearance(builtinTheme(theme)).cssVars);
  await page.evaluate(()=>{
   const now=new Date(),day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
   window.ma={ready:Promise.resolve({extId:'daily-report'}),journal:{list:async()=>({dates:[day]}),read:async()=>({content:'<!-- muster-journal:fixture:1 -->\n## [记忆目录迁移] 已完成\n- 问题：统一日志和长期记忆的位置\n- 要点：原件保留，迁移校验通过\n<!-- /muster-journal:fixture -->'})},
    data:{read:async()=>null,write:async()=>{},list:async()=>[]},commands:{execute:async()=>[]},fs:{list:async()=>[]},notify:async()=>{},storage:{set:async()=>{}}};
  });
  await page.addScriptTag({content:script});await page.locator('.entry').waitFor();
  assert.ok(!(await page.locator('#detail').innerText()).includes('muster-journal'));
  await page.screenshot({path:path.join(out,`${theme}-${width}.png`)});
  await page.evaluate(()=>{window.ma.journal.read=async()=>{throw new Error('迁移目标已变化，请核对备份');};});
  await page.keyboard.press('ArrowLeft');await page.getByText('工作日志读取失败：迁移目标已变化，请核对备份').waitFor();
  await page.screenshot({path:path.join(out,`${theme}-${width}-error.png`)});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('daily-report browser captures passed:',out);
}finally{await browser.close();}
