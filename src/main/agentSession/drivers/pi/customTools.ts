/**
 * Host 工具 → Pi 自定义 ToolDefinition：名字点号换下划线（引擎工具名不允许点）。
 * 引擎原生 read/write/edit/bash 不经这里（SDK 原生执行，经审批扩展门控）。
 * 另附 askQuestion：接到 Host 提问卡（Pi 没有原生问卷工具）。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { GuiHostTool, GuiUserQuestionOutcome, GuiUserQuestionRequest } from '../../types';
import type { DesktopCaptureImage } from '../../../desktop/captureImageScope';

function toEngineToolName(dotName: string): string {
  return dotName.replace(/\./g, '_');
}

export function buildPiCustomTools(
  hostTools: readonly GuiHostTool[],
  sessionCtx: { sessionId: string; cwd: string },
  _requestUserQuestion?: (req: GuiUserQuestionRequest) => Promise<GuiUserQuestionOutcome>,
  extraContent?: (name: string, id: string, signal: AbortSignal | undefined, text: string) =>
    Array<{ type: 'text'; text: string } | DesktopCaptureImage>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ToolDefinition<any, any, any>[] {
  const listed = hostTools.map((tool) => ({
    name: toEngineToolName(tool.id),
    label: tool.label,
    description: tool.description,
    promptSnippet: `${tool.id}${tool.argsHint ? ` (${tool.argsHint})` : ''}`,
    // Host 工具的 parameters 是标准 JSON Schema 对象；TypeBox 校验按同一形态读取
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: tool.parameters as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined) {
      // Internal worker transport uses the native call ID to bind an approval to
      // exactly this request. In-process tools ignore the extra context field.
      const text = await tool.execute(params ?? {}, { ...sessionCtx, signal, toolCallId } as typeof sessionCtx & { signal?: AbortSignal; toolCallId: string });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = {
        content: [{ type: 'text' as const, text }, ...(extraContent?.(tool.id, toolCallId, signal, text) ?? [])],
        details: {}
      };
      return result;
    }
  }));
  return listed;
}
