import { isOpen, materializeForExecution } from './lifecycle';
/**
 * AgentSessionHost 会话级操作：归档（release）、清空（clear，对齐调度 /new）、
 * fork 新会话与排队消息的撤回/改写/重排。
 */
import { guiMessageText } from '../../../shared/guiWorker';
import { app } from 'electron';
import fs from 'node:fs';
import { attachmentDir, forkAttachments } from '../../attachments/service';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { GuiSeedMessage } from '../types';
import { t } from '../../../shared/i18n';
import {controlRootFor,requireWorkspace} from '../../workspacePaths';
import { maybeWriteExitSummary } from '../../metaAgent/journalExitSummary';
import type { HostCore, QueuedItem } from './internal';
import { FORK_TRANSCRIPT_MAX } from './internal';
import { applyInjectQueueChange, getDriver, log, persistEntry, push, syncEntry, applySignal, cancelStreamingPersist } from './base';
import { rejectSubagentApprovalsFor } from './approvals';
import { purgeEngine } from './lifecycle';
import { abort } from './messaging';
import { endWorkspaceContext } from './workspaceContext';
import { lockForkSource } from './forkLock';
import { guiMessagesVersion, advanceGuiMessagesVersion } from './messagesVersion';
import {ownArchiveOperation} from './archiveOwnership';
import {disposeNodeReplSession} from '../tools/nodeRepl';
import { retireSessionResource, retireSessionWriter, hasMaterializationRetirement, ConnectionCleanupError, markRetirementFailure, retireConnection, retirePendingConnection, retirementBarrier } from './retirement';
import { ensureConnection } from './connection';
import { publishSessionRemindersChanged, purgeSessionReminders } from '../../sessionReminders/service';
import { publishModelRequestRecording } from '../modelRequestEvents';

/**
 * fork transcript 前缀（纯函数；无种子回放能力的引擎降级用）：首轮 prompt 前置，
 * 只进引擎、不进 UI 历史。格式与截断上限是给 LLM 的上下文协议，勿改字面。
 */
export function forkTranscriptFromSeeds(seeds: GuiSeedMessage[]): string {
  const body = seeds.map((s) => `【${s.role === 'user' ? '用户' : '助手'}】${s.text}`).join('\n\n');
  return (
    '[本会话 fork 自另一会话，以下是先前的对话记录，仅作上下文参考]\n' +
    (body.length > FORK_TRANSCRIPT_MAX ? `${body.slice(0, FORK_TRANSCRIPT_MAX)}\n…（过长已截断）` : body)
  );
}

/**
 * 从任意消息处 fork 新会话：UI 历史复制到新会话（截到 fork 点，含该消息）；
 * 有可靠原生截点时分叉引擎会话；其他情况延续原有种子回放或 transcript 前缀。
 */
export async function forkSession(
  host: HostCore, sessionId: string, uptoMessageId?: string,
  opts?: { hidden?: boolean; name?: string; activate?: boolean; messagingOwner?: string }
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  if (!isOpen(host,sessionId)) return {ok:false,error:t('GUI 会话未打开')};
  let entry=host.entries.get(sessionId);
  const src=host.ctx.sessions.get(sessionId);
  if(!src?.runtime)return {ok:false,error:t('GUI 会话未打开')};
  if(opts?.messagingOwner && src.meta?.musterMessagingOwner!==opts.messagingOwner)return {ok:false,error:'Messaging Session ownership changed.'};
  if(entry&&(entry.forking||entry.clearing||entry.closed||entry.busy||entry.pendingSends))return {ok:false,error:'会话正在执行其他操作，请稍后再试'};
  let unlock:()=>void=()=>{};
  let nativeCreatedToken:string|undefined;
  try {
    const pending=entry?null:host.store.loadPendingFork(sessionId);
    if(entry?.forkPendingError||entry?.forkDeliveryState==='unknown'||pending&&pending.state!=='delivered'&&pending.state!=='pending')throw new Error(entry?.forkPendingError??t('分叉上下文尚未完成，请先发送或检查原生历史'));
    const page=entry?null:host.store.loadRangeSnapshot(sessionId,undefined,1,uptoMessageId);
    let cut=entry?(uptoMessageId?entry.messages.findIndex(m=>m.id===uptoMessageId):entry.messages.length-1):page!.before+page!.messages.length-1;
    const selected=entry?entry.messages[cut]:page!.messages.find(m=>!uptoMessageId||m.id===uptoMessageId);
    if(!selected||cut<0)return {ok:false,error:t(uptoMessageId?'fork 点不存在（消息可能已被清空）':'会话还没有消息，直接发消息即可')};
    let native:{status:'forked';token:string;preservesPointIds?:boolean}|undefined;
    const sourceToken=src.runtimeResumeToken;
    const storedPoint=getDriver(host,src.runtime)?.supportsNativeFork===false?undefined:host.store.loadForkPoint(sessionId,selected.id);
    // Codex attached continuations hide inherited turns from the history RPC.
    // Keep the original recorded token available for verifying those points.
    const point=src.runtime==='codex-gui'&&sourceToken&&storedPoint?.engine==='codex'
      ? {...storedPoint,sessionToken:sourceToken} : storedPoint;
    const attachmentPath=attachmentDir(app.getPath('userData'),`gui:${sessionId}`);
    let hasAttachments=false;
    if(fs.existsSync(attachmentPath)){const dir=fs.opendirSync(attachmentPath);try{hasAttachments=!!dir.readSync();}finally{dir.closeSync();}}
    // A native engine needs its own model context. This is the explicit execution boundary.
    if(point&&point.role===selected.role&&point.sessionToken===sourceToken&&!hasAttachments){
      entry=entry??materializeForExecution(host,sessionId);
      cut=entry.messages.findIndex(message=>message.id===selected.id);
      if(cut<0)throw new Error(t('fork 点不存在（消息可能已被清空）'));
    }
    unlock=lockForkSource(host,sessionId);
    if(entry)entry.forking=true;
    const sourceEntry=entry;
    const version=()=>sourceEntry?guiMessagesVersion(sourceEntry):host.store.forkReadVersion(sessionId);
    let expected=version();
    const settings=JSON.stringify(src);
    const assertCurrent=()=>{
      if(!isOpen(host,sessionId)||host.entries.get(sessionId)!==sourceEntry||version()!==expected||
        sourceEntry&&(sourceEntry.closed||sourceEntry.clearing||sourceEntry.busy||sourceEntry.pendingSends)||
        JSON.stringify(host.ctx.sessions.get(sessionId))!==settings)throw new Error('分叉期间源会话已变化，请重试');
    };
    if(point&&sourceEntry&&!hasAttachments&&point.sessionToken===sourceToken){
      try{
        const conn=await ensureConnection(host,sourceEntry);
        expected=version();
        assertCurrent();
        if(conn.nativeFork){
          const recordedToken=storedPoint?.sessionToken!==point.sessionToken?storedPoint?.sessionToken:undefined;
          const result=await conn.nativeFork(point,recordedToken);
          if(result.status==='forked'){native=result;nativeCreatedToken=result.token;}
        }
      }catch(error){
        if(error instanceof ConnectionCleanupError){sourceEntry.forkPendingError=t('无法确认分叉进程已回收：{{detail}}', { detail: (error as Error).message });markRetirementFailure(host,sessionId,error);retireConnection(host,sourceEntry);}
        throw error;
      }
    }
    assertCurrent();
    function* prefix():IterableIterator<GuiChatMessage>{
      let cursor=0;
      while(cursor<=cut){
        assertCurrent();
        const end=Math.min(cut+1,cursor+120);
        const messages=sourceEntry?sourceEntry.messages.slice(cursor,end):host.store.loadRangeSnapshot(sessionId,end,end-cursor).messages;
        if(messages.length!==end-cursor)throw new Error('GUI fork history range changed');
        for(const message of messages)yield message;
        cursor=end;
      }
    }
    const created=await host.ctx.sessions.createTerminal({runtime:src.runtime,cwd:src.cwd??'',workspaceId:src.workspaceId,sourceSessionId:sessionId,
      name:opts?.name?.trim()||t('Fork · {{name}}',{name:src.name??t('GUI 会话')}),hidden:opts?.hidden===true,activate:opts?.activate,inheritSourceGuiConfig:true,
      ...(opts?.messagingOwner ? { meta: { musterMessagingOwner: opts.messagingOwner } } : {}),
      prepareGuiSession:async(session)=>{
        let owned=false;
        try{
          assertCurrent();host.store.beginForkPreparation(session.id);owned=true;
          let remap:(text:string)=>string;
          try{remap=forkAttachments(app.getPath('userData'),`gui:${sessionId}`,`gui:${session.id}`);}catch(error){throw new Error(t('分叉附件复制失败：{{detail}}', { detail: (error as Error).message }));}
          if(native){
            session.externalSessionId=native.token;
            session.runtimeResumeToken=native.token;
            session.nativeHistoryStorageKey=src.nativeHistoryStorageKey;
            session.nativeHistoryCwd=src.nativeHistoryCwd;
          }
          function* messages():IterableIterator<GuiChatMessage>{
            for(const message of prefix()){
              const clone=structuredClone(message);
              delete clone.turnChanges;delete clone.queued;delete clone.approval;delete clone.plan;delete clone.userQuestion;delete clone.retryHint;delete clone.suggestedReplies;
              delete clone.engineInputRef;
              for(const part of clone.parts)if(part.kind==='text')part.text=remap(part.text);
              if(native?.preservesPointIds){const p=host.store.loadForkPoint(sessionId,message.id);if(p&&p.sessionToken===sourceToken)host.store.saveForkPoint(session.id,message.id,{...p,sessionToken:native.token});}
              yield clone;
            }
          }
          await host.store.saveForkPrefix(session.id,messages(),assertCurrent);
          host.store.saveHostIntroDelivery(session.id, { attempt: 0, delivered: false });
          if(native)host.store.clearPendingFork(session.id);
          else{
            function* seeds():IterableIterator<GuiSeedMessage>{
              let cursor=0;
              while(cursor<=cut){const end=Math.min(cut+1,cursor+120);const page=host.store.loadRangeSnapshot(session.id,end,end-cursor);if(page.messages.length!==end-cursor)throw new Error('GUI fork prefix incomplete');for(const m of page.messages){const text=guiMessageText(m).trim();if(text)yield{role:m.role,text,ts:m.ts};}cursor=end;}
            }
            const descriptor=host.store.createForkContext(session.id,seeds());
            if(descriptor.count){const seed=!!getDriver(host,src.runtime!)?.supportsSeed;host.store.savePendingFork(session.id,{state:'pending',seed:seed?descriptor:null,transcript:seed?null:descriptor,delivery:seed?'seed':'transcript'});}
            else host.store.clearPendingFork(session.id);
          }
          assertCurrent();
        }catch(error){if(owned){try{host.store.delete(session.id);}catch(cleanup){throw new Error(t('分叉数据准备失败：{{detail}}；清理失败：{{cleanup}}', { detail: (error as Error).message, cleanup: (cleanup as Error).message }));}}throw error;}
        finally{if(owned)host.store.finishForkPreparation(session.id);}
      }});
    return {ok:true,sessionId:created.id};
  }catch(error){return {ok:false,error:`创建会话失败：${(error as Error).message}${nativeCreatedToken?`（已创建原生会话 ${nativeCreatedToken}）`:''}`};}
  finally{if(entry)entry.forking=false;unlock();}
}

/**
 * 归档 / 合入 worktree：中止回合、拆 driver 与 MCP，保留历史文件（与 close 相对）。
 * 这样 Windows 才能删掉仍被 GUI 子进程占着的 worktree 目录。
 */
export function release(host: HostCore, sessionId: string): Promise<void> {
  return ownArchiveOperation(host,sessionId,()=>releaseOwned(host,sessionId));
}
async function releaseOwned(host:HostCore,sessionId:string):Promise<void>{
  const entry=host.entries.get(sessionId);
  host.openedSessionIds?.delete(sessionId);
  if(entry){entry.clearing=true;cancelStreamingPersist(host,sessionId);}
  const errors:unknown[]=[];
  const existingWriterRetirement=hasMaterializationRetirement(host,sessionId);
  const start=(cleanup:()=>void|Promise<void>):Promise<void>=>{
    let pending:Promise<void>;try{pending=Promise.resolve(cleanup());}catch(error){pending=Promise.reject(error);}
    void pending.catch(()=>{});return pending;
  };
  // Begin independent owners before waiting for any one of them. Register them
  // so a close/reopen cannot bypass an archive that is still reclaiming work.
  const background=start(()=>host.ctx.bgTasks?.killAllForSessionAndWait(sessionId));
  const repl=start(()=>disposeNodeReplSession(sessionId));
  retireSessionResource(host,sessionId,()=>background);
  retireSessionResource(host,sessionId,()=>repl);
  try{
    if(entry&&!entry.closed){
      try{maybeWriteExitSummary(host.ctx,{sessionId:entry.sessionId,sessionName:host.ctx.sessions.get(sessionId)?.name??'',workspaceId:entry.workspaceId,
        workspaceRoot:controlRootFor(requireWorkspace(host.ctx.config.get(),entry.workspaceId)),messages:entry.messages});}catch{/* Optional exit summary. */}
      try{await abort(host,sessionId);}catch(error){errors.push(error);}
      const wasBusy=entry.busy;
      const attempt=(work:()=>void)=>{try{work();}catch(error){errors.push(error);}};
      attempt(()=>{if(entry.activeDesktopTurnId)host.ctx.desktopTurns?.().end(entry.sessionId,entry.activeDesktopTurnId);});
      entry.busy=false;entry.activeTurnStartedAt=undefined;entry.activeExecutionTurnId=undefined;entry.activeDesktopTurnId=undefined;entry.queue=[];
      attempt(()=>applyInjectQueueChange(host,entry));
      attempt(()=>rejectSubagentApprovalsFor(host,entry,t('会话已归档')));
      const conn=retireConnection(host,entry);retirePendingConnection(host,entry,entry.connecting,conn);
      attempt(()=>persistEntry(host,entry,[entry.assistant]));
      attempt(()=>endWorkspaceContext(entry));entry.toolset=null;
      if(wasBusy)attempt(()=>push(host,{kind:'busy',sessionId,busy:false,queued:0}));
    }
    // A failed materialization already owns the writer's release. Sharing that
    // retirement prevents a second release racing its still-pending cleanup.
    if(!existingWriterRetirement)retireSessionWriter(host,sessionId,()=>host.store.release(sessionId));
    const results=await Promise.allSettled([retirementBarrier(host,sessionId),background,repl]);
    for(const result of results)if(result.status==='rejected')errors.push(result.reason);
    if(errors.length)throw new AggregateError(errors,`GUI session archive failed: ${errors.map(String).join('; ')}`);
  }finally{if(entry){entry.clearing=false;entry.closed=true;if(host.entries.get(sessionId)===entry)host.entries.delete(sessionId);}}
}

/**
 * 清空会话（对齐调度 /new：清历史 + 下轮新会话）。
 * 停当前回合、拆连接（含 MCP）、清历史文件与内存、清续聊令牌；entry 保留（下次 send 重连）。
 */
export async function clear(host: HostCore, sessionId: string): Promise<void> {
  const entry = materializeForExecution(host,sessionId);
  if (!entry || entry.closed) throw new Error(t('GUI 会话未打开: {{id}}', { id: sessionId }));
  if (entry.forking) throw new Error('会话正在分叉，请稍后再清空');
  if (entry.clearing) throw new Error('会话正在清空，请稍后再试');
  // clearing 标志：abort 后事件泵 finally 的兜底 finishTurn 可能抢在清空动作之前
  // 派发队列、白建一条连接——置位后 finishTurn 跳过派发、startTurn 拒绝开回合
  entry.clearing = true;
  advanceGuiMessagesVersion(entry);
  // 清掉流式落盘定时器：否则 2s 后 fire 把刚删掉的历史文件重建
  cancelStreamingPersist(host, sessionId);
  try {
    // This marker must precede any destructive work. It survives an abrupt
    // exit until both the GUI data and the empty session handle are durable.
    host.store.savePendingFork(sessionId, { state: 'clearing', seed: null, transcript: null });
    entry.forkSettlement = undefined;
    await abort(host, sessionId);
    rejectSubagentApprovalsFor(host, entry, t('会话已清空'));
    const conn = retireConnection(host, entry);
    retirePendingConnection(host, entry, entry.connecting, conn);
    await retirementBarrier(host, sessionId);
    entry.toolset = null;
    entry.assistant = null;
    if (entry.activeDesktopTurnId) host.ctx.desktopTurns?.().end(entry.sessionId, entry.activeDesktopTurnId);
    entry.busy = false;
    endWorkspaceContext(entry);
    entry.activeTurnStartedAt = undefined;
    entry.activeExecutionTurnId = undefined;
    entry.activeDesktopTurnId = undefined;
    entry.queue = [];
    applyInjectQueueChange(host, entry);
    entry.messages = [];
    entry.hostIntroDelivery = undefined;
    entry.pendingHostIntro = undefined;
    entry.injections = [];
    entry.injectionUpdates = new Map();
    entry.compactions = [];
    entry.compactionSeq = 0;
    entry.openCompaction = null;
    entry.lastClosedCompaction = null;
    entry.lastSteeredTexts = [];
    entry.forkSeed = null;
    entry.forkTranscript = null;
    entry.forkTranscriptSource = null;
    entry.forkDeliveryState = undefined;
    entry.forkPendingError = undefined;
    entry.forkResumeGuard = false;
    entry.forkGuardInFlight = false;
    entry.forkGuardToken = undefined;
    entry.compactOperation = undefined;
    entry.lastUsage = null;
    entry.skipUsagePersistUntilTurn = false;
    // 引擎侧旧句柄快照：作废前取，供 purge 清旧引擎会话的落盘数据
    const meta = host.ctx.sessions.get(sessionId);
    const metaSnapshot = meta ? { ...meta } : undefined;
    // 缓存条目整体作废：重进会话按当前引擎状态重新全量同步
    const validateClear = (): void => {
      if (!entry.clearing || entry.closed || host.entries.get(sessionId) !== entry) throw new Error('清空期间会话已关闭或替换');
    };
    await host.store.clearDataStrict(sessionId, validateClear);
    validateClear();
    publishModelRequestRecording(host.ctx, sessionId, false);
    host.ctx.sessions.setBoardReplyPreview?.(sessionId, '');
    // GUI /new keeps the host session ID while discarding the old conversation.
    // Clear its reminders before removing the durable clearing marker.
    purgeSessionReminders(sessionId);
    publishSessionRemindersChanged(host.ctx, { kind: 'session', sessionId });
    // 清空即清理：旧引擎会话数据（Pi jsonl / Cursor agent 行）随应用侧历史一并删。
    // Pi purge 纯同步、先于下轮同 id 新建连接完成；Cursor 旧 agentId 唯一，无复用冲突
    void purgeEngine(host, sessionId, metaSnapshot);
    // 续聊令牌作废：下轮 ensureConnection 无 token 新建引擎会话
    await host.ctx.sessions.resetRuntimeHandleStrict(sessionId, validateClear);
    validateClear();
    const clearedMeta = host.ctx.sessions.get(sessionId);
    if (!clearedMeta || clearedMeta.externalSessionId || clearedMeta.runtimeResumeToken) {
      throw new Error('会话清空期间引擎标识发生变化');
    }
    // clearDataStrict retires the old writer as well as its files. The live
    // execution entry survives /new, so bind it to a new, genuinely empty
    // projection before exposing the cleared session or accepting another turn.
    host.store.retain(sessionId, { messages: [], lastUsage: null, injections: [], compactions: [] });
    host.store.clearPendingFork(sessionId);
    syncEntry(host, entry);
    push(host, { kind: 'busy', sessionId, busy: false, queued: 0 });
    applySignal(host, entry, 'idle', 'gui-clear');
  } catch (error) {
    // Some in-memory or on-disk pieces may already have been cleared. Keep
    // this open entry blocked rather than reconnecting to an old engine state.
    entry.forkGuardInFlight = false;
    entry.forkGuardToken = undefined;
    entry.compactOperation = undefined;
    entry.forkSettlement = undefined;
    entry.forkDeliveryState = 'unknown';
    entry.forkPendingError = `会话清空未完成，已停止自动续写：${(error as Error).message}；请检查本地历史后再处理`;
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId, message: entry.forkPendingError });
    throw new Error(entry.forkPendingError);
  } finally {
    entry.clearing = false;
  }
}

/** 撤回排队中的用户消息（对齐调度：队列与历史一并移除） */
export function cancelQueued(host: HostCore, sessionId: string, messageId: string): boolean {
  const entry = host.entries.get(sessionId) ?? (isOpen(host,sessionId)?materializeForExecution(host,sessionId):undefined);
  if (!entry || entry.forking) return false;
  const idx = entry.queue.findIndex((q) => q.messageId === messageId);
  if (idx < 0) return false;
  entry.queue.splice(idx, 1);
  entry.messages = entry.messages.filter((m) => m.id !== messageId);
  persistEntry(host, entry, 'replace');
  syncEntry(host, entry);
  applyInjectQueueChange(host, entry);
  // 渲染层排队胶囊跟 busy 推送走：撤回后必须补推，否则胶囊滞留到回合结束
  push(host, { kind: 'busy', sessionId, busy: entry.busy, queued: entry.queue.length });
  return true;
}

/** 改写一条排队消息的内容（queue 与消息历史同步改；未轮到执行的才可改） */
export function editQueued(host: HostCore, sessionId: string, messageId: string, text: string): boolean {
  const entry = host.entries.get(sessionId) ?? (isOpen(host,sessionId)?materializeForExecution(host,sessionId):undefined);
  if (!entry || entry.forking) return false;
  const content = (text ?? '').trim();
  if (!content) return false;
  const q = entry.queue.find((item) => item.messageId === messageId);
  if (!q) return false;
  q.text = content;
  // 行内编辑只改文本，随文图片保留
  const msg = entry.messages.find((m) => m.id === messageId);
  if (msg) {
    const parts = msg.parts.filter((p) => p.kind !== 'text');
    msg.parts = [{ kind: 'text', text: content }, ...parts];
  }
  persistEntry(host, entry, [msg]);
  syncEntry(host, entry);
  push(host, { kind: 'busy', sessionId, busy: entry.busy, queued: entry.queue.length });
  return true;
}

/**
 * 重排纯函数：按目标顺序重排排队条目；ids 未覆盖的（并发窗口新入队的）
 * 保序追加在尾部，不丢消息。顺序无变化返回 null（调用方免落盘/推送）。
 */
export function reorderQueueItems(queue: QueuedItem[], orderedIds: string[]): QueuedItem[] | null {
  const byId = new Map(queue.map((q) => [q.messageId, q]));
  const next: QueuedItem[] = [];
  for (const id of orderedIds) {
    const hit = byId.get(id);
    if (hit) {
      next.push(hit);
      byId.delete(id);
    }
  }
  for (const rest of byId.values()) next.push(rest);
  if (next.length === queue.length && next.every((q, i) => q === queue[i])) {
    return null;
  }
  return next;
}

/** 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序 */
export function reorderQueued(host: HostCore, sessionId: string, orderedIds: string[]): boolean {
  const entry = host.entries.get(sessionId) ?? (isOpen(host,sessionId)?materializeForExecution(host,sessionId):undefined);
  if (!entry || entry.forking) return false;
  const next = reorderQueueItems(entry.queue, orderedIds);
  if (!next) return false;
  entry.queue = next;
  const order = new Map(next.map((q, i) => [q.messageId, i]));
  const queuedMsgs = entry.messages.filter((m) => m.queued);
  queuedMsgs.sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  );
  const others = entry.messages.filter((m) => !m.queued);
  entry.messages = [...others, ...queuedMsgs];
  persistEntry(host, entry, 'replace');
  syncEntry(host, entry);
  push(host, { kind: 'busy', sessionId, busy: entry.busy, queued: entry.queue.length });
  return true;
}
