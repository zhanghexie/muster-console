export default async function ({ page, capture, assert }) {
  const short = page.getByRole('button', { name: '好的', exact: true });
  const longText = '请先检查现有测试结果，再整理需要我确认的具体问题和建议的下一步。';
  const long = page.getByRole('button', { name: longText, exact: true });
  await long.waitFor();
  assert.equal(await long.locator('.composer-reply-label').textContent(), '请先检查现有测试结果…');
  assert.equal(await short.locator('.composer-reply-label').textContent(), '好的');
  assert.ok((await long.boundingBox()).width > (await short.boundingBox()).width * 2);
  const geometry = await long.evaluate(element => {
    const capsule = element.getBoundingClientRect();
    const group = element.closest('.composer-reply-suggestions').getBoundingClientRect();
    const label = element.querySelector('.composer-reply-label');
    return { capsuleRight: capsule.right, groupRight: group.right, ellipsis: getComputedStyle(label).textOverflow,
      labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth };
  });
  assert.ok(geometry.capsuleRight <= geometry.groupRight + 1, 'long capsule must fit inside the group');
  assert.equal(geometry.ellipsis, 'ellipsis');
  assert.ok(geometry.labelScrollWidth <= geometry.labelWidth + 1, 'ten characters and the ellipsis should fit');
  assert.ok((await long.getAttribute('title')).includes(longText));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture('suggestions');
  await long.click();
  const editor = page.getByRole('textbox');
  assert.equal(await editor.textContent(), '');
  await editor.press('Tab');
  assert.equal(await editor.textContent(), longText);
  assert.equal(await page.evaluate(() => window.__uiFixture.sent.length), 0);
  await capture('draft');
}
