#!/usr/bin/env node
/**
 * 可靠性专项 P3 全量提取器：扫描 docs/audits/reliability/*.md，抽出所有 P3 发现行，
 * 输出 JSON（含来源文件、编号、处置状态、原文行），供汇总/对账。
 * 用法：node scripts/campaign-p3-extract.mjs [--json out.json] [--md out.md]
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('docs/audits/reliability');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

// 发现行形如：- F-02 | P3 | <位置> | <证据/复现：…> | 建议：… | 处置：…
const ROW_RE = /^\s*[-*]?\s*\*{0,2}((?:[A-Z]+\d*)?-?F-?\d+)\s*\|\s*P3\s*\|\s*(.*)$/;

function parseDisposition(row) {
  const m = row.match(/处置[：:]\s*([^|]*)\|?\s*$/);
  if (!m) return { disposition: '', normalized: '无处置字段' };
  const raw = m[1].trim().replace(/\*+/g, '').trim();
  if (/待定|待裁定|待意图/.test(raw)) return { disposition: raw, normalized: '待定' };
  if (/已修|已修复|已实施|已落地/.test(raw)) return { disposition: raw, normalized: '已修' };
  if (/不修|wontfix|搁置|维持现状|接受现状|不跟进|已裁定/.test(raw)) return { disposition: raw, normalized: '已裁定不修' };
  if (/文档|doc/i.test(raw)) return { disposition: raw, normalized: '文档化' };
  return { disposition: raw, normalized: raw || '无处置字段' };
}

const items = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW_RE);
    if (!m) continue;
    const id = m[1];
    const rest = m[2];
    // 拆单元格：位置 | 证据 | 建议 | 处置（证据/建议单元格内可能含被转义或缺失的分隔）
    const cells = rest.split(/\s\|\s/);
    const loc = (cells[0] || '').replace(/\*+/g, '').trim();
    const disp = parseDisposition(lines[i]);
    const evidenceCell = cells.slice(1).join(' | ');
    const sug = evidenceCell.match(/建议[：:]\s*(.+?)(?:\s*\|\s*处置|$)/)?.[1] ?? '';
    const evi = evidenceCell.match(/(?:证据\/?复现?[：:]|[`「].*?[」`]\s*[：:]?)\s*(.+?)\s*\|\s*建议/s)?.[1] ?? evidenceCell.split(/\s*\|\s*建议/)[0] ?? '';
    items.push({
      file: f,
      line: i + 1,
      id,
      loc: loc.slice(0, 300),
      evidence: evi.trim(),
      suggestion: sug.replace(/\*+/g, '').trim(),
      disposition: disp.disposition,
      status: disp.normalized,
      raw: lines[i],
    });
  }
}

const byStatus = {};
for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const mdOut = args.includes('--md') ? args[args.indexOf('--md') + 1] : null;

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(items, null, 2), 'utf8');
if (mdOut) {
  const byFile = {};
  for (const it of items) (byFile[it.file] ??= []).push(it);
  const md = [
    `# P3 提取结果（${items.length} 条）`,
    '',
    `状态分布：${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' / ')}`,
    '',
    ...Object.entries(byFile).flatMap(([f, list]) => [
      `## ${f}（${list.length}）`,
      ...list.map((it) => `- **${it.id}** [${it.status}${it.disposition ? `：${it.disposition}` : ''}] ${it.suggestion || it.loc}`),
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(mdOut, md, 'utf8');
}

console.log(`total=${items.length}`);
console.log('status:', JSON.stringify(byStatus));
const byFileCount = {};
for (const it of items) byFileCount[it.file] = (byFileCount[it.file] ?? 0) + 1;
const top = Object.entries(byFileCount).sort((a, b) => b[1] - a[1]);
console.log(`files with P3: ${top.length}`);
for (const [f, n] of top) console.log(`  ${n}\t${f}`);
