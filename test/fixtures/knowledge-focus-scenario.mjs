export default async function({page,capture,assert}){
 const pane=page.locator('.memory-tabbody > .is-shown');
 async function check(control,label){
  await control.click();
  await control.fill('焦点检查');
  await page.evaluate(()=>document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).forEach(animation=>animation.finish()));
  await control.evaluate(el=>el.scrollIntoView({block:'center'}));
  await capture(label);
  const style=await control.evaluate(el=>{
   const s=getComputedStyle(el),r=el.getBoundingClientRect();
   const clips=[];
   for(let p=el.parentElement;p;p=p.parentElement){
    const ps=getComputedStyle(p),b=p.getBoundingClientRect();
    if(['hidden','auto','scroll','clip'].includes(ps.overflowX))clips.push(r.left>=b.left&&r.right<=b.right);
   }
   return {outline:s.outlineStyle,borders:[s.borderLeftColor,s.borderRightColor,s.borderTopColor,s.borderBottomColor],focus:s.getPropertyValue('--border-focus').trim(),clips};
  });
  assert.equal(style.outline,'none','inputs must use the shared border focus, not an outer ring clipped by accordion');
  assert.ok(style.clips.every(Boolean),'all four borders must stay within clipping containers');
  assert.equal(new Set(style.borders).size,1,'focus border stays continuous on all four sides');
 }
 await page.getByRole('tab',{name:'条目总览',exact:true}).click();
 await check(pane.getByRole('textbox',{name:'搜索记忆'}),'search-focus');
 await pane.getByRole('textbox',{name:'搜索记忆'}).fill('');
 await pane.getByRole('article',{name:'需要重新核对的部署约束'}).getByRole('button',{name:'修订内容与条件'}).click();
 await check(pane.getByRole('textbox',{name:/^记忆结论/}),'revision-focus');
 await check(pane.getByRole('textbox',{name:/^适用仓库/}),'repository-focus');
 await pane.getByRole('button',{name:'取消编辑'}).click();
 await check(pane.getByRole('textbox',{name:'治理理由'}),'governance-focus');
 await pane.getByRole('combobox', { name: '内容类型'}).click();
 await page.getByRole('option',{name:'任务历史',exact:true}).click();
 await pane.getByRole('button',{name:'查询原始会话（含切换前历史）'}).click();
 await check(pane.getByRole('textbox',{name:'历史关键词'}),'history-focus');
}
