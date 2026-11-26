import fs from 'node:fs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { writeTextAtomicSync } from '../atomicJson';
import type { WorkbenchRemoteInput, WorkbenchRemoteMethod, WorkbenchRemoteReply } from './messagingHost';
import type { LogicalRemoteScope } from './logicalChannelService';

type Binding = {
  id: string; channelKey: string; botId: string; conversationId: string; threadId?: string;
  senderId: string; conversationType: 'direct' | 'group'; boundAt: number; scopeId?: string;
};
type Receipt = { key: string; at: number };
type Document = { version: 1; bindings: Binding[]; receipts: Receipt[] };
type Challenge = { code: string; expiresAt: number; attempts: number };
export type RemoteBindingStatus = {
  ready: boolean;
  binding: { code: string; expiresAt: number } | null;
  boundUsers: { id: string; label: string; boundAt: number }[];
};
type Options = {
  file: string;
  dispatch(input: WorkbenchRemoteInput & { authorizationId: string }, scope?: LogicalRemoteScope): Promise<WorkbenchRemoteReply>;
  releaseAuthorization?(id: string): void;
  now?: () => number;
};
const CHANNELS = new Set(['feishu', 'weixin', 'wecom', 'wecom-app', 'dingtalk', 'qq', 'slack',
  'telegram', 'discord', 'whatsapp', 'imessage', 'matrix', 'email']);
const TTL = 10 * 60_000;
const MAX_BINDINGS = 4096;
const MAX_TRACKED = 4096;
const MAX_RECEIPTS = 20_000;
const RECEIPT_TTL = 30 * 24 * 60 * 60_000;
const REMOTE_INPUT_SETTINGS = '设置 → 远程访问 → 远程输入';
const REMOTE_GUIDE = `请在电脑端「${REMOTE_INPUT_SETTINGS}」为此来源启用远程输入并生成绑定码，再在当前聊天发送六位绑定码。`;
const GUIDE = `尚未绑定工作台。请先在电脑端「设置 → Channels」添加此聊天为来源。${REMOTE_GUIDE}`;
const WORKBENCH_HELP = '直接发送消息即可操作工作台调度。发送 /ws 选择工作区，/s 选择调度会话，/ts 查看工作会话，/bind 绑定工作会话，/unbind 返回调度。发送「帮助」查看完整命令。';
const EMAIL_LIMIT = '邮箱可通过 Channels 收件和回复。邮件发件地址无法证明操作者身份，远程输入请使用飞书、微信等能够验证身份的平台。';
const EMPTY: WorkbenchRemoteReply = { text: '' };
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validIdentity(value: Partial<Binding>): boolean {
  return CHANNELS.has(value.channelKey ?? '') && validId(value.botId) && validId(value.senderId) &&
    validId(value.conversationId) && (value.threadId === undefined || validId(value.threadId)) &&
    (value.conversationType === 'direct' || value.conversationType === 'group');
}
function account(channel: string, botId: string): string { return JSON.stringify([channel, botId]); }
function identity(input: Partial<Binding>): string {
  return JSON.stringify([input.channelKey, input.botId, input.conversationId, input.threadId ?? '', input.senderId, input.conversationType]);
}
function challengeKey(channel: string, botId: string, scope?: LogicalRemoteScope): string {
  return scope ? JSON.stringify(['scope', scope.id]) : account(channel, botId);
}
function sameSource(input: WorkbenchRemoteInput, scope: LogicalRemoteScope): boolean {
  const source = scope.source;
  return input.channelKey === source.provider && input.botId === source.botId && input.conversationId === source.conversationId &&
    input.threadId === source.threadId && input.conversationType === source.conversationType;
}
const PAIR = /^(?:(?:接入|绑定|\/pair)\s+)?(\d{6})$/u;
const PAIR_COMMAND = /^(?:接入|绑定|\/pair)(?:\s+\d{6})?$/u;
function error(code: string, message: string) { return { ok: false as const, error: { code, message } }; }

/** Desktop-issued pairing. Transport login never grants authority to arbitrary message senders. */
export class RemoteBindingService {
  private document?: Document;
  private readonly challenges = new Map<string, Challenge>();
  private readonly guidance = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly admission = new AbortController();
  private readonly now: () => number;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  stopAdmission(): void { this.admission.abort(); this.challenges.clear(); }

  async manageAccount(channel: string, method: WorkbenchRemoteMethod, payload: unknown, signal: AbortSignal,
    snapshot: () => Promise<unknown>): Promise<unknown> {
    const botId = (payload as { botId?: unknown } | null)?.botId;
    if (!CHANNELS.has(channel) || !validId(botId)) return error('invalid-remote-account', '消息账号无效。');
    if (this.admission.signal.aborted || signal.aborted) return error('cancelled', '工作台正在关闭。');
    const state = await snapshot() as { ok?: boolean; value?: { bots?: { botId?: unknown }[] } } | null;
    if (this.admission.signal.aborted || signal.aborted) return error('cancelled', '工作台正在关闭或此账号已被移除。');
    if (!state?.ok || !Array.isArray(state.value?.bots) || !state.value.bots.some(bot => bot?.botId === botId)) {
      return error('remote-account-not-found', '此消息账号尚未接入或已被移除，请刷新账号列表。');
    }
    return this.manage(channel, method, payload, signal);
  }

  manage(channel: string, method: WorkbenchRemoteMethod, payload: unknown, signal?: AbortSignal): unknown {
    if (this.admission.signal.aborted || signal?.aborted) return error('cancelled', '工作台正在关闭。');
    const body = payload as { botId?: unknown; bindingId?: unknown } | null;
    if (!CHANNELS.has(channel) || !body || !validId(body.botId)) return error('invalid-remote-account', '消息账号无效。');
    if (channel === 'email' && method === 'remote.begin') return error('remote-sender-unverifiable', EMAIL_LIMIT);
    const key = account(channel, body.botId);
    try {
      this.read();
      if (method === 'remote.begin') {
        this.pruneChallenges();
        if (!this.challenges.has(key) && this.challenges.size >= 256) return error('remote-limit', '待绑定账号过多，请等待旧绑定码过期。');
        this.challenges.set(key, { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: this.now() + TTL, attempts: 0 });
      } else if (method === 'remote.revoke') {
        if (!validId(body.bindingId)) return error('invalid-remote-binding', '请选择要解除绑定的用户。');
        const target = this.read().bindings.find(b => !b.scopeId && b.channelKey === channel && b.botId === body.botId && b.id === body.bindingId);
        if (!target) return error('remote-binding-not-found', '此用户已解除绑定，请刷新账号状态。');
        this.write(this.read().bindings.filter(b => b.id !== target.id));
        this.retireBinding(target.id);
      }
      return { ok: true, value: this.status(channel, body.botId) };
    } catch {
      return error('remote-store-unavailable', '远程绑定记录无法保存或读取，请在电脑端检查存储权限；原记录已保留。');
    }
  }

  revokeAccount(channel: string, botId: string): void {
    const removed = this.read().bindings.filter(b => b.channelKey === channel && b.botId === botId);
    // Cancel pending turns even if persistence subsequently fails; never silently keep a removed account active.
    this.challenges.delete(account(channel, botId));
    for (const binding of removed) this.abortBinding(binding.id);
    if (removed.length) {
      this.write(this.read().bindings.filter(b => b.channelKey !== channel || b.botId !== botId));
      for (const binding of removed) this.options.releaseAuthorization?.(binding.id);
    }
  }

  intent(input: WorkbenchRemoteInput, scope?: LogicalRemoteScope): 'none' | 'pair' | 'control' {
    if (this.admission.signal.aborted || input.signal?.aborted || input.channelKey === 'email' || input.senderIsBot !== false ||
        !validIdentity(input) || typeof input.text !== 'string' || (input.conversationType === 'group' && input.addressed !== true) ||
        scope && !sameSource(input, scope)) return 'none';
    const text = input.text.trim();
    if (!text) return 'none';
    const bound = this.read().bindings.some(binding => binding.scopeId === scope?.id && identity(binding) === identity(input));
    const challenge = scope && this.challenges.get(challengeKey(input.channelKey, input.botId, scope));
    const code = PAIR.exec(text)?.[1];
    if (scope && (PAIR_COMMAND.test(text) || code && challenge && challenge.expiresAt > this.now() &&
        (!bound || challenge.code === code))) return 'pair';
    return bound ? 'control' : 'none';
  }

  isPairingSecret(text: string): boolean {
    const code = typeof text === 'string' && PAIR.exec(text.trim())?.[1];
    return !!code && [...this.challenges.values()].some(challenge => challenge.expiresAt > this.now() && challenge.code === code);
  }

  manageScope(scope: LogicalRemoteScope, method: WorkbenchRemoteMethod, bindingId?: string): RemoteBindingStatus {
    if (this.admission.signal.aborted) throw new Error('cancelled');
    const channel = scope.source.provider;
    const botId = scope.source.botId;
    const key = challengeKey(channel, botId, scope);
    const bindings = this.read().bindings;
    if (method === 'remote.begin') {
      this.pruneChallenges();
      if (!this.challenges.has(key) && this.challenges.size >= 256) throw new Error('remote-limit');
      this.challenges.set(key, { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: this.now() + TTL, attempts: 0 });
    } else if (method === 'remote.revoke') {
      const binding = bindings.find(value => value.scopeId === scope.id && value.id === bindingId);
      if (!binding) throw new Error('remote-binding-not-found');
      this.write(bindings.filter(value => value.id !== binding.id));
      this.retireBinding(binding.id);
    }
    return this.status(channel, botId, scope);
  }

  revokeScope(scope: LogicalRemoteScope): void {
    const bindings = this.read().bindings;
    const removed = bindings.filter(binding => binding.scopeId === scope.id);
    this.challenges.delete(challengeKey(scope.source.provider, scope.source.botId, scope));
    for (const binding of removed) this.abortBinding(binding.id);
    if (removed.length) {
      this.write(bindings.filter(binding => binding.scopeId !== scope.id));
      for (const binding of removed) this.options.releaseAuthorization?.(binding.id);
    }
  }

  revokeLegacySource(source: LogicalRemoteScope['source']): void {
    const bindings = this.read().bindings;
    const removed = bindings.filter(binding => !binding.scopeId && binding.channelKey === source.provider &&
      binding.botId === source.botId && binding.conversationId === source.conversationId && binding.threadId === source.threadId);
    for (const binding of removed) this.abortBinding(binding.id);
    if (removed.length) {
      this.write(bindings.filter(binding => !removed.includes(binding)));
      for (const binding of removed) this.options.releaseAuthorization?.(binding.id);
    }
  }

  async handle(input: WorkbenchRemoteInput, scope?: LogicalRemoteScope): Promise<WorkbenchRemoteReply> {
    if (this.admission.signal.aborted || input.signal?.aborted || input.senderIsBot ||
        (input.conversationType === 'group' && !input.addressed)) return EMPTY;
    if (!validIdentity(input) || !validId(input.messageId) || typeof input.text !== 'string' || input.text.length > 64 * 1024) {
      return { text: '消息信息不完整或内容过长，无法接入工作台。请重新发送文字消息。' };
    }
    // This guard also prevents alternate transports/tests from elevating an unverified email From header.
    if (scope && !sameSource(input, scope)) return EMPTY;
    if (input.channelKey === 'email') return this.guided(identity(input), EMAIL_LIMIT);
    const senderKey = identity(input);
    const messageKey = JSON.stringify([senderKey, input.messageId]);
    this.pruneTimes(this.seen, TTL);
    if (this.seen.has(messageKey)) return EMPTY;
    this.seen.set(messageKey, this.now());
    try {
      const text = input.text.trim();
      const key = challengeKey(input.channelKey, input.botId, scope);
      const challenge = this.challenges.get(key);
      const code = PAIR.exec(text)?.[1];
      let binding = this.read().bindings.find(b => b.scopeId === scope?.id && identity(b) === senderKey);
      if (scope && binding && (PAIR_COMMAND.test(text) || code && challenge && challenge.expiresAt > this.now() && challenge.code === code)) {
        return { text: `此用户已绑定。${WORKBENCH_HELP}` };
      }
      const receiptKey = createHash('sha256').update(messageKey).digest('hex');
      if (this.read().receipts.some(receipt => receipt.key === receiptKey)) {
        return binding ? { text: '这条消息此前已受理，不会重复执行。若上次没有收到结果，请在工作台核对执行状态。' } : EMPTY;
      }
      if (code && !binding) {
        if (!challenge || challenge.expiresAt <= this.now() || challenge.attempts >= 10) {
          this.challenges.delete(key);
          return this.guided(`${senderKey}:code`, `绑定码已失效或尚未生成。${scope ? REMOTE_GUIDE : GUIDE}`);
        }
        if (code !== challenge.code) {
          challenge.attempts++;
          if (challenge.attempts >= 10) this.challenges.delete(key);
          return this.guided(`${senderKey}:code`, `绑定码不正确。请核对电脑端「${REMOTE_INPUT_SETTINGS}」为此来源显示的六位绑定码。旧码过期后请重新生成。`);
        }
        if (this.read().bindings.length >= MAX_BINDINGS) return { text: `绑定用户数量已达上限，请先在电脑端「${REMOTE_INPUT_SETTINGS}」移除不再使用的绑定。` };
        binding = {
          id: randomUUID(), channelKey: input.channelKey, botId: input.botId, conversationId: input.conversationId,
          ...(input.threadId && { threadId: input.threadId }), senderId: input.senderId,
          conversationType: input.conversationType, boundAt: this.now(), ...(scope && { scopeId: scope.id })
        };
        const superseded = scope ? this.read().bindings.find(b => !b.scopeId && identity(b) === senderKey) : undefined;
        this.write([...this.read().bindings.filter(b => b.id !== superseded?.id), binding], this.reserveReceipt(receiptKey));
        if (superseded) this.retireBinding(superseded.id);
        this.challenges.delete(key);
        this.guidance.delete(senderKey);
        return { text: `绑定成功，远程已就绪。${WORKBENCH_HELP}` };
      }
      if (!binding) return this.guided(senderKey, scope ? REMOTE_GUIDE : GUIDE);
      if (/^(?:接入|绑定|\/pair)$/u.test(text)) return { text: '你已绑定工作台。直接发送任务，或发送「帮助」查看工作区、会话切换和 /bind 命令。' };
      // Durable admission precedes every command/PTY side effect. Unknown results must never be replayed automatically.
      this.write(this.read().bindings, this.reserveReceipt(receiptKey));
      const controller = new AbortController();
      const running = this.active.get(binding.id) ?? new Set<AbortController>();
      running.add(controller);
      this.active.set(binding.id, running);
      const signal = AbortSignal.any([this.admission.signal, controller.signal, ...(input.signal ? [input.signal] : [])]);
      try {
        const reply = await this.options.dispatch({ ...input, signal, authorizationId: binding.id,
          ...(input.onProgress && { onProgress: (text: string) => input.onProgress!(text, signal) }) }, scope);
        if (signal.aborted) return EMPTY;
        if (input.deliver) { await input.deliver(reply, signal); return EMPTY; }
        return reply;
      } catch {
        return signal.aborted ? EMPTY : { text: '未能确认这条消息的执行结果。请先在工作台核对，再决定是否重新发送。', failure: 'remote-result-unknown' };
      } finally {
        running.delete(controller);
        if (!running.size) this.active.delete(binding.id);
      }
    } catch {
      return { text: '远程绑定记录无法读取或保存。请在电脑端检查存储权限后重新接入；这条消息尚未执行。' };
    }
  }

  private guided(key: string, text: string): WorkbenchRemoteReply {
    this.pruneTimes(this.guidance, 60_000);
    if (this.guidance.has(key)) return EMPTY;
    this.guidance.set(key, this.now());
    return { text };
  }
  private pruneTimes(map: Map<string, number>, ttl: number): void {
    for (const [key, at] of map) if (at + ttl <= this.now()) map.delete(key);
    while (map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);
  }
  private pruneChallenges(): void {
    for (const [key, value] of this.challenges) if (value.expiresAt <= this.now()) this.challenges.delete(key);
  }
  private abortBinding(id: string): void {
    for (const controller of this.active.get(id) ?? []) controller.abort();
  }
  private retireBinding(id: string): void {
    this.abortBinding(id);
    this.options.releaseAuthorization?.(id);
  }
  private status(channel: string, botId: string, scope?: LogicalRemoteScope): RemoteBindingStatus {
    this.pruneChallenges();
    const pending = this.challenges.get(challengeKey(channel, botId, scope));
    const boundUsers = this.read().bindings.filter(b => b.scopeId === scope?.id && b.channelKey === channel && b.botId === botId).map(b => ({
      id: b.id, label: `${b.conversationType === 'group' ? '群聊' : '私聊'} · ${b.senderId}`, boundAt: b.boundAt
    }));
    return { ready: boundUsers.length > 0, binding: pending ? { code: pending.code, expiresAt: pending.expiresAt } : null, boundUsers };
  }
  private read(): Document {
    if (this.document) return this.document;
    let input: unknown;
    try {
      const stat = fs.lstatSync(this.options.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error();
      input = JSON.parse(fs.readFileSync(this.options.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.document = { version: 1, bindings: [], receipts: [] };
      throw new Error('remote-store-unavailable');
    }
    const doc = input as Partial<Document> | null;
    if (!doc || doc.version !== 1 || !Array.isArray(doc.bindings) || doc.bindings.length > MAX_BINDINGS ||
        doc.bindings.some(b => !b || !validIdentity(b) || !validId(b.id) || b.scopeId !== undefined && !validId(b.scopeId) ||
          !Number.isSafeInteger(b.boundAt) || b.boundAt < 0) ||
        (doc.receipts !== undefined && (!Array.isArray(doc.receipts) || doc.receipts.length > MAX_RECEIPTS || doc.receipts.some(r =>
          !r || typeof r.key !== 'string' || !/^[a-f0-9]{64}$/.test(r.key) || !Number.isSafeInteger(r.at) || r.at < 0))) ||
        new Set(doc.bindings.map(b => b.id)).size !== doc.bindings.length ||
        new Set(doc.bindings.map(identity)).size !== doc.bindings.length) throw new Error('remote-store-invalid');
    return this.document = { version: 1, bindings: doc.bindings, receipts: doc.receipts ?? [] };
  }
  private reserveReceipt(key: string): Receipt[] {
    const receipts = this.read().receipts.filter(receipt => receipt.at + RECEIPT_TTL > this.now());
    if (receipts.length >= MAX_RECEIPTS) throw new Error('remote-receipt-limit');
    return [...receipts, { key, at: this.now() }];
  }
  private write(bindings: Binding[], receipts = this.read().receipts): void {
    const document: Document = { version: 1, bindings, receipts };
    const json = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('remote-store-limit');
    writeTextAtomicSync(this.options.file, json, { mode: 0o600 });
    this.document = document;
  }
}
