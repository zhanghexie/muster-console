/**
 * intent 工具核心（standing intents 创建/列出/取消，memory-refactor §9，B7）：
 * handler 逻辑收口在此（hosts/intents.ts 只留身份门与服务解析壳），依赖链 node-only
 * （turnScope/agentScope + memory/intents），.mjs 可转译直测。
 *
 * 守卫（照 memory.remember 的 turnScope 先例）：
 * - **创建须本回合用户证据**：currentTurnUserText() 有值才放行——host 自治回合
 *   （runAsNonUserTurn）与后台子代理回合一律拒建；无头回合（isHeadlessTurn）拒建；
 * - **纯时间型意图拒绝**：「周五提醒我」这类纯时间触发没有可表达的事件/消息触发面，
 *   拒绝并指路现有定时任务（prompt task）——时间型触发归定时任务子系统，意图表只收
 *   消息/事件触发（确定性判定：描述含提醒动词 + 时间锚点，且未提供事件谓词）。
 *
 * 取消是持久状态（intents.cancelIntent）；list 供模型自查与面板同源。
 */
import { isSchedulerInvocation } from '../agent/agentScope';
import { currentTurnUserText, isHeadlessTurn } from '../agent/turnScope';
import {
  INTENT_CONSTANTS,
  cancelIntent,
  insertIntent,
  listIntents,
  type IntentRecord
} from './intents';
import type { MemoryDb } from './db';

// ---------------------------------------------------------------------------
// 纯时间型判定（确定性词法；无 i18n 依赖——发给 LLM 的工具报错文案）
// ---------------------------------------------------------------------------

/** 时间锚点：相对日/星期/时刻/日期/时长 */
const TIME_ANCHOR_RE =
  /今天|明日|明天|后天|今晚|今早|清晨|早上|上午|中午|下午|傍晚|晚上|凌晨|每天|每周|每月|每周[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*点|\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2}|\d+\s*(?:天|小时|分钟)后|tonight|tomorrow|yesterday|every\s*day|weekly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*am\b|\d{1,2}\s*pm\b/i;
/** 提醒动词 */
const REMIND_VERB_RE = /提醒|记得通知|别忘了|到点|remind/i;

/** 描述是否纯时间型（时间锚点 + 提醒动词同时在场） */
export function looksTimeOnlyIntent(description: string): boolean {
  const s = (description ?? '').trim();
  if (!s) return false;
  return REMIND_VERB_RE.test(s) && TIME_ANCHOR_RE.test(s);
}

// ---------------------------------------------------------------------------
// 工具核心
// ---------------------------------------------------------------------------

export interface IntentToolArgs {
  action?: string;
  description?: string;
  triggerKeywords?: unknown;
  eventPredicates?: unknown;
  cooldownHours?: number;
  fireBudget?: number;
  /** 过期天数（缺省 90；显式传才覆盖） */
  expiryDays?: number;
  id?: number;
}

export type IntentToolResult =
  | { action: 'create'; created: true; intent: IntentRecord }
  | { action: 'list'; items: IntentRecord[] }
  | { action: 'cancel'; cancelled: true; id: number };

const LIST_CAP = 20;

function keywordsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * intent 工具分发（仅调度调用链——hosts 层身份门）：
 * - create：用户回合证据 + 非纯时间型 + 触发面齐全 → 落库（armed）；
 * - list：全量生命周期（模型自查）；
 * - cancel：持久取消。
 */
export function runIntentTool(db: MemoryDb, args: IntentToolArgs): IntentToolResult {
  const action = String(args?.action ?? '').trim();
  if (action === 'list') {
    return { action: 'list', items: listIntents(db).slice(0, LIST_CAP) };
  }
  if (action === 'cancel') {
    // 与 create 对称：取消永不从对话推断——须本回合用户证据
    const turnTextCancel = currentTurnUserText();
    if (!turnTextCancel) {
      throw new Error(
        '取消意图需要用户在本回合对话中提出（host 自治/后台任务回合不可取消）；面板「意图管理」页签可手动取消'
      );
    }
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('cancel 需要有效的 id（list 里取）');
    if (!cancelIntent(db, id, Date.now())) throw new Error(`意图不存在或已是取消态：${id}`);
    return { action: 'cancel', cancelled: true, id };
  }
  if (action !== 'create') {
    throw new Error('action 须为 create / list / cancel');
  }
  // —— create 守卫（顺序：回合证据 → 无头 → 纯时间型）——
  const turnText = currentTurnUserText();
  if (!turnText) {
    throw new Error(
      '创建意图需要用户在本回合对话中提出（host 自治/后台任务回合不可建）；请把用户的前瞻请求原样带给调度回合再创建'
    );
  }
  if (isHeadlessTurn()) {
    throw new Error('无头/定时任务回合不可创建意图');
  }
  const description = String(args?.description ?? '').trim();
  if (!description) throw new Error('description 不能为空');
  const keywords = keywordsOf(args?.triggerKeywords);
  const predicates = Array.isArray(args?.eventPredicates) ? args.eventPredicates : [];
  const now = Date.now();
  if (predicates.length === 0 && looksTimeOnlyIntent(description)) {
    throw new Error(
      '纯时间型触发（如「周五提醒我」）不属于意图表——请改用现有定时任务（prompt task，时间触达）；意图只收消息关键词或任务事件触发'
    );
  }
  if (keywords.length === 0 && predicates.length === 0) {
    throw new Error(
      '意图缺少触发面：请从用户请求里提取消息关键词（triggerKeywords）或任务事件谓词（eventPredicates）；纯时间触发请用现有定时任务'
    );
  }
  const intent = insertIntent(db, {
    description,
    triggerKeywords: keywords,
    eventPredicates: predicates,
    cooldownMs:
      args?.cooldownHours != null && Number.isFinite(Number(args.cooldownHours))
        ? Math.max(0, Number(args.cooldownHours)) * 3_600_000
        : INTENT_CONSTANTS.DEFAULT_COOLDOWN_MS,
    fireBudget:
      args?.fireBudget != null && Number.isInteger(Number(args.fireBudget)) && Number(args.fireBudget) > 0
        ? Number(args.fireBudget)
        : INTENT_CONSTANTS.DEFAULT_FIRE_BUDGET,
    expiry:
      args?.expiryDays != null && Number.isFinite(Number(args.expiryDays))
        ? now + Math.max(1, Number(args.expiryDays)) * 86_400_000
        : now + INTENT_CONSTANTS.DEFAULT_EXPIRY_MS,
    createdBy: isSchedulerInvocation() ? 'intent-tool:scheduler' : 'intent-tool',
    now
  });
  return { action: 'create', created: true, intent };
}
