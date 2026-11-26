import { expect, test, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('分屏寄信在上飞起点写入邮箱，切到后台直接寄信', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const workspace = path.join(info.outputDir, 'workspace');
  const userData = path.join(info.outputDir, '.dev-sandbox/userData');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'envelope',
    workspaces: [{ id: 'envelope', name: '信封验收', path: workspace }],
    openai: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture', model: 'mock' },
    mcp: { enabled: false, servers: [] }, webAccess: { enabled: false }
  }));
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `envelope-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const page = await app.firstWindow();
    await page.locator('.app-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900));
    await page.bringToFront();
    const { sender, receiver } = await page.evaluate(async cwd => {
      const options = { cwd, workspaceId: 'envelope', runtime: 'pi', force: true };
      const sender = await window.api.sessions.create({ ...options, name: '寄件代理' });
      const receiver = await window.api.sessions.create({ ...options, name: '收件代理' });
      await window.api.sessions.select(sender.id);
      return { sender, receiver };
    }, workspace);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.getByTestId('center-pane-handle-0').focus();
    await page.keyboard.press('Control+\\');
    await expect(page.getByTestId('center-split-root')).toHaveAttribute('data-pane-count', '2');
    await page.locator('.session-item').filter({ hasText: '收件代理' }).click();
    await expect(page.locator('.agent-chat-view.is-shown')).toHaveCount(2);

    const shell = JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')).baseUrl as string;
    expect(sender.statusToken).toBeTruthy();
    const send = async (subject: string) => {
      const response = await fetch(`${shell}/v1/tool`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.statusToken}` },
        body: JSON.stringify({ name: 'host.mail.send', arguments: { to: receiver.id, subject, text: '界面核对已完成。' } }) });
      const result = await response.json();
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    const subjects = () => {
      const directory = path.join(userData, 'agent-messages');
      if (!fs.existsSync(directory)) return [];
      return fs.readdirSync(directory).filter(name => name.endsWith('.sqlite')).flatMap(name => {
        const db = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try { return db.prepare('SELECT entry_json FROM mailbox_message').all().map(row => JSON.parse(String(row.entry_json)).subject); }
        finally { db.close(); }
      });
    };
    const outgoing = page.locator(`[data-mailbox-id="${sender.id}"] .mail-envelope-scene`);
    const incoming = page.locator(`[data-mailbox-id="${receiver.id}"] .mail-envelope-scene`);
    const pending = send('分屏真实寄信');
    void pending.catch(() => {});
    await expect(outgoing).toHaveAttribute('data-phase', 'preview');
    expect(subjects()).not.toContain('分屏真实寄信');
    await expect(incoming).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('split-send-preview.png') });
    await pending;
    expect(subjects()).toContain('分屏真实寄信');
    await expect(incoming).toHaveAttribute('data-phase', 'preview');
    await page.screenshot({ path: info.outputPath('split-receive-preview.png') });
    await expect(incoming).toHaveCount(0);

    const fallback = send('隐藏窗口时立即寄信');
    void fallback.catch(() => {});
    await expect(outgoing).toHaveAttribute('data-phase', 'preview');
    expect(subjects()).not.toContain('隐藏窗口时立即寄信');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    await fallback;
    await send('后台新信');
    expect(subjects()).toEqual(expect.arrayContaining(['隐藏窗口时立即寄信', '后台新信']));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await page.bringToFront();
    await expect(page.locator('.mail-envelope-scene')).toHaveCount(0);
  } finally {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }).catch(() => {});
    await app.close();
  }
});
