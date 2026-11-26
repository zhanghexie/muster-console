/**
 * 解析入站 MCP stdio 脚本路径与 spawn 命令（供 registrar 写入各引擎配置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { toUnpackedAsarPath } from '../asarPaths';
import type { InboundMcpLaunch } from '../../shared/inboundMcp';

export const INBOUND_MCP_ENTRY = 'stdioEntry.mjs';

export function resolveInboundMcpEntryFile(fromDir = __dirname): string | undefined {
  const candidates = [
    path.join(fromDir, INBOUND_MCP_ENTRY),
    path.join(fromDir, 'inboundMcp', INBOUND_MCP_ENTRY)
  ];
  return candidates.map(toUnpackedAsarPath).find((c) => fs.existsSync(c));
}

export function inboundMcpLaunch(opts?: { execPath?: string; script?: string }): InboundMcpLaunch | null {
  const script = opts?.script ?? resolveInboundMcpEntryFile();
  if (!script) return null;
  const execPath = opts?.execPath ?? process.execPath;
  const env: Record<string, string> = {};
  const bin = path.basename(execPath).toLowerCase();
  // Electron / 安装包 muster.exe 必须当 Node 跑；系统 node 不用
  if (!/^node(\.exe)?$/.test(bin)) env.ELECTRON_RUN_AS_NODE = '1';
  return { command: execPath, args: [script], env: Object.keys(env).length ? env : undefined };
}

/**
 * 宿主工具 MCP shim 的统一 spawn 计划（2026-10-01 接入审查 P0-1 单源）：
 * command=execPath、args=[script]、env 含 ELECTRON_RUN_AS_NODE 判定。
 * 判定必须「非 node 即置位」——不得按 basename 前缀猜（打包产物名 muster.exe
 * 不以 electron 开头，安装版会漏置位、shim 以 GUI 模式启动）。codex/acp 的宿主
 * MCP 一律经此组装，禁止各 driver 再手写一份。
 */
export function hostMcpShimSpawn(
  script: string,
  opts?: { execPath?: string }
): { command: string; args: string[]; env: Record<string, string> } {
  const launch = inboundMcpLaunch({ execPath: opts?.execPath ?? process.execPath, script });
  if (!launch) throw new Error('hostMcpShimSpawn: script is empty');
  return { command: launch.command, args: launch.args, env: launch.env ?? {} };
}
