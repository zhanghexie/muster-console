#!/usr/bin/env node
/**
 * Muster 状态 hook（改造计划 P2）。
 * runtime 原生生命周期回调（claude-code / cursor-cli hooks 配置）→
 * POST $MUSTER_STATUS_URL {activity, event}（宿主 reducer 折算生命周期）。
 *
 * 纪律（对齐 AO 的 best-effort 原则）：
 * - 无 MUSTER_STATUS_URL（非宿主会话，如用户裸终端跑 claude）→ 立即 exit 0，绝不破坏 agent；
 * - 上报失败/超时（3s）也 exit 0：hook 永远不挡 agent 本体。
 *
 * 用法（由 runtime 脚本的 hooks 安装逻辑拼装，命令含 muster-hook-v1 标记便于卸载识别）：
 *   node _agent-hook.mjs muster-hook-v1 <activity> <event>
 * stdin 读 runtime 的 hook payload（JSON，可选），提取 tool_name / tool_use_id 顺带上报。
 *
 * 注意：本文件是仓库内权威副本；分发副本在
 * src/main/runtime/builtins/scripts/_agent-hook.mjs（ensureHelperScripts 拷入
 * userData/agent-runtimes/scripts/，runtime 脚本按同目录引用）。两份保持一致。
 */
import { setTimeout as sleep } from 'node:timers/promises';

const MARKER = 'muster-hook-v1';
const VALID_ACTIVITIES = new Set(['active', 'idle', 'waiting_input', 'blocked']);

const argv = process.argv.slice(2);
const markerIdx = argv.indexOf(MARKER);
const activity = markerIdx >= 0 ? argv[markerIdx + 1] : argv[0];
const event = markerIdx >= 0 ? argv[markerIdx + 2] : argv[1];

// 未知 activity（如 session-end 等忽略型事件）→ no-op
if (!VALID_ACTIVITIES.has(activity)) process.exit(0);

const statusUrl = process.env.MUSTER_STATUS_URL;
if (!statusUrl) process.exit(0);

// 读 stdin payload（claude/cursor hook 会把 JSON 打进 stdin；读不到也不影响上报）
let payload = {};
try {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  await Promise.race([
    new Promise((resolve) => process.stdin.on('end', resolve)),
    sleep(500)
  ]);
  const raw = chunks.join('').trim();
  if (raw) payload = JSON.parse(raw);
} catch {
  payload = {};
}

const body = {
  activity,
  event: event || (typeof payload.eventName === 'string' ? payload.eventName : undefined),
  toolName:
    typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.toolName === 'string'
        ? payload.toolName
        : undefined,
  toolUseId:
    typeof payload.tool_use_id === 'string'
      ? payload.tool_use_id
      : typeof payload.toolUseId === 'string'
        ? payload.toolUseId
        : undefined
};

try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3_000);
  await fetch(statusUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: ac.signal
  });
  clearTimeout(timer);
} catch {
  /* best-effort：宿主未起/端口变化都直接放行 */
}
process.exit(0);
