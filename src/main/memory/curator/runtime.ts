import { createHash, randomUUID } from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { MemoryCuratorCandidate, MemoryCuratorReceipt, MemoryCuratorSnapshot } from '../../../shared/memoryCurator';
import { runOutsideAgentScope } from '../../agent/agentScope';
import { runAsNonUserTurn } from '../../agent/turnScope';
import { redactCredentialShapes } from '../redact';
import { CuratorQueue, type CuratorClaim,type CuratorQueueState } from './queue';
import { createMemoryCuratorPiFactory } from './pi';
import { createCuratorTools,type CuratorToolContext } from './tools';
import { formatCuratorCandidates, formatCuratorUserInput,formatCuratorReceiptRepair } from './prompt';
import type { CuratorDecisionReceipt } from './storageTypes';
import type { CuratorSession, CuratorSessionEvent, CuratorSessionTool, MemoryCuratorRuntimeOptions } from './types';
import {curatorRetryDecision} from './retry';
import {CuratorBudgetError,curatorContextBudget,curatorRequestLimit} from './budget';
import {validateCuratorDraft} from './draftDiagnostics';

const finite = (value: number | undefined, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.floor(Math.max(min, Math.min(max, value!))) : fallback;
const errorText = (error: unknown) => redactCredentialShapes(error instanceof Error ? error.message : String(error)).text.slice(0, 1500);
function assertReceipt(receipt:CuratorDecisionReceipt,candidateId:string,correction?:MemoryCuratorCandidate['correction']):void {
  if(!receipt||receipt.candidateId!==candidateId||typeof receipt.operationId!=='string'||!receipt.operationId
    ||typeof receipt.policyVersion!=='string'||!receipt.policyVersion||typeof receipt.reason!=='string'||!Number.isFinite(receipt.at)
    ||!['save','duplicate','discard','history','suspend','supersede','delete','restore','correct'].includes(receipt.decision)
    ||!['active','duplicate','retained_ephemeral','discarded','suspended','superseded','rejected','updated','needs_user'].includes(receipt.disposition)
    ||!Array.isArray(receipt.affected)||receipt.affected.some(item=>!item||typeof item.id!=='string'||!Number.isInteger(item.revision)||item.revision<1))throw new Error('记忆持久回执格式无效或不属于当前候选');
  if(!correction&&(receipt.decision==='correct'||['updated','needs_user'].includes(receipt.disposition)))throw new Error('普通候选不能接收纠错回执');
  if(correction&&(receipt.targetId!==correction.memoryId||receipt.targetRevision!==correction.revision
    ||!['correct','suspend','discard'].includes(receipt.decision)||!['updated','suspended','discarded','rejected','needs_user'].includes(receipt.disposition)
    ||receipt.disposition==='updated'&&(receipt.decision!=='correct'||receipt.record?.id!==correction.memoryId||receipt.record.revision!==correction.revision+1||receipt.record.userManaged===true)
    ||receipt.disposition==='suspended'&&(receipt.decision!=='suspend'||receipt.record?.id!==correction.memoryId||receipt.record.revision!==correction.revision+1)
    ||receipt.disposition==='needs_user'&&(!receipt.proposedCorrection||!['correct','suspend'].includes(receipt.proposedCorrection.decision)||receipt.proposedCorrection.decision!==receipt.decision
      ||receipt.record?.id!==correction.memoryId||receipt.record.revision!==correction.revision||receipt.record.userManaged!==true||receipt.affected.length>0)))throw new Error('纠错回执目标、结果或用户保护格式无效');
  if(receipt.proposedCorrection)validateCuratorDraft(receipt.proposedCorrection.draft,receipt.proposedCorrection.decision==='correct'?'save':'suspend');
}
let activeWorkers = 0;
/** One durable queue and one lazy Pi session. No constructor, snapshot or idle path requests a model. */
export class MemoryCuratorRuntime {
  private readonly queue: CuratorQueue;
  private readonly owner = randomUUID();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private messages: GuiChatMessage[]=[];
  private generation=0;
  private transcriptVersion=0;
  private sessionFile?:string;
  private sessionId?:string;
  private session?: CuratorSession;
  private sessionEpoch = 0;
  private processing?: Promise<void>;
  private controller?: AbortController;
  private activeTools = new Map<string, CuratorSessionTool>();
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private assistant?: GuiChatMessage;
  private stopped = false;
  private cancelling = false;
  private lastError?: string;
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private evidenceReads = 0;
  private contextCharacters = 0;
  private sessionKey?: string;
  private retryAfterMs = 50;
  private policySignature: string;
  constructor(private readonly options: MemoryCuratorRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = finite(options.timeoutMs, 600_000, 25, 600_000);
    this.maxRequests = curatorRequestLimit(options.maxModelRequests);
    this.queue = new CuratorQueue(options.root, options.directory, this.now);
    this.adoptState(this.queue.sessionState());
    this.policySignature = this.currentPolicySignature();
    // Boot/workspace-open explicitly calls requestDrain. Constructing a read-only view never wakes Pi.
  }
  inspect(input?: import('../../../shared/memoryCurator').MemoryCuratorQueueQuery): import('../../../shared/memoryCurator').MemoryCuratorQueuePage {
    return this.queue.inspect(input);
  }
  correctionStatus(requestId:string,requesterSessionId:string):import('../../../shared/memoryCurator').MemoryCorrectionStatus {
    return this.queue.correctionStatus(requestId,requesterSessionId);
  }
  setArchived(candidateId:string,archived:boolean):{changed:boolean} {
    const changed=this.queue.setArchived(candidateId,archived);this.publish();return {changed};
  }
  snapshot(): MemoryCuratorSnapshot {
    const persisted=this.queue.sessionState();
    if(!this.processing)this.adoptState(persisted);
    const current=persisted.generation===this.generation;
    const paused = this.queue.paused || this.options.mode?.() === 'paused' || this.options.enabled?.() === false;
    const error=current?this.lastError:persisted.error;
    const snapshot = { workspaceId: this.options.workspaceId, sessionId: (current?this.session?.id||this.sessionId:persisted.sessionId)||null,
      generation: persisted.generation, status: paused ? 'paused' : this.processing ? 'running' : error ? 'error' : 'idle',
      paused, ...this.queue.counts(), running: !!this.processing, messages: current?this.messages:persisted.messages, error, updatedAt: this.now(), model: this.session?.model ?? this.selectedModel().model };
    return JSON.parse(redactCredentialShapes(JSON.stringify(snapshot)).text) as MemoryCuratorSnapshot;
  }
  /** Synchronous local maintenance uses the queue DB as a cross-process idle/claim guard. */
  withMaintenance<T>(run:(queue:DatabaseSync)=>T):T {
    if(this.stopped||this.processing||this.cancelling)throw new Error('记忆会话仍在处理，暂不能维护');
    return run(this.queue.db);
  }
  enqueue(candidate: MemoryCuratorCandidate): MemoryCuratorReceipt {
    if (this.stopped) return { queued: false, candidateId: candidate.id, reason: '记忆会话已停止' };
    const receipt = this.queue.enqueue(candidate, 'candidate', `${this.options.policyVersion ?? 'memory-curator-v1'}:${this.options.mode?.() ?? 'automatic'}`);
    this.publish(); if (receipt.queued) this.requestDrain(); return receipt;
  }
  async send(text: string): Promise<{ accepted: boolean }> {
    if (this.stopped || !this.options.userCandidate || typeof text !== 'string' || !text.trim() || text.length > 6000) return { accepted: false };
    const candidate = this.options.userCandidate(text);
    if (candidate.origin !== 'user' || candidate.sourceText !== redactCredentialShapes(text).text) throw new Error('记忆用户请求必须绑定原始用户身份与原文');
    const receipt = this.queue.enqueue(candidate, 'user', `${this.options.policyVersion ?? 'memory-curator-v1'}:${this.options.mode?.() ?? 'automatic'}`);
    this.publish(); if (receipt.queued) this.requestDrain(); return { accepted: receipt.queued };
  }
  /** May be called after enabling the feature; merely viewing state never calls this. */
  requestDrain(): void {
    if (this.stopped || this.cancelling || this.processing || !this.allowed()) return;
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = undefined; }
    if (!this.queue.counts().pending) return;
    // Both identity and user-intent ALS scopes are replaced before any asynchronous work starts.
    this.processing = runOutsideAgentScope(() => runAsNonUserTurn(() => Promise.resolve().then(() => this.drain())))
      .catch(error => { this.lastError = errorText(error); this.queue.setIfCurrent('error', this.lastError,this.generation); })
      .finally(() => { this.processing = undefined; this.publish(); this.scheduleNext(); });
    this.publish();
  }
  retryFailed(): number {
    const changed = this.queue.retryFailed();
    this.lastError = undefined; this.queue.set('error', ''); this.publish(); this.requestDrain(); return changed;
  }
  /** Config watcher entry: never changes the separate per-workspace user pause flag. */
  async refreshPolicy(): Promise<MemoryCuratorSnapshot> {
    if (this.stopped) throw new Error('记忆会话已停止');
    const signature = this.currentPolicySignature(), changed = signature !== this.policySignature;
    this.policySignature = signature;
    if (changed || !this.allowed()) {
      this.cancelling = true;
      try { await this.interrupt(); this.disposeSession(); } finally { this.cancelling = false; }
      if (changed && this.options.enabled?.() !== false && this.options.mode?.() !== 'paused') {
        this.queue.retryFailed(); this.lastError = undefined; this.queue.set('error', '');
      }
    }
    this.publish(); this.requestDrain(); return this.snapshot();
  }
  async setPaused(paused: boolean): Promise<MemoryCuratorSnapshot> {
    this.queue.set('paused', String(paused));
    if (paused) await this.interrupt(); else this.requestDrain();
    this.publish(); return this.snapshot();
  }
  async clear(): Promise<MemoryCuratorSnapshot> {
    this.cancelling = true;
    try {
      // Publish the new generation first. Other processes cannot publish old transcript/session state.
      this.queue.clearTranscript();await this.interrupt();this.disposeSession();this.adoptState(this.queue.sessionState());
    } finally { this.cancelling = false; }
    this.publish(); this.requestDrain(); return this.snapshot();
  }
  private stopping?: Promise<void>;
  private readonly aborting = new WeakMap<CuratorSession, Promise<void>>();
  private abortSession(session?: CuratorSession): Promise<void> {
    if (!session) return Promise.resolve();
    const existing = this.aborting.get(session); if (existing) return existing;
    const pending = Promise.resolve().then(() => session.abort());
    this.aborting.set(session, pending);
    void pending.then(() => this.aborting.delete(session), () => this.aborting.delete(session));
    return pending;
  }
  stopAdmission(): void { this.stopped = true; }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.cancelling = true;
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    this.stopping = (async () => {
      await this.interrupt();
      this.disposeSession();
      this.queue.close();
    })();
    void this.stopping.catch(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private allowed(): boolean { return !this.queue.paused && this.options.enabled?.() !== false && this.options.mode?.() !== 'paused'; }
  private publish(): void {
    if (this.stopped) return;
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    try { this.options.onChanged?.(this.snapshot()); } catch (error) { console.warn('[memory-curator] snapshot listener failed', errorText(error)); }
  }
  private publishStream(): void {
    if (this.publishTimer || this.stopped) return;
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; this.publish(); }, 75);
    this.publishTimer.unref?.();
  }
  private adoptState(state:CuratorQueueState):void {
    if(this.generation!==state.generation||this.transcriptVersion!==state.version||this.sessionFile!==state.sessionFile||this.sessionId!==state.sessionId)this.disposeSession();
    this.generation=state.generation;this.transcriptVersion=state.version;this.sessionFile=state.sessionFile;this.sessionId=state.sessionId;
    this.contextCharacters=state.contextCharacters;this.lastError=state.error;
    this.messages=state.messages.map(message=>({...message,parts:message.parts.filter(part=>part.kind!=='thinking').map(part=>part.kind==='tool'&&part.tool.status==='running'?{...part,tool:{...part.tool,status:'cancelled' as const}}:part)}));
  }
  private persist(): void {
    const version=this.queue.saveMessages(this.messages,this.generation,this.owner);
    if(version!==undefined)this.transcriptVersion=version;
    this.publish();
  }
  private disposeSession(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    this.sessionEpoch++; this.session?.dispose(); this.session = undefined; this.activeTools.clear();
  }
  private async interrupt(): Promise<void> {
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = undefined; }
    const session = this.session;
    this.controller?.abort(new Error('记忆处理已由宿主停止'));
    const results = await Promise.allSettled([this.abortSession(session), this.processing]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '记忆处理停止失败');
  }
  private scheduleNext(): void {
    if (this.stopped || this.cancelling || !this.allowed()) return;
    const next = this.queue.nextWakeAt();
    if (next !== undefined) {
      this.wakeTimer = setTimeout(() => runOutsideAgentScope(() => runAsNonUserTurn(() => this.requestDrain())), Math.max(this.retryAfterMs, Math.min(30_000, next - this.now() + 1)));
      this.wakeTimer.unref?.();
    } else if (this.session) {
      this.idleTimer = setTimeout(() => { if (!this.processing) this.disposeSession(); }, finite(this.options.idleDisposeMs, 300_000, 1000, 3_600_000));
      this.idleTimer.unref?.();
    }
  }
  private async ensureSession(): Promise<CuratorSession> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (this.session) return this.session;
    const factory = this.options.createSession ?? (this.options.pi && createMemoryCuratorPiFactory(this.options.pi));
    if (!factory) throw new Error('专用记忆Pi会话尚未配置');
    const epoch = ++this.sessionEpoch;
    const tools = [...this.activeTools.values()].map(tool => ({ ...tool, execute: async (input: Record<string, unknown>, signal?: AbortSignal) => {
      const current = this.activeTools.get(tool.name); if (!current || this.sessionEpoch !== epoch) throw new Error('当前没有可处理的记忆任务');
      return current.execute(input, signal);
    } }));
    const session = await factory({ root: this.options.root, directory: this.options.directory, sessionFile: this.sessionFile,
      tools, maxModelRequests: this.maxRequests,beforeModelRequest:()=>{
        if(this.sessionEpoch!==epoch||!this.controller||this.stopped||this.cancelling||!this.allowed()||this.queue.generation!==this.generation)throw new Error('记忆模型请求已暂停、过期或会话已换代');
        this.controller.signal.throwIfAborted();
        if(this.requests>=this.maxRequests)throw new CuratorBudgetError('requests');
      },onEvent: event => { if (this.sessionEpoch === epoch) this.onSessionEvent(event); } });
    if (this.controller?.signal.aborted || this.sessionEpoch !== epoch || this.stopped||!this.queue.publishSession(this.owner,this.generation,session.id,session.file)) { session.dispose(); throw new Error('记忆会话连接已取消或代次已变化'); }
    this.session = session;this.sessionId=session.id;this.sessionFile=session.file;
    this.sessionKey = this.selectedModel().key;
    return session;
  }
  private async drain(): Promise<void> {
    this.retryAfterMs = 50;
    if (activeWorkers >= 2) { this.retryAfterMs = 1000; return; }
    activeWorkers++;
    try { await this.drainExclusive(); } finally { activeWorkers--; }
  }
  private selectedModel(): { key?: string; limit: number; model?: { providerId?: string; modelId?: string; name?: string } } {
    if (!this.options.pi) return { limit: curatorContextBudget().rotateCharacters };
    const config = this.options.pi.config(), target = this.options.pi.targetModel?.();
    const providerId = target?.providerId || config.llm?.activeProviderId, modelId = target?.modelId || config.llm?.activeModelId;
    const provider = config.llm?.providers.find(p => p.id === providerId), model = provider?.models.find(m => m.id === modelId);
    return { key: createHash('sha256').update(JSON.stringify({ provider, model })).digest('hex'),
      limit: curatorContextBudget(model).rotateCharacters,
      model: { providerId, modelId, name: model?.name || modelId } };
  }
  private currentPolicySignature(): string { return `${this.options.enabled?.() !== false}:${this.options.mode?.() ?? 'automatic'}:${this.selectedModel().key ?? ''}`; }
  private async drainExclusive(): Promise<void> {
    const leaseMs = this.timeoutMs + 10_000;
    if (!this.allowed()) return;
    if (!this.queue.acquire(this.owner, leaseMs)) { this.retryAfterMs = 1000; return; }
    this.adoptState(this.queue.sessionState());
    const selected = this.selectedModel();
    if ((this.session && this.sessionKey !== selected.key) || this.contextCharacters >= selected.limit) {
      this.disposeSession();if(!this.queue.rotateSession(this.generation,this.owner)){this.queue.release(this.owner);return;}this.adoptState(this.queue.sessionState());
    }
    const claims = this.queue.claim(finite(this.options.maxBatch, 3, 1, 3), leaseMs,!!this.options.receipt);
    if (!claims.length) { this.queue.release(this.owner); return; }
    const generation = this.generation, controller = new AbortController(), policySignature = this.currentPolicySignature();
    const startedAt = this.now(), runId = randomUUID();
    this.controller = controller; this.requests = 0; this.inputTokens = 0; this.outputTokens = 0; this.evidenceReads = 0;
    const handled = new Set<string>(), confirmed=new Set<string>(),active = new Map(claims.map(claim => [claim.candidate.id, claim]));
    let toolContext:CuratorToolContext|undefined,aborted:Promise<never>|undefined;
    const assertCurrent = (id: string) => {
      controller.signal.throwIfAborted();
      if (!this.allowed() || this.stopped || this.cancelling) throw new Error('记忆处理已暂停或停止');
      if (this.currentPolicySignature() !== policySignature) throw new Error('记忆配置或策略已改变，拒绝迟到处理');
      const claim = active.get(id); if (!claim || handled.has(id)) throw new Error('候选不属于本轮或已有真实处理回执');
      this.queue.assertClaim(claim, generation);
    };
    const settle = (claim: CuratorClaim, result: CuratorDecisionReceipt) => {
      assertCurrent(claim.candidate.id);assertReceipt(result,claim.candidate.id,claim.candidate.correction);this.queue.settle(claim,result);
      handled.add(claim.candidate.id);confirmed.add(claim.candidate.id);
      if(toolContext)toolContext.candidates=toolContext.candidates.filter(candidate=>!handled.has(candidate.id));
    };
    const reconcileReceipts=async()=>{
      for(const claim of claims){
        if(handled.has(claim.candidate.id))continue;
        assertCurrent(claim.candidate.id);const pending=Promise.resolve(this.options.receipt?.(claim.candidate));
        const receipt=await(aborted?Promise.race([pending,aborted]):pending);assertCurrent(claim.candidate.id);
        if(receipt)settle(claim,receipt);
      }
    };
    const timeout = setTimeout(() => controller.abort(new CuratorBudgetError('time')), this.timeoutMs);
    let abortListener: (() => void) | undefined,rotateAfter=false,repairs=0;
    const retries:Array<{candidateId:string;status?:number;retryAt?:number;retry:boolean;budget?:string;single?:boolean}>=[];
    try {
      aborted = new Promise<never>((_, reject) => { abortListener = () => reject(controller.signal.reason ?? new Error('记忆处理已停止')); controller.signal.addEventListener('abort', abortListener, { once: true }); });
      const operation = (async () => {
        // A crash can occur after the other ledger commits and before queue.settle. Recover the
        // immutable host receipt first, before connecting Pi or asking it to make another decision.
        await reconcileReceipts();
        for(const claim of claims)if(!handled.has(claim.candidate.id)&&claim.attempts>3){this.queue.fail(claim,'处理进程中断，有限重试已用尽；未找到持久回执');handled.add(claim.candidate.id);}
        const remaining=claims.filter(claim=>!handled.has(claim.candidate.id));
        if(!remaining.length){this.lastError=undefined;this.queue.setIfCurrent('error','',generation,this.owner);return;}
        toolContext={ candidates: remaining.map(claim => claim.candidate), policyVersion: this.options.policyVersion ?? 'memory-curator-v1', assertCurrent,
          references: (candidate, query) => this.options.references(candidate, query),
          readEvidence: async (candidate, id) => this.options.readEvidence ? this.options.readEvidence(candidate, id) : { status: 'unavailable', reason: '宿主没有提供该依据内容，请使用source核对原始材料' },
          commit: async (candidate, decision) => {
            assertCurrent(candidate.id);
            const receipt: CuratorDecisionReceipt = this.options.mode?.() === 'observe'
              ? { operationId: decision.operationId, candidateId: candidate.id, policyVersion: decision.policyVersion, decision: decision.decision,
                disposition: candidate.correction?'discarded':'retained_ephemeral', affected: [], reason: '观察模式：仅记录建议，没有改变长期知识', at: this.now(),
                ...(candidate.correction?{targetId:candidate.correction.memoryId,targetRevision:candidate.correction.revision}: {}) }
              : await this.options.commit(candidate, decision, () => assertCurrent(candidate.id));
            settle(active.get(candidate.id)!, receipt); this.publish(); return receipt;
          },
          defer: (candidate, reason) => { assertCurrent(candidate.id); this.queue.defer(active.get(candidate.id)!, reason); handled.add(candidate.id);
            if(toolContext)toolContext.candidates=toolContext.candidates.filter(item=>!handled.has(item.id));this.publish(); }
        };
        const tools=createCuratorTools(toolContext);
        this.activeTools = new Map(tools.map(tool => [tool.name, tool]));
        const user = remaining[0].kind === 'user';
        const text = user ? `${formatCuratorUserInput(remaining[0].candidate.sourceText)}\n宿主绑定的请求候选ID：${remaining[0].candidate.id}` : formatCuratorCandidates(remaining.map(claim => claim.candidate));
        this.contextCharacters += text.length;
        this.messages.push({ id: randomUUID(), role: 'user', host: !user, parts: [{ kind: 'text', text: user ? remaining[0].candidate.sourceText : `收到 ${remaining.length} 条记忆候选，核对依据与已有知识。` }], ts: this.now() });
        this.assistant = { id: randomUUID(), role: 'assistant', parts: [], ts: this.now() }; this.messages.push(this.assistant);
        this.lastError = undefined; this.queue.setIfCurrent('error', '',generation,this.owner); this.persist();
        const session=await this.ensureSession();assertCurrent(remaining[0].candidate.id);
        await session.run({text,kind:user?'user':'candidate'},controller.signal);
        await reconcileReceipts();
        const missing=claims.filter(claim=>!handled.has(claim.candidate.id));
        if(missing.length){
          assertCurrent(missing[0].candidate.id);
          if(this.requests>=this.maxRequests)throw new CuratorBudgetError('requests');
          // Retain the same tool closures: comparison state and evidence read budgets do not reset.
          toolContext.candidates=missing.map(claim=>claim.candidate);repairs=1;
          const repairText=formatCuratorReceiptRepair(toolContext.candidates,confirmed.size);
          if(this.assistant)this.assistant.finishedAt=this.now();
          this.messages.push({id:randomUUID(),role:'user',host:true,parts:[{kind:'text',text:`已确认 ${confirmed.size} 条处理回执，正在补齐剩余 ${missing.length} 条。`}],ts:this.now()});
          this.assistant={id:randomUUID(),role:'assistant',parts:[],ts:this.now()};this.messages.push(this.assistant);
          this.contextCharacters+=repairText.length;this.persist();
          await session.run({text:repairText,kind:'repair'},controller.signal);
          await reconcileReceipts();
        }
      })();
      await Promise.race([operation, aborted]);
      if(this.queue.generation!==generation)throw new Error('记忆会话代次已变化');
      const missing=claims.filter(claim=>!handled.has(claim.candidate.id));
      if(missing.length){
        this.lastError=`本批已确认 ${confirmed.size}/${claims.length} 条处理回执，剩余 ${missing.length} 条经补结算仍未取得回执；已保留确认结果，未完成项可重试`;
        for(const claim of missing){
          this.queue.fail(claim,this.lastError);this.queue.setIfCurrent('error',this.lastError,generation,this.owner);
          if(this.assistant)this.assistant.error=this.lastError;
        }
      }else{this.lastError=undefined;this.queue.setIfCurrent('error','',generation,this.owner);if(this.assistant)delete this.assistant.error;}
    } catch (error) {
      let interrupted = this.queue.paused || this.cancelling || this.stopped||this.queue.generation!==generation,recoveryError:string|undefined;
      if(!interrupted){try{await reconcileReceipts();}catch(failed){recoveryError=errorText(failed);}}
      interrupted=this.queue.paused||this.cancelling||this.stopped||this.queue.generation!==generation;
      const remaining=claims.filter(claim=>!handled.has(claim.candidate.id));
      const failure=`本批已确认 ${confirmed.size}/${claims.length} 条处理回执，剩余 ${remaining.length} 条；已保留确认结果。${errorText(error)}${recoveryError?`；回执复核失败：${recoveryError}`:''}`;
      for (const claim of claims) if (!handled.has(claim.candidate.id)) {
        if (interrupted) this.queue.requeue(claim);
        else if(error instanceof CuratorBudgetError){
          const retryAt=this.now()+1000;retries.push({candidateId:claim.candidate.id,retry:claim.attempts<3,retryAt,budget:error.kind,single:true});
          this.queue.defer(claim,errorText(error),retryAt,true);
        }else {const retry=curatorRetryDecision(error,claim.attempts,this.now());retries.push({candidateId:claim.candidate.id,...retry});
          if(retry.retry||retry.retryAt!==undefined)this.queue.defer(claim,errorText(error),retry.retryAt);else this.queue.fail(claim,errorText(error));}
      }
      if (this.assistant) { this.assistant.aborted = controller.signal.aborted; if (!interrupted){if(remaining.length)this.assistant.error=failure;else delete this.assistant.error;} }
      if (!interrupted) { this.lastError = remaining.length?failure:undefined; this.queue.setIfCurrent('error', this.lastError??'',generation,this.owner); }
      controller.abort(error); await this.abortSession(this.session); this.disposeSession();
      rotateAfter=!interrupted&&error instanceof CuratorBudgetError;
    } finally {
      clearTimeout(timeout); if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      for (const part of this.assistant?.parts ?? []) if (part.kind === 'tool' && part.tool.status === 'running') part.tool.status = 'cancelled';
      if (this.assistant) this.assistant.finishedAt = this.now();
      this.queue.recordRun(runId, { startedAt, finishedAt: this.now(), candidateIds: claims.map(claim => claim.candidate.id), handled: handled.size,
        requests: this.requests, inputTokens: this.inputTokens, outputTokens: this.outputTokens, evidenceReads: this.evidenceReads, error: this.lastError,
        generation,retries,repairs,confirmed:confirmed.size, policyVersion: this.options.policyVersion ?? 'memory-curator-v1' });
      this.assistant = undefined; this.controller = undefined; this.activeTools.clear();this.queue.setIfCurrent('contextCharacters',String(this.contextCharacters),generation,this.owner);this.persist();
      if(rotateAfter&&this.queue.rotateSession(generation,this.owner))this.adoptState(this.queue.sessionState());
      this.queue.release(this.owner);
    }
  }
  private onSessionEvent(event: CuratorSessionEvent): void {
    const assistant = this.assistant;
    if (!assistant || !this.controller || this.controller.signal.aborted) return;
    if (event.type === 'model-start') {
      if (++this.requests > this.maxRequests) this.controller.abort(new CuratorBudgetError('requests'));
    } else if (event.type === 'text-delta') {
      const text = redactCredentialShapes(event.text).text, last = assistant.parts.at(-1);
      this.contextCharacters += event.text.length;
      if (last?.kind === 'text') last.text += text; else assistant.parts.push({ kind: 'text', text });
      this.publishStream();
    } else if (event.type === 'tool-start') {
      this.contextCharacters += JSON.stringify(event.input).length;
      if (event.name === 'memory_evidence') this.evidenceReads++;
      assistant.parts.push({ kind: 'tool', tool: { id: event.id, name: event.name, input: JSON.parse(redactCredentialShapes(JSON.stringify(event.input)).text), status: 'running' } }); this.persist();
    } else if (event.type === 'tool-result') {
      this.contextCharacters += event.output.length;
      const part = assistant.parts.find(part => part.kind === 'tool' && part.tool.id === event.id);
      if (part?.kind === 'tool') { part.tool.status = event.isError ? 'error' : 'ok'; part.tool.output = redactCredentialShapes(event.output).text; } this.persist();
    } else if (event.type === 'error') {
      this.lastError = errorText(event.message); assistant.error = this.lastError; this.persist();
    } else if (event.type === 'usage') {
      this.inputTokens += Math.max(0, event.inputTokens || 0); this.outputTokens += Math.max(0, event.outputTokens || 0);
    }
  }
}
