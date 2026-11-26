/** rubiks-cube 中心扩展端到端：真 app 打开面板、iframe 内 3D 交互与状态同步、
 * 从显式测试中心安装并激活。AI 侧栏经 mock LLM 读快照并执行共享领域命令（人与 AI 同一 DomainRuntime）。
 * 运行：npx playwright test test/e2e/extensions-rubiks-panel.spec.ts（先 npm run build）。 */
import { test, expect } from './fixtures/electron';
import { hasExtensionTestCenter, installCenterExtension } from './fixtures/centerExtension';
import fs from 'node:fs';

test.describe.configure({ mode: 'serial' });

test.skip(!hasExtensionTestCenter, 'Requires an explicit extension center fixture or GitHub credential');

test('rubiks-cube 面板与 AI 链路', async ({ appCtx, mockLlm }) => {
  const { win } = appCtx;
  await installCenterExtension(win, 'rubiks-cube');

  // 0) 模型指向 mock LLM（与 chat-guard 同款 provider 配置）
  await win.evaluate(async (baseUrl) => {
    await (window as any).api.config.update({
      llm: { activeProviderId: 'rubiks-e2e', activeModelId: 'mock',
        providers: [{ id: 'rubiks-e2e', name: 'Rubiks E2E', enabled: true, api: 'openai-completions', baseUrl, apiKey: 'mock-key', models: [{ id: 'mock', name: 'Mock' }] }] }
    });
  }, `http://127.0.0.1:${mockLlm.port}/v1`);

  // 1) 左侧导航打开魔方面板；开发态包需要显式信任（开发信任门，每次冷启动重新确认）
  const expandExtensions = win.getByRole('button', { name: '展开更多工具' });
  if (await expandExtensions.isVisible().catch(() => false)) await expandExtensions.click();
  await win.locator('[role="treeitem"][aria-label="魔方"]').click();
  const trustButton = win.getByRole('button', { name: '信任开发目录' });
  if (await trustButton.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
    await trustButton.click();
  }
  const frame = win.frameLocator('iframe[aria-label="扩展面板 魔方"]');
  await frame.locator('canvas').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(frame.locator('canvas')).toHaveCount(1);
  await frame.getByRole('button', { name: '六面观察' }).click();
  await expect(frame.locator('.net-face i')).toHaveCount(54);
  await frame.getByRole('button', { name: '转动与公式' }).click();
  await expect(frame.locator('#statusMain')).toHaveText('六面同色');
  await win.screenshot({ path: '.tmp/rubiks-verify/e2e-01-panel.png' });

  // 2) 点 R：命令 → DomainRuntime → 事件回流 → UI 同步
  await frame.getByRole('button', { name: 'R 顺时针', exact: true }).click();
  await expect(frame.locator('#moves')).toHaveText('1 步', { timeout: 10_000 });
  await expect(frame.locator('#statusMain')).not.toHaveText('六面同色');
  await expect(frame.locator('.history')).toHaveCount(0);

  // Real pointer input must turn a layer, not merely rotate the camera.
  await frame.getByRole('button', { name: '重置练习' }).click();
  await expect(frame.locator('#moves')).toHaveText('0 步');
  const canvas = await frame.locator('canvas').boundingBox();
  if (!canvas) throw new Error('Cube canvas missing');
  await win.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await win.mouse.down(); await win.mouse.move(canvas.x + canvas.width / 2 + 100, canvas.y + canvas.height / 2, { steps: 12 }); await win.mouse.up();
  await expect(frame.locator('#moves')).toHaveText('1 步');
  await frame.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(frame.locator('#moves')).toHaveText('0 步');
  await win.screenshot({ path: '.tmp/rubiks-verify/e2e-02-new-studio.png' });

  // 4) AI 侧栏：mock LLM 读快照（state.snapshot 工具）。侧栏可能默认已打开，按 aria-pressed 决定是否点击。
  const toggle = win.getByTestId('extension-agent-toggle').filter({ visible: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const sidebar = win.locator('.ext-agent-sidebar');
  await sidebar.waitFor({ state: 'visible', timeout: 20_000 });
  const composer = sidebar.locator('.chat-input-shell [contenteditable="true"]').first();
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.fill('tool:ext_rubiks-cube_state_snapshot {}');
  await composer.press('Enter');
  await expect(sidebar).toContainText('工具执行成功', { timeout: 30_000 });
  const reply = await sidebar.textContent();
  expect(reply).toContain('faces');
  expect(reply).not.toContain('\"history\":');
  expect(reply).not.toContain('\"lastMove\":');

  // 5) AI 执行 cube.move：edit 类命令按权限档位弹审批卡，批准后领域命令执行并同步到立方体 UI
  await composer.fill('tool:ext_rubiks-cube_command_cube_move {"move":"R"}');
  await composer.press('Enter');
  const approve = sidebar.getByRole('button', { name: '允许', exact: true });
  await approve.waitFor({ state: 'visible', timeout: 20_000 });
  await approve.click();
  await expect(frame.locator('#moves')).toHaveText('1 步', { timeout: 30_000 });
  await expect(frame.locator('.history')).toHaveCount(0);
  await expect(frame.locator('#statusMain')).toHaveText('探索中');
  await win.screenshot({ path: '.tmp/rubiks-verify/e2e-04-ai-move.png' });

  // 6) 渲染层零报错
  expect(appCtx.consoleErrors, `console errors: ${appCtx.consoleErrors.slice(0, 4).join(' | ')}`).toEqual([]);
  void fs; // 截图目录已由各步骤写出
});
