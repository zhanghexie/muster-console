/**
 * GUI Worker 会话工具集：Host 进程内工具（状态工具 + catalog 宿主工具面）。
 * 后续加工具只改这里与各 driver；禁止在 execute 里写死 runtime 名。
 * B2：MCP 代理桥已退役——第三方 MCP 经宿主中转（mcp.search/mcp.call，B1 注册面）。
 */
import type { AppContext } from '../../context';
import { getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';
import type { GuiHostTool } from '../types';
import type { GuiToolPermissionClass } from '../../../shared/guiWorkerPolicy';
import { buildCatalogHostTools } from './catalogHostTools';
import { buildBgTaskTools } from './backgroundTasks';
import { buildNodeReplTools } from './nodeRepl';
import { hostToolPermissionClass, getHostToolMeta, listHostToolIds } from '../../../shared/hostTools';
import { filterResidentHostTools } from './discovery';
import { bindSessionHostTools } from './identity';

export interface GuiSessionToolset {
  /** 会话 runtime（提示词物化按 runtime 派生指引差异；禁止散落 if 到别处）。
   * 内置 Runtime 标识仍用 string，以适配产品目录中的多个引擎。 */
  runtimeId: string;
  /** 注册给引擎的进程内工具 */
  hostTools: GuiHostTool[];
  hostClassOf(dotName: string): GuiToolPermissionClass | undefined;
}

export function buildSessionToolset(
  ctx: AppContext,
  opts: {
    runtimeId: string;
    /** Host 侧按会话状态拼的附加工具（pi 创造模式的 modes.*；调用点决定条件，这里不认识 runtime 语义） */
    extraHostTools?: GuiHostTool[];
    /** 宿主工具黑名单（点号名精确匹配；pi 模式的 tools.hostDeny。黑名单而非白名单：未来新增工具不静默缩水） */
    hostToolDeny?: readonly string[];
    /**
     * 从宿主工具面整体剔除（点号名）。
     */
    excludeHostTools?: readonly string[];
    /** Captured by the host for this connection, never supplied by the model. */
    sessionIdentity?: { sessionId: string; cwd: string };
  }
): GuiSessionToolset {
  const deny = new Set(opts.hostToolDeny ?? []);
  const exclude = new Set(opts.excludeHostTools ?? []);
  const notDenied = (t: GuiHostTool): boolean => !deny.has(t.id) && !exclude.has(t.id);
  const caps = getChatCapabilities(opts.runtimeId);
  if (caps.hostToolsAvailable === false) {
    return { runtimeId: opts.runtimeId, hostTools: [], hostClassOf: () => undefined };
  }
  // catalog 背书宿主工具：R4 常驻终态清单
  // （后台子代理不豁免；身份绑定与权限档都取 shared/hostTools meta）
  const hostTools: GuiHostTool[] = buildCatalogHostTools(ctx).filter(notDenied);
  if (ctx.bgTasks && caps.bgtasks) {
    hostTools.push(...buildBgTaskTools(ctx).filter(notDenied));
  }
  // node-repl 持久代码执行（S2.2/T2）：每会话 NodeReplSession，跨调用 globalThis（后台任务之后）
  hostTools.push(...buildNodeReplTools(ctx).filter(notDenied));
  if (opts.extraHostTools?.length) hostTools.push(...opts.extraHostTools.filter(notDenied));

  const classById = new Map(hostTools.map((t) => [t.id, t.permissionClass]));
  const preset = caps.transport === 'acp-agent' ? 'acp-subset' : 'gui-full';
  const available = new Set(listHostToolIds(preset));
  const exposed = filterResidentHostTools(hostTools.filter(tool => !getHostToolMeta(tool.id) || available.has(tool.id)));
  return {
    runtimeId: opts.runtimeId,
    hostTools: bindSessionHostTools(exposed, opts.sessionIdentity),
    hostClassOf: (dotName: string) => classById.get(dotName) ?? hostToolPermissionClass(dotName)
  };
}
