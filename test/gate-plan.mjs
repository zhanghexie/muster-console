/**
 * 质量门禁的判定逻辑（scripts/gate.mjs 的纯函数部分）。
 *
 * 守的重点：什么时候放行、什么时候必须在暂存快照里测。
 * - 快照判定漏了 → 测的是工作区而非提交内容：漏 add 的新文件照样绿，别人的半成品把你弄红；
 * - 放行判定宽了 → 代码改动免测直接入库。
 *
 * 运行: node test/gate-plan.mjs
 */
import assert from 'node:assert/strict';
import { isIgnorable, planGate, splitZ } from '../scripts/gate.mjs';

// ---------- 放行 ----------
{
  assert.deepEqual(planGate({ mode: 'staged', staged: [], dirty: ['src/a.ts'] }), { skip: '暂存区为空' });
  assert.ok(
    'skip' in planGate({ mode: 'staged', staged: ['docs/x.md', 'README.md', '.muster/w.json'], dirty: [] }),
    '只改文档/本地状态放行'
  );
  assert.ok(
    !('skip' in planGate({ mode: 'staged', staged: ['docs/x.md', 'src/a.ts'], dirty: [] })),
    '文档里夹一个代码文件就不能放行'
  );
  // 纯删除提交：staged 里只有被删文件，也必须测（孤儿 import 靠它拦）
  assert.ok(!('skip' in planGate({ mode: 'staged', staged: ['src/main/old.ts'], dirty: [] })));
  console.log('ok: 放行判定');
}

// ---------- 快照判定 ----------
{
  const inPlace = planGate({ mode: 'staged', staged: ['src/a.ts'], dirty: [] });
  assert.equal(inPlace.snapshot, false, '工作区与暂存区一致时原地测（增量类型检查可复用）');

  const docsDirty = planGate({ mode: 'staged', staged: ['src/a.ts'], dirty: ['docs/journal/x.md', '.tmp/y'] });
  assert.equal(docsDirty.snapshot, false, '只有文档/临时文件脏不影响测试结果');

  // 漏 add 的新文件（未跟踪）/ 部分暂存 / 别人的半成品：都必须在快照里测
  for (const dirty of [['src/new-helper.ts'], ['src/a.ts'], ['test/unit/x.spec.tsx'], ['package.json']]) {
    assert.equal(
      planGate({ mode: 'staged', staged: ['src/a.ts'], dirty }).snapshot,
      true,
      `工作区有 ${dirty[0]} 未暂存改动时必须在暂存快照里测`
    );
  }
  console.log('ok: 快照判定');
}

// ---------- 两档 ----------
{
  assert.deepEqual(planGate({ mode: 'staged', staged: ['src/a.ts'], dirty: [] }).runnerArgs, ['--changed-files']);
  assert.deepEqual(planGate({ mode: 'full', staged: ['src/a.ts'], dirty: [] }).runnerArgs, ['--full']);
  console.log('ok: staged 走影响面、full 走全量 + 组件单测');
}

// ---------- 工具函数 ----------
{
  assert.equal(isIgnorable('docs\\features\\a.md'), true, 'Windows 反斜杠路径');
  assert.equal(isIgnorable('src/renderer/docs.ts'), false);
  assert.deepEqual(splitZ('a\0b c\0'), ['a', 'b c'], '路径含空格按 NUL 切');
  console.log('ok: isIgnorable / splitZ');
}

console.log('gate-plan: all ok');
