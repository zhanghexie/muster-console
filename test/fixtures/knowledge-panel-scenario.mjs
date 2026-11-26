export default async function({page,capture,assert}){
  await page.getByRole('heading',{name:'延迟审批必须在提交时再次核对版本'}).waitFor();
  await capture('knowledge');
  await page.getByRole('button',{name:'查看依据与修订'}).click();
  await page.getByText('轮次 turn-42').waitFor();
  await capture('evidence');
  await page.getByLabel('治理理由').fill('只有当前任务适用，不值得长期保留');
  await page.getByRole('button',{name:'仅留历史',exact:true}).scrollIntoViewIfNeeded();
  await capture('governance');
  await page.getByRole('button',{name:'修订内容与条件'}).click();
  await page.getByLabel('适用条件（每行一条）').fill('需要人工审批的持久写入');
  await capture('editing');
  await page.getByRole('button',{name:'保存修订'}).click();
  await page.getByRole('button',{name:'待确认 1'}).click();
  assert.equal(await page.getByRole('button',{name:'确认生效'}).count(),1);
  await capture('pending');
}
