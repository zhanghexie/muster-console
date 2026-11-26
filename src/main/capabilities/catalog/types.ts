/**
 * 目录基础类型与动态工具源（catalog 拆分自 catalog.ts 21-78 行）。
 * 动态源保持零相对值导入（装配处启动时注入，见下方原注释）。
 */
export const CATALOG_VERSION = '1.65.0';

export interface ToolDef {
  /** Catalog 名，带点：group.action */
  name: string;
  description: string;
  /**
   * 目录索引用的一句话简介；省略时取 description 首句。
   * 摘要字段：目录/Available tools 行内只给一句话（渐进式披露沿技能文档，R5 后无发现层）。
   */
  summary?: string;
  /** 危险操作：executor 强制走 ui.confirm 门 */
  dangerous: boolean;
  /**
   * 不注册进调度 Agent 的工具面（能力被其他工具覆盖）；handler 保留，UI/IPC/扩展 SDK/
   * Worker 白名单按名调用不受影响。getToolHelp 也不再列出。
   */
  schedulerHidden?: boolean;
  /** 确认框主按钮动词（如「合入」→「确认合入」） */
  confirmAction?: string;
  /** 参数人话摘要；缺省则 key: value 罗列 */
  confirmSummary?: (args: Record<string, unknown>) => string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
    oneOf?: Record<string, unknown>[];
    required?: string[];
  };
}

// ---------- 动态工具来源（装配处启动时注入；保持本模块零相对值导入） ----------

export interface DynamicToolEntry {
  def: ToolDef;
  /** TOFU 内容指纹是否与信任记录一致；false 时 executor 执行前强制确认 */
  trusted: boolean;
}

type DynamicSourceFn = () => DynamicToolEntry[];
let dynamicSource: DynamicSourceFn = () => [];

export function setDynamicToolSource(src: DynamicSourceFn | null): void {
  dynamicSource = src ?? (() => []);
}

export function dynamicToolEntries(): DynamicToolEntry[] {
  try {
    return dynamicSource();
  } catch {
    return [];
  }
}

export function dynamicDefs(): ToolDef[] {
  return dynamicToolEntries().map((e) => e.def);
}

/** 组间共享参数（原 catalog.ts 私有常量，拆分后供 sessions/terminal 组文件复用；不对 catalog.ts 垫片再导出） */
export const sessionIdProp = {
  sessionId: {
    type: 'string',
    description:
      'Host UUID, >=8-char prefix or absolute worktree path; bound Workers may omit.'
  }
};
