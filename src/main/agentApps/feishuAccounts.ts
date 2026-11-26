import { createHash, randomInt } from 'node:crypto';
import type { AppFeishuChat, AppFeishuStatus, AppPlaceholderFields, AppValues } from '../../shared/agentApps';
import { appPlaceholderSource } from '../../shared/appRecordPlaceholders';
import { appConnectionNameSource } from '../../shared/appConnectionName';
import { stripFeishuMentions } from '../feishu/mentions';
import { t } from '../../shared/i18n';
import type { EventStreamHandle, OnboardingHandle } from '../feishu/larkCli';
import type { WorkbenchRemoteInput } from '../messaging/messagingHost';

/** One phone robot profile per workspace. */
export function phoneFeishuProfile(workspaceId: string): string {
  return `muster-phone-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)}`;
}
type RunCli = (args: string[], options: { profile: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export async function phoneFeishuAppBound(run: RunCli, profile: string): Promise<boolean> {
  const result = await run(['auth', 'status', '--json'], { profile, timeoutMs: 15_000 });
  let body: { ok?: boolean; appId?: string; identities?: { bot?: { available?: boolean } }; error?: { subtype?: string; message?: string } };
  try { body = JSON.parse(result.stdout || result.stderr); }
  catch { throw new Error(result.code === -2 ? t('检查手机机器人超时，请重试') : t('无法读取手机机器人的授权状态，请重试')); }
  if (body.error?.subtype === 'not_configured') return false;
  if (result.code !== 0 || body.ok === false) throw new Error(body.error?.message?.slice(0, 300) || t('检查手机机器人失败'));
  if (typeof body.appId !== 'string' || !body.appId) return false;
  // whoami only proves the public app ID exists. Check credentials in this host.
  if (body.identities?.bot?.available !== true) throw new Error(t('已找到手机机器人配置，但当前工作台无法读取它的机器人凭据。请在工作台使用的运行环境中恢复该机器人的授权；重新生成授权码不能修复凭据缺失。'));
  return true;
}
export type PhoneFeishuConversation = { type: 'p2p' | 'group'; name?: string; mentionedBot?: boolean };
export type PhoneFeishuRemoteInput = Omit<WorkbenchRemoteInput, 'channelKey' | 'botId' | 'deliver' | 'onProgress'>;
type Entry = { status: AppFeishuStatus; generation: number; handle?: OnboardingHandle; cancelWait?: () => void; expiry?: ReturnType<typeof setTimeout>; stream?: EventStreamHandle; streamReady?: boolean; streamGeneration: number; streamAdmission?: AbortController; streamError?: string; reconnect?: ReturnType<typeof setTimeout>; reconnectAttempts?: number; bindingExpiry?: ReturnType<typeof setTimeout>; pairedMessageIds?: Set<string>; botId?: Promise<string>; incoming?: Promise<void> };
export type PhoneFeishuOptions = {
  available(): boolean;
  probe(profile: string): Promise<boolean>;
  start(profile: string, onUrl: (url: string) => void): OnboardingHandle;
  qr(url: string): Promise<string | undefined>;
  emit(status: AppFeishuStatus): void;
  listen?(profile: string, onLine: (line: string) => void, onExit: (code: number, error: string) => void, onReady: () => void): EventStreamHandle;
  loadChats?(workspaceId: string): AppFeishuChat[];
  saveChat?(workspaceId: string, chat: AppFeishuChat): void | Promise<void>;
  receive?(workspaceId: string, message: AppValues, conversation: PhoneFeishuConversation, fields?: AppPlaceholderFields): void | Promise<void>;
  receiveRemote?(workspaceId: string, input: PhoneFeishuRemoteInput): Promise<boolean>;
  botId?(profile: string): Promise<string>;
  bindingTimeoutMs?: number;
  urlTimeoutMs?: number;
  authTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class PhoneFeishuAccounts {
  private entries = new Map<string, Entry>();
  constructor(private readonly options: PhoneFeishuOptions) {}
  isReceiving(workspaceId: string): boolean { return this.entries.get(workspaceId)?.streamReady === true; }
  private entry(ws: string): Entry {
    if (this.closing) throw new Error('Phone Feishu accounts are stopping');
    let entry = this.entries.get(ws);
    if (!entry) {
      entry = { status: { workspaceId: ws, cliReady: this.options.available(), appBound: false, starting: false, onboarding: null }, generation: 0, streamGeneration: 0 };
      this.entries.set(ws, entry);
    }
    return entry;
  }
  private publish(entry: Entry): void { this.options.emit(structuredClone(entry.status)); }
  async get(ws: string, ensureReceiver = true): Promise<AppFeishuStatus> {
    const entry = this.entry(ws), generation = entry.generation;
    entry.status.cliReady = this.options.available();
    if (!entry.handle && !entry.status.starting && entry.status.cliReady) {
      try {
        const appBound = await this.options.probe(phoneFeishuProfile(ws));
        if (entry.generation === generation) { entry.status.appBound = appBound; delete entry.status.lastError; }
      } catch (error) { if (entry.generation === generation) entry.status.lastError = errorText(error); }
    }
    if (ensureReceiver && entry.status.appBound && !entry.status.lastError && !entry.status.pairingError && this.options.listen) this.startStream(entry);
    return structuredClone(entry.status);
  }
  async start(ws: string): Promise<{ ok: boolean; url?: string; qrDataUrl?: string; error?: string }> {
    const entry = this.entry(ws);
    if (entry.status.starting || entry.handle) return { ok: false, error: t('这台手机已有进行中的扫码，请完成或取消后重试') };
    if (!this.options.available()) return { ok: false, error: t('飞书组件未安装，请重新安装完整版工作台') };
    const generation = ++entry.generation, current = () => entry.generation === generation;
    entry.status.starting = true; delete entry.status.lastError; this.publish(entry);
    let urlTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (await this.options.probe(phoneFeishuProfile(ws))) {
        if (current()) {
          entry.status.appBound = true; entry.status.starting = false;
          clearTimeout(entry.reconnect); entry.reconnect = undefined; entry.reconnectAttempts = 0;
          delete entry.status.pairingError;
          if (this.options.listen) this.startStream(entry); this.publish(entry);
        }
        return { ok: true };
      }
      if (!current()) return { ok: false, error: t('已取消扫码') };
      let onUrl!: (url: string) => void;
      const urlReady = new Promise<string>(resolve => { onUrl = resolve; });
      const cancelled = new Promise<null>(resolve => { entry.cancelWait = () => resolve(null); });
      const handle = this.options.start(phoneFeishuProfile(ws), onUrl);
      entry.handle = handle;
      entry.expiry = setTimeout(() => this.cancel(ws, t('接入超时，请重新扫码')), this.options.authTimeoutMs ?? 10 * 60_000);
      const finished = handle.promise.then(async result => {
        if (!current()) return null;
        if (!result.ok) throw new Error(result.error || t('手机机器人接入未完成，请重试'));
        const bound = await this.options.probe(phoneFeishuProfile(ws));
        if (!current()) return null;
        if (!bound) throw new Error(t('扫码进程已结束，但手机机器人的授权尚未保存，请重试'));
        entry.status.appBound = true;
        if (this.options.listen) this.startStream(entry);
        return null;
      }).catch(error => { if (current()) entry.status.lastError = errorText(error); return null; }).finally(() => {
        if (current()) {
          clearTimeout(entry.expiry); entry.expiry = undefined; entry.handle = undefined; entry.cancelWait = undefined;
          entry.status.starting = false; entry.status.onboarding = null; this.publish(entry);
        }
      });
      const url = await Promise.race([urlReady, finished, cancelled, new Promise<never>((_resolve, reject) => { urlTimer = setTimeout(() => reject(new Error(t('未能取得二维码，请重试'))), this.options.urlTimeoutMs ?? 20_000); })]);
      clearTimeout(urlTimer);
      if (!current()) return { ok: false, error: t('已取消扫码') };
      if (!url) return entry.status.appBound ? { ok: true } : { ok: false, error: entry.status.lastError || t('接入未完成') };
      entry.status.onboarding = { url }; entry.status.starting = false; this.publish(entry);
      const qrDataUrl = await this.options.qr(url);
      // Cancellation, rapid retry or completion during QR rendering must not resurrect an old code.
      if (!current() || !entry.handle) return entry.status.appBound ? { ok: true } : { ok: false, error: entry.status.lastError || t('已取消扫码') };
      entry.status.onboarding = { url, qrDataUrl }; this.publish(entry);
      return { ok: true, url, qrDataUrl };
    } catch (error) {
      if (current()) this.cancel(ws, errorText(error));
      return { ok: false, error: errorText(error) };
    } finally { clearTimeout(urlTimer); }
  }
  cancel(ws: string, error?: string): void {
    const entry = this.entry(ws); entry.generation++;
    if (entry.handle) this.retireHandle(entry.handle);
    entry.cancelWait?.(); clearTimeout(entry.expiry);
    entry.handle = undefined; entry.cancelWait = undefined; entry.expiry = undefined;
    entry.status.starting = false; entry.status.onboarding = null; entry.status.lastError = error;
    this.publish(entry);
  }
  async beginBinding(ws: string): Promise<AppFeishuStatus> {
    const status = await this.get(ws, false);
    if (!status.appBound || status.lastError) throw new Error(status.lastError || t('请先扫码创建手机机器人'));
    const entry = this.entry(ws); this.startBinding(entry);
    return structuredClone(entry.status);
  }
  async ensureReceiving(ws: string): Promise<void> {
    const entry = this.entry(ws);
    if (entry.streamReady) return;
    const status = await this.get(ws, false);
    if (!status.appBound || status.lastError) throw new Error(status.lastError || t('请先扫码创建手机机器人'));
    this.startStream(entry);
    const generation = entry.generation, deadline = Date.now() + 15_000;
    while (!entry.streamReady && entry.generation === generation && (entry.stream || entry.reconnect) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!entry.streamReady) throw new Error(entry.status.pairingError || t('手机机器人收信连接超时，请重试'));
  }
  private startBinding(entry: Entry): void {
    if (!this.options.listen || !this.options.saveChat) return;
    clearTimeout(entry.bindingExpiry);
    const previous = entry.status.binding?.code;
    let code: string;
    do { code = String(randomInt(100000, 1000000)); } while (code === previous || [...this.entries.values()].some(item => item.status.binding?.code === code));
    const ttl = this.options.bindingTimeoutMs ?? 10 * 60_000;
    entry.status.binding = { code, expiresAt: Date.now() + ttl, ready: entry.streamReady === true };
    delete entry.status.pairingError; delete entry.status.pairedChat;
    clearTimeout(entry.reconnect); entry.reconnect = undefined; entry.reconnectAttempts = 0;
    entry.bindingExpiry = setTimeout(() => {
      entry.status.binding = null; entry.status.pairingError = t('授权码已过期，请重新生成'); this.publish(entry);
    }, ttl);
    entry.bindingExpiry.unref?.();
    this.startStream(entry);
    this.publish(entry);
  }
  private startStream(entry: Entry): void {
    if (this.closing || this.entries.get(entry.status.workspaceId) !== entry) return;
    if (!this.options.listen) throw new Error(t('手机机器人收信服务未加载，请重启工作台'));
    const ws = entry.status.workspaceId;
    if (!entry.stream && !entry.reconnect) {
      const generation = ++entry.streamGeneration;
      const admission = new AbortController();
      entry.streamAdmission = admission;
      const fail = (error: string) => {
        if (entry.streamGeneration !== generation) return;
        admission.abort();
        entry.streamGeneration++; entry.stream = undefined; entry.streamReady = false; entry.status.receiving = false;
        // A transport failure must not revoke an unexpired pairing code.
        if (entry.status.binding) entry.status.binding.ready = false;
        const delays = this.options.reconnectDelaysMs ?? [1_000, 3_000, 10_000];
        const attempt = entry.reconnectAttempts ?? 0, retry = attempt < delays.length;
        const previousError = entry.streamError;
        entry.streamError = t('手机机器人收信连接失败，{{action}}{{detail}}', { action: retry ? t('正在自动重连') : t('请重试连接'), detail: error ? `：${error.slice(-240)}` : '' });
        if (entry.status.binding || !entry.status.pairingError || entry.status.pairingError === previousError) entry.status.pairingError = entry.streamError;
        if (retry) {
          entry.reconnectAttempts = attempt + 1;
          entry.reconnect = setTimeout(() => { entry.reconnect = undefined; this.startStream(entry); }, delays[attempt]);
          entry.reconnect.unref?.();
        }
        this.publish(entry);
      };
      try {
        const stream = this.options.listen(phoneFeishuProfile(ws), line => {
          if (entry.streamGeneration !== generation) return;
          const lifecycle = entry.generation;
          entry.incoming = (entry.incoming ?? Promise.resolve()).then(async () => {
            if (entry.generation !== lifecycle) return;
            if (await this.handleBinding(entry, line)) return;
            if (entry.generation !== lifecycle) return;
            const event = JSON.parse(line);
            if (!event || typeof event !== 'object' || typeof event.message_id !== 'string' || !/^oc_[\w-]+$/.test(event.chat_id) || event.sender_type !== 'user' || !['p2p', 'group'].includes(event.chat_type)) return;
            if (event.chat_type === 'group') {
              if (!Array.isArray(event.mentions) || !event.mentions.length) return;
              if (!this.options.botId) throw new Error(t('无法识别手机机器人的 @ 身份，请重试连接'));
              const botId = await (entry.botId ??= this.options.botId(phoneFeishuProfile(ws)).catch(error => { entry.botId = undefined; throw error; }));
              if (!event.mentions.some((mention: { id?: string }) => mention?.id === botId)) return;
            }
            if (entry.generation !== lifecycle) return;
            const remoteText = this.options.receiveRemote && event.message_type === 'text' && typeof event.content === 'string' ? stripFeishuMentions(event.content, event.mentions).slice(0, 64 * 1024) : '';
            if (this.options.receiveRemote && !admission.signal.aborted && /^om_[\w-]+$/.test(event.message_id) && /^ou_[\w-]+$/.test(event.sender_id) && remoteText) {
              if (await this.options.receiveRemote(ws, { conversationId: event.chat_id,
                threadId: event.thread_id || event.root_id || undefined, senderId: event.sender_id,
                conversationType: event.chat_type === 'group' ? 'group' : 'direct', addressed: true, senderIsBot: false,
                messageId: event.message_id, nativeMessageId: event.message_id, text: remoteText, signal: admission.signal })) return;
            }
            if (entry.generation !== lifecycle) return;
            const stamp = Number(event.create_time ?? event.timestamp);
            const fields: AppPlaceholderFields = {};
            if (!event.sender_name) fields.sender = event.chat_type === 'p2p' ? 'message-peer' : 'message-group-member';
            if (event.content == null && !event.message_type) fields.body = 'message-unknown-body';
            await this.options.receive?.(ws, { messageId: event.message_id, chatId: event.chat_id,
              sender: String(event.sender_name || appPlaceholderSource(fields.sender)), body: String(event.content ?? (fields.body ? appPlaceholderSource(fields.body) : `[${event.message_type}]`)).slice(0, 120_000),
              date: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp < 10_000_000_000 ? stamp * 1000 : stamp).toISOString() : new Date().toISOString(), mine: false, status: 'received' },
              { type: event.chat_type, mentionedBot: event.chat_type === 'group', name: event.chat_name || (event.chat_type === 'p2p' ? event.sender_name : undefined) }, Object.keys(fields).length ? fields : undefined);
          }).catch(error => { if (entry.generation === lifecycle && !(error instanceof SyntaxError)) { entry.status.pairingError = t('接收手机消息失败：{{error}}', { error: errorText(error) }); this.publish(entry); } });
        }, (_exitCode, error) => fail(error), () => {
          if (entry.streamGeneration !== generation) return;
          entry.streamReady = true; entry.status.receiving = true; entry.reconnectAttempts = 0;
          if (entry.status.pairingError === entry.streamError) delete entry.status.pairingError;
          entry.streamError = undefined;
          if (entry.status.binding) entry.status.binding.ready = true;
          this.publish(entry);
        });
        if (entry.streamGeneration === generation) entry.stream = stream;
          else this.retireHandle(stream);
      } catch (error) { fail(errorText(error)); }
    }
    this.publish(entry);
  }
  private async handleBinding(entry: Entry, line: string): Promise<boolean> {
    const binding = entry.status.binding;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
      if (entry.pairedMessageIds?.has(event.message_id)) return true;
      if (!binding || Date.now() >= binding.expiresAt) return false;
      // Only a human's direct text message to this dedicated bot can pair a private chat.
      if (event.chat_type !== 'p2p' || event.sender_type !== 'user' || event.message_type !== 'text' ||
          typeof event.message_id !== 'string' || !/^ou_[\w-]+$/.test(event.sender_id) || !/^oc_[\w-]+$/.test(event.chat_id) || typeof event.content !== 'string') return false;
      const text = event.content.trim();
      if (!/^[\d\s-]+$/.test(text) || text.replace(/[\s-]/g, '') !== binding.code) return false;
      const chat: AppFeishuChat = { chatId: event.chat_id, name: appConnectionNameSource('feishu-paired'), namePlaceholder: 'feishu-paired' };
      const generation = entry.generation;
      await this.options.saveChat!(entry.status.workspaceId, chat);
      if (entry.generation !== generation) return true;
      const paired = entry.pairedMessageIds ??= new Set<string>();
      paired.add(event.message_id);
      if (paired.size > 100) paired.delete(paired.values().next().value!);
      clearTimeout(entry.bindingExpiry); entry.status.binding = null; entry.status.pairedChat = chat;
      delete entry.status.pairingError; this.publish(entry);
      return true;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      entry.status.pairingError = t('保存手机会话失败，请重试：{{error}}', { error: errorText(error) }); this.publish(entry);
      return true;
    }
  }
  private closing = false;
  private readonly retired = new Set<Promise<void>>();
  private readonly failedHandles = new Map<{ stopAndWait(): Promise<void> }, unknown>();
  private trackRetired(pending: Promise<void>): void {
    this.retired.add(pending);
    void pending.then(() => this.retired.delete(pending), error => { this.retired.delete(pending); console.error('[phone-feishu] retired callback failed', error); });
  }
  private retireHandle(stream: { stopAndWait(): Promise<void> }): void {
    const pending = stream.stopAndWait().then(() => { this.failedHandles.delete(stream); }, error => { this.failedHandles.set(stream, error); });
    this.trackRetired(pending);
  }
  stop(): void {
    if (this.closing) return;
    for (const ws of this.entries.keys()) this.stopWorkspace(ws);
    this.closing = true;
  }
  async stopAndWait(): Promise<void> {
    const retry = this.closing;
    this.stop();
    if (retry) for (const stream of this.failedHandles.keys()) this.retireHandle(stream);
    while (this.retired.size) await Promise.allSettled([...this.retired]);
    if (this.failedHandles.size) throw new AggregateError(this.failedHandles.values(), 'Phone Feishu shutdown failed');
  }
  stopWorkspace(ws: string): void {
    const entry = this.entries.get(ws); if (!entry) return;
    entry.streamAdmission?.abort();
    this.cancel(ws); clearTimeout(entry.bindingExpiry); clearTimeout(entry.reconnect); entry.reconnect = undefined; entry.streamGeneration++;
    if (entry.stream) this.retireHandle(entry.stream);
    if (entry.incoming) this.trackRetired(entry.incoming);
    entry.stream = undefined; entry.streamReady = false; entry.status.receiving = false; entry.status.binding = null;
    this.entries.delete(ws);
  }
}
