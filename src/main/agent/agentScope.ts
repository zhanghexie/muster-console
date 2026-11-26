import { runOutsideToolInvocation } from '../runtimeKernel/toolInvocation';
import { AsyncLocalStorage } from 'node:async_hooks';

/** 当前工具/回合所属工作区：并行多区 Agent 时供 resolveBubbleWorkspaceId 使用 */
const als = new AsyncLocalStorage<string>();

export function runAsAgentWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return als.run(workspaceId, fn);
}

export function currentAgentWorkspaceId(): string | undefined {
  return als.getStore();
}

/**
 * 当前调用是否发自调度 Agent 的工具执行链（piProvider executeTool 起）。
 * 派活标记（SessionMeta.orchestrated）只认这个身份：调度经 sessions.create /
 * sessions.create / sessions.message 拉起或派活的会话自动置 true；
 * 用户 UI（IPC 直调）、扩展面板（ext-tool）、Worker 白名单工具不带此上下文，不置。
 * 注意：上下文只沿「本调用链」传播——由其他源（如槽位释放事件）在调度上下文
 * 之外发起的延迟执行（delegate 队列 drain）拿不到身份，需入队时显式捕获旗标、
 * 执行时重包（delegateQueue.orchestrated）。
 */
const schedulerToolAls = new AsyncLocalStorage<true>();

export function runAsSchedulerTool<T>(fn: () => Promise<T>): Promise<T> {
  return schedulerToolAls.run(true, fn);
}

export function isSchedulerInvocation(): boolean {
  return schedulerToolAls.getStore() === true;
}

/**
 * 当前调用所属的会话 id（GUI/CLI 工具执行链）。
 *
 * 与 `__actorSessionId` 的区别：那个是**参数注入**（按 shared/hostTools meta 的
 * bind 字段逐工具决定），只覆盖注册为 actor 的工具；这里是**上下文作用域**，随
 * 整条调用链传播，用于「父是谁」这类宿主要自己判断、模型不该自报的场景——
 * 如 sessions.create 的 asSubagent：父必须是调用者本人，模型传什么都不算数。
 */
const sessionAls = new AsyncLocalStorage<string>();
export interface GuiExecutionTurn {
  sessionId: string; turnId: string; isCurrent(): boolean;
  desktopTurnId?: string; isDesktopCurrent?(): boolean;
}
const guiTurnAls = new AsyncLocalStorage<Readonly<GuiExecutionTurn>>();
const ptyDesktopTurnAls = new AsyncLocalStorage<Readonly<import('../desktop/ptyDesktopTurns').PtyDesktopTurn>>();

export function runAsAgentSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return sessionAls.run(sessionId, fn);
}

/** 调用链上的会话 id；宿主直调（调度/UI/自动化）无此上下文 */
export function currentAgentSessionId(): string | undefined {
  return sessionAls.getStore();
}

/** The GUI gateway captures this identity from the host, never from tool arguments. */
export function runAsGuiExecutionTurn<T>(turn: GuiExecutionTurn, fn: () => Promise<T>): Promise<T> {
  return guiTurnAls.run(Object.freeze({ ...turn }), fn);
}

export function currentGuiExecutionTurn(): Readonly<GuiExecutionTurn> | undefined {
  return guiTurnAls.getStore();
}

/** Captured by the authenticated PTY gateway from the host process generation. */
export function runAsPtyDesktopTurn<T>(turn: import('../desktop/ptyDesktopTurns').PtyDesktopTurn, fn: () => Promise<T>): Promise<T> {
  return ptyDesktopTurnAls.run(Object.freeze({ ...turn }), fn);
}

export function currentPtyDesktopTurn(): Readonly<import('../desktop/ptyDesktopTurns').PtyDesktopTurn> | undefined {
  return ptyDesktopTurnAls.getStore();
}

/** Host-owned scheduler identity, captured separately for each tool invocation. */
export interface SchedulerDesktopExecutionTurn {
  sessionId: string;
  desktopTurnId: string;
  isDesktopCurrent(): boolean;
}
const schedulerDesktopSourceAls = new AsyncLocalStorage<() => SchedulerDesktopExecutionTurn | undefined>();
const schedulerDesktopTurnAls = new AsyncLocalStorage<{ turn?: Readonly<SchedulerDesktopExecutionTurn> }>();

export function runWithSchedulerDesktopTurnSource<T>(source: () => SchedulerDesktopExecutionTurn | undefined, fn: () => Promise<T>): Promise<T> {
  return schedulerDesktopSourceAls.run(source, fn);
}

/** Capture before a tool can await; later steering cannot replace this snapshot. */
export function runAsCapturedSchedulerDesktopTurn<T>(fn: () => Promise<T>): Promise<T> {
  // Nested work is part of the already-captured invocation, including when
  // that invocation started without a valid desktop turn.
  const inherited = schedulerDesktopTurnAls.getStore();
  if (inherited) return schedulerDesktopTurnAls.run(inherited, fn);
  const turn = schedulerDesktopSourceAls.getStore()?.();
  return schedulerDesktopTurnAls.run({ turn: turn ? Object.freeze({ ...turn }) : undefined }, fn);
}

export function currentSchedulerDesktopExecutionTurn(): Readonly<SchedulerDesktopExecutionTurn> | undefined {
  return schedulerDesktopTurnAls.getStore()?.turn;
}

export function runOutsideSchedulerDesktopTurn<T>(fn: () => T): T {
  return schedulerDesktopSourceAls.exit(() => schedulerDesktopTurnAls.exit(fn));
}

export function runOutsideGuiExecutionTurn<T>(fn: () => Promise<T>): Promise<T> {
  return guiTurnAls.exit(fn);
}

/** Host background work must not inherit the sender's model/tool identity. */
export function runOutsideAgentScope<T>(fn: () => T): T {
  return runOutsideToolInvocation(() => als.exit(() => schedulerToolAls.exit(() => sessionAls.exit(() => guiTurnAls.exit(() =>
    ptyDesktopTurnAls.exit(() => runOutsideSchedulerDesktopTurn(fn)))))));
}
