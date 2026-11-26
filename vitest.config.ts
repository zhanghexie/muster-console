import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { downgradeNotice, vitestWholeSuiteByAgent } from './test/helpers/runScope.mjs';
import { suiteBudgetMs, testJobs, testDeadline } from './test/helpers/resources.mjs';
import { acquireTestLease } from './test/helpers/lease.mjs';
import { armProcessDeadline } from './test/helpers/execute.mjs';

// AI 编码环境里 `vitest run` / `npx vitest` 不带过滤跑整套时，改走影响面（runner 会用 vitest related 挑 spec）
const agent = vitestWholeSuiteByAgent(process.argv, process.env);
if (agent) {
  console.log(downgradeNotice(agent, '整套组件单测'));
  const root = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [path.join(root, 'test', 'run.mjs'), '--changed'], {
    cwd: root,
    stdio: 'inherit'
  });
  process.exit(r.status ?? 1);
}

/**
 * 渲染层组件级单测（jsdom + Testing Library + window.api mock）。
 * 与三层测试体系的关系见 docs/features/testing.md。
 * 渲染层无路径别名（相对导入），无需 resolve.alias；CSS import 按默认跳过。
 * JSX 与应用构建同用 automatic runtime（tsconfig.web.json jsx: react-jsx）——
 * 仓库无根 tsconfig.json，esbuild 缺省会回落 classic（要求每个 JSX 文件自带
 * React import），guiMessageView 这类「无 React import 的 JSX」会被误炸。
 */
acquireTestLease(path.dirname(fileURLToPath(import.meta.url)));
armProcessDeadline(testDeadline(suiteBudgetMs(process.env.TEST_FULL_SUITE === '1' ? 'full' : 'filter')), 'Vitest');

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.spec.{ts,tsx}'],
    setupFiles: ['test/unit/setup.ts'],
    globals: true,
    // vmThreads：每个 spec 仍是独立 vm 上下文（隔离不变），但 jsdom 等模块跨文件复用，
    // 全套 28s → 17s。--no-isolate 更快但会让 175 个用例互相污染，不可用。
    pool: 'vmThreads',
    minWorkers: 1,
    maxWorkers: testJobs(),
    // 仅 `npm run test:coverage`（--coverage）时生效；未覆盖清单由 scripts/coverage-report.mjs 出
    coverage: {
      provider: 'v8',
      include: ['src/renderer/src/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
      exclude: ['**/*.d.ts', 'src/shared/i18n/locales/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: '.tmp/coverage'
    }
  }
});
