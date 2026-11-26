import { defineConfig } from '@playwright/test';
import { acquireTestLease } from './test/helpers/lease.mjs';
import { armProcessDeadline } from './test/helpers/execute.mjs';
import { testDeadline } from './test/helpers/resources.mjs';
import { E2E_RUN_ID_PATTERN, e2eOutputDir } from './test/helpers/e2e-artifacts';
import { randomUUID } from 'node:crypto';

acquireTestLease(__dirname);
// Explicit full runs may extend the ceiling; the default entry keeps 175s.
const e2eBudgetMs = Number(process.env.MUSTER_E2E_GLOBAL_TIMEOUT_MS) || 175_000;
armProcessDeadline(testDeadline(e2eBudgetMs), 'Playwright');

// Playwright clears outputDir before starting. Isolate each command so an old
// fixture or locked trace cannot block the next run (or be deleted by it).
const previousRunId = process.env.MUSTER_PLAYWRIGHT_RUN_ID;
const runId = previousRunId && E2E_RUN_ID_PATTERN.test(previousRunId) ? previousRunId : randomUUID();
process.env.MUSTER_PLAYWRIGHT_RUN_ID = runId;

/**
 * Electron E2E：真 app（out/ 构建产物）+ dev-sandbox 隔离 + mock-llm。
 * 运行：npm run test:e2e（内部先 npm run build；从仓库根目录起跑——electron 子进程
 * 继承 runner 的 cwd，沙箱根目录按 cwd/.dev-sandbox 解析）。
 *
 * workers 固定 1：所有 spec 共享 .dev-sandbox 沙箱目录，并行必互相踩。
 */
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  globalTimeout: e2eBudgetMs,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  globalSetup: './test/helpers/e2e-artifacts.ts',
  use: {
    trace: 'retain-on-failure'
  },
  outputDir: e2eOutputDir(__dirname, runId)
});
