/**
 * GUI Worker 会话工具面的常驻过滤（R5：发现层退役——tools.search/tools.call 退出工具面，
 * 常驻清单即模型全部可用面）。保留两类工具：Worker 常驻清单内的宿主工具，以及不带
 * hostTools 元数据的原生注册（引擎侧通道工具、modes.* 等）。
 * 完整执行器保持私有；本过滤不改变任何工具的执行路径。
 */
import { getHostToolMeta } from '../../../shared/hostTools';
import { residentHostToolIds } from '../../../shared/toolDiscovery';
import type { GuiHostTool } from '../types';

export function filterResidentHostTools(candidates: GuiHostTool[]): GuiHostTool[] {
  return candidates.filter(tool => residentHostToolIds('worker').includes(tool.id) || !getHostToolMeta(tool.id));
}
