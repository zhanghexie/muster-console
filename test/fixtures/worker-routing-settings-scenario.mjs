import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function ({ page, capture, assert, width }) {
  const assets = fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url));
  await page.route('**/assets/harness-brands/*', route =>
    route.fulfill({ path: path.join(assets, path.basename(new URL(route.request().url()).pathname)) }));
  await page.getByRole('button', { name: '自动派活设置' }).click();
  const pane = page.locator('.settings-tabpane[data-settings-item="worker"]');
  const resources = pane.getByRole('navigation', { name: 'Worker 列表' });
  const engineHeading = pane.getByRole('heading', { name: '引擎配置', level: 2 });
  const heading = pane.getByRole('heading', { name: '自动派活', exact: true });
  const scopes = pane.getByRole('group', { name: '自动派活应用范围' });
  await resources.getByRole('button', { name: '配置 Muster Core' }).waitFor();
  await engineHeading.waitFor();
  await pane.getByRole('button', { name: '清除冷却' }).waitFor();
  assert.equal(await pane.getByText('连接你熟悉的引擎，选择适合的工作方式。').count(), 0);
  assert.equal(await heading.evaluate(node => node.closest('section').previousElementSibling?.dataset.settingsItem), 'worker-engines');
  const sections = await pane.locator('.worker-layout').evaluate(node => {
    const [engines, routing] = node.children;
    return { actual: routing.offsetTop - engines.offsetTop - engines.offsetHeight, gap: parseFloat(getComputedStyle(node).rowGap) };
  });
  assert.ok(Math.abs(sections.actual - sections.gap) <= 1, JSON.stringify(sections));
  const refreshButton = pane.getByRole('button', { name: '刷新' });
  await refreshButton.click();
  const refresh = pane.getByRole('dialog', { name: '模型目录刷新' });
  await refresh.getByText('没有可刷新的外部模型目录').waitFor();
  const [refreshBounds, triggerBounds, headerBounds] = await Promise.all([
    refresh.boundingBox(), refreshButton.boundingBox(), pane.locator('[data-settings-item="worker-engines"] > .s-sec-h').boundingBox()
  ]);
  assert.ok(refreshBounds.width > triggerBounds.width + 40);
  assert.ok(refreshBounds.x >= headerBounds.x - 1 && refreshBounds.x + refreshBounds.width <= headerBounds.x + headerBounds.width + 1);
  await capture('engine-heading-refresh');
  await page.keyboard.press('Escape');
  await refresh.waitFor({ state: 'hidden' });
  const grid = pane.locator('.worker-routing-standard');
  const groups = grid.locator(':scope > fieldset');
  assert.deepEqual(await groups.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['低', '中', '高', '极高']);
  assert.deepEqual(await groups.evaluateAll(nodes => nodes.map(node => node.querySelectorAll('.worker-routing-strength [data-filled]').length)), [1, 2, 3, 4]);
  const columns = await grid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  const expectedColumns = new Map([[1440, 4], [1180, 2], [390, 1]]).get(width);
  assert.ok([1, 2, 4].includes(columns));
  if (expectedColumns !== undefined) assert.equal(columns, expectedColumns);
  assert.equal(await resources.getByRole('button', { name: '自动派活', exact: true }).count(), 0);
  const frame = pane.locator('.worker-pane');
  const height = await frame.evaluate(node => ({ actual: node.clientHeight, target: Math.min(720, Math.max(360, innerHeight * 0.75)), previous: Math.min(560, Math.max(320, innerHeight * 0.6)) }));
  assert.ok(Math.abs(height.actual - height.target) <= 1, JSON.stringify(height));
  assert.ok(height.actual > height.previous);
  const frameBounds = await frame.boundingBox();
  assert.ok((await heading.boundingBox()).y > frameBounds.y + frameBounds.height);
  const paneBounds = await pane.boundingBox();
  await resources.getByRole('button', { name: '全部支持' }).click();
  const list = resources.locator('.worker-list-scroll');
  const outerStart = await pane.evaluate(node => node.scrollTop);
  if (await list.evaluate(node => node.scrollHeight > node.clientHeight)) {
    const listBounds = await list.boundingBox();
    await page.mouse.move(listBounds.x + listBounds.width / 2, listBounds.y + Math.min(60, listBounds.height / 2));
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('.worker-list-scroll').scrollTop > 0);
    assert.equal(await pane.evaluate(node => node.scrollTop), outerStart);
  }
  await page.mouse.move(paneBounds.x + paneBounds.width - 6, paneBounds.y + 24);
  await page.mouse.wheel(0, Math.max(140, frameBounds.height - 165));
  await page.waitForFunction(() => {
    const pane = document.querySelector('.settings-tabpane[data-settings-item="worker"]');
    const heading = pane.querySelector('[data-settings-item="worker-routing"]');
    return pane.scrollTop > 0 && heading.getBoundingClientRect().top < pane.getBoundingClientRect().bottom;
  });
  assert.ok((await frame.boundingBox()).y + frameBounds.height > (await pane.boundingBox()).y);
  await capture('engines-and-routing');
  await heading.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  assert.equal(await scopes.getByRole('button', { name: '全局默认' }).getAttribute('aria-pressed'), 'true');
  assert.ok(await scopes.getByRole('button').evaluateAll(buttons => buttons.every(button => {
    const text = document.createRange();
    text.selectNodeContents(button);
    const label = text.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    return text.getClientRects().length === 1 && label.top >= bounds.top && label.bottom <= bounds.bottom && label.left >= bounds.left && label.right <= bounds.right;
  })));
  assert.equal(await pane.getByText('跨 Harness 权限', { exact: true }).count(), 0);
  await capture('routing-global');
  await scopes.getByRole('button', { name: '仅当前工作区' }).press('Enter');
  await pane.getByText('当前工作区跟随全局默认').waitFor();
  await capture('routing-inherited');
  const light = grid.getByRole('group', { name: '低' });
  const first = light.getByRole('checkbox', { name: /启用 Muster Core · GUI · fixture-openai · swift-model/ });
  assert.equal(await first.isChecked(), true);
  await first.uncheck();
  await pane.getByText('待保存为工作区配置').waitFor();
  const save = page.locator('.settings-savebar button.btn.primary');
  await save.click();
  await pane.getByText('当前工作区有独立派活配置').waitFor();
  await heading.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await capture('routing-override');
  await pane.getByRole('button', { name: '恢复跟随全局' }).click();
  await pane.locator('.worker-routing-follow-preview').getByText(/swift-model/).waitFor();
  await heading.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await capture('routing-follow-preview');
  await save.click();
  await pane.getByText('当前工作区跟随全局默认').waitFor();
  assert.equal(await first.isChecked(), true);
  const writes = await page.evaluate(() => window.__uiFixture.calls.filter(call => ['workerRouting.save', 'workerRouting.followGlobal'].includes(call.path)));
  assert.deepEqual(writes.map(({ path, args }) => [path, args[0].expectedVersion]), [
    ['workerRouting.save', 'inherited:0:8'], ['workerRouting.followGlobal', 'workspace:1']
  ]);
  if (width <= 390) {
    const extra = grid.getByRole('group', { name: '极高' });
    await extra.getByText('暂无候选').waitFor();
    await extra.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await capture('extra-high');
  }
  const search = page.getByRole('combobox', { name: '搜索设置' });
  await search.fill('自动派活');
  await page.getByRole('option', { name: /自动派活/ }).waitFor();
  await search.press('Enter');
  await page.waitForFunction(() => {
    const anchor = document.querySelector('[data-settings-item="worker-routing"]');
    return anchor?.classList.contains('is-settings-flash') && anchor.getBoundingClientRect().top > 0 && anchor.getBoundingClientRect().bottom < innerHeight;
  });
  assert.equal(await pane.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  assert.equal(await scopes.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  const add = page.getByRole('button', { name: '添加特殊功能' });
  await add.press('Enter');
  await page.getByRole('textbox', { name: '功能名称' }).waitFor();
  await add.press('Enter');
  await page.getByRole('textbox', { name: '功能名称' }).waitFor({ state: 'hidden' });
}
