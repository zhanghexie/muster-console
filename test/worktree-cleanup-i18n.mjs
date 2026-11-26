import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const { applyLocaleSetting, t } = require(path.resolve('src/shared/i18n/index.ts'));
applyLocaleSetting('en');
for (const message of [
  '删除或清理失败', '清理 worktree 失败', '归档清理失败：{{error}}', 'worktree 有未提交改动，已保留',
  'worktree 有被 Git 忽略的文件，已保留', '分支有未合入提交，已保留', '无法确认未登记分支的归属，已保留',
  '会话关联的以下分支已保留：{{branches}}', '归属未确认', '未合入',
  '{{message}}。本会话即将归档并安全清理 worktree；无法安全清理的内容会保留。',
  '该目录未登记为 Git worktree，无法确认归属', '强制删除目录', '强制删除遗留目录',
  '将永久删除以下目录及其中所有文件，包括未提交和被忽略的文件：\n{{path}}\n\n分支 {{branch}} 将保留。此操作不可撤销。',
  '该目录包含或重叠其他任务仓库，请先分别处理。', '目录身份已变化，请重新检查。',
  '该目录仍有 Git worktree 登记，请使用普通清理。', '清理确认已过期，请重新检查目录。',
  '目录内包含其他 Git 仓库，已停止强制清理。', '目录已删除，分支 {{branch}} 已保留。'
]) assert.doesNotMatch(t(message, { error: 'error', branches: 'branch', message: 'merged', path: '/tree', branch: 'ao/task' }), /[\u4e00-\u9fff]/, message);
console.log('worktree-cleanup-i18n: new user-facing messages are translated');
