export default async function({ page, capture, assert, width }) {
  const nav = page.getByRole('navigation', { name: '设置分组' });
  const current = () => page.locator('.settings-tabpane.is-shown');
  async function navigate(label) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await current().getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
  }
  async function shot(name) {
    assert.ok(await current().evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${name}: no overflow`);
    await capture(name);
  }
  async function detailStyle() {
    await current().locator('.settings-detail-header').evaluate(async el => {
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        await Promise.allSettled(ancestor.getAnimations().map(animation => animation.finished));
      }
    });
    return current().locator('.settings-detail-header h2').evaluate(el => {
      const css = getComputedStyle(el);
      return { size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight };
    });
  }
  await nav.waitFor();
  await navigate('通用');
  await current().getByRole('heading', { name: '滚动与动效' }).scrollIntoViewIfNeeded();
  const header = current().locator('.s-sec-heading').filter({ has: page.getByRole('heading', { name: '滚动与动效' }) });
  const geometry = await header.evaluate(el => {
    const title = el.querySelector('h2').getBoundingClientRect();
    const row = el.closest('section').querySelector('.s-row').getBoundingClientRect();
    return { helpCount: el.querySelectorAll('p').length, rowGap: row.top - title.bottom };
  });
  assert.equal(geometry.helpCount, 0, 'No save-timing annotation below the section title');
  assert.ok(geometry.rowGap >= 16, 'Section heading retains spacing without a timing annotation');
  await shot('general-heading-help');
  const pathTitle = current().getByRole('heading', { name: 'worktree 存储目录', level: 3 });
  await pathTitle.scrollIntoViewIfNeeded();
  const titleStyle = await pathTitle.evaluate(el => { const css = getComputedStyle(el); return { color: css.color, size: css.fontSize, weight: css.fontWeight }; });
  const peerStyle = await current().getByRole('heading', { name: '任务运行时阻止休眠', level: 3 }).evaluate(el => { const css = getComputedStyle(el); return { color: css.color, size: css.fontSize, weight: css.fontWeight }; });
  assert.deepEqual(titleStyle, peerStyle, 'Path label is a third-level title, equal to peer setting titles');
  await shot('general-field-title');
  await navigate('模型与输入');
  await current().getByLabel('供应商名称').waitFor();
  await current().locator('.llm-provider').evaluate(async el => {
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  const providerStyle = await detailStyle();
  const providerX = await current().locator('.settings-detail-header').evaluate(el => el.getBoundingClientRect().left);
  await shot('provider-details');
  await current().getByTitle('删除此供应商').click();
  const providerConfirm = page.getByRole('dialog', { name: '删除此供应商' });
  await providerConfirm.waitFor();
  assert.equal(await providerConfirm.evaluate(el => !!el.closest('.settings-tabpane')), false, 'Confirmation is outside page layout');
  await shot('provider-delete-dialog');
  await providerConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await current().getByRole('heading', { name: '文件与输入', exact: true, level: 2 }).scrollIntoViewIfNeeded();
  await current().getByRole('heading', { name: '文件限制' }).waitFor();
  await shot('input-section-help');
  await navigate('Harness 接入');
  await current().getByRole('button', { name: '配置 Muster Core', exact: true }).click();
  await current().getByRole('heading', { name: 'Muster Core', exact: true }).waitFor();
  assert.deepEqual(await detailStyle(), providerStyle, 'Agent and provider titles share typography');
  if (width > 820) assert.equal(await current().locator('.settings-detail-header').evaluate(el => el.getBoundingClientRect().left), providerX, 'Shared detail alignment');
  await shot('agent-details');
  await navigate('能力管理');
  await current().getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
  await current().getByRole('button', { name: '查看 code-review' }).click();
  assert.deepEqual(await detailStyle(), providerStyle, 'Skill and provider titles share typography');
  if (width > 820) assert.equal(await current().locator('.settings-detail-header').evaluate(el => el.getBoundingClientRect().left), providerX, 'Shared skill detail alignment');
  await shot('skill-details');
  await navigate('外观');
  await current().locator('[data-theme-id=custom]').hover();
  await current().getByRole('button', { name: '删除主题「自定义主题」', exact: true }).click();
  const themeConfirm = page.getByRole('dialog', { name: '确认删除主题「自定义主题」？' });
  await themeConfirm.waitFor();
  await shot('theme-delete-dialog');
  await themeConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await navigate('快捷键');
  const chord = current().getByRole('button', { name: '系统组合键', exact: true });
  await chord.click();
  assert.equal(await chord.getAttribute('aria-pressed'), 'true');
  await shot('shortcut-recording');
  await page.keyboard.press('Control+Alt+Y');
  assert.equal(await chord.textContent(), 'Ctrl+Alt+Y');
  await chord.click();
  await page.keyboard.press('Escape');
  assert.equal(await chord.textContent(), 'Ctrl+Alt+Y', 'Escape preserves draft and keeps settings open');
  await shot('shortcut-recorded');
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'All IPC mocked');
}
