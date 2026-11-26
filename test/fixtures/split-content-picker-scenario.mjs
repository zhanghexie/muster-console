export default async function ({ page, capture, assert }) {
  await page.waitForFunction(() => !document.querySelector('.center-snap-create button[aria-haspopup]').disabled);
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await page.getByRole('button', { name: 'PowerShell', exact: true }).waitFor();
  await capture('terminal-menu');
  await page.keyboard.press('Escape');
  const checkAlignment = async () => {
    const geometry = await page.evaluate(() => {
      const search = document.querySelector('.center-snap-search').getBoundingClientRect();
      const card = document.querySelector('.center-snap-assist-choice').getBoundingClientRect();
      const create = document.querySelector('.center-snap-create > button');
      const terminal = document.querySelector('.center-snap-create > button:last-child');
      return { left: card.left - search.left, right: card.right - search.right,
        color: getComputedStyle(create).color, terminalColor: getComputedStyle(terminal).color };
    });
    assert.ok(Math.abs(geometry.left) < 1 && Math.abs(geometry.right) < 1, JSON.stringify(geometry));
    assert.equal(geometry.terminalColor, geometry.color);
  };
  await checkAlignment();
  await capture('list');
  await page.getByRole('searchbox').fill('prepare');
  assert.equal(await page.locator('.center-snap-assist .center-snap-assist-choice').count(), 1);
  await checkAlignment();
  await capture('search');
  await page.getByTestId('pick-7').click();
  assert.equal((await page.evaluate(() => window.__selected)).sessionId, '7');
  await page.getByRole('searchbox').fill('没有这条内容');
  await page.getByText('没有匹配的内容').waitFor();
  await capture('empty');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('dialog', { name: '新建任务', exact: true }).waitFor();
  await capture('new-session');
}
