export default async function ({page, capture, assert}) {
  const row=page.getByRole('treeitem',{name:'工作日报'});
  const input=page.getByPlaceholder('输入内容');
  await input.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await row.evaluate(el=>el===document.activeElement),true);
  const style=await row.evaluate(el=>({outline:getComputedStyle(el).outlineStyle, shadow:getComputedStyle(el).boxShadow}));
  assert.equal(style.outline,'none','keyboard focus should not draw an outline');
  assert.notEqual(style.shadow,'none','keyboard focus needs a visible soft fill');
  await capture('tree-focused');
  await page.keyboard.press('Tab');
  const button=page.getByRole('button',{name:'普通按钮'});
  assert.equal(await button.evaluate(el=>el===document.activeElement),true);
  assert.equal(await button.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  assert.equal(await button.evaluate(el=>getComputedStyle(el).borderTopColor),'rgba(0, 0, 0, 0)', 'focus does not add a button border');
  await capture('button-focused');
  await page.emulateMedia({forcedColors:'active'});
  assert.notEqual(await button.evaluate(el=>getComputedStyle(el).outlineStyle),'none','forced colors must retain focus outline');
}
