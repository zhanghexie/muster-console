export default async function({page,capture,assert}){
  await page.getByText('更正请求已入队，尚未应用；以审查结果和结果版本为准。').waitFor();
  await capture('correction-queued');
  await page.getByRole('button',{name:'updated',exact:true}).click();
  await page.getByText('结果版本：memory-subscription · r5').waitFor();
  await capture('correction-applied');
  await page.getByRole('button',{name:'failed',exact:true}).click();
  await page.getByText('本次更正处理失败，尚未确认应用；请查看失败原因。').waitFor();
  await capture('correction-failed');
  await page.getByRole('button',{name:'needs_user',exact:true}).click();
  await page.getByText('审查完成，待你处理').waitFor();
  assert.equal(await page.getByText('已更正并生效',{exact:true}).count(),0);
  await capture('correction-needs-user');
  await page.getByRole('button',{name:'打开原记忆'}).scrollIntoViewIfNeeded();
  await capture('correction-proposal');
  await page.getByRole('button',{name:'打开原记忆'}).click();
  assert.equal(await page.getByLabel('记忆跳转').textContent(),'entries:memory-subscription');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
}
