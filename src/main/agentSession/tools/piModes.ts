/**
 * Pi 创造模式的会话工具：modes.list / create / update / delete。
 * 仅 creator 模式会话由 Host 挂载（registry 的 extraHostTools 通道）；写 userData 模式库。
 * 权限：list=read（auto）；写操作=edit（default 弹审批卡、auto 全自动、ask/plan 探索态拒绝）
 * ——与 DSH 自建 preset 写工作区外走审批卡对齐。
 * 例外强制门：create/update 携带 extensions（宿主进程权限任意代码）时无视权限档一律
 * 走 ui.confirm 确认卡（catalog dangerous 门同款；auto 档策略放行后的唯一拦截点），
 * 被拒不执行、如实回给模型。
 * 描述与结果文本均发给 LLM（对齐 backgroundTasks.ts 豁免）。
 */
import {
  createPiMode,
  deletePiMode,
  listPiModes,
  updatePiMode,
  type PiModeDef
} from '../drivers/pi/modes';
import type { ConfirmDialogFields, ConfirmResult } from '../../../shared/confirmDialog';
import type { GuiHostTool } from '../types';

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * extensions 确认卡通道：签名与 UiBridge.confirm 的收窄形态一致（driver 接线传入
 * ctx.ui.confirm，与 catalog dangerous 门同一确认框）；测试注入桩即可单测。
 */
export type ModesExtensionConfirm = (
  title: string,
  detail: string,
  opts?: ConfirmDialogFields
) => Promise<ConfirmResult>;

export interface PiModeToolsOptions {
  /**
   * modes.create/update 携带 extensions（宿主进程权限任意代码）时的强制确认卡通道。
   * 与权限档无关（auto 档策略表对 edit 类直接放行，唯一拦截点在本门）；未接线时
   * 携带扩展路径的调用一律拒绝（fail-closed），不静默放行。
   */
  confirmExtensions?: ModesExtensionConfirm;
}

/** args.extensions 里实际携带的扩展路径（空串/非字符串项剔除；空数组=无代码，不弹卡） */
function extensionPathsOf(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : [];
}

/** 确认卡被拒的拒绝理由（§6 语义：button/close/esc=显式否决勿重试；backdrop/timeout 可重试） */
function describeConfirmRefusal(cancelledBy: string | undefined): string {
  if (cancelledBy === 'backdrop' || cancelledBy === 'timeout') {
    return `用户未确认（cancelledBy=${cancelledBy}，可稍后再次请求确认）`;
  }
  return `用户拒绝（cancelledBy=${cancelledBy ?? 'button'}，请勿原样重试）`;
}

/**
 * extensions 强制确认门：返回 null=放行；返回字符串=拒绝原因（调用不执行、不落盘）。
 * 触发条件：args.extensions 解析出 ≥1 个扩展路径（真正要挂任意代码的形态）；
 * 空数组=清除扩展不添代码、非法形态由 createPiMode/updatePiMode 的字段校验拒绝，均不占用户一次确认。
 */
async function confirmExtensionsGate(
  confirm: ModesExtensionConfirm | undefined,
  action: 'create' | 'update',
  args: Record<string, unknown>
): Promise<string | null> {
  const paths = extensionPathsOf(args.extensions);
  if (!paths.length) return null;
  const modeId = typeof args.id === 'string' ? args.id.trim() : '';
  const actionLabel = action === 'create' ? '创建' : '更新';
  if (!confirm) {
    return `已拒绝${actionLabel}模式「${modeId}」：参数携带 extensions（宿主进程权限任意代码扩展），但当前会话未接入确认卡通道。请去掉 extensions 字段，或由用户在宿主内直接配置该模式。`;
  }
  const list = paths.map((p) => `- ${p}`).join('\n');
  const result = await confirm('模式扩展需要确认', `该模式携带宿主权限任意代码扩展：\n${list}\n仅在信任来源时确认。`, {
    dangerous: true,
    subtitle: `modes.${action}`,
    intent: `该模式携带宿主权限任意代码扩展，仅在信任来源时确认`,
    summary: `${actionLabel}模式「${modeId}」将挂载 ${paths.length} 个扩展：\n${list}`,
    confirmLabel: `确认${actionLabel}`,
    cancelLabel: '取消'
  });
  if (result && result.confirmed === true) return null;
  return `已拒绝${actionLabel}模式「${modeId}」：${describeConfirmRefusal(result?.cancelledBy)}。携带 extensions（宿主权限任意代码）的模式必须经用户逐次确认，本次调用未执行、未落盘。`;
}

/** 构建创造模式的 modes.* 宿主工具（userDataDir 参数化，测试可直接转译导入） */
export function buildPiModeTools(userDataDir: string, opts?: PiModeToolsOptions): GuiHostTool[] {
  return [
    {
      id: 'modes.list',
      label: 'modes.list',
      description: '列出全部可选的自定义模式（含内置）。创作前先调用以避免重名。',
      argsHint: '无参数',
      parameters: { type: 'object', properties: {} },
      permissionClass: 'read',
      async execute() {
        const roster = listPiModes(userDataDir);
        const lines = roster.map(
          (m) =>
            `- ${m.id}｜${m.name}｜${m.trust === 'system' ? '内置' : '自建'}${
              m.broken ? `｜损坏: ${m.broken}` : ''
            }${m.description ? `｜${m.description}` : ''}`
        );
        return `共 ${roster.length} 个模式：\n${lines.join('\n')}`;
      }
    },
    {
      id: 'modes.create',
      label: 'modes.create',
      description:
        '新建自定义模式 {id, name, description, persona}。id 为小写字母/数字/连字符；persona 是该模式的行为指令（写清工作方式/口吻/优先级/边界）。可选配：tools.native（引擎原生工具白名单，read/write/edit/bash 子集）、tools.nativeDeny（原生工具黑名单）、tools.hostDeny（屏蔽的宿主工具点号 id 数组，如 ui.notify、bgtasks.spawn、mcp）、tools.exclude（任意工具名黑名单，含扩展/自定义工具）、thinkingLevel（off/minimal/low/medium/high/xhigh/max）、model（钉住模型 {providerId?, modelId?}，须已在设置里配置）、defaultGuiMode（default/ask/plan/auto）、systemPrompt（整体替换引擎基底提示词，慎用）、contextFiles（是否加载 AGENTS.md 等上下文文件）、skillsPaths（旧字段，不再扩展来源；技能须链接到全局或项目 .agents/skills）、promptPaths（附加模板目录）、temperature（0-2）、providerHeaders（额外请求头）、guards（硬守卫：guards.bashReadOnly 只读白名单、guards.bashAllow 额外放行正则、guards.bashDeny 命令黑名单正则、guards.denyPaths 写路径保护子串）、turnInject（回合前动态注入模板，占位符 {{now}}/{{date}}/{{time}}/{{cwd}}）、turnInjectStable（stable snapshot：同日逐字节复用注入文本，保前缀缓存，翻日才重渲染）、inputTransforms（输入变换规则 [{pattern,replacement}]）、contextTrim（{maxToolResultChars} 超长工具结果截断，全文自动落盘可 read 取回）、extensions（⚠️ 自定义 TS 扩展路径，以宿主进程权限执行任意代码，只放可信模块）、themes（自定义主题路径）、scopedModels（可切换模型集）、piSettings（pi 原生 settings 透传，如 compaction/retry）。新模式对新会话立即可选。',
      argsHint:
        'id, name, description, persona, tools?, thinkingLevel?, model?, defaultGuiMode?, systemPrompt?, contextFiles?, skillsPaths?, promptPaths?, temperature?, providerHeaders?, guards?, turnInject?, turnInjectStable?, inputTransforms?, contextTrim?, extensions?, themes?, scopedModels?, piSettings?',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模式 id：小写字母/数字/连字符，字母或数字开头' },
          name: { type: 'string', description: '显示名（简短中文）' },
          description: { type: 'string', description: '一句话适用场景（模式菜单展示）' },
          persona: { type: 'string', description: '行为指令正文' },
          tools: {
            type: 'object',
            properties: {
              native: {
                type: 'array',
                items: { type: 'string', enum: ['read', 'write', 'edit', 'bash'] },
                description: '引擎原生工具白名单（缺省全量）'
              },
              nativeDeny: {
                type: 'array',
                items: { type: 'string', enum: ['read', 'write', 'edit', 'bash'] },
                description: '引擎原生工具黑名单（白名单之后应用）'
              },
              hostDeny: {
                type: 'array',
                items: { type: 'string' },
                description: '屏蔽的宿主工具点号 id（如 ui.notify、bgtasks.spawn、mcp；缺省不屏蔽）'
              },
              exclude: {
                type: 'array',
                items: { type: 'string' },
                description: '任意工具名黑名单（excludeTools，含扩展/自定义工具，最后应用）'
              }
            }
          },
          thinkingLevel: {
            type: 'string',
            enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            description: '思考档位（缺省：reasoning 模型 medium / 非 reasoning off）'
          },
          model: {
            type: 'object',
            properties: {
              providerId: { type: 'string' },
              modelId: { type: 'string' }
            },
            description: '钉住模型（缺省沿用全局激活配置）'
          },
          defaultGuiMode: {
            type: 'string',
            enum: ['default', 'ask', 'plan', 'auto'],
            description: '选中该模式时的默认权限档（不设=保持当前档位）'
          },
          systemPrompt: {
            type: 'string',
            description: '整体替换引擎基底系统提示（GUI 政策层/行为规约仍追加在后；慎用）'
          },
          contextFiles: {
            type: 'boolean',
            description: '是否加载 AGENTS.md/CLAUDE.md 等上下文文件（缺省 true）'
          },
          skillsPaths: {
            type: 'array',
            items: { type: 'string' },
            description: '兼容旧模式的字段，不再扩展技能来源；请把技能链接到全局或项目 .agents/skills'
          },
          promptPaths: {
            type: 'array',
            items: { type: 'string' },
            description: '附加 prompt 模板根目录（提供即开启 pi 模板发现）'
          },
          temperature: { type: 'number', description: '采样温度 0-2（缺省不动）' },
          providerHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '额外/覆盖的 provider 请求头'
          },
          guards: {
            type: 'object',
            properties: {
              bashReadOnly: {
                type: 'boolean',
                description: 'bash 只读白名单（与 ask/plan 同源；可与 bashAllow OR）'
              },
              bashAllow: {
                type: 'array',
                items: { type: 'string' },
                description: 'bash 额外放行正则（如 ^\\\\s*npm\\\\s+test；与 bashReadOnly OR）'
              },
              bashDeny: {
                type: 'array',
                items: { type: 'string' },
                description: '命令黑名单正则（命中 bash 工具 command 即引擎级拦截，如 \\\\brm -rf\\\\b）'
              },
              denyPaths: {
                type: 'array',
                items: { type: 'string' },
                description: '写路径保护子串（write/edit 的 path 包含即拦截，如 .env、node_modules）'
              }
            },
            description: '硬守卫：tool_call 级引擎拦截，比 persona 软约束硬'
          },
          turnInject: {
            type: 'string',
            description:
              '回合前动态注入模板（每轮渲染后追加到本轮系统提示；占位符 {{now}}/{{date}}/{{time}}/{{cwd}}）'
          },
          turnInjectStable: {
            type: 'boolean',
            description:
              'stable snapshot 注入（须配 turnInject）：同一天内逐字节复用同一份渲染结果，翻日才重渲染——保 provider 前缀缓存命中；代价是时间只到「天」粒度新鲜。缺省 false=每轮重渲染'
          },
          inputTransforms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: '正则' },
                replacement: { type: 'string', description: '替换文本（可用 $1 引用捕获组）' }
              },
              required: ['pattern', 'replacement']
            },
            description: '输入变换规则（发送前按序应用，最多 20 条）'
          },
          contextTrim: {
            type: 'object',
            properties: {
              maxToolResultChars: { type: 'number', description: 'toolResult 文本块截断上限（200-100000）' }
            },
            description: '上下文瘦身：超长工具结果截断'
          },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description:
              '自定义扩展路径（TS 模块，jiti 加载；可注册工具/命令/provider/压缩钩子等一切扩展能力）。⚠️ 扩展以宿主进程权限执行任意代码——只放可信来源的模块'
          },
          themes: {
            type: 'array',
            items: { type: 'string' },
            description: '自定义主题路径（TUI 主题；宿主 GUI 下基本无效果）'
          },
          scopedModels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                providerId: { type: 'string' },
                modelId: { type: 'string' },
                thinkingLevel: {
                  type: 'string',
                  enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
                }
              },
              required: ['providerId', 'modelId']
            },
            description: '可切换模型集（模型循环；须已在设置里配置，缺失条目跳过并告警）'
          },
          piSettings: {
            type: 'object',
            additionalProperties: {},
            description:
              'pi 原生 settings 透传（模式级覆盖 pi 全部设置面）：compaction{enabled,reserveTokens,keepRecentTokens}、retry{enabled,maxRetries,baseDelayMs,...}、shellPath/shellCommandPrefix、steeringMode/followUpMode、images.autoResize、thinkingBudgets、enabledModels 等；键值不校验语义，pi 自行忽略未知键'
          }
        },
        required: ['id', 'name', 'description', 'persona']
      },
      permissionClass: 'edit',
      async execute(args) {
        // extensions 强制确认门先于一切写入（权限档无关，auto 档同样拦）
        const gateRefusal = await confirmExtensionsGate(opts?.confirmExtensions, 'create', args);
        if (gateRefusal) return gateRefusal;
        const input: PiModeDef = {
          id: str(args, 'id') ?? '',
          name: str(args, 'name') ?? '',
          description: str(args, 'description') ?? '',
          persona: str(args, 'persona') ?? ''
        };
        if (args.tools !== undefined) input.tools = args.tools as PiModeDef['tools'];
        if (args.thinkingLevel !== undefined) {
          input.thinkingLevel = args.thinkingLevel as PiModeDef['thinkingLevel'];
        }
        if (args.model !== undefined) input.model = args.model as PiModeDef['model'];
        if (args.defaultGuiMode !== undefined) {
          input.defaultGuiMode = args.defaultGuiMode as PiModeDef['defaultGuiMode'];
        }
        if (args.systemPrompt !== undefined) input.systemPrompt = str(args, 'systemPrompt');
        if (args.contextFiles !== undefined) input.contextFiles = args.contextFiles === true;
        if (args.skillsPaths !== undefined) input.skillsPaths = args.skillsPaths as string[];
        if (args.promptPaths !== undefined) input.promptPaths = args.promptPaths as string[];
        if (args.temperature !== undefined) input.temperature = args.temperature as number;
        if (args.providerHeaders !== undefined) {
          input.providerHeaders = args.providerHeaders as Record<string, string>;
        }
        if (args.guards !== undefined) input.guards = args.guards as PiModeDef['guards'];
        if (args.turnInject !== undefined) input.turnInject = str(args, 'turnInject');
        if (args.turnInjectStable !== undefined) {
          input.turnInjectStable = args.turnInjectStable === true;
        }
        if (args.inputTransforms !== undefined) {
          input.inputTransforms = args.inputTransforms as PiModeDef['inputTransforms'];
        }
        if (args.contextTrim !== undefined) {
          input.contextTrim = args.contextTrim as PiModeDef['contextTrim'];
        }
        if (args.extensions !== undefined) input.extensions = args.extensions as string[];
        if (args.themes !== undefined) input.themes = args.themes as string[];
        if (args.scopedModels !== undefined) {
          input.scopedModels = args.scopedModels as PiModeDef['scopedModels'];
        }
        if (args.piSettings !== undefined) {
          input.piSettings = args.piSettings as Record<string, unknown>;
        }
        const err = createPiMode(userDataDir, input);
        if (err) return `创建失败：${err}`;
        return `模式「${input.id}」已创建。新开会话即可在模式菜单选择；对已开始的会话不生效。`;
      }
    },
    {
      id: 'modes.update',
      label: 'modes.update',
      description:
        '修改用户自建模式：id 必填，其余全部可选（缺省字段保留原值）。可选字段与 modes.create 一致：name/description/persona/tools{native,nativeDeny,hostDeny,exclude}/thinkingLevel/model/defaultGuiMode/systemPrompt/contextFiles/skillsPaths/promptPaths/temperature/providerHeaders/guards/turnInject/inputTransforms/contextTrim/extensions/themes/scopedModels/piSettings。',
      argsHint: 'id + 任意可选字段（同 modes.create）',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          persona: { type: 'string' },
          tools: {
            type: 'object',
            properties: {
              native: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'edit', 'bash'] } },
              nativeDeny: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'edit', 'bash'] } },
              hostDeny: { type: 'array', items: { type: 'string' } },
              exclude: { type: 'array', items: { type: 'string' } }
            }
          },
          thinkingLevel: {
            type: 'string',
            enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          },
          model: {
            type: 'object',
            properties: { providerId: { type: 'string' }, modelId: { type: 'string' } }
          },
          defaultGuiMode: { type: 'string', enum: ['default', 'ask', 'plan', 'auto'] },
          systemPrompt: { type: 'string' },
          contextFiles: { type: 'boolean' },
          skillsPaths: { type: 'array', items: { type: 'string' } },
          promptPaths: { type: 'array', items: { type: 'string' } },
          temperature: { type: 'number' },
          providerHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          guards: {
            type: 'object',
            properties: {
              bashReadOnly: { type: 'boolean' },
              bashAllow: { type: 'array', items: { type: 'string' } },
              bashDeny: { type: 'array', items: { type: 'string' } },
              denyPaths: { type: 'array', items: { type: 'string' } }
            }
          },
          turnInject: { type: 'string' },
          turnInjectStable: { type: 'boolean' },
          inputTransforms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pattern: { type: 'string' },
                replacement: { type: 'string' }
              },
              required: ['pattern', 'replacement']
            }
          },
          contextTrim: {
            type: 'object',
            properties: {
              maxToolResultChars: { type: 'number' }
            }
          },
          extensions: { type: 'array', items: { type: 'string' } },
          themes: { type: 'array', items: { type: 'string' } },
          scopedModels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                providerId: { type: 'string' },
                modelId: { type: 'string' },
                thinkingLevel: {
                  type: 'string',
                  enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
                }
              },
              required: ['providerId', 'modelId']
            }
          },
          piSettings: {
            type: 'object',
            additionalProperties: {}
          }
        },
        required: ['id']
      },
      permissionClass: 'edit',
      async execute(args) {
        // extensions 强制确认门先于一切写入（权限档无关，auto 档同样拦）
        const gateRefusal = await confirmExtensionsGate(opts?.confirmExtensions, 'update', args);
        if (gateRefusal) return gateRefusal;
        const id = str(args, 'id') ?? '';
        const patch: Record<string, unknown> = {};
        for (const key of [
          'name',
          'description',
          'persona',
          'tools',
          'thinkingLevel',
          'model',
          'defaultGuiMode',
          'systemPrompt',
          'contextFiles',
          'skillsPaths',
          'promptPaths',
          'temperature',
          'providerHeaders',
          'guards',
          'turnInject',
          'turnInjectStable',
          'inputTransforms',
          'contextTrim',
          'extensions',
          'themes',
          'scopedModels',
          'piSettings'
        ]) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        const err = updatePiMode(userDataDir, id, patch);
        if (err) return `更新失败：${err}`;
        return `模式「${id}」已更新。对新会话生效。`;
      }
    },
    {
      id: 'modes.delete',
      label: 'modes.delete',
      description: '删除用户自建模式 {id}（内置模式不可删）。',
      argsHint: 'id',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      permissionClass: 'edit',
      async execute(args) {
        const id = str(args, 'id') ?? '';
        const err = deletePiMode(userDataDir, id);
        if (err) return `删除失败：${err}`;
        return `模式「${id}」已删除。`;
      }
    }
  ];
}
