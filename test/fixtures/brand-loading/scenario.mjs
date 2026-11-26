export default async function ({ page, capture, assert }) {
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'发送中',exact:true}).waitFor();
 const neutral = await page.getByRole('button',{name:'发送中',exact:true}).evaluate(el=>{
   const c=getComputedStyle(el); const probe=document.createElement('span');
   probe.style.backgroundColor=c.getPropertyValue('--interaction-hover'); document.body.appendChild(probe);
   const expected=getComputedStyle(probe).backgroundColor; probe.remove(); return c.backgroundColor===expected;
 });
 assert.equal(neutral,true,'发送加载第一帧必须是中性背景');
 await capture('running', { animations: 'allow' });
 assert.equal(await page.locator('.brand-loader-orbit').count(),2);
 await page.getByRole('button',{name:'模拟发送已确认',exact:true}).click();
 assert.equal(await page.locator('.brand-loader-orbit').count(),1);
 await page.getByRole('button',{name:'停止',exact:true}).click();
 await page.getByRole('button',{name:'发送',exact:true}).waitFor();
 await page.getByRole('button',{name:'刷新模型目录',exact:true}).click();
 await capture('operation', {animations:'allow'});
 await page.getByRole('button',{name:'模拟请求完成',exact:true}).click();
 await page.getByRole('button',{name:'切换 Diff 读取',exact:true}).click();
 await capture('diff', {animations:'allow'});
 await page.getByRole('button',{name:'切换 Diff 读取',exact:true}).click();
 await page.evaluate(()=>document.documentElement.dataset.uiMotion='reduced');
 assert.equal(await page.locator('.brand-loader-orbit').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 await capture('reduced');
}
