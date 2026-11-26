import { fileURLToPath } from 'node:url';

export default async function({ page, capture, assert }) {
  for (const name of ['claude.svg', 'openai.svg', 'cursor.svg']) {
    await page.route(`**/assets/harness-brands/${name}`, route => route.fulfill({ path: fileURLToPath(new URL(`../../src/renderer/src/assets/harness-brands/${name}`, import.meta.url)) }));
  }
  const nav = page.getByRole('navigation', { name: '设置分组' });
  const current = () => page.locator('.settings-tabpane.is-shown');
  async function navigate(name) {
    await nav.getByRole('button', { name, exact: true }).click();
    await current().getByRole('heading', { level: 1, name, exact: true }).waitFor();
  }
  async function verify(label) {
    await current().evaluate(async el => {
      for (let node = el; node; node = node.parentElement) await Promise.allSettled(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
      await new Promise(requestAnimationFrame);
    });
    const pageTitle = await current().locator('.settings-pane-title').evaluate(el => {
      const css = getComputedStyle(el), rule = getComputedStyle(el, '::after');
      return { border: css.borderBottomWidth, position: css.position, ruleContent: rule.content };
    });
    assert.equal(pageTitle.border, '0px', `${label}: page title has no border`);
    assert.equal(pageTitle.position, 'static', `${label}: page title scrolls with the page`);
    assert.ok(['none', 'normal'].includes(pageTitle.ruleContent), `${label}: page title has no underline pseudo-element`);
    assert.doesNotMatch(await current().innerText(), /立即生效|即时生效|保存后.{0,20}生效|需保存|改颜色即实时预览/, `${label}: no redundant save-timing annotations`);
    const data = await current().locator('.s-sec-h h2:visible, .settings-detail-section-head h3:visible, .kb-workbench-section > h2:visible, .settings-resource-detail .usage-heading > strong:visible').evaluateAll(headings => headings.map(el => ({
      text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize),
      expected: parseFloat(getComputedStyle(el).getPropertyValue('--font-title')),
      item: parseFloat(getComputedStyle(el).getPropertyValue('--font-control')),
      resource: !!el.closest('.settings-resource-detail'),
      underline: getComputedStyle(el.closest('.s-sec-h, .settings-detail-section-head, .usage-heading') ?? el).borderBottomWidth,
      contentGap: getComputedStyle(el.closest('.s-sec-h, .settings-detail-section-head, .usage-heading') ?? el).marginBottom
    })));
    assert.ok(data.length, `${label}: section headings present`);
    for (const heading of data) {
      assert.equal(heading.size, heading.expected, `${label}/${heading.text}: section uses title scale`);
      assert.ok(heading.size - heading.item >= 3, `${label}/${heading.text}: clear section/item hierarchy`);
      assert.equal(heading.underline, '0px', `${label}/${heading.text}: section heading has no underline`);
      assert.equal(heading.contentGap, heading.resource ? '8px' : '12px', `${label}/${heading.text}: heading-to-content gap`);
    }
    const rows = await current().locator('.s-row:not(.is-divided):visible, .s-frow:visible').evaluateAll(items => items.map(el => {
      const style = getComputedStyle(el);
      return { name: el.querySelector('h3')?.textContent, top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) };
    }));
    for (const row of rows) assert.ok(row.top <= 8 && row.bottom <= 8, `${label}: compact row padding ${JSON.stringify(row)}`);
    const groups = await current().locator('.s-sec + .s-sec:visible, .settings-detail-section + .settings-detail-section:visible, .kb-workbench-section:visible').evaluateAll(sections => sections.map(el => ({
      name: el.querySelector('h2, h3')?.textContent,
      resource: !!el.closest('.settings-resource-detail'),
      border: getComputedStyle(el).borderTopWidth,
      gap: el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom
    })));
    for (const group of groups) {
      assert.equal(group.border, '0px', `${label}/${group.name}: no divider before the section`);
      assert.ok(group.gap >= (group.resource ? 31 : 47), `${label}/${group.name}: section spacing (got ${group.gap})`);
    }
    assert.ok(await current().evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${label}: no overflow`);
    await capture(label);
  }
  await nav.waitFor();
  await navigate('通用');
  await current().getByRole('heading', { name: '滚动与动效', exact: true }).scrollIntoViewIfNeeded();
  const itemSize = await current().getByRole('heading', { name: '滚动手感', exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.equal(itemSize, 14, 'Setting item titles remain on the control scale');
  await verify('general-section-hierarchy');
  await navigate('外观');
  await current().getByRole('heading', { name: '你的头像', exact: true }).scrollIntoViewIfNeeded();
  await verify('appearance-no-timing-annotations');
  await navigate('模型与输入');
  await current().getByLabel('供应商名称').waitFor();
  await verify('provider-section-hierarchy');
  await current().getByRole('heading', { name: '文件与输入', exact: true, level: 2 }).scrollIntoViewIfNeeded();
  await current().getByRole('heading', { name: '文件限制', exact: true }).waitFor();
  await verify('input-section-hierarchy');
  await navigate('Harness 接入');
  await current().getByRole('button', { name: '配置 Muster Core', exact: true }).click();
  await current().getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  await verify('agent-section-hierarchy');
  await navigate('能力管理');
  await current().getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
  await current().getByRole('button', { name: /^查看 automations(?: |$)/ }).click();
  await current().getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  await verify('capability-section-hierarchy');
  await navigate('快捷键');
  await verify('shortcuts-section-hierarchy');
  await navigate('远程访问');
  await verify('remote-section-hierarchy');
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'All IPC mocked');
}
