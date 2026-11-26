/**
 * 日报面板 parseEntries × journalFormat.parseJournalEntries 漂移守卫。
 * 面板（resources/extensions/daily-report/ui/panel.html）是查看器、有自己的内嵌解析器；
 * 条目边界必须与格式合同单源（shared/journalFormat.ts 的 ENTRY_HEAD_RE）一致——
 * 同一批 fixture 下两边认出的条目（主题/状态/顺序）必须相同；非合同 ## 行两边都不当条目头。
 * 已知且有意的不对称：缺「- 问题：」的不完整条目，严格解析器丢弃、面板照显（查看器语义）。
 * 运行: node test/journal-panel-parse.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-panel-'));
const compile = createSharedCompiler(root, tmp);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const jf = await import(pathToFileURL(compile('shared/journalFormat.ts')));

// 从 panel.html 源码中抽出 parseEntries（改了面板解析器而忘了这个测试会先在这里炸）
const html = fs.readFileSync(path.join(root, 'resources', 'extensions', 'daily-report', 'ui', 'panel.html'), 'utf8');
const src = html.match(/function parseEntries\(md\) \{[\s\S]*?\n  \}/);
assert.ok(src, 'panel.html 中能定位 parseEntries 源码');
const panelParse = new Function('md', `${src[0]}\nreturn parseEntries(md);`);

// ---------- 合同内 fixture：边界/主题/状态完全一致 ----------
{
  const md = [
    '# 2026-09-04 工作日志',
    '',
    '## [缺陷 7067 排查] 已完成',
    '- 问题：审批流无法触发',
    '- 要点：根因是签名校验失败',
    '- 要点：',
    '  - 嵌套子要点甲',
    '  - 嵌套子要点乙',
    '',
    '## [记忆面板开发] 进行中',
    '- 问题：做行卡面板',
    '- 要点：UI 待完善',
    '## [外部依赖] 阻塞',
    '- 问题：等待依赖',
    '- 要点：确认状态',
    '## [暂缓] 搁置',
    '- 问题：等待恢复',
    '- 要点：记录原因'
  ].join('\n');
  const strict = jf.parseJournalEntries(md);
  const panel = panelParse(md);
  assert.equal(panel.length, strict.length, '条目数一致');
  strict.forEach((e, i) => {
    assert.equal(panel[i].title, e.topic, `第 ${i} 条主题一致`);
    assert.equal(panel[i].status, e.status, `第 ${i} 条状态一致`);
  });
  assert.ok(panel[0].lines.some((l) => l.includes('根因是签名校验失败')), '面板保留正文行');
  console.log('ok: contract fixtures agree');
}

// ---------- 非合同 ## 行不当条目头（此前面板把任意 ## 行切一块——两套边界就是在这里漂移的） ----------
{
  const md = [
    '## [正常条目] 已完成',
    '- 问题：x',
    '- 要点：y',
    '## 这是不带方括号的杂行标题',
    '- 要点：属于正文而不是新条目',
    '## [另一个正常条目] 进行中',
    '- 问题：z',
    '- 要点：w'
  ].join('\n');
  const strict = jf.parseJournalEntries(md);
  const panel = panelParse(md);
  assert.deepEqual(
    panel.map((e) => [e.title, e.status]),
    strict.map((e) => [e.topic, e.status]),
    '非合同 ## 行不产生条目边界'
  );
  console.log('ok: non-contract ## lines are not entry heads');
}

// ---------- 有意的不对称：不完整条目严格丢弃、面板照显 ----------
{
  const md = ['## [缺问题行] 已完成', '- 要点：没有问题行', '', '## [完整条目] 进行中', '- 问题：ok', '- 要点：ok'].join('\n');
  const strict = jf.parseJournalEntries(md);
  const panel = panelParse(md);
  assert.equal(strict.length, 1, '严格解析器只认完整条目');
  assert.equal(panel.length, 2, '面板作为查看器照显不完整条目');
  assert.equal(panel[1].title, strict[0].topic, '完整条目两边一致');
  console.log('ok: incomplete entry — strict drops, panel shows');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('journal-panel-parse: all ok');
