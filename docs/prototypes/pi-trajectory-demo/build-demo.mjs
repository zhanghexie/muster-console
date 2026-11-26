/**
 * 组装 v3 透明模式 demo：真实聊天 DOM（捕获自运行中的 app）+ 真实样式表
 * + 三类 harness 标注（新样式仅用现有 token）。输出 scratch/trace-demo.html。
 */
import fs from 'node:fs';

const panel = fs.readFileSync(new URL('./captured-panel.html', import.meta.url), 'utf8');
const viewStart = panel.search(/<div class="[^"]*agent-chat-view/);
let seg = panel.slice(viewStart);
const mainEnd = seg.indexOf('</main>');
if (mainEnd > 0) seg = seg.slice(0, mainEnd);

// 切回合：pre(头部) + chunks(回合) + post(composer 等)
const ANCHOR = '<div class="chat-turn-anchor';

// ── 标注模板（内容为贴近真实的示例文案）──
const INJECT_3 = `<div class="harness-a harness-inject"><details>
<summary><span class="h-ico">⌁</span>本次发送追加了 3 段注入<span class="h-segs">HOST.md · 记忆 · 模式</span><span class="h-caret">▾</span></summary>
<div class="harness-seg"><label>HOST.md · 工作区协议（材料化，1,182 字）</label><pre>本仓库由 MetaAgent 工作台托管时：终端里的 Worker 请阅读 .metaAgent/HOST.md（宿主协议说明…）禁止读写 .metaAgent 本地存储；异常上报分级：做不下去或需要用户决策 → 说清卡点并停下等用户…</pre></div>
<div class="harness-seg"><label>记忆段 · 长期记忆（会话相关检索，286 字）</label><pre>相关记忆：MetaWorld Mobile 真实 UE 工程：主仓+per-plugin 嵌套仓库；嵌套容器设计已定案（自动发现全部+负担优化）…</pre></div>
<div class="harness-seg"><label>模式段 · 全自动附加协议（97 字）</label><pre>当前为全自动模式：按既定计划推进，完成后一次性汇报，不做中途确认。</pre></div>
</details></div>`;

const INJECT_2 = `<div class="harness-a harness-inject"><details>
<summary><span class="h-ico">⌁</span>本次发送追加了 2 段注入<span class="h-segs">HOST.md · 记忆</span><span class="h-caret">▾</span></summary>
<div class="harness-seg"><label>HOST.md · 工作区协议（同上，1,182 字）</label><pre>（与上次相同，hash 一致，展开看全文）</pre></div>
<div class="harness-seg"><label>记忆段 · 变更（本次新增“相机/ISM”相关检索，312 字）</label><pre>相关记忆：ISM 挂载问题曾在 08-29 处理过一轮（R-12 关联）；当前分支 fix/…</pre></div>
</details></div>`;

const STEER = `<div class="harness-a harness-steer"><span class="h-badge">插话</span><span>别再改 MountCamera 了，先看 ISM 父子级那边的约束，从根源处理</span><span class="h-time">10:31:42</span></div>`;

const DRAWER = `<div class="harness-a harness-drawer"><details>
<summary><span>⚙ harness 详情 · 本轮 3 次模型调用 · 插话 1 条</span></summary>
<table><tr><th>#</th><th>模型</th><th>输入</th><th>输出</th><th>TTFT</th><th>耗时</th><th>重试</th></tr>
<tr><td>1</td><td>deepseek-v4.1</td><td class="num">46,211</td><td class="num">1,204</td><td class="num">1.8s</td><td class="num">9.4s</td><td class="num">—</td></tr>
<tr><td>2</td><td>deepseek-v4.1</td><td class="num">52,884</td><td class="num">962</td><td class="num">2.1s</td><td class="num">8.1s</td><td class="num">1</td></tr>
<tr><td>3</td><td>deepseek-v4.1</td><td class="num">58,102</td><td class="num">1,847</td><td class="num">1.6s</td><td class="num">11.2s</td><td class="num">—</td></tr>
</table>
<div class="h-note">生效提示词快照 #3 · 系统提示词 4,214 字 · 工具 ×27（原生 19 + 宿主 8）· 采样 temperature 0.7 · 上下文 58,102 token</div>
</details></div>`;

const COMPACT = `<div class="harness-a harness-compact"><span class="h-ico">⇡</span><span>此处发生上下文压缩 · 42,180 字 → 11,902 字（更早历史已替换为摘要）</span></div>`;

// 计量 chips：插进 assistant 回合的 hoverbar 最前
const chips = `<span class="harness-metrics"><span class="harness-chip up">↑ 46.2k</span><span class="harness-chip down">↓ 1.8k</span><span class="harness-chip">思 3.1k</span><span class="harness-chip">28.7s</span></span>`;
const withChips = (t) => t.replace('<div class="chat-hoverbar">', '<div class="chat-hoverbar">' + chips);

const parts = seg.split(ANCHOR);
const pre = parts[0];
const post = ANCHOR + parts[parts.length - 1];
const turns = parts.slice(1, -1).map((t) => ANCHOR + t);

// 选回合：最后 2 个 user + 各自后的 assistant（找最近的 user 索引）
const roleOf = (t) => (t.match(/data-role="(\w+)"/) || [])[1];
const userIdx = turns.map((t, i) => (roleOf(t) === 'user' ? i : -1)).filter((i) => i >= 0);
const lastTwoUsers = userIdx.slice(-2);
const first = lastTwoUsers[0];
const picked = turns.slice(first); // 从倒数第二个 user 起到结尾（含 composer 前所有回合）

// 组装：干净容器（不沿用原 h-page 绝对布局祖先链——抽出来会没有高度）
//       user1 + 注入快照(3段) + assistant1(计量chips) + 压缩分隔 + user2 + 注入快照(2段)
//       + assistant2(中段插 steering 线 + 计量chips) + harness 抽屉
const chunks = picked.map((t) => ({ role: roleOf(t), html: t }));
const out = [];
let userCount = 0;
let asstCount = 0;
let steered = false;
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  if (c.role === 'user') {
    userCount++;
    if (userCount === 2) out.push(COMPACT);
    out.push(c.html);
    if (userCount === 1) out.push(INJECT_3);
    else out.push(INJECT_2);
    continue;
  }
  if (c.role === 'assistant') {
    asstCount++;
    if (asstCount === 2 && !steered) {
      steered = true;
      // 在 assistant 回合中段（首个工具卡前）插一条 steering 线
      const cut = c.html.indexOf('<details class="tool-card');
      const body = cut > 0 ? c.html.slice(0, cut) + STEER + c.html.slice(cut) : STEER + c.html;
      out.push(withChips(body));
    } else {
      out.push(withChips(c.html));
    }
    // 给最后一个 assistant 回合挂 harness 抽屉
    if (i === chunks.length - 1) out.push(DRAWER);
    continue;
  }
}
// user2 前插压缩分隔（已在循环内处理）
const turnHtml = out.join('');
const chat = `<div class="chat-list demo-list"><div class="agent-chat-col">${turnHtml}</div></div>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title> Harness 透明模式 · 交互 demo（v3）</title>
<link rel="stylesheet" href="file:///E:/Projects/metaagent-workbench/src/renderer/src/styles.css">
<style>
/* ══ 以下为透明模式新增样式（demo 增量），只允许使用既有 token ══ */
body.demo-body { margin: 0; background: var(--bg-canvas); color: var(--ink);
  font: 13px/1.6 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.demo-wrap { max-width: 880px; margin: 0 auto; padding: 0 0 48px; }
.demo-topbar { position: sticky; top: 0; z-index: 9; display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: var(--bg-panel); border-bottom: 1px solid var(--hairline); }
.demo-topbar .demo-title { font-weight: 600; font-size: 13px; }
.demo-topbar .demo-sub { color: var(--text-3); font-size: 12px; }
.demo-topbar .demo-spacer { flex: 1; }
/* 开关：bg-input 底 + hairline 边，开=绿 */
.harness-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  color: var(--text-2); font-size: 12px; user-select: none; }
.harness-toggle .tk { width: 30px; height: 16px; border-radius: 999px; background: var(--bg-input);
  border: 1px solid var(--hairline); position: relative; transition: background var(--dur-base, 160ms) var(--ease-out, ease); }
.harness-toggle .tk::after { content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--text-3); transition: transform var(--dur-base, 160ms) var(--ease-out, ease), background var(--dur-base,160ms) ease; }
body.harness-on .harness-toggle .tk { background: var(--ink); border-color: var(--ink); }
body.harness-on .harness-toggle .tk::after { transform: translateX(14px); background: var(--bg-canvas); }
body.harness-on .harness-toggle { color: var(--ink); }
/* 标注公共：默认隐藏；开启后按组件自身 display 显示（不互相覆盖） */
.harness-a { display: none; }
body.harness-on .harness-inject { display: block; }
body.harness-on .harness-steer { display: flex; }
body.harness-on .harness-drawer { display: block; }
body.harness-on .harness-compact { display: flex; }
/* 透明模式下 hoverbar 常显（时间 + 计量 chips）；特异性压过 .chat-msg.chat-quiet .chat-hoverbar */
body.harness-on .chat-msg.chat-quiet .chat-hoverbar { opacity: 1; pointer-events: auto; }
/* ── 注入快照 ── */
.harness-inject { margin: 2px 0 6px 36px; border: 1px dashed var(--hairline); border-radius: 8px;
  background: var(--bg-inset); overflow: hidden; }
.harness-inject summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; color: var(--text-2); font-size: 12px; }
.harness-inject summary::-webkit-details-marker { display: none; }
.harness-inject summary:hover { background: var(--hover-fill); }
.harness-inject .h-ico { color: var(--purple); font-size: 11px; }
.harness-inject .h-segs { color: var(--text-3); }
.harness-inject .h-caret { margin-left: auto; color: var(--text-3); transition: transform var(--dur-fast, 120ms) ease; }
.harness-inject[open] .h-caret { transform: rotate(180deg); }
.harness-seg { border-top: 1px solid var(--hairline); padding: 6px 10px; }
.harness-seg label { display: block; color: var(--text-3); font-size: 11px; margin-bottom: 3px; }
.harness-seg pre { margin: 0; padding: 6px 8px; background: var(--bg-canvas); border-radius: 6px;
  color: var(--text-2); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  max-height: 88px; overflow: hidden; }
/* ── 插话线 ── */
.harness-steer { display: flex; align-items: center; gap: 8px; margin: 4px 0 4px 36px; padding: 5px 10px;
  border-left: 2px solid var(--purple); background: var(--bg-inset); border-radius: 0 8px 8px 0;
  color: var(--ink-soft); font-size: 12px; }
.harness-steer .h-badge { flex: none; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--purple); color: var(--purple); }
.harness-steer .h-time { margin-left: auto; color: var(--text-3); font-size: 11px; }
/* ── 计量 chips（挂在 hoverbar 里）── */
.harness-metrics { display: none; gap: 4px; align-items: center; margin-right: 6px; }
body.harness-on .harness-metrics { display: inline-flex; }
.harness-chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--bg-inset);
  color: var(--text-2); border: 1px solid var(--hairline); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* ── 每轮 harness 详情抽屉 ── */
.harness-drawer { margin: 2px 0 8px 36px; border: 1px solid var(--hairline); border-radius: 8px;
  background: var(--bg-panel); overflow: hidden; }
.harness-drawer summary { list-style: none; cursor: pointer; padding: 6px 10px; color: var(--text-2);
  font-size: 12px; display: flex; gap: 6px; align-items: center; }
.harness-drawer summary::-webkit-details-marker { display: none; }
.harness-drawer summary:hover { background: var(--hover-fill); }
.harness-drawer table { width: calc(100% - 20px); margin: 0 10px 8px; border-collapse: collapse; font-size: 11px; }
.harness-drawer th { text-align: left; color: var(--text-3); font-weight: 500; padding: 3px 6px;
  border-bottom: 1px solid var(--hairline); }
.harness-drawer td { padding: 4px 6px; color: var(--ink-soft); border-bottom: 1px solid var(--hairline); }
.harness-drawer td.num { color: var(--text-2); font-variant-numeric: tabular-nums; }
.harness-drawer .h-note { padding: 0 10px 8px; color: var(--text-3); font-size: 11px; }
/* ── 压缩分隔 ── */
.harness-compact { display: flex; align-items: center; gap: 8px; margin: 8px 36px; color: var(--text-3); font-size: 11px; }
.harness-compact::before, .harness-compact::after { content: ''; flex: 1; height: 1px; background: var(--hairline); }
.harness-compact .h-ico { color: var(--yellow); }
/* 关闭态时 hoverbar 里原生时间右对齐不受影响 */
.demo-list { height: 780px; flex: none; border: 1px solid var(--hairline); border-radius: 10px; background: var(--bg-panel); }
</style>
</head>
<body class="demo-body harness-on">
<div class="demo-topbar">
  <span class="demo-title">修消费态加载图</span>
  <span class="demo-sub">v3 交互 demo · 真实 DOM + 真实样式</span>
  <span class="demo-spacer"></span>
  <label class="harness-toggle" id="tg"><span>Harness 透明</span><span class="tk"></span></label>
</div>
<div class="demo-wrap">
${chat}
</div>
<script>
document.getElementById('tg').addEventListener('click', () => document.body.classList.toggle('harness-on'));
</script>
</body>
</html>`;

fs.writeFileSync(new URL('./trace-demo.html', import.meta.url), html);
console.log('demo written:', html.length, 'bytes | turns picked:', chunks.length, '(user:', userCount + ')');
