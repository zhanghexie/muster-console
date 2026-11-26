/** Isolated Electron reads the persistent conversation and edits rules without invoking a model. */
import { test, expect, _electron, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('调度安全入口读取持久审核，收起不改变调度草稿', async () => {
  test.setTimeout(80_000);
  const root = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, '.tmp/safety-e2e-'));
  const data = path.join(fixture, '.dev-sandbox/userData'), project = path.join(fixture, 'work');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(project);
  const workspaceId = 'safety-e2e';
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: project, activeWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, name: '安全实验室', path: project }], mcp: { enabled: false, servers: [] } }));
  const auditDir = path.join(data, 'safety', createHash('sha256').update(workspaceId).digest('hex').slice(0, 24));
  fs.mkdirSync(auditDir, { recursive: true });
  const auditFile = path.join(auditDir, 'conversation.json');
  const original = JSON.stringify({ messages: [{ id: 'hello', role: 'assistant', text: '审批上下文已恢复，可以继续讨论合入条件。', createdAt: Date.now() }], rules: [{ id: 'r1', text: '无冲突且检查通过才允许合入', actions: ['git.merge'], enabled: true, revision: 1, createdAt: Date.now(), sourceText: '用户原话' }], ruleRevision: 1, generation: 1, records: [{ requestId: 'hidden-request', workspaceId, action: 'git.deleteBranch', summary: '清理已合并分支', fingerprint: 'hidden-fingerprint', generation: 1, risk: 'high', status: 'allowed', reason: '精确目标已核实', createdAt: Date.now(), model: { name: '隔离审核模型' } }] });
  fs.writeFileSync(auditFile, original);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `safety-test-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', error => errors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 45_000 });
    await expect.poll(() => win.evaluate(id => window.api.safety.snapshot(id), workspaceId)).toMatchObject({ workspaceId, records: [{ summary: '清理已合并分支' }] });
    await win.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat').first().click();
    const dispatch = win.locator('[data-agent-purpose="dispatch"]');
    const editor = dispatch.locator('[contenteditable="true"]').first();
    await editor.fill('保留此调度草稿');
    await win.getByRole('button', { name: '打开安全子系统' }).click();
    const sheet = win.getByRole('dialog', { name: '安全子系统' });
    await expect(sheet).toHaveAttribute('data-mp-stage', 'in');
    await expect(sheet.getByText('审批上下文已恢复，可以继续讨论合入条件。')).toBeVisible();
    const safetyInput = sheet.getByRole('textbox', { name: '询问或更正审批' });
    await safetyInput.fill('保留审批草稿');
    const screenshots = path.join(root, '.tmp/safety-ui-captures'); fs.mkdirSync(screenshots, { recursive: true });
    const settledDialog = async (dialog: Locator) => {
      await expect(dialog).toHaveAttribute('data-mp-stage', 'in');
      await expect(dialog).toHaveCSS('opacity', '1');
      await expect(dialog.locator('..')).toHaveCSS('opacity', '1');
    };
    const panel = win.locator('.agent-float-panel');
    const header = sheet.locator('.agent-memory-sheet-header');
    const tabs = sheet.getByRole('navigation', { name: '审批视图' });
    const readGeometry = () => sheet.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const headerBounds = element.querySelector('.agent-memory-sheet-header')!.getBoundingClientRect();
      const tabBounds = element.querySelector('.safety-tabs')!.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, scrollTop: element.scrollTop,
        headerInside: headerBounds.top >= bounds.top && headerBounds.bottom <= bounds.bottom,
        tabsInside: tabBounds.top >= bounds.top && tabBounds.bottom <= bounds.bottom,
        overflow: element.scrollWidth > element.clientWidth };
    });
    const colors: string[] = [];
    for (const theme of ['dark', 'light']) {
      const result = await win.evaluate(async ({ id, workspaceId }) => window.api.themes.activate(id, { scope: 'workspace', workspaceId }), { id: theme, workspaceId });
      expect(result.ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme);
      const active = await win.evaluate(() => window.api.themes.list());
      expect(active.active.id).toBe(theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.style.getPropertyValue('--ink').trim())).toBe(active.active.colors.ink);
      colors.push(await sheet.evaluate(element => getComputedStyle(element).backgroundColor));
      await expect(header).toBeVisible(); await expect(tabs).toBeVisible();
      const geometry = await readGeometry();
      expect(geometry).toMatchObject({ scrollTop: 0, headerInside: true, tabsInside: true, overflow: false });
      expect(geometry.height).toBeGreaterThan(300);
      await sheet.screenshot({ path: path.join(screenshots, `${theme}.png`) });
      await win.screenshot({ path: path.join(screenshots, `${theme}-window.png`) });
      await sheet.getByRole('button', { name: '重置审批会话' }).click();
      const reset = win.getByRole('dialog', { name: '重置审批会话？' });
      await settledDialog(reset);
      await expect(reset).toContainText('保留放行规则和审批事项记录');
      expect(fs.readFileSync(auditFile, 'utf8')).toBe(original);
      await win.screenshot({ path: path.join(screenshots, `reset-${theme}.png`) });
      await reset.getByRole('button', { name: '取消', exact: true }).click();
      await expect(reset).toHaveCount(0);
      expect(fs.readFileSync(auditFile, 'utf8')).toBe(original);
    }
    expect(colors[0]).not.toBe(colors[1]);
    const beforeNarrow = await panel.boundingBox(); expect(beforeNarrow).not.toBeNull();
    const resize = await panel.locator('.agent-panel-resizer').boundingBox(); expect(resize).not.toBeNull();
    await win.mouse.move(resize!.x + resize!.width / 2, resize!.y + resize!.height / 2);
    await win.mouse.down();
    await win.mouse.move(resize!.x + resize!.width / 2 + 390 - beforeNarrow!.width, resize!.y + resize!.height / 2, { steps: 10 });
    await win.mouse.up();
    await expect(sheet).toBeVisible();
    await expect(win.getByRole('button', { name: '收起安全子系统' })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThanOrEqual(395);
    const narrow = await readGeometry();
    expect(narrow.width).toBeLessThanOrEqual(395); expect(narrow.width).toBeGreaterThanOrEqual(350);
    expect(narrow.width).toBeLessThan(beforeNarrow!.width - 60);
    expect(narrow).toMatchObject({ scrollTop: 0, headerInside: true, tabsInside: true, overflow: false });
    await expect(safetyInput).toBeVisible();
    await sheet.screenshot({ path: path.join(screenshots, 'narrow.png') });
    await win.screenshot({ path: path.join(screenshots, 'narrow-window.png') });
    fs.writeFileSync(path.join(screenshots, 'geometry.json'), JSON.stringify({ beforeNarrow, narrow, colors }, null, 2));
    await sheet.getByRole('button', { name: '审批事项' }).click();
    await expect(sheet.getByText('精确目标已核实')).toBeVisible();
    await expect(sheet).not.toContainText('hidden-request');
    await expect(sheet).not.toContainText('hidden-fingerprint');
    await expect(sheet.getByRole('button', { name: '刷新' })).toHaveCount(0);
    await sheet.getByRole('button', { name: '关闭安全子系统' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(editor).toHaveText('保留此调度草稿');
    expect(fs.readFileSync(auditFile, 'utf8')).toBe(original);
    await win.getByRole('button', { name: '打开安全子系统' }).click();
    await sheet.getByRole('button', { name: '对话', exact: true }).click();
    await expect(safetyInput).toHaveValue('保留审批草稿');
    await sheet.getByRole('button', { name: '重置审批会话' }).click();
    const reset = win.getByRole('dialog', { name: '重置审批会话？' });
    await settledDialog(reset);
    expect(fs.readFileSync(auditFile, 'utf8')).toBe(original);
    await win.screenshot({ path: path.join(screenshots, 'reset-narrow.png') });
    await reset.getByRole('button', { name: '确认重置', exact: true }).click();
    try { await expect(reset).toHaveCount(0); }
    catch (error) {
      console.log('Reset dialog:', await reset.innerText());
      console.log('Reset state:', await win.evaluate(id => window.api.safety.snapshot(id), workspaceId));
      await win.screenshot({ path: path.join(screenshots, 'reset-failure.png') });
      throw error;
    }
    await expect(sheet.getByText('审批上下文已恢复，可以继续讨论合入条件。')).toHaveCount(0);
    await sheet.getByRole('button', { name: '放行规则', exact: true }).click();
    await expect(sheet.getByText('无冲突且检查通过才允许合入')).toBeVisible();
    await sheet.getByRole('button', { name: '停用规则', exact: true }).click();
    await expect(sheet.getByRole('button', { name: '启用规则', exact: true })).toBeVisible();
    const saved = await win.evaluate(id => window.api.safety.snapshot(id), workspaceId);
    expect(saved.messages).toEqual([]); expect(saved.rules[0].enabled).toBe(false);
    expect(saved.records).toHaveLength(1);
    expect(saved.ruleRevision).toBe(2);
    await expect(win.evaluate(id => window.api.safety.send(id, ''), workspaceId)).rejects.toThrow();
    await expect(win.evaluate(id => window.api.safety.send(id, '只回复此事项', 'missing-request'), workspaceId)).rejects.toThrow();
    await expect(win.evaluate(id => window.api.safety.setRuleEnabled(id, 'r1', true, 1), workspaceId)).rejects.toThrow();

    await sheet.getByRole('button', { name: '关闭安全子系统' }).click();
    await expect(sheet).toHaveCount(0);
    await win.getByRole('button', { name: '打开记忆子系统' }).click();
    const memory = win.getByRole('dialog', { name: '记忆子系统' });
    const memoryBefore = await win.evaluate(id => window.api.memoryCurator.state(id), workspaceId);
    for (const theme of ['dark', 'light']) {
      await win.evaluate(async ({ id, workspaceId }) => window.api.themes.activate(id, { scope: 'workspace', workspaceId }), { id: theme, workspaceId });
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await memory.getByRole('button', { name: '重置记忆会话' }).click();
      const memoryReset = win.getByRole('dialog', { name: '重置记忆会话？' });
      await settledDialog(memoryReset);
      await expect(memoryReset).toContainText('不会删除已保存的记忆');
      await win.screenshot({ path: path.join(screenshots, `memory-reset-${theme}.png`) });
      await memoryReset.getByRole('button', { name: '取消', exact: true }).click();
      await expect(memoryReset).toHaveCount(0);
      expect((await win.evaluate(id => window.api.memoryCurator.state(id), workspaceId)).generation).toBe(memoryBefore.generation);
    }
    await memory.getByRole('button', { name: '重置记忆会话' }).click();
    await settledDialog(win.getByRole('dialog', { name: '重置记忆会话？' }));
    await win.getByRole('dialog', { name: '重置记忆会话？' }).getByRole('button', { name: '确认重置', exact: true }).click();
    await expect(win.getByRole('dialog', { name: '重置记忆会话？' })).toHaveCount(0);
    const memoryAfter = await win.evaluate(id => window.api.memoryCurator.state(id), workspaceId);
    expect(memoryAfter.generation).toBeGreaterThan(memoryBefore.generation);
    expect(memoryAfter.messages).toEqual([]);
    expect(memoryAfter.pending).toBe(memoryBefore.pending);
    expect(memoryAfter.paused).toBe(memoryBefore.paused);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
});
