/**
 * 会话左栏 busy 判定：近期 PTY 输出 = 工作中。
 * 运行: node test/session-activity.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'sessionActivity.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-act-'));
  const outFile = path.join(tmp, 'sessionActivity.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const {
  PTY_OUTPUT_IDLE_MS,
  PTY_WORKING_SILENCE_IDLE_MS,
  isPtyOutputActive,
  nextPtyLifecycle,
  sessionListBusy
} = await import(pathToFileURL(outFile).href);

assert.equal(PTY_OUTPUT_IDLE_MS, 750);

// Stop is authoritative even when the TUI prints recap / redraw after its hook.
for (const lifecycle of ['idle', 'working', 'quiet']) {
  assert.equal(nextPtyLifecycle({ lifecycle, activity: { kind: 'idle', ts: 1000 }, lastOutputAt: 1100, now: 3600000 }), 'idle');
}
assert.equal(nextPtyLifecycle({ lifecycle: 'working', activity: { kind: 'active', ts: 1200, pendingTools: ['tool'] },
  lastOutputAt: 1100, now: 3600000 }), 'working', 'a new execution fact revokes the old Stop');

const now = 1_000_000;
  assert.equal(nextPtyLifecycle({ lifecycle: 'working', activity: { kind: 'active', ts: now - 31_000 },
    lastOutputAt: now - 31_000, now }), 'quiet', 'stale generic active must not lock busy for five minutes');
assert.equal(isPtyOutputActive(0, now), false, '从未输出不算工作');
assert.equal(isPtyOutputActive(now, now), true, '刚有输出算工作');
assert.equal(isPtyOutputActive(now - 749, now), true, '749ms 内仍算工作');
assert.equal(isPtyOutputActive(now - 750, now), false, '满 750ms 不算工作');
assert.equal(isPtyOutputActive(now - 2000, now), false, '停更后不算工作');

// ---------- 生命周期迁移（非对称迟滞）----------
// 回归（2026-09-16 用户实测）：working 中执行长静默命令（构建/安装/无输出脚本），
// 旧规则 750ms 无输出即翻 idle——「明明在运行，状态却变成空闲」。改为 working 中
// 静默满 PTY_WORKING_SILENCE_IDLE_MS 才翻；变 working 仍快（750ms 内有输出即算）。
assert.equal(PTY_WORKING_SILENCE_IDLE_MS, 30_000);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'working', lastOutputAt: now - 10_000, now }),
  'working',
  '回归：working 静默 10s 维持 working（旧规则此处误翻 idle）'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'working', lastOutputAt: now - 29_999, now }),
  'working',
  'working 静默未满 30s 维持 working'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'working', lastOutputAt: now - 30_000, now }),
  'quiet',
  'working 静默满 30s 降低置信度，不断言 idle'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'idle', lastOutputAt: now - 100, now }),
  'working',
  'idle 输出恢复（750ms 内）立即 working'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'idle', lastOutputAt: now - 2000, now }),
  'quiet',
  '旧输出没有完成信号，等待输出'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'starting', lastOutputAt: 0, now }),
  null,
  'starting 无输出不迁移（保持 starting）'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'starting', lastOutputAt: now - 2000, now }),
  'quiet',
  'starting 早停输出进入等待输出'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'starting', lastOutputAt: now - 100, now }),
  'working',
  'starting 有新鲜输出进 working'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'blocked', lastOutputAt: now, now }),
  null,
  'blocked 不参与输出启发式'
);
assert.equal(
  nextPtyLifecycle({ lifecycle: 'exited', lastOutputAt: now, now }),
  null,
  'exited 不参与输出启发式'
);

assert.equal(sessionListBusy({ lifecycle: 'working' }), true);
assert.equal(sessionListBusy({ status: 'running' }), true, '无 lifecycle 时 running 视为工作');
assert.equal(sessionListBusy({ lifecycle: 'idle' }), false);
assert.equal(sessionListBusy({ lifecycle: 'blocked' }), false);
assert.equal(sessionListBusy({ lifecycle: 'starting' }), false);
assert.equal(sessionListBusy({ lifecycle: 'exited' }), false);
assert.equal(sessionListBusy({ lifecycle: 'working', type: 'scheduled' }), false);
assert.equal(sessionListBusy({ lifecycle: 'idle', status: 'running' }), false, 'lifecycle 优先');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('session-activity ok');
