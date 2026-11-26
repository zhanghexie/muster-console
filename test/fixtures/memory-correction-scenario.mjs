/** Real production UI and CSS; deterministic IPC fixture, not storage acceptance. */
export default async function({page,capture,assert}){
 await page.getByRole('button',{name:'修订内容与条件'}).click();
 await page.getByLabel('记忆结论',{exact:true}).fill('报告先写结论，再说明验证范围和未完成事项');
 await capture('editing');
 await page.getByRole('button',{name:'保存并生效'}).click();
 await page.getByRole('status').filter({hasText:'已保存 r2'}).waitFor();
 await page.getByRole('button',{name:'恢复版本 r1'}).waitFor();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
 assert.equal(overflow,false);
 await capture('saved-history');
 await page.getByRole('button',{name:'停止使用'}).click();
 await page.getByRole('status').filter({hasText:'已暂停'}).waitFor();
 await page.getByRole('button',{name:'撤销本次修改'}).click();
 await page.getByRole('status').filter({hasText:'已保存 r4 · 已生效'}).waitFor();
 await page.getByRole('button',{name:'恢复版本 r1'}).click();
 await page.getByRole('heading',{name:'报告先写结论',exact:true}).waitFor();
}
