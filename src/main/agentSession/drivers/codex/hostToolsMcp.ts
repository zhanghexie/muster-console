/** Registers the Codex Host tool catalog through the stdio MCP shim and gateway. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostMcpShimSpawn, resolveInboundMcpEntryFile } from '../../../inboundMcp/launch';
import { hostToolsToCatalog, type HostToolsCatalog } from '../acp/mcpServers';
import { startHostToolGateway } from '../acp/hostToolGateway';
import type { GuiDriverConnectInput } from '../../types';
import { CodexDesktopDelivery } from './desktopDelivery';
import type { GlobalEngineDelivery } from '../../../desktop/globalEngineDelivery';

/** 宿主工具 MCP 超时（秒）：长命令/问卷/审批都合法，对齐 Cursor askQuestion 24h */
export const CODEX_HOST_TOOLS_TIMEOUT_SEC = 24 * 60 * 60;

export const CODEX_HOST_MCP_SERVER = 'muster';

export interface CodexHostToolsMcpHandle {
  /** 原生线程的 MCP 配置片段（含 mcp_servers.muster） */
  configFragment: Record<string, unknown>;
  catalog: HostToolsCatalog;
  desktopDelivery: CodexDesktopDelivery;
  /** Give each newly spawned native engine process a different gateway credential. */
  rotateTurn(): void;
  close: () => void;
}

function resolveHostMcpScript(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  // 打包产物走 resolveInboundMcpEntryFile；测试即时转译成 ESM 时 __dirname 会炸，吞掉后走候选路径
  try {
    const bundled = resolveInboundMcpEntryFile();
    if (bundled) return bundled;
  } catch {
    /* ignore */
  }
  // 只认构建产物 .mjs：源码 .ts 入口有无扩展名相对导入（stdioEntry.ts:7 起），
  // Node 原生加载不了，不构成发布/回退入口（2026-10-01 接入审查 r2 附注）
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', '..', 'inboundMcp', 'stdioEntry.mjs'),
    path.join(process.cwd(), 'out/main/inboundMcp/stdioEntry.mjs')
  ];
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) throw new Error('找不到宿主工具 MCP 脚本 inboundMcp/stdioEntry');
  return hit;
}

/**
 * 组装 Codex 宿主工具 MCP：目录仅包含传入的公开工具及可用的审批桥。
 * host.ask 由宿主按通道可用性提供，不额外添加旧问卷别名。
 */
export async function setupCodexHostToolsMcp(
  input: Pick<
    GuiDriverConnectInput,
    | 'sessionId'
    | 'cwd'
    | 'workspaceContext'
    | 'hostTools'
    | 'requestApproval'
    | 'requestUserQuestion'
    | 'getPolicyState'
    | 'getTurnId'
    | 'getDesktopTurnId'
    | 'log'
  >,
  opts?: { hostMcpScript?: string; globalDelivery?: GlobalEngineDelivery }
): Promise<CodexHostToolsMcpHandle | null> {
  const desktopDelivery = new CodexDesktopDelivery(() => input.getTurnId?.(), reason =>
    input.log('warn', `Codex desktop action delivery unconfirmed: ${reason}`), opts?.globalDelivery);
  const gateway = await startHostToolGateway(input, { interceptor: desktopDelivery, captureImages: true });
  let catalogPath: string | undefined;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-mcp-'));
    catalogPath = path.join(dir, 'catalog.json');
    // 目录与宿主公开清单同源；可用的自愿审批桥另行登记。
    const catalog = hostToolsToCatalog(input.hostTools, {
      includeAskQuestion: !!input.requestUserQuestion,
      includeRequestApproval: !!input.requestApproval
    });
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const script = resolveHostMcpScript(opts?.hostMcpScript);
    // P0-1 单源：spawn 计划（execPath + ELECTRON_RUN_AS_NODE 判定）一律来自 hostMcpShimSpawn
    const shim = hostMcpShimSpawn(script);
    const env: Record<string, string> = {
      ...shim.env,
      MUSTER_HOST_TOOLS_URL: gateway.url,
      MUSTER_HOST_TOOLS_TOKEN: gateway.token,
      MUSTER_HOST_TOOLS_CATALOG: catalogPath,
      MUSTER_HOST_TOOLS_PRESET: 'gui-full'
    };
    const configFragment = {
      mcp_servers: {
        [CODEX_HOST_MCP_SERVER]: {
          command: shim.command,
          args: shim.args,
          env,
          enabled: true,
          enabled_tools: catalog.tools.map((t) => t.name),
          tool_timeout_sec: CODEX_HOST_TOOLS_TIMEOUT_SEC
        }
      }
    };
    return {
      configFragment,
      catalog,
      desktopDelivery,
      rotateTurn: () => { env.MUSTER_HOST_TOOLS_TOKEN = gateway.rotateToken(); },
      close: () => {
        desktopDelivery.close();
        gateway.close();
        if (catalogPath) {
          try {
            fs.rmSync(path.dirname(catalogPath), { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    };
  } catch (e) {
    desktopDelivery.close();
    gateway.close();
    if (catalogPath) {
      try {
        fs.rmSync(path.dirname(catalogPath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
