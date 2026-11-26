/**
 * GUI Worker 工具审批策略表自测（模式门控 default/ask/plan/auto × permissionClass（含 dynamic）× 路径区内外）。
 * 运行: node test/gui-worker-policy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-policy-'));

const compile = createSharedCompiler(root, tmp);
const policyOut = compile('shared/guiWorkerPolicy.ts');
const { decideToolPermission, derivePermissionMode, looksReadOnlyMcpTool, isReadOnlyShellCommand } =
  await import(pathToFileURL(policyOut).href);

const decide = (
  mode,
  permissionClass,
  { pathInsideRoot = null, mcpReadOnly = false, shellCommand, planExecuting = false } = {}
) =>
  decideToolPermission({
    mode,
    planExecuting,
    permissionClass,
    pathInsideRoot,
    mcpReadOnly,
    ...(shellCommand !== undefined ? { shellCommand } : {})
  });

// ---------- default（派生 acceptEdits，原审批表不变） ----------
assert.equal(decide('default', 'read', { pathInsideRoot: false }), 'auto', 'read 恒 auto');
assert.equal(decide('default', 'edit', { pathInsideRoot: true }), 'auto', '区内 edit 自动');
assert.equal(decide('default', 'edit', { pathInsideRoot: false }), 'prompt', '区外 edit 审批');
assert.equal(decide('default', 'edit', {}), 'prompt', '无路径判定的 edit 审批（fail closed）');
assert.equal(decide('default', 'shell', { shellCommand: 'rm -rf /' }), 'auto', 'native execution uses engine permissions, not safety review');
assert.equal(decide('default', 'status'), 'auto', '宿主状态工具自动');
assert.equal(decide('default', 'browser'), 'auto', 'browser 动作类放行（2026-09-11 撤审批）');
assert.equal(decide('default', 'mcp', { mcpReadOnly: true }), 'auto', 'MCP 只读自动');
assert.equal(decide('default', 'mcp', { mcpReadOnly: false }), 'prompt', 'MCP 写入审批');

// ---------- ask（只读门控：禁写、bash 白名单、MCP 写拒） ----------
assert.equal(decide('ask', 'edit', { pathInsideRoot: true }), 'deny', 'ask：区内 edit 也拒（禁用语义）');
assert.equal(decide('ask', 'edit', {}), 'deny', 'ask：无路径 edit 拒');
assert.equal(decide('ask', 'shell', { shellCommand: 'git status' }), 'auto', 'ask：只读命令放行');
assert.equal(decide('ask', 'shell', { shellCommand: 'git log --oneline' }), 'auto');
assert.equal(decide('ask', 'shell', { shellCommand: 'npm install' }), 'deny', 'ask：写命令拒');
assert.equal(decide('ask', 'shell', { shellCommand: 'rm -rf dist && ls' }), 'deny', 'ask：管道/分号含写动作拒');
assert.equal(decide('ask', 'read'), 'auto', 'ask：read 放行');
assert.equal(decide('ask', 'status'), 'auto', 'ask：status 放行');
assert.equal(decide('ask', 'mcp', { mcpReadOnly: true }), 'auto', 'ask：MCP 只读放行');
assert.equal(decide('ask', 'mcp', { mcpReadOnly: false }), 'deny', 'ask：MCP 写拒');
assert.equal(decide('ask', 'browser'), 'deny', 'ask：browser 动作类拒（探索时别乱点）');
assert.equal(decide('plan', 'browser'), 'deny', 'plan 探索：browser 动作类拒');
assert.equal(
  decide('plan', 'browser', { planExecuting: true }),
  'auto',
  'plan 执行中：browser 动作类放行'
);

// ---------- plan（探索态 = ask 门控；执行态门控解除） ----------
assert.equal(decide('plan', 'edit', { pathInsideRoot: true }), 'deny', 'plan 探索：edit 拒');
assert.equal(decide('plan', 'shell', { shellCommand: 'git diff' }), 'auto', 'plan 探索：只读命令放行');
assert.equal(decide('plan', 'shell', { shellCommand: 'cargo build' }), 'deny', 'plan 探索：写命令拒');
assert.equal(
  decide('plan', 'edit', { pathInsideRoot: true, planExecuting: true }),
  'auto',
  'plan 执行中：区内 edit 自动（门控解除、权限恢复 acceptEdits）'
);
assert.equal(
  decide('plan', 'shell', { shellCommand: 'cargo build', planExecuting: true }),
  'auto',
  'plan 执行中：原生 Shell 沿执行权限放行'
);
assert.equal(
  decide('plan', 'edit', { pathInsideRoot: false, planExecuting: true }),
  'prompt',
  'plan 执行中：区外 edit 审批'
);

// ---------- dynamic（动态注册类：比内置 edit 更保守——只读门控下一律 deny） ----------
assert.equal(decide('ask', 'dynamic'), 'deny', 'ask：dynamic 只读门控 deny');
assert.equal(decide('plan', 'dynamic'), 'deny', 'plan 探索：dynamic deny');
assert.equal(decide('default', 'dynamic'), 'prompt', 'default：dynamic 审批');
assert.equal(
  decide('plan', 'dynamic', { planExecuting: true }),
  'prompt',
  'plan 执行中：dynamic 仍审批（门控解除但保守）'
);

// ---------- auto（全部自动） ----------
for (const cls of ['read', 'edit', 'shell', 'status', 'mcp', 'browser', 'dynamic']) {
  assert.equal(decide('auto', cls, { pathInsideRoot: false, mcpReadOnly: false }), 'auto', `auto：${cls} 全自动`);
}

// ---------- 派生权限 ----------
assert.equal(derivePermissionMode('default'), 'acceptEdits');
assert.equal(derivePermissionMode('ask'), 'ask');
assert.equal(derivePermissionMode('plan'), 'ask');
assert.equal(derivePermissionMode('plan', true), 'acceptEdits', 'plan 执行中恢复 acceptEdits');
assert.equal(derivePermissionMode('auto'), 'auto');

// ---------- MCP 只读启发式 ----------
assert.equal(looksReadOnlyMcpTool('list_issues'), true);
assert.equal(looksReadOnlyMcpTool('get_task', '读取任务'), true);
assert.equal(looksReadOnlyMcpTool('search_docs'), true);
assert.equal(looksReadOnlyMcpTool('create_issue'), false);
assert.equal(looksReadOnlyMcpTool('update_task'), false);

// ---------- shell 只读白名单（唯一实现：isReadOnlyShellCommand；原调度 SAFE_BASH_PREFIXES 已删） ----------
assert.equal(isReadOnlyShellCommand('ls -la'), true);
assert.equal(isReadOnlyShellCommand('cat package.json'), true);
assert.equal(isReadOnlyShellCommand('rg TODO src'), true);
assert.equal(isReadOnlyShellCommand('echo hi > file'), false, '重定向写拒');
assert.equal(isReadOnlyShellCommand('git push'), false);
assert.equal(isReadOnlyShellCommand(''), false);

// 回归（2026-09-14）：quote 感知切段——纯只读链式不再被 ||/|/; 整条误杀
assert.equal(
  isReadOnlyShellCommand(
    "grep -A2 '\"node_modules/@earendil-works/pi-coding-agent\"' package-lock.json 2>/dev/null || ls node_modules/@earendil-works 2>/dev/null"
  ),
  true,
  '2>/dev/null + || 串联的只读命令放行（用户实测被拦的原命令）'
);
assert.equal(isReadOnlyShellCommand('ls a || ls b'), true, '安全 || 放行');
assert.equal(isReadOnlyShellCommand('ls a | wc -l'), true, '安全管道放行');
assert.equal(isReadOnlyShellCommand('echo hi; ls -la'), true, '安全分号放行');
assert.equal(isReadOnlyShellCommand('git log --oneline | head -5'), true);
assert.equal(isReadOnlyShellCommand('grep "a|b" f'), true, '引号内 | 不再误判为操作符');
assert.equal(isReadOnlyShellCommand("grep 'rm -rf' f"), true, '引号内危险词是匹配模式');
assert.equal(isReadOnlyShellCommand('grep x f 2>/dev/null'), true, 'stderr 丢弃放行');
assert.equal(isReadOnlyShellCommand('grep x f > /dev/null'), true, '显式 /dev/null 放行');
assert.equal(isReadOnlyShellCommand('ls -la 2>&1'), true, 'fd 复制放行');
assert.equal(isReadOnlyShellCommand('ls -la &'), true, '后台化只读命令放行');
assert.equal(isReadOnlyShellCommand('wc -l < f'), true, '输入重定向只读');

// 回归：堵「无空格重定向写文件」等绕过
assert.equal(isReadOnlyShellCommand('grep x f >out.txt'), false, '>后无空格的写不再漏');
assert.equal(isReadOnlyShellCommand('grep x f >> log'), false);
assert.equal(isReadOnlyShellCommand('echo "$(cat f >x)"'), false, '命令替换拒');
assert.equal(isReadOnlyShellCommand('echo `cat f`'), false, '反引号拒');
assert.equal(isReadOnlyShellCommand("sed -n '/x/w out' f"), false, 'sed 写命令拒');
assert.equal(isReadOnlyShellCommand("awk '{print > \"x\"}' f"), false, 'awk 重定向拒');
assert.equal(isReadOnlyShellCommand("awk '{print>\"x\"}' f"), false);
assert.equal(isReadOnlyShellCommand('find . -name "*.tmp" -delete'), false, 'find -delete 拒');
assert.equal(isReadOnlyShellCommand('dir 2>nul'), false, '重定向目标白名单仅 /dev/null');
assert.equal(isReadOnlyShellCommand('grep "x f'), false, '引号未闭合 fail closed');
assert.equal(isReadOnlyShellCommand('cat f; rm -rf /'), false, '链式含写动作仍拒');
assert.equal(isReadOnlyShellCommand('bash < script'), false, '前缀白名单外拒');

// 回归（2026-09-14 二轮，子代理评审 19 项绕过逐一封堵）
const bypasses = [
  ['ls >&out1.txt', '>&file 双流重定向（fd 复制分支需校验数字）'],
  ['echo hi >&out1.txt', ''],
  ['echo hi >"/dev/null"trash.txt', '引号目标后邻接拼接'],
  ['find . -maxdepth 0 -fprintf pwn4.txt %f', 'find -fprintf'],
  ['find . -maxdepth 0 -fls pwn5.txt', 'find -fls'],
  ["find . -maxdepth 1 -name 'd.tmp' -exec \"rm\" {} +", 'find -exec 引号拆词'],
  ["find . -maxdepth 0 -exec sh -c 'touch x.txt' {} +", 'find -exec sh'],
  ["find . -maxdepth 0 -exec sh -c 'touch x.txt' {} \\;", 'find -exec 转义分号'],
  ['find . -maxdepth 1 -name "a\\\"" -o -name \'d.tmp\' -delete', '双引号内 \\\" 转义致吞尾'],
  ["awk 'BEGIN{system(\"touch x.txt\")}'", 'awk system()'],
  ['awk \'BEGIN{print "x" | "touch x.txt"}\'', 'awk 管道执行'],
  ["sed -n '1e' <<< 'touch x.txt'", 'sed 地址+e 执行'],
  ["echo x | sed -n 's/x/x/wpwn.txt'", 'sed s 标志 w 胶水文件名'],
  ['tree -o pwn15.txt .', 'tree -o 写文件'],
  ['git branch -D x', 'git branch 删分支'],
  ["rg --pre 'touch x.txt' pat f", 'rg 预处理器执行任意程序'],
  ['find . -maxdepth 0 -exec chmod 777 . {} +', 'find -exec chmod'],
  ["find . -maxdepth 1 -name 'd.tmp' -exec 'r'm {} +", 'find -exec 拼接引号词'],
];
for (const [cmd, why] of bypasses) {
  assert.equal(isReadOnlyShellCommand(cmd), false, `绕过封堵：${why || cmd}`);
}

// 误伤候选（应放行）
assert.equal(isReadOnlyShellCommand("sed -n -e 's/a/b/p' f"), true, '-e 分离式 flag');
assert.equal(isReadOnlyShellCommand("sed -n 's/e/E/p' f"), true, 's/// 内部 e 不再误伤（掩码）');
assert.equal(isReadOnlyShellCommand('grep x f 2>/dev/null;ls'), true, '紧凑 ; 切段');
assert.equal(isReadOnlyShellCommand('grep x f 2>/dev/null&&ls'), true, '紧凑 && 切段');
assert.equal(isReadOnlyShellCommand("awk -v x='>' '{print}' f"), true, 'awk 只查 action 块');
assert.equal(isReadOnlyShellCommand('echo $((1+1))', ), true, '$(( 算术放行');
assert.equal(isReadOnlyShellCommand("awk '$1 > 100' f"), true, 'awk 块外纯模式比较');
assert.equal(isReadOnlyShellCommand("sed -n '1p' error.log"), true, '文件名含 e 不误伤');
assert.equal(isReadOnlyShellCommand('ls >&-'), false, '>&- 关 fd 保守拒');
assert.equal(isReadOnlyShellCommand('ls >&/dev/null'), true, '>&/dev/null 放行');
assert.equal(isReadOnlyShellCommand('ls 2>&1>&out1.txt'), false);
assert.equal(isReadOnlyShellCommand('ls >'), false, '> 后无目标拒');
assert.equal(isReadOnlyShellCommand('ls\r\npwd'), true, 'CRLF 切段');
assert.equal(isReadOnlyShellCommand('ls -la &'), true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] gui-worker-policy');
