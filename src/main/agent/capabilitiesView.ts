import type { AppContext } from '../context';
import { requireShellApi } from '../context';
import { getCatalogInfo, WORKER_TOOL_ALLOWLIST } from '../capabilities/catalog';
import type { CapabilitiesView } from '../../shared/types';
import { resolveEffectiveMcpFromApp } from '../../shared/mcpConfig';
import { schedulerWorkspacePromptScope } from './schedulerWorkspaceContext';
import { listInjections } from './injection-registry';
import {
  buildCatalogAppendix,
  buildDefaultDispatcherAppendBody,
  buildMetaAgentAppendPromptText
} from './systemPrompt';

export function getCapabilitiesView(ctx: AppContext): CapabilitiesView {
  const cfg = ctx.config.get();
  const mcp = resolveEffectiveMcpFromApp(cfg, cfg.activeWorkspaceId, 'pi-dispatcher');
  const mcpServers = mcp.enabled
    ? mcp.servers.filter((s) => s.enabled).map((s) => s.name)
    : [];
  const mcpOpts = { mcpEnabled: mcp.enabled, mcpServers };
  const defaultBody = buildDefaultDispatcherAppendBody(requireShellApi(ctx).baseUrl, mcpOpts);
  const customBody = typeof cfg.dispatcherAppendPrompt === 'string' ? cfg.dispatcherAppendPrompt : '';
  const isCustom = customBody.trim().length > 0;
  const body = isCustom ? customBody.trim() : defaultBody;
  const catalogAppendix = buildCatalogAppendix();
  const fullPreview = buildMetaAgentAppendPromptText(requireShellApi(ctx).baseUrl, {
    ...mcpOpts,
    customBody,
    rules: cfg.agentRules,
    ...(ctx.orchestrator?.getWorkspacePromptScope(cfg.activeWorkspaceId) ??
      schedulerWorkspacePromptScope(ctx.config, cfg.activeWorkspaceId))
  });

  return {
    catalog: getCatalogInfo(),
    workerToolAllowlist: [...WORKER_TOOL_ALLOWLIST],
    // A3 注入注册表：设置页「注入清单」只读展示（纯文本渲染，无交互）
    injections: listInjections().map((s) => ({ ...s })),
    dispatcher: {
      body,
      defaultBody,
      customBody,
      isCustom,
      catalogAppendix,
      fullPreview,
      initNotes: [
        '调度使用 Muster Core。模型和凭据保存在工作台私有目录。',
        '初始化时追加 appendSystemPrompt = 本页「调度提示词」正文 + Catalog 摘要 + 当前回合目录快照。',
        '调度技能目录：宿主 ~/.muster/skills、用户 ~/.agents/skills 和工作区各源根的 .agents/skills。',
        '壳层能力面（R5 终态）：常驻清单即模型全部可用面——工具原生注册直调，九个能力域收敛为 X.run 单入口（参数细节在 ~/.muster/skills/ 技能文档），发现层（tools.search/tools.call）已退役。',
        'Worker 经 Shell API 以 Bearer 绑定可信身份；常驻工具按身份/运行时投影，注册面即权限面。',
        'Worker 不必查 sessions.observe：MUSTER_STATUS_URL / MUSTER_SELF / Bearer token 已带齐身份。'
      ]
    }
  };
}
