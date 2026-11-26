/**
 * 调度 askQuestion（工具等用户作答）的挂起/作答/取消与人等状态。
 * 第二张提问卡到达时先取消旧卡；等待态经 getHumanWait 供 X1-F02 单一等人谓词
 * isSchedulerWaitingOnHuman（schedulerStatusStore）读取（C2 内存账）。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { randomUUID } from 'node:crypto';
import { t } from '../../../shared/i18n';
import type { CursorAskQuestionMapped } from '../../../shared/cursorAskQuestion';
import {
  attachAskQuestionCard,
  buildAskQuestionCard,
  findAskQuestionAnchor,
  settleAskQuestionCard,
  type OrchestratorAskOutcome,
  type OrchestratorHumanWait
} from '../../../shared/orchestratorAskQuestion';
import type { OrchestratorHost } from './internal';

/**
 * 调度 askQuestion：挂提问卡等用户作答。第二张到达时先取消旧卡。
 * 等待态经 getHumanWait 供 isSchedulerWaitingOnHuman（X1-F02 C2 账）读取；
 * 原 onOrchestratorHumanWait 事件钩子全仓无消费者，已随 X1-F02 删除。
 */
export function requestUserQuestion(
  o: OrchestratorHost,
  mapped: CursorAskQuestionMapped,
  workspaceId?: string
): Promise<OrchestratorAskOutcome> {
  const wsId = workspaceId?.trim() || o.ctx.resolveBubbleWorkspaceId();
  const bucket = o.ensureBucket(wsId);
  const assistant = findAskQuestionAnchor(bucket.display);
  if (!assistant) {
    return Promise.resolve({ kind: 'aborted' });
  }
  abortPendingAsk(o, wsId);
  return new Promise<OrchestratorAskOutcome>((resolve) => {
    const questionId = randomUUID();
    const card = buildAskQuestionCard(
      questionId,
      mapped,
      assistant.parts?.length ?? assistant.toolCalls?.length ?? 0
    );
    attachAskQuestionCard(assistant, card);
    o.pendingAsks.set(wsId, { questionId, since: Date.now(), resolve });
    o.emit('agent:message', { ...assistant, workspaceId: wsId });
    o.persistBucket(wsId);
    o.ctx.ui.setBubble(t('等你回答'), 'confirm', wsId);
  });
}

/** 渲染层作答/取消（IPC chat:respondUserQuestion） */
export function respondUserQuestion(
  o: OrchestratorHost,
  workspaceId: string,
  questionId: string,
  action: 'answer' | 'abort',
  answers?: Array<{ id: string; selected: string[]; custom?: string }>
): boolean {
  const wsId = workspaceId?.trim() || o.workspaceId;
  const pending = o.pendingAsks.get(wsId);
  if (!pending || pending.questionId !== questionId) return false;
  const outcome: OrchestratorAskOutcome =
    action === 'abort'
      ? { kind: 'aborted' }
      : {
          kind: 'answered',
          answers: (answers ?? []).map((a) => ({
            id: String(a.id),
            selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
            ...(a.custom ? { custom: String(a.custom) } : {})
          }))
        };
  return resolvePendingAsk(o, wsId, outcome);
}

/** 另一单 needs_you 通道可读的当前等待态；无挂起卡则 null */
export function getHumanWait(o: OrchestratorHost, workspaceId?: string): OrchestratorHumanWait | null {
  const wsId = workspaceId ?? o.workspaceId;
  const p = o.pendingAsks.get(wsId);
  if (!p) return null;
  return { workspaceId: wsId, reason: 'askQuestion', questionId: p.questionId, since: p.since };
}

export function abortPendingAsk(o: OrchestratorHost, wsId: string, reason?: 'superseded'): void {
  resolvePendingAsk(o, wsId, { kind: 'aborted', ...(reason ? { reason } : {}) });
}

function resolvePendingAsk(o: OrchestratorHost, wsId: string, outcome: OrchestratorAskOutcome): boolean {
  const pending = o.pendingAsks.get(wsId);
  if (!pending) return false;
  o.pendingAsks.delete(wsId);
  const bucket = o.buckets.get(wsId);
  const assistant = bucket ? findAskQuestionAnchor(bucket.display) : undefined;
  if (assistant) {
    settleAskQuestionCard(assistant, pending.questionId, outcome);
    o.emit('agent:message', { ...assistant, workspaceId: wsId });
  }
  if (bucket?.busy) {
    o.ctx.ui.setBubble(t('思考中…'), 'thinking', wsId);
  }
  o.persistBucket(wsId);
  pending.resolve(outcome);
  return true;
}
