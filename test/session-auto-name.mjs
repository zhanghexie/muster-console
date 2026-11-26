/**
 * 默认名会话首条用户指令自动命名回归：
 * - shared/sessionAutoName.ts 纯函数：折叠空白、码点截断、空文本
 * - buildAgentTerminalSession：未显式命名才打 autoNamed 标
 * - SessionsService.autoNameFromInstruction / rename：改名即清标，非默认名与空文本不动
 * 运行: node test/session-auto-name.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-auto-name-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const originalLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const load = rel => require(path.join(root, 'src', rel));

const { deriveAutoSessionName, AUTO_SESSION_NAME_MAX } = load('shared/sessionAutoName.ts');
const { buildAgentTerminalSession } = load('main/sessions/createTerminal.ts');
const { SessionsService } = load('main/sessions.ts');

// ---------- 纯函数 ----------

assert.equal(AUTO_SESSION_NAME_MAX, 10);
assert.equal(deriveAutoSessionName('帮我改下我们的会话功能，谢谢'), '帮我改下我们的会话功', 'CJK 取前 10 字');
assert.equal(deriveAutoSessionName('短指令'), '短指令', '短于上限原样保留');
assert.equal(deriveAutoSessionName('第一行\n\n第二行\t续'), '第一行 第二行 续', '换行/制表折叠为单空格');
assert.equal(deriveAutoSessionName('  前后空白  '), '前后空白', '去首尾空白');
assert.equal(deriveAutoSessionName('   \n\t '), undefined, '纯空白无名字');
assert.equal(deriveAutoSessionName(''), undefined, '空串无名字');
assert.equal(deriveAutoSessionName(undefined), undefined, '非字符串入参不炸');
assert.equal(deriveAutoSessionName('🙂'.repeat(12)), '🙂'.repeat(10), '代理对不劈半');
assert.equal(deriveAutoSessionName('abcdefghijKLMN'), 'abcdefghij', 'ASCII 同样按 10 截断');
assert.equal(deriveAutoSessionName('一二三四五六七八九十十一', 3), '一二三', '自定义上限');

// ---------- buildAgentTerminalSession 打标 ----------

const baseInput = { id: 's1', now: 1, statusToken: 'tok', inWs: 2, runtime: 'pi', cwd: tmp, workspaceId: 'ws' };
const defaulted = buildAgentTerminalSession({ ...baseInput });
assert.equal(defaulted.name, '工作面板 3');
assert.equal(defaulted.autoNamed, true, '未显式命名 → 默认名 + autoNamed 标');

const named = buildAgentTerminalSession({ ...baseInput, name: '我的任务' });
assert.equal(named.name, '我的任务');
assert.equal(named.autoNamed, undefined, '显式命名不打标');

// ---------- SessionsService 行为 ----------

const now = Date.now();
let saved = [
  { id: 'auto', name: '工作面板 1', autoNamed: true, type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'ws', cwd: tmp, createdAt: now, lastUsedAt: now, status: 'running', lifecycle: 'idle' },
  { id: 'manual', name: '工作面板 2', type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'ws', cwd: tmp, createdAt: now, lastUsedAt: now, status: 'running', lifecycle: 'idle' },
  { id: 'renamed', name: '工作面板 3', autoNamed: true, type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'ws', cwd: tmp, createdAt: now, lastUsedAt: now, status: 'running', lifecycle: 'idle' }
];
const store = { loadSessions: () => structuredClone(saved), saveSessions: rows => { saved = structuredClone(rows); }, loadEndedSessionRefs: () => [], saveEndedSessionRefs() {} };
const pty = { isRunning: () => false, getStatus: () => 'idle', getLastOutputAt: () => 0, getBufferTail: () => undefined };
const config = { get: () => ({ workspaces: [{ id: 'ws', path: tmp, roots: [{ id: 'root', path: tmp }] }], activeWorkspaceId: 'ws', defaultRuntime: 'pi' }) };
let broadcasts = 0;
const service = new SessionsService(store, pty, config, () => null, { push() {} }, { report() {} }, { get: () => ({ surface: 'pty' }) });
service.broadcast = () => { broadcasts++; };

// 默认名会话：首条指令改名 + 清标 + 落盘
const after = service.autoNameFromInstruction('auto', '帮我改下我们的会话功能，第二行');
assert.equal(after.name, '帮我改下我们的会话功');
assert.equal(after.autoNamed, undefined, '改名后标记清除');
assert.equal(service.get('auto').name, '帮我改下我们的会话功');
assert.equal(broadcasts, 1, '改名广播');
await new Promise(r => setTimeout(r, 350));
assert.equal(saved.find(s => s.id === 'auto').name, '帮我改下我们的会话功', '改名经防抖落盘');

// 同会话第二条指令不再改名
service.autoNameFromInstruction('auto', '第二条指令不该生效');
assert.equal(service.get('auto').name, '帮我改下我们的会话功', '标记已清，后续指令不改名');

// 空文本（纯图片消息）不动，标记保留，之后的文字指令仍可命名
assert.equal(service.autoNameFromInstruction('renamed', '   ').name, '工作面板 3');
assert.equal(service.get('renamed').autoNamed, true, '空文本保留标记');
assert.equal(service.autoNameFromInstruction('renamed', '真正的首条指令在图片之后').name, '真正的首条指令在图片');
assert.equal(service.get('renamed').autoNamed, undefined);

// 非 autoNamed 会话（显式命名/旧数据）不自动改名
assert.equal(service.autoNameFromInstruction('manual', '这条不该生效').name, '工作面板 2');
assert.equal(service.autoNameFromInstruction('missing-id', 'x'), undefined, '未知会话安全返回');

// rename() 清标记：手工改名后的会话不再被后续指令覆盖
service.rename('renamed', '手工定名');
assert.equal(service.get('renamed').autoNamed, undefined, '手工改名清标记');
service.autoNameFromInstruction('renamed', '又一条指令');
assert.equal(service.get('renamed').name, '手工定名', '手工名不被指令覆盖');

console.log('test/session-auto-name.mjs 全部通过');
