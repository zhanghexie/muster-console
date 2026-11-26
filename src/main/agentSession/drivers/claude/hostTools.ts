/**
 * claude 会话的宿主工具注册：SDK 官方进程内 MCP 通道（createSdkMcpServer + tool()）。
 * - 点号名 → 下划线（sessions.setStatus → sessions_setStatus），引擎侧全名
 *   mcp__muster__sessions_setStatus（政策层目录用引擎实际名，见 prompt.ts claude 分支）；
 * - 权限与执行走 GUI 公共宿主工具网关；
 * - JSON Schema 按字段投影为 SDK 需要的 Zod shape，不能投影的约束明确告警，
 *   完整 schema 由宿主执行边界校验。
 * - host.ask 随已过滤的工具列表注册，复用工作台的提问交互。
 * 动态 import SDK 与 zod/v4（测试注入假 SDK 时不经过这里）。
 */
import type { GuiDriverConnectInput } from '../../types';
import { createGuiHostToolGateway } from '../../tools/gateway';
import type { ClaudeSdkModule } from './claudeSdk';
import { projectClaudeDesktopImage } from './desktopImage';

/** 进程内 MCP server 名；allowedTools 用 mcp__muster 整 server 放行 */
export const CLAUDE_HOST_MCP_SERVER = 'muster';

/** 宿主工具在引擎侧的可见名（政策层目录/审批回显用） */
export function claudeEngineToolName(dotName: string): string {
  return `mcp__${CLAUDE_HOST_MCP_SERVER}__${dotName.replace(/\./g, '_')}`;
}

/** Project the public JSON Schema to the Zod raw shape required by Claude SDK. */
async function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
  onUnsupported: (message: string) => void
): Promise<Record<string, unknown>> {
  const z = (await import('zod/v4')).z;
  const shape: Record<string, unknown> = {};
  const props =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.not) {
    onUnsupported('root schema conditions are enforced by the host');
  }
  for (const [key, raw] of Object.entries(props)) {
    let field: ReturnType<typeof z.fromJSONSchema>;
    try {
      field = z.fromJSONSchema(raw as Parameters<typeof z.fromJSONSchema>[0], { defaultTarget: 'draft-7' });
    } catch (error) {
      onUnsupported(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      // A broad JSON value remains required when the original property was
      // required; authoritative validation still uses the complete schema.
      field = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);
    }
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

export interface ClaudeHostToolDeps {
  sdk: ClaudeSdkModule;
  input: Pick<
    GuiDriverConnectInput,
    | 'sessionId'
    | 'cwd'
    | 'workspaceContext'
    | 'hostTools'
    | 'requestApproval'
    | 'getPolicyState'
    | 'getTurnId'
    | 'getDesktopTurnId'
    | 'log'
  >;
  isCurrent?: () => boolean;
}

/**
 * 组装 muster 进程内 MCP server（无宿主工具时返回 undefined）。
 * server 名固定 muster：引擎 allowedTools 用 mcp__muster 整 server 放行。
 */
export async function buildClaudeMcpServer(
  deps: ClaudeHostToolDeps
): Promise<ReturnType<ClaudeSdkModule['createSdkMcpServer']> | undefined> {
  const { sdk, input } = deps;
  if (!input.hostTools.length) return undefined;
  const tools = [];
  let approvalSeq = 0;
  const gateway = createGuiHostToolGateway(input, { isCurrent: deps.isCurrent, captureImages: true });
  for (const tool of input.hostTools) {
    const engineName = tool.id.replace(/\./g, '_');
    const shape = await jsonSchemaToZodShape(tool.parameters ?? {}, (message) => input.log('warn', `Claude 工具 ${tool.id} 的 schema 投影不完整：${message}`));
    const handler = async (args: unknown, extra: unknown): Promise<{
      content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: 'image/png'; data: string }>;
      isError?: boolean;
    }> => {
      const signal = extra && typeof extra === 'object' ? (extra as { signal?: AbortSignal }).signal : undefined;
      const result = await gateway.invoke(engineName, args, {
        id: `mcp-${++approvalSeq}`,
        approvalName: claudeEngineToolName(tool.id),
        signal
      });
      if (result.image) {
        let projection: Awaited<ReturnType<typeof projectClaudeDesktopImage>>;
        try { projection = await projectClaudeDesktopImage(result.image, result.text); }
        catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Desktop screenshot projection failed.' }], isError: true }; }
        let current = false;
        try { current = result.imageCurrent?.() === true && (deps.isCurrent?.() ?? true) && !signal?.aborted; } catch { /* revoked */ }
        if (!result.ok || !current) return { content: [{ type: 'text', text: 'Desktop screenshot authorization changed.' }], isError: true };
        return { content: [{ type: 'text', text: result.text }, { type: 'text', text: JSON.stringify({ imageView: projection.dimensions,
          actionCoordinates: 'Convert image pixels to capture pixels: x *= captureWidth / width; y *= captureHeight / height.' }) }, projection.image] };
      }
      return { content: [{ type: 'text', text: result.text }], ...(result.ok ? {} : { isError: true }) };
    };
    tools.push(
      sdk.tool(
        engineName,
        tool.description || tool.label,
        shape as Parameters<typeof sdk.tool>[2],
        handler as Parameters<typeof sdk.tool>[3]
      )
    );
  }
  return sdk.createSdkMcpServer({
    name: CLAUDE_HOST_MCP_SERVER,
    tools,
    // 状态四件套/browser/问卷都是小工具：绕过 deferred tool search，常驻提示词
    alwaysLoad: true
  });
}
