import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

export default async function({ page, capture, assert, width }) {
  // esbuild does not perform Vite's new URL(asset, import.meta.url) transform.
  // Serve the exact production marks from the repo for this isolated capture.
  for (const name of readdirSync(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url)).filter(name => /\.(svg|png)$/.test(name))) {
    await page.route(`**/assets/harness-brands/${name}`, route => route.fulfill({ path: fileURLToPath(new URL(`../../src/renderer/src/assets/harness-brands/${name}`, import.meta.url)) }));
  }
  const nav = page.getByRole('navigation', { name: '设置分组' });
  const current = () => page.locator('.settings-tabpane.is-shown');
  async function navigate(label) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await current().getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
  }
  async function settled() {
    await current().locator('.settings-detail-header').evaluate(async el => {
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) await Promise.allSettled(ancestor.getAnimations().map(a => a.finished));
    });
  }
  async function styles(row) {
    await page.mouse.move(5, 5);
    return row.evaluate(el => {
      const style = getComputedStyle(el), title = getComputedStyle(el.querySelector('.settings-resource-name'));
      return { height: style.minHeight, padding: style.padding, radius: style.borderRadius, selected: style.backgroundColor, nameSize: title.fontSize, nameWeight: title.fontWeight };
    });
  }
  async function panel() {
    await settled();
    return current().locator('.settings-resource-detail').evaluate(el => {
      const style = getComputedStyle(el), header = getComputedStyle(el.querySelector('.settings-detail-header'));
      return { left: style.paddingLeft, headerBottom: header.paddingBottom, divider: header.borderBottomWidth, columns: getComputedStyle(el.closest('.settings-resource-layout')).gridTemplateColumns };
    });
  }
  async function shot(label) {
    const frame = await current().locator('.settings-resource-layout').evaluate(el => {
      const css = getComputedStyle(el);
      return { edges: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth], radius: css.borderTopLeftRadius, expectedRadius: css.getPropertyValue('--radius-card').trim(), padding: css.padding, background: css.backgroundColor };
    });
    assert.deepEqual(frame.edges, ['1px', '1px', '1px', '1px'], `${label}: one perimeter border around the resource browser`);
    assert.equal(frame.radius, frame.expectedRadius, `${label}: shared rounded corners`);
    assert.equal(frame.padding, page.viewportSize().height <= 600 ? '12px' : '16px', `${label}: controls sit inside the perimeter`);
    assert.equal(frame.background, 'rgba(0, 0, 0, 0)', `${label}: perimeter does not add a filled card`);
    assert.ok(await current().evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${label}: no page overflow`);
    await capture(label);
  }
  await nav.waitFor();
  await navigate('模型与输入');
  await current().getByLabel('供应商名称').waitFor();
  const selectedProvider = current().locator('.settings-resource-item[aria-pressed=true]');
  const commonRow = await styles(selectedProvider);
  const commonPanel = await panel();
  assert.equal(commonRow.height, '56px');
  if (width > 820) assert.ok(commonPanel.columns.startsWith('224px '), 'Shared list width is 224px');
  const searchSkin = await current().getByRole('searchbox', { name: '搜索供应商' }).evaluate(el => { const style = getComputedStyle(el); return [style.borderWidth, style.marginTop]; });
  assert.deepEqual(searchSkin, ['0px', '0px'], 'Search input never gains a second border');
  assert.equal(commonPanel.headerBottom, '0px');
  assert.equal(commonPanel.divider, '0px');
  await current().getByRole('searchbox', { name: '搜索供应商' }).fill('团队');
  assert.equal(await current().getByRole('navigation', { name: '供应商' }).locator('.settings-resource-item').count(), 1);
  assert.equal(await current().getByLabel('供应商名称').inputValue(), '示例模型服务', 'Search retains current draft');
  await current().getByRole('searchbox', { name: '搜索供应商' }).fill('');
  await current().getByRole('heading', { name: '模型与输入', level: 1 }).click();
  await shot('providers');
  await current().getByRole('heading', { name: '连接配置', exact: true }).scrollIntoViewIfNeeded();
  await shot('provider-connection');
  await navigate('通用');
  await current().getByRole('heading', { name: '命令行环境', exact: true }).waitFor();
  await navigate('Harness 接入');
  const agentNav = current().getByRole('navigation', { name: 'Worker 列表' });
  const tabStyle = await agentNav.locator('.worker-catalog-tabs').evaluate(el => {
    const style = getComputedStyle(el), button = getComputedStyle(el.querySelector('button'));
    return { display: style.display, gap: parseFloat(style.gap), buttonBackground: button.backgroundColor, buttonHeight: button.minHeight };
  });
  assert.equal(tabStyle.display, 'flex', 'Agent scope tabs retain their layout');
  assert.ok(tabStyle.gap >= 16, 'Agent scope tabs never run together');
  assert.equal(tabStyle.buttonBackground, 'rgba(0, 0, 0, 0)', 'Agent scope tabs use an underline instead of a filled button');
  assert.equal(tabStyle.buttonHeight, '32px');
  const footer = await agentNav.locator('.worker-list-footer').evaluate(el => ({ display: getComputedStyle(el).display, direction: getComputedStyle(el).flexDirection }));
  assert.deepEqual(footer, { display: 'flex', direction: 'column' }, 'Agent footer actions are separate full rows');
  assert.equal(await agentNav.getByRole('button', { name: '终端环境', exact: true }).count(), 0);
  for (const name of ['默认与通用']) {
    const style = await agentNav.getByRole('button', { name, exact: true }).evaluate(el => {
      const css = getComputedStyle(el); return { display: css.display, gap: parseFloat(css.gap), height: css.minHeight };
    });
    assert.equal(style.display, 'flex'); assert.ok(style.gap >= 6); assert.equal(style.height, '32px');
  }
  await agentNav.getByRole('button', { name: '全部支持', exact: true }).click();
  assert.equal(await agentNav.getByRole('button', { name: '全部支持', exact: true }).getAttribute('aria-pressed'), 'true');
  await agentNav.getByRole('button', { name: '我的 Agent', exact: true }).click();
  await current().getByRole('button', { name: '配置 Muster Core', exact: true }).click();
  assert.equal(await current().locator('.worker-back').evaluate(el => getComputedStyle(el).display), width > 820 ? 'none' : 'flex', 'Agent return button is only visible in a narrow layout');
  assert.equal(await current().locator('.harness-model-actions').evaluate(el => getComputedStyle(el).display), 'flex', 'Model actions retain their toolbar layout');
  assert.equal(await current().locator('.harness-model-list').evaluate(el => getComputedStyle(el).display), 'grid', 'Models retain their own rows');
  assert.equal(await current().locator('.harness-model-item input').first().evaluate(el => getComputedStyle(el).appearance), 'auto', 'Model membership remains a checkbox');
  assert.deepEqual(await styles(current().locator('.settings-resource-item[aria-pressed=true]')), commonRow, 'Agent uses identical list geometry and selected colors');
  const agentPanel = await panel();
  if (width > 820) assert.deepEqual(agentPanel, commonPanel, 'Agent uses the same detail inset and header');
  await current().getByRole('heading', { name: '基本信息', exact: true }).waitFor();
  await shot('agents');
  await navigate('能力管理');
  await current().getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
  await current().getByRole('button', { name: /^查看 automations(?: |$)/ }).click();
  assert.deepEqual(await styles(current().locator('.settings-resource-item[aria-pressed=true]')), commonRow, 'Skills use identical list geometry and selected colors');
  const skillPanel = await panel();
  if (width > 820) assert.deepEqual(skillPanel, commonPanel, 'Skills use the same detail inset and header');
  assert.equal(await current().getByRole('button', { name: '编辑 SKILL.md' }).isDisabled(), true);
  await current().getByRole('button', { name: /^查看 automations(?: |$)/ }).getByText('宿主维护 · 只读').waitFor({ state: 'attached' });
  await current().getByRole('button', { name: /^查看 apps(?: |$)/ }).getByText('已关联 4 个入口').waitFor({ state: 'attached' });
  await shot('skills');
  if (width <= 820) await current().getByRole('button', { name: '关闭详情', exact: true }).click();
  await current().getByRole('button', { name: 'MCP', exact: true }).click();
  await current().getByRole('button', { name: '查看 docs-reader', exact: true }).click();
  const connection = current().getByRole('region', { name: '连接信息' });
  assert.equal(await connection.locator('.cm-connection').count(), 0, 'No result before a connection test');
  await current().getByRole('button', { name: '查看 docs-reader', exact: true }).getByText('已启用', { exact: true }).waitFor({ state: 'attached' });
  await settled(); await shot('mcp');
  await connection.getByRole('button', { name: '连接测试', exact: true }).click();
  await connection.getByRole('status').getByText('握手成功', { exact: true }).waitFor();
  await current().getByRole('button', { name: '查看 docs-reader', exact: true }).getByText('握手成功').waitFor({ state: 'attached' });
  await shot('mcp-connected');
  if (width <= 820) await current().getByRole('button', { name: '关闭详情', exact: true }).click();
  await current().getByRole('button', { name: '应用能力', exact: true }).click();
  await current().getByRole('button', { name: '查看 browser.run', exact: true }).click();
  await settled(); await shot('catalog');
  await navigate('文本工具');
  await current().getByRole('button', { name: '翻译', exact: true }).click();
  await settled(); await shot('text-tools');
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'No real or missing IPC');
}
