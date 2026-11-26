#!/usr/bin/env node
/**
 * ma-ui 契约校验器 + 试写预览生成（无依赖，node ≥18）
 * 用法：
 *   node trials.mjs            校验 trials/*.json 并重新生成 trials/preview.html
 *   node trials.mjs <file...>  只校验指定文件
 * JSON 格式：{ scene, render: { mode, title, preset, data }, feedback? }
 * 校验规则与 contract.md 同步演进——这里是未来 ui.render 参数校验的雏形。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TONES = ['success', 'danger', 'warning', 'info', 'neutral'];
const STATES_STEPS = ['done', 'doing', 'todo'];
const STATES_CHECK = ['done', 'doing', 'todo', 'blocked'];
const CHART_TYPES = ['bar', 'line', 'donut'];
const COLOR_TOKENS = ['blue', 'purple', 'green', 'yellow', 'red', 'text3'];
const INPUT_TYPES = ['number', 'range', 'select', 'checkbox', 'segmented'];

function fail(path, msg) {
  return { path, msg };
}

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function checkTable(d, p, errs) {
  if (!Array.isArray(d.columns) || !d.columns.length) errs.push(fail(p + '.columns', '必填非空数组'));
  if (!Array.isArray(d.rows)) errs.push(fail(p + '.rows', '必填数组'));
  (d.columns || []).forEach((c, i) => {
    if (!isStr(c.key) || !isStr(c.label)) errs.push(fail(`${p}.columns[${i}]`, 'key/label 必填字符串'));
  });
  (d.rows || []).forEach((r, i) => {
    (d.columns || []).forEach(c => {
      if (!(c.key in r)) errs.push(fail(`${p}.rows[${i}]`, `缺列 ${c.key}`));
      else if (c.badge && !(Array.isArray(r[c.key]) && TONES.includes(r[c.key][1])))
        errs.push(fail(`${p}.rows[${i}].${c.key}`, 'badge 列值须 [文本, tone]'));
    });
  });
}

function checkKv(d, p, errs) {
  const hasEntries = Array.isArray(d.entries) && d.entries.length;
  const hasSections = Array.isArray(d.sections) && d.sections.length;
  if (hasEntries && hasSections) errs.push(fail(p, 'entries 与 sections 二选一'));
  if (!hasEntries && !hasSections) { errs.push(fail(p, 'entries[] 或 sections[] 必填其一')); return; }
  if (hasSections) d.sections.forEach((sec, i) => {
    if (!isStr(sec.title)) errs.push(fail(`${p}.sections[${i}].title`, '必填'));
    if (!Array.isArray(sec.entries) || !sec.entries.length) errs.push(fail(`${p}.sections[${i}].entries`, '必填非空数组'));
    (sec.entries || []).forEach((e, j) => {
      if (!isStr(e.k) || !('v' in e)) errs.push(fail(`${p}.sections[${i}].entries[${j}]`, 'k/v 必填'));
    });
  });
  if (hasEntries) d.entries.forEach((e, i) => {
    if (!isStr(e.k) || !('v' in e)) errs.push(fail(`${p}.entries[${i}]`, 'k/v 必填'));
  });
}

function checkStats(d, p, errs) {
  if (!Array.isArray(d.metrics) || !d.metrics.length) { errs.push(fail(p + '.metrics', '必填非空数组')); return; }
  d.metrics.forEach((m, i) => {
    if (!isStr(m.label) || !('value' in m) || (!isStr(m.value) && !isNum(m.value))) errs.push(fail(`${p}.metrics[${i}]`, 'label 必填、value 数字或字符串'));
    if (m.trendDir && !['up', 'down', 'warn', 'flat'].includes(m.trendDir)) errs.push(fail(`${p}.metrics[${i}].trendDir`, '枚举 up|down|warn|flat'));
  });
}

function checkCompare(d, p, errs) {
  if (!Array.isArray(d.options) || d.options.length < 2) errs.push(fail(p + '.options', '至少 2 个选项'));
  if (!Array.isArray(d.criteria) || !d.criteria.length) errs.push(fail(p + '.criteria', '必填非空数组'));
  (d.criteria || []).forEach((c, i) => {
    if ((d.options || []).length && (!Array.isArray(c.values) || c.values.length !== d.options.length))
      errs.push(fail(`${p}.criteria[${i}].values`, `长度须等于选项数（${(d.options || []).length}）`));
    (c.values || []).forEach((v, j) => {
      const ok = isStr(v) || (Array.isArray(v) && isStr(v[0]) && TONES.includes(v[1]));
      if (!ok) errs.push(fail(`${p}.criteria[${i}].values[${j}]`, '字符串或 [文本, tone]'));
    });
  });
}

function checkChart(d, p, errs) {
  if (!CHART_TYPES.includes(d.type)) { errs.push(fail(p + '.type', `枚举 ${CHART_TYPES.join('|')}`)); return; }
  if (!Array.isArray(d.labels) || !d.labels.length) errs.push(fail(p + '.labels', '必填非空数组'));
  if (!Array.isArray(d.series) || !d.series.length) { errs.push(fail(p + '.series', '必填')); return; }
  const multi = typeof d.series[0] === 'object' && d.series[0] !== null;
  const series = multi ? d.series : null;
  if (!multi && !d.series.every(isNum)) errs.push(fail(p + '.series', '单序列须数值数组'));
  if (multi) {
    if (d.type === 'donut' || d.type === 'pie') errs.push(fail(p + '.series', 'donut 仅单序列'));
    series.forEach((se, i) => {
      if (!isStr(se.name)) errs.push(fail(`${p}.series[${i}].name`, '多序列须命名'));
      if (!Array.isArray(se.values) || !se.values.every(isNum)) errs.push(fail(`${p}.series[${i}].values`, '数值数组'));
      else if (se.values.length !== d.labels.length) errs.push(fail(`${p}.series[${i}].values`, '与 labels 等长'));
    });
  } else if (d.labels.length !== d.series.length) {
    errs.push(fail(p + '.series', 'labels 与 series 等长'));
  }
  if (d.colors && !d.colors.every(c => COLOR_TOKENS.includes(c)))
    errs.push(fail(p + '.colors', `token 名枚举 ${COLOR_TOKENS.join('|')}`));
  if (d.colors && multi && d.colors.length !== d.series.length)
    errs.push(fail(p + '.colors', '多序列时长度须等于序列数'));
}

function checkSteps(d, p, errs) {
  if (!Array.isArray(d.steps) || !d.steps.length) { errs.push(fail(p + '.steps', '必填非空数组')); return; }
  d.steps.forEach((s, i) => {
    if (!isStr(s.t)) errs.push(fail(`${p}.steps[${i}].t`, '必填'));
    if (!STATES_STEPS.includes(s.state)) errs.push(fail(`${p}.steps[${i}].state`, `枚举 ${STATES_STEPS.join('|')}`));
    if (s.date && !isStr(s.date)) errs.push(fail(`${p}.steps[${i}].date`, '字符串'));
    if (s.progress != null && (!isNum(s.progress) || s.progress < 0 || s.progress > 100)) errs.push(fail(`${p}.steps[${i}].progress`, '0–100'));
    if (s.note && !isStr(s.note)) errs.push(fail(`${p}.steps[${i}].note`, '字符串'));
  });
}

function checkChecklist(d, p, errs) {
  if (!Array.isArray(d.items) || !d.items.length) { errs.push(fail(p + '.items', '必填非空数组')); return; }
  d.items.forEach((it, i) => {
    if (!isStr(it.text)) errs.push(fail(`${p}.items[${i}].text`, '必填'));
    if (!STATES_CHECK.includes(it.state)) errs.push(fail(`${p}.items[${i}].state`, `枚举 ${STATES_CHECK.join('|')}`));
    if (it.note && !isStr(it.note)) errs.push(fail(`${p}.items[${i}].note`, '字符串'));
  });
}

/* expr 求值器（与 demo ma-runtime 同款，白名单无 eval） */
function makeEval() {
  function evalExpr(src, scope) {
    const s = String(src).replace(/\s+/g, '');
    if (!/^[-+*/(),<>=!.0-9a-zA-Z_]*$/.test(s)) throw new Error('非法字符');
    const toks = [];
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (/[0-9.]/.test(ch)) { let n = ''; while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++]; toks.push({ t: 'num', v: parseFloat(n) }); }
      else if (/[a-zA-Z_]/.test(ch)) { let id = ''; while (i < s.length && /[a-zA-Z_0-9]/.test(s[i])) id += s[i++]; toks.push({ t: 'id', v: id }); }
      else if ('+-*/(),<>='.includes(ch)) {
        if ((ch === '>' || ch === '<' || ch === '=') && s[i + 1] === '=') { toks.push({ t: 'op', v: ch + '=' }); i += 2; }
        else if (ch === '=' && s[i + 1] === '=') { toks.push({ t: 'op', v: '==' }); i += 2; }
        else if (ch === '!' && s[i + 1] === '=') { toks.push({ t: 'op', v: '!=' }); i += 2; }
        else { toks.push({ t: 'op', v: ch }); i++; }
      } else throw new Error('非法字符 ' + ch);
    }
    let p = 0;
    const peek = () => toks[p];
    const eat = v => { const t = toks[p++]; if (!t || t.v !== v) throw new Error('语法错误（期望 ' + v + '）'); };
    const FN = {
      round: (x, n) => { const m = Math.pow(10, n || 0); return Math.round(x * m) / m; },
      min: Math.min, max: Math.max, abs: Math.abs,
      sum: (...a) => a.reduce((x, y) => x + y, 0)
    };
    function primary() {
      const t = peek(); if (!t) throw new Error('意外结束');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === 'id') {
        p++;
        if (peek() && peek().v === '(') {
          eat('('); const args = [expr()]; while (peek() && peek().v === ',') { eat(','); args.push(expr()); } eat(')');
          if (!FN[t.v]) throw new Error('未知函数 ' + t.v);
          return FN[t.v](...args);
        }
        if (!(t.v in scope)) throw new Error('未知变量 ' + t.v);
        return scope[t.v];
      }
      if (t.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
      if (t.v === '-') { p++; return -primary(); }
      throw new Error('语法错误（' + t.v + '）');
    }
    const mul = () => { let v = primary(); while (peek() && (peek().v === '*' || peek().v === '/')) { const o = toks[p++].v; v = o === '*' ? v * primary() : v / primary(); } return v; };
    const add = () => { let v = mul(); while (peek() && (peek().v === '+' || peek().v === '-')) { const o = toks[p++].v; v = o === '+' ? v + mul() : v - mul(); } return v; };
    const cmp = () => { let v = add(); while (peek() && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v)) { const o = toks[p++].v; const r = add(); v = o === '<' ? v < r : o === '>' ? v > r : o === '<=' ? v <= r : o === '>=' ? v >= r : o === '==' ? v === r : v !== r; } return v; };
    const expr = () => cmp();
    const out = expr();
    if (p < toks.length) throw new Error('未消费尾部');
    return out;
  }
  return evalExpr;
}
const evalExpr = makeEval();

function checkControls(d, p, errs) {
  if (!Array.isArray(d.inputs) || !d.inputs.length) { errs.push(fail(p + '.inputs', '必填非空数组')); return; }
  const ids = new Set();
  d.inputs.forEach((inp, i) => {
    const q = `${p}.inputs[${i}]`;
    if (!isStr(inp.id)) errs.push(fail(q + '.id', '必填'));
    else if (ids.has(inp.id)) errs.push(fail(q + '.id', '重复'));
    ids.add(inp.id);
    if (!isStr(inp.label)) errs.push(fail(q + '.label', '必填'));
    if (!INPUT_TYPES.includes(inp.type)) errs.push(fail(q + '.type', `枚举 ${INPUT_TYPES.join('|')}`));
    if ((inp.type === 'select' || inp.type === 'segmented') && !(Array.isArray(inp.options) && inp.options.every(o => isStr(o.value) && isStr(o.label))))
      errs.push(fail(q + '.options', 'select/segmented 必填 [{value,label}]'));
    if ((inp.type === 'number' || inp.type === 'range') && !isNum(inp.value)) errs.push(fail(q + '.value', '数值型须给数值'));
  });
  if (!Array.isArray(d.outputs) || !d.outputs.length) { errs.push(fail(p + '.outputs', '必填非空数组')); return; }
  const labels = new Set();
  d.outputs.forEach(o => { if (isStr(o.label)) { if (labels.has(o.label)) errs.push(fail(p + '.outputs', `label 重名：${o.label}（followup 占位按 label 引用）`)); labels.add(o.label); } });
  const scope = {};
  d.inputs.forEach(i => { if (isStr(i.id) && isNum(i.value)) scope[i.id] = i.value; else if (isStr(i.id)) scope[i.id] = i.value === true ? 1 : 0; });
  d.outputs.forEach((o, i) => {
    const q = `${p}.outputs[${i}]`;
    if (!isStr(o.label)) errs.push(fail(q + '.label', '必填'));
    if (!isStr(o.expr)) errs.push(fail(q + '.expr', '必填'));
    else { try { const v = evalExpr(o.expr, scope); if (!Number.isFinite(v)) throw new Error('结果非有限数'); } catch (e) { errs.push(fail(q + '.expr', `试算失败（默认值代入）: ${e.message}`)); } }
    if (o.fmt && o.fmt !== 'mmss') errs.push(fail(q + '.fmt', '仅支持 mmss'));
  });
  if (d.followup) {
    if (!isStr(d.followup.label) || !isStr(d.followup.text)) errs.push(fail(p + '.followup', 'label/text 必填'));
    else {
      const known = new Set([...ids, ...d.outputs.map(o => o.label)]);
      const refs = [...d.followup.text.matchAll(/[{]([^{}]+)[}]/g)].map(m => m[1]);
      refs.forEach(r => { if (!known.has(r)) errs.push(fail(p + '.followup.text', `占位 {${r}} 不在 inputs.id / outputs.label`)); });
    }
  }
}

function checkGroup(d, p, errs) {
  if (!Array.isArray(d.children) || !d.children.length) { errs.push(fail(p + '.children', '必填非空数组')); return; }
  if (d.columns && ![2, 3].includes(d.columns)) errs.push(fail(p + '.columns', '仅 2|3'));
  d.children.forEach((ch, i) => {
    const q = `${p}.children[${i}]`;
    if (ch.span && ch.span !== 'full') errs.push(fail(q + '.span', "仅 'full'"));
    if (!isStr(ch.preset) || !CHECKERS[ch.preset]) errs.push(fail(q + '.preset', '未知 preset: ' + ch.preset));
    else if (ch.preset === 'group') errs.push(fail(q + '.preset', 'group 不可嵌套'));
    else if (!ch.data || typeof ch.data !== 'object') errs.push(fail(q + '.data', '必填对象'));
    else CHECKERS[ch.preset](ch.data, q + '.data', errs);
  });
}

const CHECKERS = { table: checkTable, kv: checkKv, stats: checkStats, compare: checkCompare, chart: checkChart, steps: checkSteps, checklist: checkChecklist, controls: checkControls, group: checkGroup };

function verifyFile(file) {
  const errs = [];
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return [{ path: file, msg: 'JSON 解析失败: ' + e.message }]; }
  const r = doc.render;
  if (!r || typeof r !== 'object') return [{ path: file, msg: '缺 render 对象' }];
  if (r.mode && !['inline', 'browser'].includes(r.mode)) errs.push(fail('render.mode', '枚举 inline|browser'));
  if (!isStr(r.title)) errs.push(fail('render.title', '必填'));
  if (r.note != null && !isStr(r.note)) errs.push(fail('render.note', '字符串（部件脚注）'));
  if (!isStr(r.preset)) errs.push(fail('render.preset', '必填'));
  else if (!CHECKERS[r.preset]) errs.push(fail('render.preset', '未知 preset: ' + r.preset));
  else if (!r.data || typeof r.data !== 'object') errs.push(fail('render.data', '必填对象'));
  else CHECKERS[r.preset](r.data, 'render.data', errs);
  if (r.html && !isStr(r.html)) errs.push(fail('render.html', '须字符串'));
  return errs;
}

/* preview：从 demo 提取契约 style + runtime，注入全部 trials 数据岛 */
function buildPreview(files) {
  const demo = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const css = demo.match(/<style id="ma-contract-style">([\s\S]*?)<\/style>/)[1];
  const js = demo.match(/<script id="ma-runtime">([\s\S]*?)<\/script>/)[1];
  const widgets = files.map(f => {
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    const r = doc.render;
    return `  <figure class="ma-widget" data-preset="${r.preset}" data-mode="${r.mode || 'inline'}" data-file="${(f.split(/[\\/]/).pop())}"${r.note ? ` data-note="${String(r.note).replace(/"/g, '&quot;')}"` : ''}>
    <script type="application/json" class="ma-data">${JSON.stringify(r.data).replace(/<\//g, '<\\/')}</script>
  </figure>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><title>ma-ui 试写预览</title>
<style>${css}
.preview-head{max-width:780px;margin:24px auto 0;padding:0 20px;color:var(--text-3);font-size:var(--fs-caption)}
.preview-list{max-width:780px;margin:0 auto;padding:12px 20px 80px}
</style></head><body>
<div class="preview-head">契约试写预览（${files.length} 份，theme 键无切换——正式 renderer 有）· 深浅用 DevTools 或改 html data-theme</div>
<div class="preview-list">
${widgets}
</div>
<script>${js}</script>
</body></html>`;
}

const args = process.argv.slice(2);
const dir = join(ROOT, 'trials');
let files = args.length
  ? args.map(a => join(process.cwd(), a))
  : readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'preview.html').sort().map(f => join(dir, f));

let bad = 0;
for (const f of files) {
  const errs = verifyFile(f);
  const name = f.split(/[\\/]/).pop();
  if (errs.length) { bad++; errs.forEach(e => console.log(`FAIL ${name} :: ${e.path} :: ${e.msg}`)); }
  else console.log(`PASS ${name}`);
}
if (!args.length && files.length) {
  writeFileSync(join(dir, 'preview.html'), buildPreview(files));
  console.log(`---- preview.html 已生成（${files.length} 份）`);
}
process.exit(bad ? 1 : 0);
