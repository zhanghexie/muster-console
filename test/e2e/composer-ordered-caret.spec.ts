import { test as base, expect, _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 回归（2026-10-07 报单②）：输入框 md 有序列表每次续项光标消失。
// 根因：源前缀曾是零宽内联 span（font-size:0），Chromium 的 caret 度量取相邻
// 内联对象样式——空项行 [prefix, br] 里所有元素边界位的 caret 高度都被毒化为 0，
// 原生点击落点也一样不可见（jsdom 无法复现，须真 Chromium 逐帧闪烁探针）。
// 修复：前缀文本移进行属性 data-prefix（measure() 合成等长虚拟偏移），
// 空项行回到 [br] 首子形态，(line,0) 与正文文本内 caret 均有真实度量。
// 本用例还原修复（恢复零宽 span 结构）即转红：探针在续项后检测不到闪烁。
const repoRoot = path.resolve(__dirname, '../..');
const test = base.extend<{}, { appCtx: { app: ElectronApplication; win: Page } }>({
  appCtx: [async ({}, use) => {
    fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
    const cwd = fs.mkdtempSync(path.join(repoRoot, '.tmp/e2e-caret-'));
    const userData = path.join(cwd, '.dev-sandbox/userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', themeId: 'dark', uiFont: 'oppo', activeWorkspaceId: 'demo-playground',
      workspaces: [], mcp: { enabled: false, servers: [] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.MUSTER_SANDBOX = '1';
    env.MUSTER_INSTANCE_ID = path.basename(cwd);
    for (const key of ['MUSTER_NO_SANDBOX', 'MUSTER_DEV_MOBILE_WS', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
    const app = await _electron.launch({ executablePath: createRequire(__filename)('electron'), args: [repoRoot], cwd, env, timeout: 60_000 });
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('.app-shell', { timeout: 60_000 });
      await use({ app, win });
    } finally {
      await app.evaluate(({ app }) => app.exit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }, { scope: 'worker' }]
});

/** 光标闪烁探针：连续帧截图（含 caret），任意两帧不同 = 有可见闪烁 caret。 */
async function caretBlinks(page: Page): Promise<boolean> {
  const shots: Buffer[] = [];
  for (let i = 0; i < 5; i++) {
    shots.push(await page.screenshot({ caret: 'initial' }));
    await page.waitForTimeout(300);
  }
  return shots.some((s, i) => i > 0 && !s.equals(shots[0]));
}

test('有序列表续项后光标可见（空项行不被零宽前缀毒化）', async ({ appCtx }) => {
  const { win: page } = appCtx;
  await page.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
  const shell = page.locator('.agent-float-panel .chat-input-shell');
  await shell.locator('.composer-editable').click();
  // 面板入场等动效落定，避免闪烁探针被其它动画污染
  await shell.evaluate(async (el) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  });
  const editor = shell.locator('.composer-editable');

  await editor.pressSequentially('1. 第一项');
  expect(await caretBlinks(page)).toBe(true);
  for (const [n, next] of [['2.', '第二项'], ['3.', '第三项']] as const) {
    await editor.press('Shift+Enter');
    // 续项后：DOM 结构为行属性前缀 + 占位 br，无零宽 span；标记渲染；光标可见
    const line = editor.locator(`[data-md="ordered"][data-marker="${n}"]`);
    await expect(line).toHaveCount(1);
    expect(await line.getAttribute('data-prefix')).toBe(`${n} `);
    expect(await editor.locator('.composer-md-prefix').count()).toBe(0);
    expect(await line.locator('br[data-composer-placeholder]').count()).toBe(1);
    expect(await caretBlinks(page)).toBe(true);
    await editor.pressSequentially(next);
  }
  // 多行输入后仍可继续在末项内编辑（光标存活）
  expect(await caretBlinks(page)).toBe(true);
});
