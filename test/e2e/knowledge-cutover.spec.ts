import {test,expect} from './fixtures/electron';

test('正式启动只暴露新知识治理，旧资料不再导入',async({appCtx})=>{
 const {win}=appCtx;
 const result=await win.evaluate(async()=>{
   const cfg=await window.api.config.get();const id=cfg.activeWorkspaceId!;
   const before=await window.api.knowledge.list(id);
   const created=await window.api.knowledge.create(id,{namespace:'worker',draft:{kind:'stable_constraint',summary:'本地验收夹具固定使用隔离测试服务',applicability:[]}});
   const after=await window.api.knowledge.list(id);
   return {before:before.records.length,after:after.records.length,disposition:created.disposition};
 });
 expect(result.before).toBe(0);expect(result.after).toBe(1);expect(result.disposition).toBe('active');
 // Navigate through the actual product sidebar, not a standalone React fixture.
 const button=win.getByRole('listitem').filter({hasText:'记忆整理'});await button.click();
 await expect(win.getByTestId('memory-overview')).toBeVisible();
 await expect(win.getByRole('tab',{name:'总览',exact:true})).toHaveAttribute('aria-selected','true');
 const canvas=await win.locator('.memory-overview-card').boundingBox();expect(canvas!.height).toBeGreaterThan(200);
 await win.getByRole('tab',{name:'条目总览',exact:true}).click();
 await expect(win.getByRole('heading',{name:'本地验收夹具固定使用隔离测试服务'})).toBeVisible();
 await win.getByRole('tab',{name:'主动提醒',exact:true}).click();
 await win.getByRole('tab',{name:'条目总览',exact:true}).click();
 await expect(win.getByRole('heading',{name:'本地验收夹具固定使用隔离测试服务'})).toBeVisible();
 await win.getByRole('tab',{name:'总览',exact:true}).click();
 await expect(win.getByTestId('memory-overview')).toBeVisible();
 await expect.poll(()=>win.locator('.memory-tabbody > .xfade:not(.is-shown)').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).opacity==='0'))).toBe(true);
 await win.screenshot({path:'.tmp/memory-overview-restored-electron.png',fullPage:true});
});
