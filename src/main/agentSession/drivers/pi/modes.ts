import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
/**
 * Pi 自定义模式库（pi 创造模式的数据面）。
 *
 * - 内置模式（trust=system，id 不可占用/改/删）：
 *   - `creator`：创作引导 + modes.* 宿主工具；
 *   - `explore`：只读探索（native=read/bash + bash 只读白名单），结论报告；
 *   - `judge`：验收判定（只读 ∪ test/typecheck/build），结构化 PASS/FAIL（预留视觉验收接缝）；
 * - 用户模式：<userDataDir>/agents/pi/modes/<id>.json，一文件一模式，落盘即可选
 *   （与 DSH 自建 preset 的「创作即进 roster」语义对齐，但不需要子进程/junction）。
 *
 * 模式只携带 persona/配置（会话系统提示追加段 + 工具面开关），挂载点在 Host 侧：
 * connect 时 Host 把 persona 并进 systemPromptAppend、creator 模式额外注册 modes.* 工具，
 * pi driver 零改动。本模块参数化根目录、零工程内依赖，可被测试直接转译导入。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PiModeInfo {
  id: string;
  /** 显示名（缺省回落 id） */
  name: string;
  description: string;
  /** 内置模式不可改删；用户模式可 update/delete */
  trust: 'system' | 'user';
  /** 展示排序：内置靠前，用户模式按名称 */
  order: number;
  /** 展示级健康标记（JSON 解析失败/字段缺失） */
  broken: string | undefined;
}

/** 模式定义（落盘/物化用；info 是它的展示投影） */
export interface PiModeDef {
  id: string;
  name: string;
  description: string;
  /** 行为指令：会话系统提示的追加段（进引擎不进 UI） */
  persona: string;
  /**
   * 工具面裁剪（缺省=全量）：
   * - native：引擎原生工具白名单（read/write/edit/bash 子集）；
   * - nativeDeny：引擎原生工具黑名单（与 native 白名单互补，excludeTools 语义，后应用）；
   * - hostDeny：宿主工具黑名单（点号名精确匹配，如 ui.notify / bgtasks.spawn / mcp）。
   * - exclude：任意工具名黑名单（createAgentSession 的 excludeTools，含扩展/自定义工具，最后应用）。
   * host 用黑名单是刻意的：未来新增宿主工具时旧模式自动带上，不静默缩水。
   */
  tools?: { native?: string[]; nativeDeny?: string[]; hostDeny?: string[]; exclude?: string[] };
  /** 思考档位覆盖（reasoning 模型缺省 medium，非 reasoning 缺省 off） */
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 钉住模型（缺省沿用全局激活配置；未给的一侧回落全局） */
  model?: { providerId?: string; modelId?: string };
  /** 选中该模式时的默认会话权限档（不设=保持现状） */
  defaultGuiMode?: 'default' | 'ask' | 'plan' | 'auto';
  /** 替换 pi 原生基底系统提示（GUI 政策层/行为规约/persona 仍追加在其后） */
  systemPrompt?: string;
  /** 是否加载 AGENTS.md/CLAUDE.md 等上下文文件（缺省 true） */
  contextFiles?: boolean;
  /** 旧字段保留兼容；Pi 仅发现全局/项目 .agents/skills，传入时告警而不扩展来源。 */
  skillsPaths?: string[];
  /** 附加 prompt 模板根路径（提供即开启 pi 模板发现；GUI 会话缺省关闭模板） */
  promptPaths?: string[];
  /** 采样温度（经 provider 请求钩子注入 payload；缺省不动） */
  temperature?: number;
  /** 额外/覆盖的 provider 请求头（缺省不动） */
  providerHeaders?: Record<string, string>;
  /**
   * 硬守卫（tool_call 钩子引擎级拦截，比 persona 的软约束硬）：
   * - bashReadOnly：bash 只读白名单（与 ask/plan 同源 isReadOnlyShellCommand）；
   * - bashAllow：bash 额外放行正则（与 bashReadOnly OR，如 test/typecheck/build；
   *   链式命令逐段判定，每段都需命中）；
   * - bashDeny：命令黑名单（正则字符串，命中 bash 工具的 command 即拒——实现只拦 bash 工具名，
   *   不含 pwsh；白名单之后）；
   * - denyPaths：写路径保护（write/edit 的 path 包含该子串即拒，不区分大小写）。
   */
  guards?: {
    bashDeny?: string[];
    denyPaths?: string[];
    bashReadOnly?: boolean;
    bashAllow?: string[];
  };
  /**
   * 回合前动态注入（before_agent_start 钩子）：每轮代理启动时把模板渲染后追加到
   * 本轮系统提示。支持占位符 {{now}}（本地日期时间）、{{date}}、{{time}}、{{cwd}}。
   */
  turnInject?: string;
  /**
   * stable snapshot 注入（须配 turnInject）：同一天内逐字节复用同一份渲染结果（翻日才重渲染），
   * 保 provider prompt/KV 前缀缓存命中；代价是 {{time}}/{{now}} 里的时间只到「天」粒度新鲜。
   * 缺省 false=每轮重渲染（时间分钟级新鲜，但每轮打爆前缀缓存）。
   */
  turnInjectStable?: boolean;
  /**
   * 输入变换规则（Host 侧发送前按序应用，先于引擎）：pattern 为正则，
   * replacement 为替换文本（可用 $1 等捕获组引用）。
   */
  inputTransforms?: Array<{ pattern: string; replacement: string }>;
  /** 上下文瘦身（context 钩子）：toolResult 文本块超过上限即截断 */
  contextTrim?: { maxToolResultChars?: number };
  /**
   * 自定义扩展路径（TS 模块，jiti 加载；可注册工具/命令/provider/压缩钩子等一切扩展能力）。
   * ⚠️ 扩展以宿主进程权限执行任意代码——只放自己写的或可信来源的模块。
   */
  extensions?: string[];
  /** 自定义主题路径（TUI 主题；宿主 GUI 下基本无效果，为完整性开放） */
  themes?: string[];
  /** 可切换模型集（模型循环用；须已在设置里配置） */
  scopedModels?: Array<{
    providerId: string;
    modelId: string;
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }>;
  /**
   * pi 原生 settings 透传（SettingsManager.inMemory）——模式级覆盖 pi 全部设置面：
   * compaction（enabled/reserveTokens/keepRecentTokens）、retry（enabled/maxRetries/…）、
   * shellPath/shellCommandPrefix、steeringMode/followUpMode、images.autoResize、
   * thinkingBudgets、enabledModels 等。键值不校验语义，pi 自行忽略未知键。
   */
  piSettings?: Record<string, unknown>;
}

const MODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 40;
const DESC_MAX = 200;
const PERSONA_MAX = 8000;
const SYSTEM_PROMPT_MAX = 100_000;
const NATIVE_TOOLS = ['read', 'write', 'edit', 'bash'] as const;
const HOST_TOOL_ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const GUI_MODES = ['default', 'ask', 'plan', 'auto'] as const;
const HEADER_NAME_RE = /^[a-zA-Z0-9-]+$/;

/** 内置创造模式的会话内引导（发给 LLM 的提示词数据，有意不翻） */
const CREATOR_PERSONA = `你正处于「创造模式」：职责是帮用户创作可复用的自定义模式（persona 型 agent 配置），并用 modes.* 工具落盘。

工具：
- modes.list：列出全部可选模式（含内置）。
- modes.create：新建模式，参数 {id, name, description, persona}。
- modes.update / modes.delete：修改/删除用户自建模式（内置模式不可改删）。

创作规约：
1. 先 modes.list 了解既有模式，避免重复造轮子或重名。
2. id 用小写字母/数字/连字符，字母或数字开头（如 code-review、tutorial）。
3. persona 是模式的灵魂：写清该模式下 agent 的工作方式、口吻、优先级与边界；具体、可执行、避免空话，建议 10 条以内。
4. 可选配面很宽（工具裁剪/思考档/钉模型/权限档/系统提示替换/上下文文件与 skill/模板路径/请求参数/硬守卫/回合注入/输入变换/上下文瘦身/自定义扩展/主题/可切换模型集/pi 设置透传等），完整定义以 modes.create 的参数 schema 为准；不传=沿用全局。
5. name 用简短中文名；description 一句话说清适用场景（会显示在模式菜单里）。
6. 动手前先与用户确认模式定位；落盘后告知「新开会话即可在模式菜单选择」。
7. 新模式对已开始的会话不生效（模式在会话首建时挂载）；当前会话仍是创造模式。
8. 不批量堆砌：每个模式都应有明确的差异化定位，用户不要就停。
9. extensions 会以宿主进程权限执行任意代码：只引用可信来源的模块，并在创建前向用户明确说明将加载哪些扩展。`;

/** 探索模式：结论导向，扫文件给结论，不贴大段原文 */
const EXPLORE_PERSONA = `你正处于「探索模式」：只读探索代码与仓库，产出结论报告。

工具边界（硬守卫已生效，越界会被拦截）：
- 仅有 read 与 bash；bash 仅允许只读命令（查看/搜索：ls/cat/grep/rg/find/git status|diff|log 等）。
- 禁止改文件、禁止安装依赖、禁止跑会改仓库状态的命令。

工作方式：
1. 带着问题扫结构与入口，快速定位相关文件与数据流。
2. 结论导向：先给判断与要点，必要时再点名关键文件:行；不要大段粘贴原文。
3. 最终产出「结论报告」：问题 / 结论 / 证据路径 / 不确定点；短、可行动。`;

/**
 * 验收判定：逐项 PASS/FAIL + 证据。visualGate 字段为后续视觉验收门预留接缝
 * （本模式不截图，填 pending；视觉门接入后可写 pass/fail/skip）。
 */
const JUDGE_PERSONA = `你正处于「验收判定」模式：对照验收项逐项判定 PASS/FAIL，并给出可复核证据。

工具边界（硬守卫已生效）：
- 仅有 read 与 bash；bash = 只读命令 ∪ 测试/类型检查/构建（npm test、npm run test*、typecheck、build 等）。
- 禁止改业务源码；不要手改文件去「刷绿」。

工作方式：
1. 先读清验收清单（任务描述 / 测试计划 / 变更说明）。
2. 逐项执行：读代码或跑对应验证命令，收集证据。
3. 输出结构化判定（固定格式，便于后续门消费）：

## 判定结果
| 项 | 判定 | 证据 |
|---|---|---|
| … | PASS 或 FAIL | 命令摘要或 file:line |

- 总结：通过数 / 失败数 / 阻塞项
- 视觉验收（预留接缝）：visualGate=pending（本模式不截图；后续视觉验收门可填 pass/fail/skip）

FAIL 时说明缺什么证据或差在哪；不要替用户改代码。`;

/** 验收模式 bash 额外放行：test / typecheck / build（与 bashReadOnly OR） */
const JUDGE_BASH_ALLOW = [
  String.raw`^\s*npm(\.cmd)?\s+test\b`,
  String.raw`^\s*npm(\.cmd)?\s+run\s+\S*(test|typecheck|build)\S*`,
  String.raw`^\s*npx(\.cmd)?\s+(vitest|tsc)\b`
];

const BUILTIN_MODES: PiModeDef[] = [
  {
    id: 'creator',
    name: '创造模式',
    description: '用 modes.* 工具创作自定义模式（人格/行为指令），新模式立即可选',
    persona: CREATOR_PERSONA
  },
  {
    id: 'explore',
    name: '探索模式',
    description: '只读探索：扫代码给结论报告（bash 只读白名单，不改文件）',
    persona: EXPLORE_PERSONA,
    tools: { native: ['read', 'bash'] },
    guards: { bashReadOnly: true },
    defaultGuiMode: 'ask'
  },
  {
    id: 'judge',
    name: '验收判定',
    description: '验收官：逐项 PASS/FAIL 带证据（只读 + test/typecheck/build）',
    persona: JUDGE_PERSONA,
    tools: { native: ['read', 'bash'] },
    guards: { bashReadOnly: true, bashAllow: JUDGE_BASH_ALLOW }
  }
];

/** 内置模式 id 列表（bgtasks.spawn 等可发现性文案的单源） */
export function builtinPiModeIds(): string[] {
  return BUILTIN_MODES.map((m) => m.id);
}

/** 用户模式根：<userDataDir>/agents/pi/modes */
export function piModesDir(userDataDir: string): string {
  return userDataStorage(userDataDir).resolve('app', 'pi-modes');
}

export function isPiCreatorMode(modeId: string | undefined): boolean {
  return modeId === 'creator';
}

/** 内置模式定义（无则 null） */
export function builtinPiMode(id: string): PiModeDef | null {
  return BUILTIN_MODES.find((m) => m.id === id) ?? null;
}

function readUserModeFile(file: string, id: string): { info: PiModeInfo; def: PiModeDef | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      info: { id, name: id, description: '', trust: 'user', order: 100, broken: `JSON 解析失败: ${(e as Error).message}` },
      def: null
    };
  }
  const rec = (parsed ?? {}) as Record<string, unknown>;
  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name : id;
  const description = typeof rec.description === 'string' ? rec.description : '';
  const personaOk = typeof rec.persona === 'string' && rec.persona.trim().length > 0;
  const opt = pickOptionalFields(rec);
  const def: PiModeDef | null = personaOk
    ? { id, name, description, persona: rec.persona as string, ...opt }
    : null;
  // 盘上恢复的字段同样要过校验：手改文件写出枚举外的 thinkingLevel / 非法 native
  // 子集时静默透传会污染引擎调用（如 native:["deploy"] 过滤后原生工具全没了）
  if (def) {
    const verr = validatePiModeInput(def, { idRequired: true });
    if (verr) {
      return {
        def: null,
        info: { id, name, description, trust: 'user', order: 100, broken: `字段校验失败: ${verr}` }
      };
    }
  }
  return {
    def,
    info: {
      id,
      name,
      description,
      trust: 'user',
      order: 100,
      broken: personaOk ? undefined : 'persona 缺失或为空'
    }
  };
}

/**
 * 列出可选模式：内置（creator/explore/judge）+ 用户目录，先到先得（同名 id 时内置遮蔽用户文件，
 * 与 DSH system 根遮蔽用户根一致）。
 */
export function listPiModes(userDataDir: string): PiModeInfo[] {
  const byId = new Map<string, PiModeInfo>();
  for (const m of BUILTIN_MODES) {
    byId.set(m.id, {
      id: m.id,
      name: m.name,
      description: m.description,
      trust: 'system',
      order: 1,
      broken: undefined
    });
  }
  const root = piModesDir(userDataDir);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    dirents = []; // 根不存在（首条自建模式落盘前）是常态
  }
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue; // 一文件一模式；非法文件名跳过
    const id = d.name.slice(0, -'.json'.length);
    if (!MODE_ID_RE.test(id)) continue; // 非可用 id 的文件直接跳过（与 dsh roster 同款）
    const { info } = readUserModeFile(path.join(root, d.name), id);
    if (!byId.has(id)) byId.set(id, info);
  }
  return [...byId.values()].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name, 'zh-Hans-CN')
  );
}

/** 读模式定义（内置优先；缺失/损坏返回 null） */
export function readPiMode(userDataDir: string, id: string): PiModeDef | null {
  const builtin = builtinPiMode(id);
  if (builtin) return builtin;
  if (!MODE_ID_RE.test(id)) return null;
  const file = path.join(piModesDir(userDataDir), `${id}.json`);
  try {
    return readUserModeFile(file, id).def;
  } catch {
    return null;
  }
}

/** 校验模式入参；返回错误文案（null=通过）。existingId 传更新目标以区分「重名=自己」 */
export function validatePiModeInput(
  input: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    persona?: unknown;
    tools?: unknown;
    thinkingLevel?: unknown;
    model?: unknown;
    defaultGuiMode?: unknown;
    systemPrompt?: unknown;
    contextFiles?: unknown;
    skillsPaths?: unknown;
    promptPaths?: unknown;
    temperature?: unknown;
    providerHeaders?: unknown;
    guards?: unknown;
    turnInject?: unknown;
    turnInjectStable?: unknown;
    inputTransforms?: unknown;
    contextTrim?: unknown;
    extensions?: unknown;
    themes?: unknown;
    scopedModels?: unknown;
    piSettings?: unknown;
  },
  opts?: { idRequired?: boolean }
): string | null {
  const id = input.id;
  if (opts?.idRequired || id !== undefined) {
    if (typeof id !== 'string' || !MODE_ID_RE.test(id)) {
      return 'id 须为小写字母/数字/连字符，且字母或数字开头';
    }
  }
  const name = input.name;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX)) {
    return `name 须为 1-${NAME_MAX} 字`;
  }
  const description = input.description;
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > DESC_MAX)
  ) {
    return `description 须为不超过 ${DESC_MAX} 字的字符串`;
  }
  const persona = input.persona;
  if (
    persona !== undefined &&
    (typeof persona !== 'string' || !persona.trim() || persona.length > PERSONA_MAX)
  ) {
    return `persona 须为 1-${PERSONA_MAX} 字的行为指令文本`;
  }
  const tools = input.tools as
    | { native?: unknown; nativeDeny?: unknown; hostDeny?: unknown; exclude?: unknown }
    | null
    | undefined;
  if (tools !== undefined && tools !== null && typeof tools === 'object') {
    if (tools.native !== undefined) {
      if (
        !Array.isArray(tools.native) ||
        tools.native.length === 0 ||
        tools.native.some((t) => !(NATIVE_TOOLS as readonly unknown[]).includes(t))
      ) {
        // 空数组必须是「全禁」而不是「全放」：消费端用 .length 判空会反转语义，干脆禁止
        return `tools.native 须为 ${NATIVE_TOOLS.join('/')} 的非空子集（全禁个别工具用 nativeDeny/exclude）`;
      }
    }
    if (tools.nativeDeny !== undefined) {
      if (
        !Array.isArray(tools.nativeDeny) ||
        tools.nativeDeny.some((t) => !(NATIVE_TOOLS as readonly unknown[]).includes(t))
      ) {
        return `tools.nativeDeny 只能是 ${NATIVE_TOOLS.join('/')} 的子集`;
      }
    }
    if (tools.exclude !== undefined) {
      if (
        !Array.isArray(tools.exclude) ||
        tools.exclude.some((t) => typeof t !== 'string' || !t.trim())
      ) {
        return 'tools.exclude 须为非空工具名数组';
      }
    }
    if (tools.hostDeny !== undefined) {
      if (
        !Array.isArray(tools.hostDeny) ||
        tools.hostDeny.some((t) => typeof t !== 'string' || !HOST_TOOL_ID_RE.test(t as string))
      ) {
        return 'tools.hostDeny 须为宿主工具点号 id 数组（如 ui.notify、bgtasks.spawn、mcp）';
      }
    }
  } else if (tools !== undefined && tools !== null) {
    return 'tools 须为对象（{native?, nativeDeny?, hostDeny?, exclude?}）';
  }
  const thinkingLevel = input.thinkingLevel;
  if (
    thinkingLevel !== undefined &&
    !(THINKING_LEVELS as readonly unknown[]).includes(thinkingLevel)
  ) {
    return `thinkingLevel 只能是 ${THINKING_LEVELS.join('/')}`;
  }
  const model = input.model as { providerId?: unknown; modelId?: unknown } | null | undefined;
  if (model !== undefined && model !== null && typeof model === 'object') {
    if (
      (model.providerId !== undefined && typeof model.providerId !== 'string') ||
      (model.modelId !== undefined && typeof model.modelId !== 'string')
    ) {
      return 'model.providerId / model.modelId 须为字符串';
    }
    if (!model.providerId && !model.modelId) return 'model 至少给 providerId 或 modelId 之一';
  } else if (model !== undefined && model !== null) {
    return 'model 须为对象（{providerId?, modelId?}）';
  }
  const defaultGuiMode = input.defaultGuiMode;
  if (
    defaultGuiMode !== undefined &&
    !(GUI_MODES as readonly unknown[]).includes(defaultGuiMode)
  ) {
    return `defaultGuiMode 只能是 ${GUI_MODES.join('/')}`;
  }
  const systemPrompt = input.systemPrompt;
  if (
    systemPrompt !== undefined &&
    (typeof systemPrompt !== 'string' || !systemPrompt.trim() || systemPrompt.length > SYSTEM_PROMPT_MAX)
  ) {
    return `systemPrompt 须为 1-${SYSTEM_PROMPT_MAX} 字的提示词文本`;
  }
  if (input.contextFiles !== undefined && typeof input.contextFiles !== 'boolean') {
    return 'contextFiles 须为布尔值';
  }
  for (const key of ['skillsPaths', 'promptPaths'] as const) {
    const paths = input[key];
    if (
      paths !== undefined &&
      (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.trim()))
    ) {
      return `${key} 须为非空字符串数组（目录路径）`;
    }
  }
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== 'number' || Number.isNaN(input.temperature) || input.temperature < 0 || input.temperature > 2)
  ) {
    return 'temperature 须为 0-2 的数字';
  }
  const providerHeaders = input.providerHeaders;
  if (providerHeaders !== undefined) {
    if (typeof providerHeaders !== 'object' || providerHeaders === null || Array.isArray(providerHeaders)) {
      return 'providerHeaders 须为 {请求头名: 值} 对象';
    }
    for (const [k, v] of Object.entries(providerHeaders)) {
      if (!HEADER_NAME_RE.test(k) || typeof v !== 'string') {
        return `providerHeaders 的键须为合法请求头名、值须为字符串（问题键: ${k}）`;
      }
    }
  }
  const guards = input.guards as
    | {
        bashDeny?: unknown;
        denyPaths?: unknown;
        bashReadOnly?: unknown;
        bashAllow?: unknown;
      }
    | null
    | undefined;
  if (guards !== undefined && guards !== null && typeof guards === 'object') {
    if (guards.bashDeny !== undefined) {
      if (!Array.isArray(guards.bashDeny)) return 'guards.bashDeny 须为正则字符串数组';
      for (const p of guards.bashDeny) {
        if (typeof p !== 'string' || !p.trim()) return 'guards.bashDeny 须为非空正则字符串数组';
        try {
          new RegExp(p);
        } catch (e) {
          return `guards.bashDeny 含无法编译的正则「${p}」: ${(e as Error).message}`;
        }
      }
    }
    if (guards.denyPaths !== undefined) {
      if (
        !Array.isArray(guards.denyPaths) ||
        guards.denyPaths.some((p) => typeof p !== 'string' || !p.trim())
      ) {
        return 'guards.denyPaths 须为非空字符串数组（路径子串）';
      }
    }
    if (guards.bashReadOnly !== undefined && typeof guards.bashReadOnly !== 'boolean') {
      return 'guards.bashReadOnly 须为布尔值';
    }
    if (guards.bashAllow !== undefined) {
      if (!Array.isArray(guards.bashAllow)) return 'guards.bashAllow 须为正则字符串数组';
      for (const p of guards.bashAllow) {
        if (typeof p !== 'string' || !p.trim()) return 'guards.bashAllow 须为非空正则字符串数组';
        try {
          new RegExp(p);
        } catch (e) {
          return `guards.bashAllow 含无法编译的正则「${p}」: ${(e as Error).message}`;
        }
      }
    }
  } else if (guards !== undefined && guards !== null) {
    return 'guards 须为对象（{bashDeny?, denyPaths?, bashReadOnly?, bashAllow?}）';
  }
  if (input.turnInject !== undefined) {
    if (typeof input.turnInject !== 'string' || input.turnInject.length > 4000) {
      return 'turnInject 须为不超过 4000 字的模板文本';
    }
  }
  if (input.turnInjectStable !== undefined && typeof input.turnInjectStable !== 'boolean') {
    return 'turnInjectStable 须为布尔值';
  }
  const inputTransforms = input.inputTransforms;
  if (inputTransforms !== undefined) {
    if (!Array.isArray(inputTransforms) || inputTransforms.length > 20) {
      return 'inputTransforms 须为不超过 20 条的规则数组';
    }
    for (const rule of inputTransforms as Array<{ pattern?: unknown; replacement?: unknown }>) {
      if (!rule || typeof rule !== 'object') return 'inputTransforms 每条须为 {pattern, replacement}';
      if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) {
        return 'inputTransforms 的 pattern 须为非空正则字符串';
      }
      try {
        new RegExp(rule.pattern);
      } catch (e) {
        return `inputTransforms 含无法编译的正则「${rule.pattern}」: ${(e as Error).message}`;
      }
      if (typeof rule.replacement !== 'string') return 'inputTransforms 的 replacement 须为字符串';
    }
  }
  const contextTrim = input.contextTrim as { maxToolResultChars?: unknown } | null | undefined;
  if (contextTrim !== undefined && contextTrim !== null && typeof contextTrim === 'object') {
    const max = contextTrim.maxToolResultChars;
    if (
      max !== undefined &&
      (typeof max !== 'number' || !Number.isFinite(max) || max < 200 || max > 100_000)
    ) {
      return 'contextTrim.maxToolResultChars 须为 200-100000 的数字';
    }
  } else if (contextTrim !== undefined && contextTrim !== null) {
    return 'contextTrim 须为对象（{maxToolResultChars?}）';
  }
  for (const key of ['extensions', 'themes'] as const) {
    const paths = input[key];
    if (
      paths !== undefined &&
      (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.trim()))
    ) {
      return `${key} 须为非空字符串数组（文件或目录路径）`;
    }
  }
  const scopedModels = input.scopedModels;
  if (scopedModels !== undefined) {
    if (!Array.isArray(scopedModels) || scopedModels.length > 32) {
      return 'scopedModels 须为不超过 32 条的数组';
    }
    for (const entry of scopedModels as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== 'object') return 'scopedModels 每条须为对象';
      if (typeof entry.providerId !== 'string' || !entry.providerId.trim()) {
        return 'scopedModels 每条须带非空 providerId';
      }
      if (typeof entry.modelId !== 'string' || !entry.modelId.trim()) {
        return 'scopedModels 每条须带非空 modelId';
      }
      if (
        entry.thinkingLevel !== undefined &&
        !(THINKING_LEVELS as readonly unknown[]).includes(entry.thinkingLevel)
      ) {
        return `scopedModels 的 thinkingLevel 只能是 ${THINKING_LEVELS.join('/')}`;
      }
    }
  }
  const piSettings = input.piSettings;
  if (piSettings !== undefined) {
    if (typeof piSettings !== 'object' || piSettings === null || Array.isArray(piSettings)) {
      return 'piSettings 须为 {键: 值} 对象（pi 原生 settings）';
    }
    try {
      if (JSON.stringify(piSettings).length > 65_536) return 'piSettings 序列化后超过 64KB';
    } catch {
      return 'piSettings 须可 JSON 序列化';
    }
  }
  return null;
}

/** 新建用户模式；id 与内置/既有冲突即拒绝。返回错误文案（null=成功） */
export function createPiMode(
  userDataDir: string,
  input: PiModeDef
): string | null {
  if (!MODE_ID_RE.test(input.id)) return 'id 须为小写字母/数字/连字符，且字母或数字开头';
  if (builtinPiMode(input.id)) return `id「${input.id}」是内置模式，不可占用`;
  const err = validatePiModeInput(input, { idRequired: true });
  if (err) return err;
  const file = path.join(piModesDir(userDataDir), `${input.id}.json`);
  if (fs.existsSync(file)) return `模式「${input.id}」已存在（更新请用 modes.update）`;
  fs.mkdirSync(piModesDir(userDataDir), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...input, name: input.name.trim(), updatedAt: new Date().toISOString() },
      null,
      2
    ),
    'utf8'
  );
  return null;
}

/** 从磁盘记录恢复可选配字段（字段缺失/类型不对即视为未设置） */
function pickOptionalFields(prev: Record<string, unknown>): Omit<PiModeDef, 'id' | 'name' | 'description' | 'persona'> {
  const out: Omit<PiModeDef, 'id' | 'name' | 'description' | 'persona'> = {};
  if (prev.tools && typeof prev.tools === 'object') out.tools = prev.tools as PiModeDef['tools'];
  if (typeof prev.thinkingLevel === 'string') out.thinkingLevel = prev.thinkingLevel as PiModeDef['thinkingLevel'];
  if (prev.model && typeof prev.model === 'object') out.model = prev.model as PiModeDef['model'];
  if (typeof prev.defaultGuiMode === 'string') out.defaultGuiMode = prev.defaultGuiMode as PiModeDef['defaultGuiMode'];
  if (typeof prev.systemPrompt === 'string') out.systemPrompt = prev.systemPrompt;
  if (typeof prev.contextFiles === 'boolean') out.contextFiles = prev.contextFiles;
  if (Array.isArray(prev.skillsPaths)) out.skillsPaths = prev.skillsPaths as string[];
  if (Array.isArray(prev.promptPaths)) out.promptPaths = prev.promptPaths as string[];
  if (typeof prev.temperature === 'number') out.temperature = prev.temperature;
  if (prev.providerHeaders && typeof prev.providerHeaders === 'object') {
    out.providerHeaders = prev.providerHeaders as Record<string, string>;
  }
  if (prev.guards && typeof prev.guards === 'object') out.guards = prev.guards as PiModeDef['guards'];
  if (typeof prev.turnInject === 'string') out.turnInject = prev.turnInject;
  if (typeof prev.turnInjectStable === 'boolean') out.turnInjectStable = prev.turnInjectStable;
  if (Array.isArray(prev.inputTransforms)) out.inputTransforms = prev.inputTransforms as PiModeDef['inputTransforms'];
  if (prev.contextTrim && typeof prev.contextTrim === 'object') out.contextTrim = prev.contextTrim as PiModeDef['contextTrim'];
  if (Array.isArray(prev.extensions)) out.extensions = prev.extensions as string[];
  if (Array.isArray(prev.themes)) out.themes = prev.themes as string[];
  if (Array.isArray(prev.scopedModels)) out.scopedModels = prev.scopedModels as PiModeDef['scopedModels'];
  if (prev.piSettings && typeof prev.piSettings === 'object') out.piSettings = prev.piSettings as Record<string, unknown>;
  return out;
}

/** 更新用户模式（内置不可改）；patch 缺省字段保留原值。返回错误文案（null=成功） */
export function updatePiMode(
  userDataDir: string,
  id: string,
  patch: Partial<Omit<PiModeDef, 'id'>>
): string | null {
  if (builtinPiMode(id)) return '内置模式不可修改';
  if (!MODE_ID_RE.test(id)) return '非法模式 id';
  const err = validatePiModeInput({ ...patch, id });
  if (err) return err;
  const file = path.join(piModesDir(userDataDir), `${id}.json`);
  if (!fs.existsSync(file)) return `模式「${id}」不存在`;
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return '既有模式文件损坏（JSON 解析失败），请删除后重建';
  }
  const prevOpt = pickOptionalFields(prev);
  const next: PiModeDef = {
    id,
    name: typeof patch.name === 'string' ? patch.name : String(prev.name ?? id),
    description:
      typeof patch.description === 'string' ? patch.description : String(prev.description ?? ''),
    persona: typeof patch.persona === 'string' ? patch.persona : String(prev.persona ?? ''),
    tools: patch.tools !== undefined ? patch.tools : prevOpt.tools,
    thinkingLevel: patch.thinkingLevel !== undefined ? patch.thinkingLevel : prevOpt.thinkingLevel,
    model: patch.model !== undefined ? patch.model : prevOpt.model,
    defaultGuiMode:
      patch.defaultGuiMode !== undefined ? patch.defaultGuiMode : prevOpt.defaultGuiMode,
    systemPrompt: patch.systemPrompt !== undefined ? patch.systemPrompt : prevOpt.systemPrompt,
    contextFiles: patch.contextFiles !== undefined ? patch.contextFiles : prevOpt.contextFiles,
    skillsPaths: patch.skillsPaths !== undefined ? patch.skillsPaths : prevOpt.skillsPaths,
    promptPaths: patch.promptPaths !== undefined ? patch.promptPaths : prevOpt.promptPaths,
    temperature: patch.temperature !== undefined ? patch.temperature : prevOpt.temperature,
    providerHeaders:
      patch.providerHeaders !== undefined ? patch.providerHeaders : prevOpt.providerHeaders,
    guards: patch.guards !== undefined ? patch.guards : prevOpt.guards,
    turnInject: patch.turnInject !== undefined ? patch.turnInject : prevOpt.turnInject,
    turnInjectStable:
      patch.turnInjectStable !== undefined ? patch.turnInjectStable : prevOpt.turnInjectStable,
    inputTransforms:
      patch.inputTransforms !== undefined ? patch.inputTransforms : prevOpt.inputTransforms,
    contextTrim: patch.contextTrim !== undefined ? patch.contextTrim : prevOpt.contextTrim,
    extensions: patch.extensions !== undefined ? patch.extensions : prevOpt.extensions,
    themes: patch.themes !== undefined ? patch.themes : prevOpt.themes,
    scopedModels: patch.scopedModels !== undefined ? patch.scopedModels : prevOpt.scopedModels,
    piSettings: patch.piSettings !== undefined ? patch.piSettings : prevOpt.piSettings
  };
  if (!String(next.persona).trim()) return 'persona 不可为空';
  fs.writeFileSync(
    file,
    JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  return null;
}

/** 删除用户模式（内置不可删）。返回错误文案（null=成功） */
export function deletePiMode(userDataDir: string, id: string): string | null {
  if (builtinPiMode(id)) return '内置模式不可删除';
  if (!MODE_ID_RE.test(id)) return '非法模式 id';
  const file = path.join(piModesDir(userDataDir), `${id}.json`);
  try {
    fs.unlinkSync(file);
  } catch {
    return `模式「${id}」不存在或已删除`;
  }
  return null;
}

/** pi 模式定义 → GuiDriverConnectInput 的 pi 专属附加段（host 连接与后台子代理共用的单源映射） */
export function piModeConnectExtras(mode: PiModeDef | null | undefined) {
  if (!mode) return {};
  return {
    nativeTools: mode.tools?.native,
    nativeToolsDeny: mode.tools?.nativeDeny,
    thinkingLevel: mode.thinkingLevel,
    ...(mode.model ? { modelOverride: { ...mode.model } } : {}),
    ...(mode.systemPrompt ? { systemPromptReplace: mode.systemPrompt } : {}),
    ...(mode.contextFiles !== undefined ? { contextFiles: mode.contextFiles } : {}),
    ...(mode.skillsPaths?.length ? { skillsPaths: mode.skillsPaths } : {}),
    ...(mode.promptPaths?.length ? { promptPaths: mode.promptPaths } : {}),
    ...(mode.temperature !== undefined ? { temperature: mode.temperature } : {}),
    ...(mode.providerHeaders ? { providerHeaders: mode.providerHeaders } : {}),
    ...(mode.guards ? { guards: mode.guards } : {}),
    ...(mode.turnInject ? { turnInject: mode.turnInject } : {}),
    ...(mode.turnInjectStable ? { turnInjectStable: true } : {}),
    ...(mode.inputTransforms?.length ? { inputTransforms: mode.inputTransforms } : {}),
    ...(mode.contextTrim ? { contextTrim: mode.contextTrim } : {}),
    ...(mode.extensions?.length ? { extensionPaths: mode.extensions } : {}),
    ...(mode.themes?.length ? { themePaths: mode.themes } : {}),
    ...(mode.tools?.exclude?.length ? { excludeTools: mode.tools.exclude } : {}),
    ...(mode.piSettings ? { piSettings: mode.piSettings } : {})
  };
}

/** pi 引擎原生工具全集（read/write/edit/bash） */
export const PI_NATIVE_TOOL_ALL = ['read', 'write', 'edit', 'bash'] as const;

/**
 * 引擎原生工具白/黑名单过滤（driver 注册工具面与政策层目录共用的单源）。
 * nativeTools 空数组在此表现为「未设置」（创建路径已禁空数组；手改盘上文件会被
 * readUserModeFile 的校验标 broken，这里只是防御）。
 */
export function filterPiNativeTools(
  nativeAll: readonly string[],
  extras: { nativeTools?: string[]; nativeToolsDeny?: string[] }
): string[] {
  const allow = extras.nativeTools?.length
    ? nativeAll.filter((t) => extras.nativeTools!.includes(t))
    : [...nativeAll];
  return extras.nativeToolsDeny?.length
    ? allow.filter((t) => !extras.nativeToolsDeny!.includes(t))
    : allow;
}
