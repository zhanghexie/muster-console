export default async function({page,capture,assert}){
 await page.getByRole('tab',{name:'总览',exact:true}).waitFor();
 const stable=()=>page.waitForFunction(()=>Array.from(document.querySelectorAll('.memory-tabbody > .xfade:not(.is-shown)')).every(el=>getComputedStyle(el).opacity==='0'));
 for(const name of ['条目总览','用户画像','晋升审阅','审批队列','回收站']){
  await page.getByRole('tab',{name:new RegExp('^'+name)}).click();
  await stable();
  const pane=page.locator('.memory-tabbody > .is-shown');
  assert.equal(await pane.getByText(/处理未完成|处理队列/).count(),0);
  if(name==='回收站'){assert.equal(await pane.getByText(/新增知识|需要重新核对/).count(),0);await capture('recycle');}
  if(name==='用户画像'){assert.equal(await pane.getByRole('combobox', { name: '记忆范围'}).count(),0);await capture('profile');}
  assert.equal(await page.getByRole('heading',{name:'记忆中心',exact:true}).count(),1);
  assert.equal(await page.locator('.knowledge-header,.knowledge-tabs').count(),0);
  assert.equal(await page.locator('.prompt-task-toolbar').count(),1);
  assert.equal(await page.locator('.memory-tabs').count(),1);
 }
 await page.getByRole('tab',{name:'条目总览',exact:true}).click();await stable();
 const contentBox=await page.getByRole('combobox', { name: '内容类型'}).boundingBox();
 const searchBox=await page.getByRole('textbox',{name:'搜索记忆'}).boundingBox();
 assert.ok(Math.abs(contentBox.y-searchBox.y)<10,'content filter and search remain on one toolbar row');
 await capture('entries');
 await page.getByRole('combobox', { name: '内容类型'}).click();
 await capture('content-menu');
 await page.getByRole('option',{name:'任务历史',exact:true}).click();
 await page.getByRole('button',{name:'查询原始会话（含切换前历史）'}).waitFor();
 await capture('history');
 await page.getByRole('tab',{name:'总览',exact:true}).click();await stable();
 await capture('overview');
 await page.getByRole('tab',{name:'索引状态',exact:true}).click();await stable();
 assert.equal(await page.locator('.is-shown').getByRole('button',{name:'处理队列／重试失败事件'}).count(),1);
 await capture('processing');
}
