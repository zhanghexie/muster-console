import {checkInputs,checkMenus} from './memory-control-checks.mjs';
export default async function({page,capture,assert}){
 const pane=page.locator('.memory-tabbody > .is-shown');
 for(const [i,name] of ['总览','条目总览','用户画像','晋升审阅','审批队列','主动提醒','索引状态','回收站'].entries()){
  await page.getByRole('tab',{name:new RegExp('^'+name)}).click();
  await checkInputs(page,pane,assert);
  await checkMenus(page,pane,assert,capture,`page-${i}`);
  await capture(`page-${i}`);
 }
 await page.getByRole('tab',{name:'条目总览',exact:true}).click();
 await pane.getByRole('button',{name:'新增知识或偏好'}).click();
 await checkMenus(page,pane,assert,capture,'create');
 await pane.getByRole('combobox', { name: '知识类型',exact:true}).click();
 await page.getByRole('option',{name:'可复用经验',exact:true}).click();
 await checkInputs(page,pane,assert);
 await capture('create-lesson');
 await pane.getByRole('button',{name:'取消新增',exact:true}).click();
 await pane.getByRole('article',{name:'需要重新核对的部署约束'}).getByRole('button',{name:'修订内容与条件'}).click();
 await checkInputs(page,pane,assert);
 await checkMenus(page,pane,assert,capture,'revision');
 await capture('revision');
 await pane.getByRole('combobox', { name: '内容类型'}).click();
 await page.getByRole('option',{name:'任务历史',exact:true}).click();
 await pane.getByRole('button',{name:'查询原始会话（含切换前历史）'}).click();
 await checkInputs(page,pane,assert);
 await checkMenus(page,pane,assert,capture,'history');
 const query=pane.getByRole('textbox',{name:'历史关键词'});
 await query.fill('关键词');await query.press('Tab');await page.keyboard.press('Shift+Tab');
 await capture('history-keyboard-focus');
 await query.fill('');await capture('history-empty-focus');
}
