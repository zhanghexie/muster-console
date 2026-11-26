/**
 * 调度回合前缀注入（runTurn 进回合前组装，进 LLM 上下文、不进 display）：
 * - R-12 调度记忆（MEMORY.md bootstrap + SITUATION 态势）
 * - C1 跨日日期提醒
 * - B3 transcript 快照指针（一次性）
 * - B5/B7 读路径（trigger / standing intents / Lane2，仅用户回合）
 * （自 orchestrator.ts 拆分；`this.ctx` 改为显式 ctx 参数，其余逐字保留。）
 */
import type { AppContext } from '../../context';
import { resolveSchedulerWorkspaceRoot, writeSchedulerSituationNow } from '../../orchestrator/situationWriter';
import { getMemoryService } from '../../memory/runtime';
import { runIntentMessageScan } from '../../memory/intents';
import { readSchedulerSituation } from '../../metaAgent/schedulerMemoryStore';
import { SCHEDULER_SITUATION_INJECT_MARKER } from '../../../shared/schedulerMemory';
import { buildTranscriptPointerLine } from '../../../shared/compactSummary';
import { decideDateChangeReminder } from '../../../shared/dateChangeReminder';
import type { WsAgentBucket } from './types';
import {defaultCwdFor} from '../../../shared/workspaceRoots';
import {prepareRecall,clearRecall,piRecallEpoch} from '../../memory/recallDedup';

/**
 * R-12 注入点实现（B5 §12 收敛：记忆数据源切 MemoryService.inject——调度面画像=
 * 调度 MEMORY.md ≤6K bootstrap，kind=bootstrap 落账）：
 * - due 时现采现写 SITUATION（冷启动新鲜，R-11）+ 前缀注入；
 * - **逐回合预算内刷新**（§7 Lane1-①）：versionToken（内容哈希 sha256(text)，见
 *   service.ts injectKnowledge）比对，文件没变
 *   跳过重注入（前缀已在上下文——前缀缓存语义）；变化（写入/外部编辑/翻日）才
 *   重新注入。B8 退役回落：boot 恒装配（index.ts），服务未装配属装配事故——
 *   空记忆注入 + 错误日志，不再走旧 readSchedulerMemory 链（SITUATION 不在记忆
 *   服务域，宿主现采现写不受影响）。
 * 两段全空返回原文（零注入）；失败 fail-open 不挡回合。
 */
export function applySchedulerMemoryInjection(
  ctx: AppContext,
  bucket: WsAgentBucket,
  wsId: string,
  text: string
): string {
  const due = bucket.memoryInjectionDue;
  try {
    const root = resolveSchedulerWorkspaceRoot(ctx, wsId);
    if (!root) return text;
    const svc = getMemoryService();
    let memoryBlock = '';
    let situationBlock = '';
    if (!svc) {
      console.error('[memory] MemoryService 未装配（应恒装配）——调度记忆本轮空注入');
      bucket.memoryInjectionDue = false;
    } else {
      const inj = svc.injectKnowledge(root, 'scheduler');
      const unchanged =
        !due && bucket.memoryInjectionVersion !== undefined && bucket.memoryInjectionVersion === inj.versionToken;
      bucket.memoryInjectionVersion = inj.versionToken;
      if (!unchanged) memoryBlock = inj.text;
      bucket.memoryInjectionDue = false;
    }
    if (due) {
      // 态势先重写一次再读：保证注入的是当前态势而非上次节流留下的旧快照
      writeSchedulerSituationNow(ctx, wsId);
      const sit = readSchedulerSituation(root);
      if (sit) {
        situationBlock = `${SCHEDULER_SITUATION_INJECT_MARKER} (.muster/scheduler/SITUATION.md, the host-generated current orchestration situation, read-only; carried automatically on the first turn of a new conversation)\n${sit}`;
      }
    }
    const prefix = [memoryBlock, situationBlock].filter((s) => s.trim()).join('\n\n');
    return prefix ? `${prefix}\n\n${text}` : text;
  } catch (err) {
    bucket.memoryInjectionDue = false;
    console.error('[orchestrator] scheduler memory injection failed（跳过注入，不挡回合）', wsId, err);
    return text;
  }
}

/**
 * C1 跨日 date-change reminder：pi 的 system prompt 不含日期（spike 见
 * shared/dateChangeReminder.ts 头注），调度会话常活数天，「今天」感知会过期。
 * 首次锚定/跨自然日时在回合文本最前注入一行 <系统提醒>（复用现有回合前缀通道，
 * 不改 system——保前缀缓存，ZCode injectDateChangeReminder 同思路）。host 与用户
 * 回合都带（人隔天回来问「今天…」同样需要）。dateKey 记桶上，纯内存即可（重启
 * 重新锚定一次，代价一行）。
 */
export function applyDateChangeReminder(bucket: WsAgentBucket, text: string): string {
  const r = decideDateChangeReminder({
    nowMs: Date.now(),
    lastInjectedDate: bucket.lastTurnDateKey
  });
  bucket.lastTurnDateKey = r.dateKey;
  return r.line ? `${r.line}\n\n${text}` : text;
}

/**
 * B3 transcript 快照指针注入：compact 前快照成功后，下一回合（host 与用户回合
 * 都带）在最前注入一行「完整历史快照已存 <路径>」，摘要丢失的细节模型可用文件
 * 工具按需回读（ZCode buildCompactSummaryMessage transcriptPath 条款同思路，
 * 复用 C1 同款回合前缀通道与 <系统提醒> 形态）。一次性：注入即清；会话切换/
 * 清空时随旧会话失效（clearHistory/openSession/forkSession/deleteSession 已清）。
 */
export function applyTranscriptPointerInjection(bucket: WsAgentBucket, text: string): string {
  const path = bucket.transcriptPointer;
  if (!path) return text;
  delete bucket.transcriptPointer;
  return `${buildTranscriptPointerLine(path)}\n\n${text}`;
}

/**
 * 读路径回合前缀组装（B5 §7）：R-12 调度记忆前缀 + trigger 注入（Lane1-③，仅
 * 调度面）+ standing intents 消息面扫描（B7 §9，全词预筛确定性命中→有界隐藏块）+
 * Lane2 深检索（回忆意图 && Lane1 无强命中；零模型调用，超时静默降级）。
 * host 自治回合只保留 R-12 前缀——无 trigger/intents/Lane2（方案立场：自治负载
 * 不做读路径增强，消息面/事件面只服务用户消息与事件流）。
 */
export async function composeReadPathTurnText(
  ctx: AppContext,
  bucket: WsAgentBucket,
  wsId: string,
  text: string,
  host?: boolean,
  turnId?: string
): Promise<string> {
  if(bucket.memoryInjectionDue||host)clearRecall(bucket);
  let out = applyDateChangeReminder(bucket, applySchedulerMemoryInjection(ctx, bucket, wsId, text));
  out = applyTranscriptPointerInjection(bucket, out);
  if (host) return out;
  const svc = getMemoryService();
  if (!svc) {clearRecall(bucket);return out;}
  let root: string | undefined;
  try {
    root = resolveSchedulerWorkspaceRoot(ctx, wsId);
  } catch {
    clearRecall(bucket);
    return out;
  }
  if (!root) {clearRecall(bucket);return out;}
  try {
    const db = svc.init(root);
    let intentBlock='';
    // F-06：standing intents 扫描失败不能静默吞——留一行诊断日志（仍不挡回合）
    try{intentBlock=runIntentMessageScan(db,text,Date.now()).block;}
    catch(err){console.warn('[orchestrator] standing intents 扫描失败（跳过，不挡回合）', wsId, err);}
    const workspace=ctx.config.get().workspaces.find(w=>w.id===wsId);
    const recall=await svc.recallKnowledge(root,text,'scheduler',workspace?{root:defaultCwdFor(workspace)}:undefined);
    const injection=prepareRecall(bucket,bucket.piSession,piRecallEpoch(bucket.piSession),turnId??'',recall);
    const extra=[intentBlock,injection].filter(Boolean).join('\n\n');
    return extra ? `${out}\n\n${extra}` : out;
  } catch (err) {
    clearRecall(bucket);
    console.warn('[orchestrator] 读路径注入（trigger/Lane2）失败（跳过，不挡回合）', wsId, err);
    return out;
  }
}
