/**
 * 面板历史双栈状态机（shared/panelHistoryCore.ts）自测。
 * 语义：push(entry) 记录「切走前的面板」；goBack/goForward 传「当前面板」。
 * 覆盖：入栈/去重、上限裁剪、back/forward 往返横跳、新导航清空前进栈。
 * Run: node test/panel-history.mjs
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
const entry = path.join(root, 'src', 'shared', 'panelHistoryCore.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-history-'));
const outFile = path.join(tmp, 'panelHistoryCore.mjs');
const src = fs.readFileSync(entry, 'utf-8');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  },
  fileName: entry
});
fs.writeFileSync(outFile, outputText, 'utf-8');

const { PanelHistoryCore, PANEL_HISTORY_LIMIT } = await import(pathToFileURL(outFile).href);

// 1) 基本往返：null → A → B，返回两次到 null，前进两次回 B
{
  const h = new PanelHistoryCore((e) => e);
  assert.equal(h.backDepth, 0);
  assert.equal(h.forwardDepth, 0);
  assert.equal(h.goBack('x'), undefined, '空栈返回 undefined');
  assert.equal(h.goForward('x'), undefined, '空前进返回 undefined');

  let cur = null;
  h.push(cur); cur = 'A'; // null → A
  h.push(cur); cur = 'B'; // A → B
  assert.equal(h.backDepth, 2);
  assert.equal(h.forwardDepth, 0);

  cur = h.goBack(cur); // B → A
  assert.equal(cur, 'A');
  assert.deepEqual(h.back, [null]);
  assert.deepEqual(h.forward, ['B']);

  cur = h.goBack(cur); // A → null（current=A 入前进栈）
  assert.equal(cur, null);
  assert.deepEqual(h.back, []);
  assert.deepEqual(h.forward, ['B', 'A']);

  cur = h.goForward(cur); // null → A
  assert.equal(cur, 'A');
  assert.deepEqual(h.back, [null]);
  assert.deepEqual(h.forward, ['B']);

  cur = h.goForward(cur); // A → B
  assert.equal(cur, 'B');
  assert.deepEqual(h.back, [null, 'A']);
  assert.deepEqual(h.forward, [], '前进耗尽');
}

// 2) 新导航清空前进栈（浏览器分叉语义）；back 栈顶去重仍要清 forward
{
  const h = new PanelHistoryCore((e) => e);
  let cur = null;
  h.push(cur); cur = 'A';
  h.push(cur); cur = 'B';
  cur = h.goBack(cur); // B → A，forward=[B]
  assert.equal(cur, 'A');
  assert.equal(h.forwardDepth, 1);
  assert.equal(h.push(cur), true, '去重 push 也要清 forward（返回 true）');
  assert.equal(h.forwardDepth, 0, '新导航清空前进栈');
  assert.deepEqual(h.back, [null, 'A'], 'back 栈顶与 entry 相同不重复追加');
}

// 3) 中途分叉后前进栈方向正确（nearest first），旧前进栈作废
{
  const h = new PanelHistoryCore((e) => e);
  let cur = null;
  h.push(cur); cur = 'A';
  h.push(cur); cur = 'B';
  h.push(cur); cur = 'C';
  cur = h.goBack(cur); // C → B
  cur = h.goBack(cur); // B → A
  assert.equal(cur, 'A');
  assert.deepEqual(h.forward, ['C', 'B'], '后进的前进先出（B 比 C 近）');
  cur = h.goForward(cur); // A → B
  assert.equal(cur, 'B');
  // 在 B 处切到新面板 D：forward 里残留的 C 必须被清掉
  h.push(cur); cur = 'D';
  assert.deepEqual(h.forward, [], '分叉后旧前进栈作废');
  assert.equal(h.goForward(cur), undefined);
  cur = h.goBack(cur); // D → B
  assert.equal(cur, 'B');
}

// 4) 上限裁剪：back/forward 各自不超过 LIMIT
{
  const h = new PanelHistoryCore((e) => e);
  for (let i = 0; i < PANEL_HISTORY_LIMIT + 10; i++) h.push(`p${i}`);
  assert.equal(h.backDepth, PANEL_HISTORY_LIMIT);
  assert.equal(h.back[0], 'p10', '最旧条目被裁剪');
  assert.equal(h.back[h.backDepth - 1], `p${PANEL_HISTORY_LIMIT + 9}`, '最新条目在栈顶');

  const g = new PanelHistoryCore((e) => e);
  g.back = Array.from({ length: PANEL_HISTORY_LIMIT + 5 }, (_, i) => `b${i}`);
  let cur = 'now';
  for (let i = 0; i < PANEL_HISTORY_LIMIT + 5; i++) {
    const t = g.goBack(cur);
    assert.ok(t != null);
    cur = t;
  }
  assert.equal(g.forwardDepth, PANEL_HISTORY_LIMIT, 'forward 超限裁剪');
}

// 5) push 返回值：无变化时返回 false（调用方免刷新）
{
  const h = new PanelHistoryCore((e) => e);
  let cur = null;
  h.push(cur); cur = 'A';
  h.push(cur); cur = 'B';
  assert.equal(h.push(cur), true);
  // 连续 push 相同 entry 且无 forward 可清 → 无变化
  assert.equal(h.push(cur), false, '重复 push 相同 entry 且 forward 已空时无变化');
  cur = h.goBack(cur); // → A，forward=[B]
  assert.equal(h.push(cur), true, '清了 forward 算变化');
}

// 6) 对象条目按 keyOf 值去重（渲染层每次新建条目对象，按引用比较去重会失效）
{
  const h = new PanelHistoryCore((e) => `${e.kind}:${e.value}`);
  const mk = (value) => ({ kind: 'panel', value });
  h.push(mk(null)); // null → A：记 {panel,null}
  // 模拟虚拟屏关/开回环：中间无 recorded 变迁，再次记 {panel,null}——
  // back 栈顶已是同值 → 不重复追加（引用不同但按 keyOf 视为同一条目）
  assert.equal(h.push(mk(null)), false, '同值去重：back 不变、forward 已空 → 无变化');
  assert.equal(h.backDepth, 1, 'back 栈顶同值条目不重复追加');
  // 同值但 forward 非空：去重不追加，仍要清 forward（历史分叉）
  const t = h.goBack(mk('A')); // null → A：forward=[A]
  assert.equal(t?.value, null);
  assert.equal(h.push(mk(null)), true, '同值去重仍清 forward → 算变化');
  assert.equal(h.forwardDepth, 0, '同值 push 清掉前进栈');
  // 不同值（新对象）正常追加
  h.push(mk('A'));
  assert.equal(h.backDepth, 2);
}

console.log('panel-history: ok');
