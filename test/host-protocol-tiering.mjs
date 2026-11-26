/**
 * A5 HOST.md 披露分级（zcode-adoption-plan A5）：
 * 1) 核心协议长度硬帽（HOST_CORE_MAX_CHARS=1000，超帽生成处即抛）+ 核心节必载内容；
 * 2) 扩展协议（HOST-EXT.md）承载下放内容；两层结构 + 锚点引用存在；
 * 3) ensure 落盘：HOST.md 与 HOST-EXT.md 双文件、显式 protocolBody 逃生口、
 *    AGENTS.md 托管段新增「协议类内容给路径不给全文」规约行；
 * 4) 在隔离工作区核对 extension 扩展协议和生成源。
 * 运行: node test/host-protocol-tiering.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tiering-'));
const compile = createSharedCompiler(root, tmp);

const hostProtocol = await import(pathToFileURL(compile('main/metaAgent/hostProtocol.ts')).href);
const {
  HOST_CORE_MAX_CHARS,
  ensureHostCoreWithinCap,
  buildMetaAgentHostCoreMarkdown,
  buildMetaAgentHostExtensionMarkdown,
  buildMetaAgentHostProtocolMarkdown
} = hostProtocol;

// ---------- 1) 核心协议长度硬帽 ----------
assert.equal(HOST_CORE_MAX_CHARS, 1000, '硬帽常量 = 1000 字符');
const core = buildMetaAgentHostCoreMarkdown();
assert.ok(
  core.length <= HOST_CORE_MAX_CHARS,
  `核心协议 ${core.length} 字符须 ≤ ${HOST_CORE_MAX_CHARS}（超帽内容下放 HOST-EXT.md）`
);
assert.throws(
  () => ensureHostCoreWithinCap('x'.repeat(HOST_CORE_MAX_CHARS + 1)),
  /over the 1000 cap/,
  '超帽断言：长度越限生成处即抛错（还原即红：删 ensureHostCoreWithinCap 内的 throw）'
);
console.log(`ok  1) 核心协议长度硬帽（当前 ${core.length}/${HOST_CORE_MAX_CHARS} 字符，越限抛错）`);

// ---------- 2) 核心节必载内容（宿主判定/三档 phase/needs_you/hooks 合法性/禁区/EXT 指针） ----------
assert.match(core, /MUSTER_HOST=1/, '宿主判定门');
assert.match(core, /sessions.create\(asSubagent=true\)/, '所有 Worker 可派子代理');
assert.match(core, /sessions.observe/, '统一会话观察入口');
assert.doesNotMatch(core, /do not (open|create) sessions/i, '不注入与工具能力相反的禁令');
assert.match(core, /needs_you/);
assert.match(core, /done/);
assert.match(core, /idle/);
assert.match(core, /never report/, '进行中不报 needs_you 的反例语义');
assert.match(core, /MUSTER_STATUS_URL/, '上报端点');
assert.match(core, /## hooks/, 'hooks 合法性节');
assert.match(core, /activity/, 'hooks 只报 activity');
assert.match(core, /never invent URLs/);
assert.match(core, /## Forbidden/, '禁区节（agent-rules.mjs 契约）');
assert.doesNotMatch(core, /probe-read/, '旧运行时文件不再允许探测读取');
assert.match(core, /HOST-EXT\.md/, '扩展协议路径引用');
assert.match(core, /file tool/, '按需读取的指令');
assert.doesNotMatch(core, /Global Conduct Rules|全局行为规约/, '规约节属用户数据不进核心模板');
assert.doesNotMatch(core, /\[host\] P11/, 'worktree 细节下放扩展协议');
assert.doesNotMatch(core, /browser\.open/, '浏览器教学下放扩展协议');
console.log('ok  2) 核心节必载内容 + 下放项不回流');

// ---------- 3) 扩展协议承载下放内容 ----------
const ext = buildMetaAgentHostExtensionMarkdown();
  assert.match(ext, /continue working until all work is complete or a blocker requires user decision/);
  assert.match(ext, /kind=notice and continue without waiting for a reply or ending the turn/);
  assert.match(ext, /kind=ask when a reply is needed/);
  assert.match(ext, /waitFor 武装等待/);
  assert.match(ext, /kind=handoff only for final delivery after the entire task is complete, then wait for acceptance/);

assert.match(ext, /configures CLI MCP automatically/);
assert.match(ext, /Settings → Capability management → MCP/);
assert.doesNotMatch(ext, /Settings → Integrations|Write CLI engine MCP config/);
for (const marker of [
  'host.sessions.requestIntegrate',
  '`git commit` before reporting `needs_you`',
  '[host] P11',
  'host.mail.send',
  'host.mail.read',
  '~/.muster/skills/', // R5：run 入口参数细节指路技能文档
  'replyTo',
  'Delivery notes',
  'up to 10 Unicode characters',
  'host.ui.notify',
  'host.browser.run',
  'muster-console' // Product 探测（META_AGENT_PRODUCT，产品改名时同步）
]) {
  assert.ok(ext.includes(marker), `扩展协议承载 ${marker}`);
}
assert.doesNotMatch(ext, /tools\.search|tools_search/, 'R5 发现层退役：扩展协议不再教学 tools.search');
assert.doesNotMatch(ext, /tools\.call|tools_call/, 'R5 发现层退役：扩展协议不再教学 tools.call');
assert.match(ext, /HOST\.md/, '扩展协议回指核心协议');
assert.match(ext, /MUSTER_SHELL_API/);
assert.match(ext, /MUSTER_SESSION_TOKEN/);
assert.match(ext, /Do not inspect workspace storage/, '发现只使用可信env/MCP，不读工作区本地存储');
assert.match(ext, /sessions\.create\(\{task,asSubagent:true,isolation\}\)/, '创建示例必须给出必填隔离选择');
assert.match(ext, /isolated defaults to the cwd Git repository only/, '默认隔离范围与创建行为一致');
assert.match(ext, /Waiting is host\.waitFor\. host\.mail\.read reads and never waits\./, '等待引导落在扩展协议');
const { SESSIONS_OPS_TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/sessionsOps.ts')).href);
const mailParams = SESSIONS_OPS_TOOL_DEFS.find(def => def.name === 'sessions.readMessages').parameters.properties;
assert.ok(mailParams.bodyOffset && !mailParams.offset, 'single-message schema uses bodyOffset');
assert.match(ext, /host\.mail\.read \{[^}]*messageId\?,bodyOffset\?/);
assert.match(ext, /messageId\+bodyOffset\/length/);
assert.doesNotMatch(ext, /messageId\+offset\/length/);
assert.match(ext, /Read-class actions need no approval; operation-class actions may require permission approval, and non-empty upload also receives safety review\./);
assert.doesNotMatch(ext, /Actions execute directly without approval/);
assert.doesNotMatch(ext, /waitMs|watchSessionIds/, '已删除的等待参数不得继续出现');
console.log('ok  3) 扩展协议（HOST-EXT.md）承载全部下放内容');

// ---------- 4) buildMetaAgentHostProtocolMarkdown = 核心 + 规约节（agent-rules.mjs 契约） ----------
const plain = buildMetaAgentHostProtocolMarkdown();
assert.equal(plain, core, '无规约时 HOST.md 正文 = 核心协议');
assert.ok(plain.indexOf('## Forbidden') !== -1);
const withRules = buildMetaAgentHostProtocolMarkdown([{ id: 'a', text: '分级规约戊', enabled: true }]);
// R0 英文化：规约节头由中文改为英文（agentConduct.ts renderAgentRulesSection）
assert.match(withRules, /## Global Conduct Rules \(user-set; must be followed\)\n1\. 分级规约戊/);
assert.ok(withRules.indexOf('## 禁区') < withRules.indexOf('分级规约戊'), '规约节恒在核心协议之后');
console.log('ok  4) HOST.md = 核心协议（+ 规约节），契约不破');

// New workspaces use the shared domain skills. Do not materialize retired
// protocol copies or write generated instructions into project AGENTS.md.
const scaffold = await import(pathToFileURL(compile('main/metaAgent/scaffold.ts')).href);
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tiering-ws-'));
try {
  assert.equal(scaffold.ensureMetaAgentScaffold(ws).created, true);
  assert.ok(fs.existsSync(path.join(ws, '.muster', 'workflows')));
  for (const file of ['.muster/HOST.md', '.muster/HOST-EXT.md', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(ws, file)), false, file);
  }
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
console.log('ok  5) fresh workspace scaffold omits retired protocol copies');

// extension contract is checked against the generated protocol, never the user's local .muster.
assert.match(ext, /extensions\.run/);
assert.match(ext, /immediate review/);
assert.doesNotMatch(ext, /\/v1\/ext-tool|First execution of an action/);
console.log('ok  6) generated protocol describes extension');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] host-protocol-tiering');
