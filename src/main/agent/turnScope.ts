/**
 * 回合级作用域（memory-refactor B3 直写门/污点标记的数据面）：
 * 当前回合的用户消息文本 + 网络来源工具污点，经 AsyncLocalStorage 沿调用链传播
 * （与 agentScope 的调度身份标记同机制）。
 *
 * 建立点（runWithTurnUserText，只覆盖**真用户消息**回合——直写门只在有正面证据时开）：
 * - 调度面：piProvider.runPiTurn（交互调度回合，turnKind='user'）；
 * - GUI Worker 面：agentSession drivers/pi/driver 的 send。
 *
 * 非用户回合（两类，均**不建立用户消息证据面**，memory.remember 保守拒绝）：
 * - host 自治回合（orchestrator {host:true} 链路：事件 flush/邮箱收信/
 *   requestIntegrate/sessions.message 上行/facts 投递）——runPiTurn turnKind='host'
 *   → runAsNonUserTurn（B3 评审 MAJOR-1：自治提示词不是用户对话，不得充当当回合
 *   userText 证据）；
 * - 后台子代理（subagentTask 经共享 PiRuntimeDriver.send，连接标记 nonUserTurns）
 *   → runAsNonUserTurn——任务提示词由父会话合成，同样不是用户证据；
 * - 无头定时任务（runHeadlessPiTask）→ runAsHeadlessTurn：连污点跟踪面也不开，
 *   staging 种类门据此整批拒收。
 * 非用户回合仍保留回合内污点跟踪（markTurnNetworkTaint 可用）——memory.note 的
 * untrusted 分类不受影响。
 *
 * 污点标记点：capabilities/executor 在网络来源工具（provenance.isNetworkSourceTool）
 * 执行返回后 markTurnNetworkTaint——只影响当前回合作用域（无作用域时是 no-op）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

interface TurnScopeState {
  eventId:string;
  startedAt:number;
  sessionId?:string;
  /** 回合种类：'user'=真用户消息（明示记住证据面）；'task'=host 自治/后台子代理等非用户回合（只跟踪污点） */
  kind: 'user' | 'task';
  /** 本回合用户消息原文（明示记住判定的证据源；kind='task' 时恒空且对外不可见） */
  userText: string;
  /** 本回合是否出现过网络来源工具结果（§5 回合内污点） */
  networkTainted: boolean;
}

const turnAls = new AsyncLocalStorage<TurnScopeState>();
/** 无头（定时任务）回合标记：无头任务不建用户回合作用域，只打本标记（§5 种类门数据源） */
const headlessAls = new AsyncLocalStorage<true>();

/**
 * A GUI engine running in a child process cannot carry AsyncLocalStorage over
 * IPC. Keep one host-owned state per turn and re-enter it for each tool or
 * memory callback; creating a fresh scope per callback would lose provenance
 * and network taint between calls. Retire it when the turn is settled.
 */
export function createPromptAuthorityScope(
  originalUserText: string | undefined,
  nonUserTurns = false
): { run<T>(fn: () => T): T; close(): void } {
  const state: TurnScopeState = {
    kind: nonUserTurns || originalUserText === undefined ? 'task' : 'user',
    userText: nonUserTurns ? '' : (originalUserText ?? ''),
    networkTainted: false,
    eventId: randomUUID(),
    startedAt: Date.now()
  };
  let closed = false;
  return {
    run<T>(fn: () => T): T {
      if (closed) throw new Error('The originating turn has already ended');
      return turnAls.run(state, fn);
    },
    close(): void { closed = true; }
  };
}

/** 进入一个带用户消息的回合作用域（调度/GUI Worker 的 prompt 调用点包裹） */
export function runWithTurnUserText<T>(userText: string, fn: () => T): T {
  return turnAls.run({ kind: 'user', userText: userText ?? '', networkTainted: false,eventId:randomUUID(),startedAt:Date.now() }, fn);
}

/**
 * 非用户回合包裹（orchestrator host 自治回合 / 后台子代理任务回合）：不带用户消息
 * 证据面（currentTurnUserText 恒 undefined，memory.remember 据此保守拒绝），但保留
 * 回合内污点跟踪（memory.note 的 untrusted 分类不受影响）。
 */
export function runAsNonUserTurn<T>(fn: () => T): T {
  return turnAls.run({ kind: 'task', userText: '', networkTainted: false,eventId:randomUUID(),startedAt:Date.now() }, fn);
}

/** Prompt expansions are never an authorization source. Missing provenance fails closed. */
export function runWithPromptAuthority<T>(originalUserText: string | undefined, fn: () => T): T {
  return originalUserText === undefined ? runAsNonUserTurn(fn) : runWithTurnUserText(originalUserText, fn);
}

/** Authenticated CLI candidate only; a session token is never explicit remember permission. */
export function runWithExternalMemoryCandidate<T>(sessionId:string,fn:()=>T):T {
  return turnAls.run({kind:'task',userText:'',eventId:`cli:${sessionId}:${randomUUID()}`,sessionId,startedAt:Date.now(),networkTainted:false},fn);
}

/** Host-owned identity for tool calls, never supplied by a model argument. */
export function currentMemoryTurn():{eventId:string;startedAt:number;sessionId?:string}|undefined {
  const state=turnAls.getStore();return state?{eventId:state.eventId,startedAt:state.startedAt,sessionId:state.sessionId}:undefined;
}

/** 无头回合包裹（runHeadlessPiTask 等非用户对话回合；工具据此拒收 staging 候选） */
export function runAsHeadlessTurn<T>(fn: () => T): T {
  return headlessAls.run(true, fn);
}

/** 当前是否处于无头（定时任务）回合 */
export function isHeadlessTurn(): boolean {
  return headlessAls.getStore() === true;
}

/** 当前回合用户消息文本（无回合作用域/非用户回合=undefined——直写门据此保守拒绝） */
export function currentTurnUserText(): string | undefined {
  const s = turnAls.getStore();
  return s && s.kind === 'user' ? s.userText : undefined;
}

/** 给当前回合打网络来源污点（无作用域时 no-op：非回合内调用不产生跨回合污染） */
export function markTurnNetworkTaint(): void {
  const s = turnAls.getStore();
  if (s) s.networkTainted = true;
}

/** 当前回合是否已被网络来源工具污点（无作用域=undefined——调用方按需保守处理） */
export function isCurrentTurnNetworkTainted(): boolean | undefined {
  return turnAls.getStore()?.networkTainted;
}
