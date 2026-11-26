export default async function ({ page, capture, assert }) {
  const pane = page.locator('.settings-tabpane.is-shown');
  const trigger = pane.getByRole('button', { name: '语言与文字', exact: true });
  await trigger.waitFor();
  assert.equal(await trigger.evaluate(el => getComputedStyle(el, '::after').content), 'none', 'heading has no disclosure arrow');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快速跳转' });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '任务与工作区', exact: true }).count(), 1);
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).count(), 0);
  const positions = await dialog.locator('.settings-jump-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  assert.ok(positions.every((top, index) => index === 0 || top > positions[index - 1]), 'sections are in one vertical list');
  await capture('section-index');
  await dialog.getByRole('heading', { name: '快速跳转' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await trigger.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '会话与记录', exact: true }).click();
  const target = pane.getByRole('button', { name: '会话与记录', exact: true });
  await target.focus();
  const position = await target.evaluate(el => {
    const pane = el.closest('.settings-tabpane');
    const header = pane.querySelector('.settings-pane-title');
    return { heading: el.getBoundingClientRect().top, header: header.getBoundingClientRect().bottom, scrollTop: pane.scrollTop };
  });
  assert.ok(position.scrollTop > 0, 'jump scrolls the actual settings pane');
  assert.ok(position.heading >= position.header, 'destination is not covered by the sticky header');
  await capture('section-destination');
}
