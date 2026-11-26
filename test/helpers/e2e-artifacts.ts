import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

export const E2E_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function e2eOutputDir(root: string, runId: string): string {
  return path.join(root, 'test-results', `run-${runId}`);
}

export default function cleanupAfterSuccessfulRun({ configFile, projects }: FullConfig): void {
  // A one-shot CLI process exits with the overall result, including reporter and teardown errors.
  const args = process.argv.slice(3);
  if (process.argv[2] !== 'test' || args.some(arg => arg === '--ui' || arg.startsWith('--ui-'))) return;
  if (args.some(arg => arg === '--output' || arg.startsWith('--output='))) return;
  const runId = process.env.MUSTER_PLAYWRIGHT_RUN_ID;
  if (!configFile || !runId || !E2E_RUN_ID_PATTERN.test(runId)) return;

  // The config module can be loaded through a symlinked path, such as /var on macOS.
  const outputDir = e2eOutputDir(fs.realpathSync(path.dirname(configFile)), runId);
  if (!projects.some(project => project.outputDir === outputDir)) return;

  // Keep the checkout's test lease through cleanup. Node only allows synchronous work on exit.
  process.prependOnceListener('exit', code => {
    if (code !== 0) return;
    try {
      const parent = fs.lstatSync(path.dirname(outputDir), { throwIfNoEntry: false });
      if (!parent) return;
      if (!parent.isDirectory()) throw new Error('test-results 不是实际目录');
      fs.rmSync(outputDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      fs.writeSync(2, `test:e2e：自动清理失败，请检查目录占用或权限后手动清理 ${outputDir}。${String(error)}\n`);
    }
  });
}
