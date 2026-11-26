import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import { assessIntegrationEvidence } from './gitPolicy';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SafetyDecision,
  SafetyOperation,
  SafetyRecord,
  SafetyService,
  SafetySnapshot,
  SafetyMessage,
  SafetyRule,
  SafetyStreamEvent,
} from '../../shared/safety';
import { currentTurnUserText } from '../agent/turnScope';
import { writeTextAtomicSync } from '../atomicJson';
import {
  operationFingerprint,
  SAFETY_POLICY_VERSION,
  safetyRisk,
} from './policy';
import type {
  SafetyReviewer,
  SafetyReviewRequest,
  SafetyReviewResult,
} from './pi';
import {
  redactSafetyEvidence,
  redactSafetyText,
  safetySecrets,
} from './redact';
import { redactCredentialShapes } from '../memory/redact';
const clean = (text: string) =>
  redactCredentialShapes(text).text.slice(0, 8000);
export interface SafetyServiceOptions {
  userDataPath: string;
  reviewer: SafetyReviewer;
  onChanged?: (snapshot: SafetySnapshot) => void;
  timeoutMs?: number;
  confirmationTimeoutMs?: number;
  queueTimeoutMs?: number;
  captureTrustedState?: (op: SafetyOperation) => () => boolean;
  humanConfirm?: (
    operation: SafetyOperation,
    reason: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}
interface State {
  records: SafetyRecord[];
  messages: SafetyMessage[];
  rules: SafetyRule[];
  ruleRevision: number;
  generation: number;
  busy: boolean;
  tail: Promise<void>;
  controller?: AbortController;
  activeRequestId?: string;
  summary?: string;
  poisoned?: boolean;
}
export function createSafetyService(
  options: SafetyServiceOptions,
): SafetyService {
  const directory = userDataStorage(options.userDataPath).resolve('app', 'safety');
  const states = new Map<string, State>(),
    pending = new WeakMap<SafetyOperation, Promise<SafetyDecision>>();
  const waiting = new Map<
    string,
    {
      workspaceId: string;
      cancel: () => void;
    }
  >();
  let disposed = false;
  const file = (id: string) =>
    path.join(
      directory,
      createHash('sha256').update(id).digest('hex').slice(0, 24),
      'conversation.json',
    );
  function state(id: string): State {
    const existing = states.get(id);
    if (existing) return existing;
    let saved: Partial<State> = {};
    try {
      const name = file(id),
        stat = fs.lstatSync(name);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4 * 1024 * 1024
      )
        throw new Error('安全转录文件无效');
      saved = JSON.parse(fs.readFileSync(name, 'utf8'));
      if (
        !Array.isArray(saved.messages) ||
        !Array.isArray(saved.rules) ||
        !Array.isArray(saved.records) ||
        !Number.isSafeInteger(saved.ruleRevision)
      )
        throw new Error('安全转录格式无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const legacy = path.join(path.dirname(file(id)), 'audit.json');
      try {
        const stat = fs.lstatSync(legacy);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw new Error('旧安全审计无效');
        const records: unknown = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        if (!Array.isArray(records)) throw new Error('旧安全审计格式无效');
        saved = {
          records: records.filter((r) => r?.workspaceId === id).slice(-200),
        };
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT')
          throw legacyError;
      }
    }
    const s: State = {
      records: (saved.records ?? []).map((r) =>
        ['reviewing', 'needs_confirmation'].includes(r.status)
          ? {
              ...r,
              status: 'failed',
              reason: '上次进程未完成审核；必须重新提交，不恢复授权',
            }
          : r,
      ),
      messages: saved.messages ?? [],
      rules: saved.rules ?? [],
      ruleRevision: saved.ruleRevision ?? 0,
      generation: (saved.generation ?? 0) + 1,
      busy: false,
      tail: Promise.resolve(),
      summary: saved.summary,
    };
    states.set(id, s);
    return s;
  }
  function snapshot(id: string): SafetySnapshot {
    const s = state(id);
    return structuredClone({
      workspaceId: id,
      records: s.records,
      messages: s.messages,
      rules: s.rules,
      ruleRevision: s.ruleRevision,
      generation: s.generation,
      busy: s.busy,
    });
  }
  function publish(id: string) {
    const s = state(id),
      name = file(id);
    const pendingStream = streamTimers.get(id);
    if (pendingStream) { clearTimeout(pendingStream); streamTimers.delete(id); }
    if (s.poisoned) throw new Error('安全审计写入失败，必须恢复服务后再审批');
    try {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      const data = {
        records: s.records.slice(-200),
        messages: s.messages,
        rules: s.rules,
        ruleRevision: s.ruleRevision,
        generation: s.generation,
        summary: s.summary,
      };
      writeTextAtomicSync(name, JSON.stringify(data), { mode: 0o600 });
    } catch (error) {
      console.error('[safety] audit persistence failed:', clean(error instanceof Error ? error.message : String(error)));
      s.poisoned = true;
      s.controller?.abort(new Error('安全审计写入失败'));
      throw error;
    }
    // Committed storage is authoritative. A failed renderer notification cannot undo it.
    try {
      options.onChanged?.(snapshot(id));
    } catch (error) {
      console.warn(
        '[safety] state notification failed:',
        clean(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const streamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function publishStream(id: string): void {
    if (streamTimers.has(id)) return;
    const timer = setTimeout(() => {
      streamTimers.delete(id);
      try { options.onChanged?.(snapshot(id)); }
      catch (error) { console.warn('[safety] stream notification failed:', clean(String(error))); }
    }, 50);
    timer.unref?.();
    streamTimers.set(id, timer);
  }
  function mutateRules<T>(id: string, mutate: () => T): T {
    const s = state(id),
      previousRules = structuredClone(s.rules),
      previousRevision = s.ruleRevision;
    try {
      const result = mutate();
      publish(id);
      return result;
    } catch (error) {
      s.rules = previousRules;
      s.ruleRevision = previousRevision;
      throw error;
    }
  }
  function message(
    id: string,
    role: SafetyMessage['role'],
    text: string,
    requestId?: string,
    origin?: SafetyMessage['origin'],
  ): SafetyMessage {
    const s = state(id);
    const item: SafetyMessage = {
      id: randomUUID(),
      role,
      text: clean(text),
      createdAt: Date.now(),
      requestId,
      origin,
    };
    s.messages.push(item);
    while (
      s.messages.length > 160 ||
      (s.messages.length > 1 && JSON.stringify(s.messages).length > 45000)
    ) {
      const removed = s.messages.shift()!;
      // Extractive summary carries message/request provenance; it never grants authority.
      s.summary = redactCredentialShapes(
        `${s.summary ?? ''}\n[${removed.id};${removed.requestId ?? 'chat'};${removed.role}] ${removed.text.slice(0, 300)}`,
      ).text.slice(-12000);
    }
    return item;
  }
  function enqueue<T>(id: string, run: () => Promise<T>, persistOnCompletion = true): Promise<T> {
    const s = state(id),
      generation = s.generation;
    const next = s.tail.then(async () => {
      if (disposed || s.poisoned || generation !== s.generation)
        throw new Error('安全会话或审计已失效');
      s.busy = true;
      try {
        return await run();
      } finally {
        s.busy = false;
        // Authorization paths already commit their verdict/handoff. Busy is
        // ephemeral: avoid a redundant write racing an immediate human reply.
        if (persistOnCompletion) publish(id);
        else {
          try { options.onChanged?.(snapshot(id)); }
          catch (error) { console.warn('[safety] state notification failed:', clean(String(error))); }
        }
      }
    });
    s.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async function review(
    id: string,
    request: SafetyReviewRequest,
  ): Promise<SafetyReviewResult> {
    const s = state(id),
      controller = new AbortController();
    s.controller = controller;
    s.activeRequestId = request.requestId;
    const generation = s.generation;
    let expectedRevision = s.ruleRevision;
    const timer = setTimeout(
      () => controller.abort(new Error('审批模型执行超过预算')),
      options.timeoutMs ?? (request.gitEvidence ? 90000 : 45000),
    );
    let streamed: SafetyMessage | undefined;
    const ensureStreamMessage = (): SafetyMessage => {
      if (streamed) return streamed;
      streamed = message(id, 'assistant', '', request.requestId, 'reviewer');
      streamed.parts = [];
      return streamed;
    };
    const onStream = (event: SafetyStreamEvent): void => {
      if (event.type === 'model-start') ensureStreamMessage();
      else if (event.type === 'text-delta') {
        const target = ensureStreamMessage();
        const text = clean(event.text);
        const last = target.parts?.at(-1);
        if (last?.kind === 'text') last.text += text;
        else target.parts?.push({ kind: 'text', text });
        target.text = clean((target.text || '') + text);
      } else if (event.type === 'tool-start') {
        const target = ensureStreamMessage();
        const input = JSON.parse(redactSafetyEvidence(JSON.stringify(event.input))) as Record<string, unknown>;
        target.parts?.push({ kind: 'tool', tool: { id: event.id, name: event.name, input, status: 'running' } });
      } else if (event.type === 'tool-result') {
        const target = ensureStreamMessage();
        const part = target.parts?.find(part => part.kind === 'tool' && part.tool.id === event.id);
        if (part?.kind === 'tool') {
          part.tool.status = event.isError ? 'error' : 'ok';
          // Git evidence pages belong to the current review request. Keep the
          // call status in the transcript without retaining the captured source.
          if (part.tool.name !== 'safety_evidence') part.tool.output = clean(event.output);
        }
      } else if (event.type === 'error') {
        const target = ensureStreamMessage();
        target.error = clean(event.message);
      }
      publishStream(id);
    };
    let listener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      listener = () => {
        let failure = controller.signal.reason ?? new Error('已停止');
        // Rejecting the race only releases our logical queue. Detach the
        // physical reviewer too, before the next queued request can reuse it.
        // This guard prevents an old request from releasing a newer reviewer.
        if (s.controller === controller) {
          try {
            options.reviewer.release?.(id);
          } catch (error) {
            failure = new Error(`审批模型取消清理失败：${clean(error instanceof Error ? error.message : String(error))}`);
            console.warn('[safety]', failure.message);
          }
        }
        reject(failure);
      };
      controller.signal.addEventListener('abort', listener, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return options.reviewer(
            {
              ...request,
              onEvent: onStream,
              history: [
                ...(s.summary
                  ? [
                      {
                        id: 'history-summary',
                        role: 'system' as const,
                        text: s.summary,
                        createdAt: 0,
                      },
                    ]
                  : []),
                ...s.messages,
              ],
              rules: s.rules.filter((r) => r.enabled),
              ruleRevision: s.ruleRevision,
              updateRule: request.updateRule
                ? (input) => {
                    if (
                      disposed ||
                      controller.signal.aborted ||
                      s.controller !== controller ||
                      s.generation !== generation ||
                      s.ruleRevision !== expectedRevision
                    )
                      throw new Error('用户规则写入作用域或版本已失效');
                    const result = request.updateRule!(input);
                    expectedRevision = s.ruleRevision;
                    return result;
                  }
                : undefined,
            },
            controller.signal,
          );
        }),
        aborted,
      ]);
    } catch (error) {
      if (!controller.signal.aborted) {
        onStream({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', listener);
      if (s.controller === controller) {
        s.controller = undefined;
        s.activeRequestId = undefined;
      }
    }
  }
  async function authorize(op: SafetyOperation): Promise<SafetyDecision> {
    const requestId = randomUUID(),
      risk = safetyRisk(op),
      decision = (
        allowed: boolean,
        reason: string,
        extra: Partial<SafetyDecision> = {},
      ): SafetyDecision => ({
        allowed,
        reason,
        requestId,
        risk,
        ...extra,
      });
    if (disposed || op.signal?.aborted)
      return decision(false, '操作已取消', { cancelled: true });
    if (risk === 'routine') return decision(true, '例行操作，沿用既有能力授权');
    let s: State, currentTrusted: () => boolean;
    try {
      s = state(op.workspaceId);
    } catch {
      return decision(false, '安全审计不可读取，未授权', { auditUnavailable: true });
    }
    try {
      currentTrusted = options.captureTrustedState?.(op) ?? (() => true);
    } catch {
      return decision(false, '宿主作用域无效，操作已取消', { cancelled: true });
    }
    const generation = s.generation,
      fingerprint = operationFingerprint(op),
      secrets = safetySecrets(op.args),
      reason = (text: string) => clean(redactSafetyText(text, secrets));
    const current = () => {
      try {
        return (
          !disposed &&
          !s.poisoned &&
          !op.signal?.aborted &&
          s.generation === generation &&
          currentTrusted() &&
          operationFingerprint(op) === fingerprint
        );
      } catch {
        return false;
      }
    };
    const record: SafetyRecord = {
      requestId,
      workspaceId: op.workspaceId,
      action: op.action,
      fingerprint,
      generation,
      risk: 'high',
      status: 'reviewing',
      reason: '排队等待审批',
      createdAt: Date.now(),
      summary: op.summary ? reason(op.summary) : undefined,
    };
    s.records.push(record);
    s.records = s.records.slice(-200);
    message(
      op.workspaceId,
      'system',
      `审批请求：${op.action}。${op.summary ? reason(op.summary) : ''}`,
      requestId,
      'approval_request',
    );
    const request: SafetyReviewRequest = redactSafetyEvidence({
      requestId,
      fingerprint,
      generation,
      workspaceId: op.workspaceId,
      actorId: op.actorId,
      action: op.action,
      args: structuredClone(op.args),
      targetFingerprint: op.targetFingerprint,
      summary: op.summary,
      evidence: op.evidence,
      gitEvidence: op.gitEvidence,
      trustedUserIntent: currentTurnUserText() ?? null,
      policyVersion: SAFETY_POLICY_VERSION,
    });
    return new Promise<SafetyDecision>((resolve) => {
      let settled = false;
      let handedOff = false;
      let humanRevision: number | undefined;
      let humanController: AbortController | undefined;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const clearEvidence = () => {
        if (!request.gitEvidence) return;
        for (const key of Object.keys(request.gitEvidence.contents)) delete request.gitEvidence.contents[key];
        request.gitEvidence = undefined;
      };
      const finish = (
        allowed: boolean,
        text: string,
        extra: Partial<SafetyDecision> = {},
      ) => {
        if (settled) return;
        settled = true;
        clearEvidence();
        humanController?.abort(new Error('本次人工审批已结束'));
        waiting.delete(requestId);
        clearTimeout(expiry);
        clearTimeout(queueExpiry);
        clearInterval(monitor);
        op.signal?.removeEventListener('abort', cancel);
        record.status = allowed
          ? 'allowed'
          : record.status === 'failed'
            ? 'failed'
            : 'denied';
        record.reason = reason(text);
        record.finishedAt = Date.now();
        try {
          publish(op.workspaceId);
        } catch {
          allowed = false;
          record.status = 'failed';
          record.reason = '安全审计写入失败，未授权';
          extra = { ...extra, auditUnavailable: true };
          // Publish cannot commit after a disk error, but the UI must still learn
          // that the request ended. Never return a ticket without its audit.
          try { options.onChanged?.(snapshot(op.workspaceId)); } catch {}
        }
        resolve(decision(allowed, record.reason, extra));
      };
      const cancel = () => {
        if (s.activeRequestId === requestId)
          s.controller?.abort(new Error('操作已取消或作用域已变化'));
        finish(false, '操作已取消或作用域已变化', { cancelled: true });
      };
      const monitor = setInterval(() => {
        if (s.poisoned) {
          record.status = 'failed';
          finish(false, '安全审计写入失败，未授权');
        } else if (!current() || (humanRevision !== undefined && humanRevision !== s.ruleRevision)) cancel();
      }, 50);
      monitor.unref();
      const queueExpiry = setTimeout(
        () => handoff('审批排队超过预算，请人工决定本次操作'),
        options.queueTimeoutMs ?? 300000,
      );
      queueExpiry.unref();
      const handoff = (text: string) => {
        if (settled || handedOff) return;
        if (s.poisoned) {
          record.status = 'failed';
          finish(false, '安全审计写入失败，未授权');
          return;
        }
        if (!current()) { cancel(); return; }
        handedOff = true;
        clearEvidence();
        humanRevision = s.ruleRevision;
        clearTimeout(queueExpiry);
        const confirm = op.humanConfirm
          ? (signal: AbortSignal) => op.humanConfirm!(reason(text), signal)
          : options.humanConfirm
            ? (signal: AbortSignal) => options.humanConfirm!(op, reason(text), signal)
            : undefined;
        record.reason = reason(text);
        message(op.workspaceId, 'system', `${record.reason}。${confirm ? '已转交人工确认弹窗，请在弹窗决定本次操作。' : '人工确认通道不可用，本次操作未授权；请恢复确认通道后重新提交。'}`, requestId, 'service');
        if (!confirm) {
          record.status = 'failed';
          finish(false, `${record.reason}；人工确认通道不可用，未授权`, { escalated: true });
          return;
        }
        record.status = 'needs_confirmation';
        humanController = new AbortController();
        try { publish(op.workspaceId); } catch {
          record.status = 'failed';
          finish(false, '安全审计写入失败，未授权', { escalated: true });
          return;
        }
        if (settled) return;
        expiry = setTimeout(
          () => {
            record.status = 'failed';
            message(op.workspaceId, 'system', '人工确认超时，本次操作未授权。', requestId, 'service');
            finish(false, '等待人工确认超过预算，未授权', { escalated: true });
          },
          options.confirmationTimeoutMs ?? 1800000,
        );
        expiry.unref();
        // A human must not occupy the workspace's reviewer queue. Resolve the
        // current model turn first and ignore every later model receipt.
        void Promise.resolve().then(() => {
          if (settled || humanController!.signal.aborted) return undefined;
          return confirm(humanController!.signal);
        }).then((accepted) => {
          if (settled) return;
          if (!current() || humanRevision !== s.ruleRevision) { cancel(); return; }
          if (typeof accepted !== 'boolean') throw new Error('人工确认未返回有效决定');
          const text = `用户在人工确认弹窗中${accepted ? '批准' : '拒绝'}本次操作：${op.action}${record.summary ? `。${record.summary}` : ''}`;
          message(op.workspaceId, 'system', text, requestId, 'human_decision');
          finish(accepted, text, { escalated: true, humanDecision: accepted });
        }).catch((error) => {
          if (settled) return;
          record.status = 'failed';
          const text = `人工处理失败，未授权：${reason(error instanceof Error ? error.message : String(error))}`;
          message(op.workspaceId, 'system', text, requestId, 'service');
          finish(false, text, { escalated: true });
        });
      };
      waiting.set(requestId, { workspaceId: op.workspaceId, cancel });
      op.signal?.addEventListener('abort', cancel, { once: true });
      const run = async () => {
        clearTimeout(queueExpiry);
        if (settled || handedOff) return;
        if (!current()) {
          cancel();
          return;
        }
        const revision = s.ruleRevision;
        try {
          record.status = 'reviewing';
          publish(op.workspaceId);
          const assessment = assessIntegrationEvidence(request.gitEvidence, [
            request.summary, request.gitEvidence?.delivery,
            typeof request.args.message === 'string' ? request.args.message : undefined,
          ].filter(Boolean).join('\n'));
          const reviewed = await review(op.workspaceId, request);
          const r = { ...reviewed,
            verdict: reviewed.verdict === 'allow' && assessment.critical.length ? 'concern' as const : reviewed.verdict,
            reason: [reviewed.reason, ...assessment.critical, ...assessment.informational].filter(Boolean).join('；'),
          };
          if (settled) return;
          if (!current() || revision !== s.ruleRevision) {
            finish(false, '审批作用域或规则版本已变化', { cancelled: true });
            return;
          }
          if (
            r.requestId !== requestId ||
            r.fingerprint !== fingerprint ||
            r.generation !== generation ||
            !['allow', 'concern'].includes(r.verdict) ||
            !reviewed.reason?.trim()
          )
            throw new Error('非法或过期裁决');
          record.model = r.model;
          const resultText = r.verdict === 'allow'
            ? '通过'
            : `需要人工审核：${reason(r.reason).replace(/\s+/g, ' ')}`;
          message(op.workspaceId, 'assistant', resultText, requestId, 'reviewer');
          if (r.verdict === 'allow') {
            finish(true, r.reason);
            return;
          }
          handoff(`审批代理需要人工确认：${r.reason}`);
        } catch (error) {
          if (settled) return;
          if (s.poisoned) {
            record.status = 'failed';
            finish(false, '安全审计写入失败，未授权');
            return;
          }
          if (!current() || revision !== s.ruleRevision) {
            cancel();
            return;
          }
          handoff(`审批模型失败：${error instanceof Error ? error.message : String(error)}。请人工决定本次操作`);
        }
      };
      try {
        publish(op.workspaceId);
        if (op.signal?.aborted) { cancel(); return; }
        void enqueue(op.workspaceId, run, false).catch((error) => {
          if (settled) return;
          if (s.poisoned) {
            record.status = 'failed';
            finish(false, '安全审计写入失败，未授权');
          } else if (!current()) cancel();
          else handoff(`审批队列失败：${String(error)}`);
        });
      } catch {
        record.status = 'failed';
        finish(false, '安全审计写入失败，未授权');
      }
    });
  }
  const stop = (id: string) => {
    const s = state(id);
    s.generation++;
    const activeController = s.controller;
    activeController?.abort(new Error('审批会话已停止'));
    for (const item of waiting.values())
      if (item.workspaceId === id) item.cancel();
    try {
      // Active reviews synchronously detach their reviewer on abort. Idle
      // sessions still need to be released when stopping a conversation.
      if (!activeController) options.reviewer.release?.(id);
    } finally {
      publish(id);
    }
  };
  return {
    authorize(op) {
      const prior = pending.get(op);
      if (prior) return prior;
      const promise = authorize(op).finally(() => pending.delete(op));
      pending.set(op, promise);
      return promise;
    },
    snapshot,
    async send(id, text, requestId) {
      if (!text.trim() || text.length > 8000)
        throw new Error('请输入1至8000字符');
      if (requestId) {
        const record = state(id).records.find((r) => r.requestId === requestId);
        if (!record) throw new Error('审批请求不存在或不属于当前工作区');
        message(id, 'user', text, requestId, 'user_chat');
        message(id, 'system', record.status === 'needs_confirmation'
          ? '本次审批已由人工确认弹窗接管。聊天消息不会批准操作，请在弹窗中确认或拒绝。'
          : `本次审批状态：${record.status}。聊天消息不会重新审批；需要重试时请从原操作入口重新提交。`, requestId, 'service');
        publish(id);
        return snapshot(id);
      }
      await enqueue(id, async () => {
        const s = state(id),
          generation = s.generation;
        message(id, 'user', text, undefined, 'user_chat');
        publish(id);
        const result = await review(id, {
          requestId: randomUUID(),
          fingerprint: 'chat',
          generation,
          workspaceId: id,
          action: '__user_chat__',
          args: {},
          trustedUserIntent: clean(text),
          policyVersion: SAFETY_POLICY_VERSION,
          updateRule: (input) => {
            return mutateRules(id, () => {
              const revision = ++s.ruleRevision;
              const rule: SafetyRule = {
                id: input.id ?? randomUUID(),
                text: clean(input.text),
                actions: input.actions.map(clean),
                enabled: input.enabled,
                revision,
                createdAt: Date.now(),
                sourceText: clean(text),
              };
              const index = s.rules.findIndex((r) => r.id === rule.id);
              if (index < 0) s.rules.push(rule);
              else s.rules[index] = rule;
              return rule;
            });
          },
        });
        if (disposed || s.generation !== generation)
          throw new Error('审批聊天作用域已失效');
        if (result.reason) {
          const last = s.messages.at(-1);
          if (!requestId && last?.role === 'assistant' && last.requestId === result.requestId && last.origin === 'reviewer') {
            const finalText = clean(result.reason);
            const textParts = last.parts?.filter(part => part.kind === 'text') ?? [];
            // Pi already streamed the assistant answer into these parts. Keep
            // that interleaved transcript (and its tool positions); only add
            // the final reason when a reviewer produced no visible text.
            if (!textParts.some(part => part.kind === 'text' && part.text.trim())) {
              last.text = finalText;
              last.parts = [...(last.parts ?? []), { kind: 'text', text: finalText }];
            } else if (!last.text.trim()) {
              last.text = finalText;
            }
            publish(id);
          } else message(id, 'assistant', result.reason, undefined, 'reviewer');
        }
      });
      return snapshot(id);
    },
    stop,
    clearConversation(id) {
      stop(id);
      const s = state(id);
      s.messages = [];
      s.summary = undefined;
      publish(id);
      return snapshot(id);
    },
    setRuleEnabled(id, ruleId, enabled, revision) {
      const s = state(id);
      if (s.ruleRevision !== revision)
        throw new Error('审批规则版本已变化，请刷新');
      mutateRules(id, () => {
        const rule = s.rules.find((r) => r.id === ruleId);
        if (!rule) throw new Error('审批规则不存在');
        rule.enabled = enabled;
        rule.revision = ++s.ruleRevision;
      });
      return snapshot(id);
    },
    invalidate(id) {
      for (const key of id ? [id] : states.keys()) stop(key);
    },
    dispose() {
      disposed = true;
      for (const timer of streamTimers.values()) clearTimeout(timer);
      streamTimers.clear();
      for (const id of states.keys()) stop(id);
      options.reviewer.dispose?.();
    },
  };
}
