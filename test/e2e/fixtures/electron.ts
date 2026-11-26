/**
 * Playwright Electron E2E 启动夹具。
 *
 * 每个 spec 文件一个全新应用实例（worker 级夹具，auto）：
 *   1. 先跑 scripts/reset-dev-sandbox.mjs 还原沙箱基准（与 npm run test:ui 同源）；
 *   2. 以 MUSTER_SANDBOX=1 启动构建产物（electron . → out/main/index.js），
 *      不设 ELECTRON_RENDERER_URL，渲染层加载 out/renderer/index.html；
 *   3. 等 .app-shell 出现（渲染层水合以 app:boot:wait 放行为前提，即主进程 IPC 已注册）；
 *   4. 收集渲染层 console error/warning 与 pageerror，供 smoke 断言零错误；
 *   5. 结束时 app.close() 优雅退出；该 app 关闭=最小化到托盘，若进程未在时限内
 *      退出则 taskkill 杀进程树（pty shell 是 electron 子进程，必须连树杀）。
 *
 * mockLlm 为懒加载夹具：只有用到的 spec（chat-guard）才拉起 test/mock-llm.mjs；
 * 端口已被占用时视为外部已有实例（如手动 npm run mock-llm），复用且不负责停。
 */
import { test as base, expect, _electron as playwrightElectron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
export type { ElectronApplication, Page };
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 仓库 package.json 无 "type": "module"，Playwright 把 TS 转译成 CJS 跑，
// 这里不能用 import.meta，用 CJS 产物里天然存在的 __dirname/__filename。
export const repoRoot = path.resolve(__dirname, '..', '..', '..');

// require('electron') 返回的是 electron 可执行文件路径（非模块）
const nodeRequire = createRequire(__filename);
const electronExecutable = nodeRequire('electron') as unknown as string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AppContext {
  app: ElectronApplication;
  win: Page;
  consoleErrors: string[];
}

export interface MockLlm {
  port: number;
  /** false = 复用外部已运行的实例（手动 npm run mock-llm），测试结束不负责停 */
  owned: boolean;
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), sleep(10_000)]);
  const deadline = Date.now() + 8000;
  while (proc.exitCode === null && Date.now() < deadline) await sleep(300);
  if (proc.exitCode === null && proc.pid && process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 进程恰好已退出 */
    }
  }
}

export const test = base.extend<{}, { appCtx: AppContext; mockLlm: MockLlm; isolatedSandbox: boolean }>({
  isolatedSandbox: [false, { option: true, scope: 'worker' }],
  appCtx: [
    async ({ isolatedSandbox }, use) => {
      // Extension update tests modify installed packages. Use a disposable
      // profile and let the real app seed it without resetting the shared demo.
      const cwd = isolatedSandbox ? fs.mkdtempSync(path.join(os.tmpdir(), 'muster-e2e-')) : repoRoot;
      if (!isolatedSandbox) execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'reset-dev-sandbox.mjs')], {
        cwd: repoRoot,
        stdio: 'ignore'
      });

      const env = { ...process.env } as Record<string, string | undefined>;
      // 走构建产物而非 dev server；避免外部 dev 实例的端口约定干扰本实例
      delete env.ELECTRON_RENDERER_URL;
      delete env.MUSTER_DEVTOOLS_PORT;
      delete env.MUSTER_WEB_PORT;
      delete env.MUSTER_NO_SANDBOX;
      env.MUSTER_SANDBOX = '1';
      env.MUSTER_INSTANCE_ID = `e2e-${process.pid}`;

      // 注：electron.launch 不支持 slowMo（playwright 1.63 静默忽略）。
      // 演示用旋钮是 PW_CONFIRM_PAUSE_MS（确认框点击前驻留，见 chat-guard）与
      // PW_LINGER_MS（关 app 前驻留，见下）。
      const app = await playwrightElectron.launch({
        executablePath: electronExecutable,
        args: [repoRoot],
        cwd,
        env: env as Record<string, string>,
        timeout: 60_000
      });
      try {
        const win = await app.firstWindow();

        const consoleErrors: string[] = [];
        win.on('console', (msg) => {
          if (msg.type() === 'error' || msg.type() === 'warning') {
            const text = msg.text();
            // 未打包运行时 Electron 自带的 CSP 安全告警（打包后不出现），非应用缺陷
            if (text.includes('Electron Security Warning')) return;
            consoleErrors.push(`[console.${msg.type()}] ${text}`);
          }
        });
        win.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));

        await win.waitForSelector('.app-shell', { timeout: 60_000 });
        await use({ app, win, consoleErrors });
        const lingerMs = Number(process.env.PW_LINGER_MS || 0);
        if (lingerMs > 0) await win.waitForTimeout(lingerMs).catch(() => {});
      } finally {
        await stopApp(app);
        if (isolatedSandbox) fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      }
    },
    { scope: 'worker', auto: true }
  ],

  mockLlm: [
    async ({}, use) => {
      const port = Number(process.env.MOCK_LLM_PORT || 18034);
      if (await probePort(port)) {
        await use({ port, owned: false });
        return;
      }
      const child = spawn(process.execPath, [path.join(repoRoot, 'test', 'mock-llm.mjs')], {
        cwd: repoRoot,
        env: { ...process.env, MOCK_LLM_PORT: String(port) },
        stdio: 'ignore'
      });
      for (let i = 0; i < 100; i++) {
        if (await probePort(port)) break;
        if (child.exitCode !== null) throw new Error(`mock-llm 启动即退出(code=${child.exitCode})`);
        await sleep(100);
      }
      if (!await probePort(port)) {
        child.kill();
        throw new Error(`mock-llm 10s 内未就绪(端口 ${port})`);
      }
      await use({ port, owned: true });
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
    { scope: 'worker' }
  ]
});

export { expect };
