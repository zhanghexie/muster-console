/**
 * ma-ui 部件链接识别（src/shared/uiArtifactLink.ts）纯逻辑测试。
 * 运行: node test/ui-artifact-link.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-link-'));
const compile = createSharedCompiler(root, tmp);
const { matchUiArtifactLink, extractUiArtifactLinks, isUiRenderToolName, uiRenderWidgetFromToolCall } = await import(pathToFileURL(compile('shared/uiArtifactLink.ts')).href);
const { uiMessageArtifacts } = await import(pathToFileURL(compile('shared/uiMessageArtifacts.ts')).href);
const { transformUiArtifactMarkdown } = await import(pathToFileURL(compile('shared/uiArtifactMarkdown.ts')).href);

// ── 单链接匹配：win/unix 分隔、file://、大小写 ──
const win = 'C:\\Users\\admin\\AppData\\Roaming\\metaagent-workbench\\agent-sessions\\abc-123\\ui\\01-回归.inline.html';
const hit = matchUiArtifactLink(win);
assert.equal(hit?.mode, 'inline');
assert.equal(hit?.path, win.replace(/\\/g, '/'));
assert.equal(matchUiArtifactLink('/home/x/.config/metaagent-workbench/agent-sessions/s1/ui/02-wide.browser.html')?.mode, 'browser');
assert.equal(matchUiArtifactLink('file:///C:/Users/appdata/agent-sessions/s/ui/01-x.INLINE.html')?.mode, 'inline');
assert.equal(matchUiArtifactLink('file://%43%3A/x'), null);

// ── 非部件路径拒绝：普通 html / 别的目录 / 相对路径 / 越界注入 ──
assert.equal(matchUiArtifactLink('C:/repo/docs/x.inline.html'), null, '不在 agent-sessions/ui 下');
assert.equal(matchUiArtifactLink('C:/data/agent-sessions/s/ui/../../evil.html'), null, '路径穿越拒绝');
assert.equal(matchUiArtifactLink('https://example.com/a.inline.html'), null, 'http 链接拒绝');
assert.equal(matchUiArtifactLink('readme.html'), null);
assert.equal(matchUiArtifactLink(''), null);
assert.equal(matchUiArtifactLink('x'.repeat(2000)), null);

// ── 文本提取：markdown 目标与裸路径、去重 ──
const text = [
  '结果见 [回归汇总](C:/app/agent-sessions/s1/ui/01-sum.inline.html) 和',
  'C:\\app\\agent-sessions\\s1\\ui\\02-wide.browser.html，',
  '另有普通链接 https://x.com/a.inline.html 与 C:/repo/x.inline.html 不算。'
].join('\n');
const found = extractUiArtifactLinks(text);
assert.equal(found.length, 2, 'markdown 目标 + 裸路径，各一');
assert.equal(found[0]?.mode, 'inline');
assert.equal(found[1]?.mode, 'browser');
assert.deepEqual(extractUiArtifactLinks(''), []);
assert.deepEqual(extractUiArtifactLinks('没有链接'), []);

// ── 双轨：ui.render 工具名形态 + 工具结果反查部件（{link} 字段）──
assert.equal(isUiRenderToolName('ui.render'), true);
assert.equal(isUiRenderToolName('ui_render'), true);
assert.equal(isUiRenderToolName('mcp__muster__ui_render'), true);
assert.equal(isUiRenderToolName('UI.RENDER'), true);
assert.equal(isUiRenderToolName('ui.renderx'), false);
assert.equal(isUiRenderToolName('browser.open'), false);
const LINK = 'C:/data/agent-sessions/sg-9/ui/01-x.inline.html';
const toolHit = uiRenderWidgetFromToolCall('mcp__muster__ui_render', JSON.stringify({ link: LINK, markdown: '[x](<…>)' }));
assert.equal(toolHit?.mode, 'inline');
assert.equal(toolHit?.path, LINK);
const bareHit = uiRenderWidgetFromToolCall('ui.render', JSON.stringify({ link: LINK.replace('.inline', '.browser') }));
assert.equal(bareHit?.mode, 'browser');
assert.equal(uiRenderWidgetFromToolCall('ui.render', null), null);
assert.equal(uiRenderWidgetFromToolCall('ui.render', 'not json'), null);
assert.equal(uiRenderWidgetFromToolCall('ui.render', JSON.stringify({})), null);
assert.equal(uiRenderWidgetFromToolCall('browser.open', JSON.stringify({ link: LINK })), null);

// 无工具产物时不为隐藏表扫描长正文；正文独立链接仍由 Markdown 插件呈现。
let bodyReads = 0;
const plain = {
  id: 'plain', role: 'assistant', createdAt: 1,
  get content() { bodyReads += 1; return '长正文\n'.repeat(10000); }
};
assert.deepEqual(uiMessageArtifacts(plain), { all: [], fallback: [] });
assert.equal(bodyReads, 0, '无产物时不读/扫描正文；还原提前返回即红');
const textOnly = { ...plain, parts: [{ kind: 'text', get text() { bodyReads += 1; return '长正文'; } }] };
bodyReads = 0;
assert.deepEqual(uiMessageArtifacts(textOnly), { all: [], fallback: [] });
assert.equal(bodyReads, 0, 'parts 路径无产物时也不扫描正文');
const call = { id: 'tool', name: 'ui.render', arguments: '{}', result: JSON.stringify({ link: LINK }), status: 'ok' };
const finalLink = `[部件](<${LINK}>)`;
for (const parts of [false, true]) {
  const artifactMessage = (text, toolCall = call) => ({
    id: 'artifact', role: 'assistant', createdAt: 1, content: parts ? '' : text,
    ...(parts ? { parts: [{ kind: 'tool', toolCall }, { kind: 'text', text }] } : { toolCalls: [toolCall] })
  });
  const present = uiMessageArtifacts(artifactMessage(finalLink));
  assert.equal(present.all.length, 1);
  assert.equal(present.fallback.length, 0, '最终正文已呈现产物时不重复兜底');
  assert.equal(uiMessageArtifacts(artifactMessage('`' + finalLink + '`')).fallback.length, 1, '代码引用不抑制产物');
  assert.equal(uiMessageArtifacts(artifactMessage('完成')).fallback.length, 1);
  assert.equal(uiMessageArtifacts(artifactMessage(finalLink, { ...call, status: 'running' })).all.length, 0);
  assert.equal(uiMessageArtifacts(artifactMessage(finalLink, { ...call, result: 'broken' })).all.length, 0);
}

// 普通 AST 不为不存在的部件重建所有子树（还原 hasArtifacts 短路即红）。
const ordinaryChildren = [
  { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: 'plain' }] }] },
  { type: 'paragraph', children: [{ type: 'link', url: 'https://example.com/', children: [{ type: 'text', value: 'normal link' }] }] }
];
const ordinary = { type: 'root', children: ordinaryChildren };
const paragraphChildren = ordinaryChildren[0].children;
transformUiArtifactMarkdown(ordinary, [LINK]);
assert.equal(ordinary.children, ordinaryChildren, '普通 Markdown 不重建根子数组');
assert.equal(ordinary.children[0].children, paragraphChildren, '普通段落不复制子数组');
const referenceTree = () => ({ type: 'root', children: [
  { type: 'paragraph', children: [{ type: 'linkReference', identifier: 'Plot', children: [{ type: 'text', value: '部件' }] }] },
  { type: 'definition', identifier: 'plot', url: LINK }
] });
const referenced = referenceTree();
transformUiArtifactMarkdown(referenced);
assert.ok(referenced.children.some(node => node.type === 'maUiArtifact'), '引用式部件由 definition 识别，不得误走普通正文短路');
const suppressedReference = referenceTree();
transformUiArtifactMarkdown(suppressedReference, [LINK]);
assert.ok(!suppressedReference.children.some(node => node.type === 'maUiArtifact'));
assert.equal(suppressedReference.children[0].children[0].value, '部件', '抑制产物仍保留引用标签');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ui-artifact-link: 断言全过');
