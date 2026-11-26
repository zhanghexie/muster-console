/**
 * 工具行截断契约（chat.css）：轻量工具行的路径/详情必须随容器宽度收缩、
 * 挤压时出省略号，不得回退成定长上限。
 * 背景（2026-09-15 截图定责）：42em 定宽在宽窗口提前截断路径、右侧大片留白；
 * 链接行 ellipsis 挂在 flex 容器（a.ws-file-link）上不生效，被 overflow 硬切
 * 连省略号都没有。另：动词必须是 .tool-lite-verb（shrink:0 + nowrap），
 * 匿名文本节点会被 CJK min-content 压成竖排。回归由本用例拦截（还原即转红）。
 * 运行: node test/tool-lite-line-css.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs
  .readFileSync(path.join(root, 'src/renderer/src/styles/chat.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释后再解析，规则前挂注释不影响匹配

/** 取选择器列表（逗号分隔）包含 target 的规则体；正则按最内层 {..} 对匹配
 * （chat.css 里的 @container 嵌套块不影响——本用例断言的选择器均在顶层） */
function ruleBody(target) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(target)) return m[2];
  }
  return null;
}

const must = (cond, msg) => assert.ok(cond, msg);

// 1) 两处截断容器的行宽上限必须是百分比（随容器），不得回退成定长 em/px
for (const sel of ['.tool-lite-detail', '.tool-card.tool-lite .tool-target']) {
  const body = ruleBody(sel);
  must(body, `chat.css 缺少规则 ${sel}`);
  must(/max-width:\s*100%/.test(body), `${sel} 的 max-width 必须是 100%（随容器收缩）；定长上限会在宽窗口提前截断`);
}

// 2) 链接行的省略号必须挂内层 label：外层 a 是 flex 容器，text-overflow 不作用于
//    其 flex 子项——只挂外层会被 overflow:hidden 硬切、不出省略号
const labelBody = ruleBody('.tool-card.tool-lite .tool-target.ws-file-link .ws-file-link-label');
must(labelBody, 'chat.css 缺少 .tool-target.ws-file-link .ws-file-link-label 省略号规则');
must(
  /overflow:\s*hidden/.test(labelBody) && /text-overflow:\s*ellipsis/.test(labelBody),
  'ws-file-link-label 必须自带 overflow:hidden + text-overflow:ellipsis'
);

// 3) 收缩链完整：summary 定宽 fit-content 且封顶容器，label/target 都允许收缩
//    （任何一环变成不可收缩，长路径就会撑破行或提前截断）
const summaryBody = ruleBody('.tool-card summary');
must(
  summaryBody && /width:\s*fit-content/.test(summaryBody) && /max-width:\s*100%/.test(summaryBody),
  'summary 必须保持 width:fit-content + max-width:100%（行宽兜底）'
);
const liteLabel = ruleBody('.tool-lite-label');
must(liteLabel && /min-width:\s*0/.test(liteLabel), '.tool-lite-label 必须保持 min-width:0（可收缩）');
const targetBody = ruleBody('.tool-card.tool-lite .tool-target');
must(targetBody, 'chat.css 缺少规则 .tool-card.tool-lite .tool-target');
must(/min-width:\s*0/.test(targetBody), '.tool-card.tool-lite .tool-target 必须保持 min-width:0');
must(/flex:\s*0\s+1\s+auto/.test(targetBody), 'tool-target 必须允许收缩（flex: 0 1 auto）；flex:none 会让长路径无法收缩');

// 4) 动词徽标不得被 flex 压成竖排：CJK min-content 只有一字宽，匿名文本
//    节点默认 shrink 会被挤成「读 / 取」逐字折行。挤压只让路径省略。
const verbBody = ruleBody('.tool-lite-verb');
must(verbBody, 'chat.css 缺少规则 .tool-lite-verb（动词必须是独立 flex 项，不能是匿名文本节点）');
must(/flex-shrink:\s*0/.test(verbBody) || /flex:\s*none/.test(verbBody), '.tool-lite-verb 必须 flex-shrink:0（或 flex:none），禁止被压窄');
must(/white-space:\s*nowrap/.test(verbBody), '.tool-lite-verb 必须 white-space:nowrap（CJK 否则按字折行）');
const sepBody = ruleBody('.tool-lite-sep');
must(sepBody && /flex-shrink:\s*0/.test(sepBody), '.tool-lite-sep 必须 flex-shrink:0（间隔点跟动词一起保形）');

const chatTsx = fs.readFileSync(path.join(root, 'src/renderer/src/components/ChatMessageView.tsx'), 'utf8');
must(
  /className="tool-lite-verb"/.test(chatTsx),
  'ChatMessageView 必须把动词包进 .tool-lite-verb（禁止裸文本节点当 flex 项）'
);
must(
  /<span className="tool-lite-label">\s*(?:\{[^\n]*<span className="tool-(?:call-summary-prefix|lite-sep)"[^\n]*\n\s*)*<span className="tool-lite-verb">\{verb\}<\/span>/.test(chatTsx),
  '在可选的分组前缀后，tool-lite-verb 必须包着 {verb}'
);

// 5) JSX 侧接线：链接行 DOM 必须保持 a.tool-target.ws-file-link > 内层
//    span.ws-file-link-label 结构，否则上面全部 CSS 选择器失配
const tsx = fs.readFileSync(path.join(root, 'src/renderer/src/components/ToolVisuals.tsx'), 'utf8');
must(
  /className="tool-target ws-file-link"/.test(tsx) && /ws-file-link-label/.test(tsx),
  'ToolTitleTarget 必须渲染 tool-target ws-file-link + 内层 ws-file-link-label（CSS 选择器依赖该结构）'
);

console.log('tool-lite-line-css: 契约全部满足');
