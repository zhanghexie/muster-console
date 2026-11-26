/**
 * 工作区气泡文案态单测。
 * 运行: node test/workspace-bubble-label.mjs
 * 注：workspaceBubbleLabel.ts 迁移 i18n 后带相对依赖（shared/i18n），
 * 用 createSharedCompiler 编译入口+依赖（i18next 用临时 shim）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bubble-label-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('renderer/src/panels/workspaceBubbleLabel.ts');
const mod = await import(pathToFileURL(outFile).href);

assert.deepEqual(
  mod.resolveBubbleLabel({ panelOpen: true, workspaceName: 'ws' }),
  { text: '正在对话', mode: 'docked' }
);
// 调度回合实时态抢显示
assert.deepEqual(
  mod.resolveBubbleLabel({
    panelOpen: false,
    workspaceName: 'ws',
    liveText: '执行工具 run_tests…',
    liveActive: true
  }),
  { text: '执行工具 run_tests…', mode: 'live' }
);
// live 空文案回落工作区名
assert.deepEqual(
  mod.resolveBubbleLabel({
    panelOpen: false,
    workspaceName: 'ws',
    liveText: '  ',
    liveActive: true
  }),
  { text: 'ws', mode: 'name' }
);
// idle 态显示工作区名
assert.deepEqual(
  mod.resolveBubbleLabel({ panelOpen: false, workspaceName: 'ws' }),
  { text: 'ws', mode: 'name' }
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('workspace-bubble-label: ok');
