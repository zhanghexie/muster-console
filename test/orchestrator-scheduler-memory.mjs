/**
 * 调度记忆注入与去历史会话的 Orchestrator 装配守卫（R-12）。
 * 真实 Orchestrator 依赖 electron/Pi 无法离线构造（同 test/turn-gate.mjs 的降级口径：
 * 纯逻辑由 test/scheduler-memory*.mjs 守卫，此处锁**装配点**——还原注入/拆分即红）。
 * 运行: node test/orchestrator-scheduler-memory.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// 调度 Orchestrator 已按职责拆分：门面 + orchestrator/ 子模块。守卫读「门面 +
// 子模块全量」拼接源，锚点跨文件仍逐字可查（拆分 2026-09-26，语义不变）。
const readOrchSrc = () => {
  const orchDir = path.join(root, 'src/main/agent/orchestrator');
  return [
    read('src/main/agent/orchestrator.ts'),
    ...fs
      .readdirSync(orchDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => read(path.join('src/main/agent/orchestrator', f)))
  ].join('\n');
};

const orchSrc = readOrchSrc();
const eventsSrc = read('src/main/orchestrator/events.ts');
const indexSrc = read('src/main/index.ts');

// ---------- 1) 注入时机三处（桶建立 / clearHistory 后首轮 / compact 后） ----------
assert.match(orchSrc, /memoryInjectionDue:\s*true/, '新桶建立必须置注入标记（每区首轮）');
assert.match(
  orchSrc,
  /b\.memoryInjectionDue = true;[^\n]*\n\s*\/\/ 清掉模式扩展/,
  'clearHistory 必须重置注入标记（新对话首轮再注入）'
);
assert.match(
  orchSrc,
  /if \(result\.ok\) \{\s*\n\s*\/\/ R-12 compact 后刷新[\s\S]*?b\.memoryInjectionDue = true;/,
  'compact 成功后必须置刷新标记'
);

// ---------- 2) 注入点：runTurn 前缀（进 LLM 上下文、不进 display；B5 §12 收敛） ----------
// 记忆数据源切 MemoryService.injectKnowledge（调度面 bootstrap 画像，memory/refactor §7），
// 态势仍在 due 时现采现写；host 自治回合无 trigger/Lane2（B5 读路径立场）。
assert.match(orchSrc, /composeReadPathTurnText\(o\.ctx, bucket, wsId, checkedText, host, assistant\.id\)/, 'runTurn 必须将真实轮次身份带入读路径注入点');
assert.match(orchSrc, /text:\s*turnText/, '送 piProvider 的回合文本用注入后文本');
assert.match(orchSrc, /svc\.injectKnowledge\(root, 'scheduler'/, '调度记忆前缀数据源=MemoryService.inject（§12 收敛）');
assert.match(orchSrc, /bucket\.memoryInjectionVersion === inj\.versionToken/, '逐回合 versionToken 比对（文件没变不重注入）');
assert.match(orchSrc, /writeSchedulerSituationNow\(ctx, wsId\)/, '注入前现采现写态势（冷启动新鲜）');
assert.match(orchSrc, /bucket\.memoryInjectionDue = false;/, '注入即清除标记（同会话幂等）');
assert.match(orchSrc, /svc\.recallKnowledge\(root,text,'scheduler'/, '用户回合走现有知识召回入口');
assert.match(orchSrc, /if \(host\) return out;/, 'host 自治回合跳过 trigger/Lane2');
// display 用户消息不被前缀污染：send() 里 userMsg 用原始 text，startTurn 才拿 turnText
// （B3 直写门：startTurn 第 5 参是 host 标记，不影响文本——还原注入即红）
assert.match(orchSrc, /const userMsg:\s*ChatMessage\s*=\s*\{[\s\S]*?content:\s*text,[\s\S]*?bucket\.display\.push\(userMsg\)/, 'display 用户消息保持原文');
assert.match(orchSrc, /o\.startTurn\(bucket, wsId, turnText, images, opts\?\.host, notification,/, 'startTurn 使用计算后的引擎输入与独立通知');

// ---------- 3) 去历史会话：listSessions 只回定时桶 / openSession 拒聊天桶 ----------
assert.match(orchSrc, /listableSchedulerSessions\(all\)/, 'listSessions 必须过滤只剩定时桶');
assert.match(
  orchSrc,
  /isOpenableSchedulerSessionFile\(sessionFile, taskDir\)/,
  'openSession 必须门控（仅定时任务桶目录）'
);
assert.match(orchSrc, /getPiSessionDir\(`\$\{wsId\}:tasks`\)/, '门控基准=定时任务桶目录');
// clearHistory 记忆豁免：不得出现删 scheduler 目录的调用
assert.doesNotMatch(orchSrc, /scheduler[^)\n]*rmSync|rmSync[^)\n]*scheduler/, 'clearHistory 不得删 scheduler/ 记忆目录');

// ---------- 4) 事件泵缝 + index 装配 ----------
assert.match(eventsSrc, /onSituationChange\?\:\s*\(workspaceId: string\) => void/, '泵依赖含 onSituationChange 缝');
assert.match(eventsSrc, /this\.noteSituation\(ws\);\s*\n\s*this\.schedule\(ws\);/, 'enqueue（相位翻转等）后发信号');
assert.match(eventsSrc, /finally \{\s*\n\s*\/\/ R-12：flush 后[\s\S]*?this\.noteSituation\(workspaceId\);/, 'flush 后发信号');
assert.match(indexSrc, /onSituationChange:\s*noteSchedulerSituationChanged/, 'index 装配缝');
assert.match(indexSrc, /bindSchedulerSituationContext\(ctx\)/, 'index 注入节流器 ctx');

console.log('orchestrator-scheduler-memory: all ok');
