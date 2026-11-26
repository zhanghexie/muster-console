/**
 * 类型检查：最多两个 tsc 进程（TEST_JOBS=1 可串行），增量缓存落 .tmp/tsbuildinfo/。
 * 与其他测试命令共用 checkout 互斥，避免多个 AI 同时占用 CPU/内存。
 *
 * 用法：node scripts/typecheck.mjs [--cwd <dir>]
 *   --cwd  在另一棵树里检查（提交门禁的暂存快照）；tsc 仍用本仓 node_modules 里的那份。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testJobs, testDeadline } from '../test/helpers/resources.mjs';
import { acquireTestLease } from '../test/helpers/lease.mjs';
import { armProcessDeadline } from '../test/helpers/execute.mjs';

export const PROJECTS = ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.test.json', 'tsconfig.test-node.json'];

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');

function runProject(cwd, project) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tscBin, '--noEmit', '-p', project], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('error', (e) => resolve({ project, code: 1, ms: Date.now() - t0, out: String(e) }));
    child.on('close', (code) => resolve({ project, code: code ?? 1, ms: Date.now() - t0, out }));
  });
}

export async function typecheck(cwd) {
  const release = acquireTestLease(cwd);
  try {
    const results = [];
    let cursor = 0;
    // Keep CPU and memory available for the desktop. Never start all three tsc processes together.
    await Promise.all(Array.from({ length: Math.min(testJobs(), 2) }, async () => {
      while (cursor < PROJECTS.length) results.push(await runProject(cwd, PROJECTS[cursor++]));
    }));
    for (const r of results) {
      console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} tsc -p ${r.project}  ${r.ms}ms`);
      if (r.code !== 0 && r.out.trim()) console.log(r.out.trimEnd());
    }
    return results.every((r) => r.code === 0);
  } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  armProcessDeadline(testDeadline(175_000), 'typecheck');
  const i = process.argv.indexOf('--cwd');
  const cwd = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exit((await typecheck(cwd)) ? 0 : 1);
}
