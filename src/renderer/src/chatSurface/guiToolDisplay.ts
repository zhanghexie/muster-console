import type { GuiToolCallView } from '../../../shared/guiWorker';
import type { ToolCallRecord } from '../../../shared/types';
import { safeJson } from './safeJson';

// renderer 的 delta/part 更新只替换目标 part，已完成工具及 input 保持不可变引用
// （applyGuiMessageDelta/applyGuiMessagePart）。不让末段正文增长重新串行化旧工具参数。
// WeakMap 随源工具生命周期释放，不保留被逐出的会话；顶层字段逐项校验也覆盖原位终态化。
const displayTools = new WeakMap<GuiToolCallView, ToolCallRecord>();

export function toDisplayToolCall(tool: GuiToolCallView): ToolCallRecord {
  const hit = displayTools.get(tool);
  const patch = tool.patch || undefined;
  if (hit && hit.id === tool.id && hit.name === tool.name && hit.input === tool.input &&
      hit.status === tool.status && hit.result === tool.output && hit.patch === patch) return hit;
  const out: ToolCallRecord = {
    id: tool.id,
    name: tool.name,
    arguments: safeJson(tool.input),
    input: tool.input,
    status: tool.status,
    ...(tool.output !== undefined ? { result: tool.output } : {}),
    ...(patch ? { patch } : {})
  };
  displayTools.set(tool, out);
  return out;
}
