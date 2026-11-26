import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ImapFlow, type ImapTransport } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { AppConnection, AppPlaceholderFields, AppValues, MailConnectionConfig } from '../../shared/agentApps';
import { appPlaceholderSource } from '../../shared/appRecordPlaceholders';
import { appConnectionNameSource } from '../../shared/appConnectionName';
import type { AppConnectors, AppImportedBatch, ConnectionSecret } from './service';
import type { FeedProxy } from './feedProxy';
import { createOwnedImapTransport } from './imapTransport';
import { imapMailboxKey, legacyImapOwner } from '../messaging/imapConsumerArbiter';

const MAX_BYTES = 2 * 1024 * 1024;
function plain(value: unknown): string {
  if (value && typeof value === 'object') return plain((value as Record<string, unknown>)['#text'] ?? '');
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[m]!).trim();
}
function array<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
export function parseFeed(xml: string, sourceUrl: string): AppValues[] {
  return parseFeedBatch(xml, sourceUrl).records;
}
export function parseFeedBatch(xml: string, sourceUrl: string): AppImportedBatch {
  if (Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed is too large or declares unsupported entities');
  if (XMLValidator.validate(xml) !== true) throw new Error('RSS/Atom response is not valid XML');
  const doc = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false }).parse(xml);
  const items = doc.rss?.channel?.item ?? doc.feed?.entry ?? doc['rdf:RDF']?.item;
  if (items === undefined && !doc.rss?.channel && !doc.feed && !doc['rdf:RDF']) throw new Error('Response is not an RSS/Atom feed');
  const placeholderFields: Array<AppPlaceholderFields | null> = [];
  const records = array<Record<string, any>>(items).slice(0, 200).map(item => {
    const link = typeof item.link === 'string' ? item.link : array<Record<string, string>>(item.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
    let url = ''; try { if (link) { const u = new URL(link, sourceUrl); if (['http:', 'https:'].includes(u.protocol)) url = u.href; } } catch { /* A malformed article URL is kept as plain text without navigation. */ }
    const date = plain(item.pubDate ?? item.published ?? item.updated ?? item['dc:date']);
    const title = plain(item.title); placeholderFields.push(title ? null : { title: 'rss-no-title' });
    return { title: title || appPlaceholderSource('rss-no-title'), content: plain(item['content:encoded'] ?? item.content ?? item.description ?? item.summary).slice(0, 120_000),
      url, externalId: plain(item.guid ?? item.id) || url || createHash('sha256').update(JSON.stringify(item)).digest('hex'), publishedAt: Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : '' };
  });
  return { records, ...(placeholderFields.some(Boolean) ? { placeholderFields } : {}) };
}
export function isPublicAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (net.isIP(a) === 4) {
    const [x, y, z] = a.split('.').map(Number);
    return !(x === 0 || x === 10 || x === 127 || x === 169 && y === 254 || x === 172 && y >= 16 && y <= 31 || x === 192 && (y === 168 || y === 0 && (z === 0 || z === 2)) || x === 198 && (y === 18 || y === 19 || y === 51 && z === 100) || x === 203 && y === 0 && z === 113 || x === 100 && y >= 64 && y <= 127 || x >= 224);
  }
  if (net.isIP(a) !== 6) return false;
  const global = new net.BlockList(); global.addSubnet('2000::', 3, 'ipv6');
  const special = new net.BlockList(); special.addSubnet('2001::', 23, 'ipv6'); special.addSubnet('2001:db8::', 32, 'ipv6'); special.addSubnet('2002::', 16, 'ipv6');
  return global.check(a, 'ipv6') && !special.check(a, 'ipv6');
}
type FeedNetwork = { proxy?: FeedProxy; lookup?: (host: string) => Promise<{ address: string; family: number }[]> };
function isFakeAddress(address: string): boolean {
  return net.isIP(address) === 4 && /^198\.(18|19)\./.test(address);
}
/** Pin direct DNS; synthetic DNS requires a configured proxy or an OS TUN interface + HTTPS. */
export async function fetchFeed(url: string, signal?: AbortSignal, redirects = 0, network: FeedNetwork = {}): Promise<string> {
  const deadline = AbortSignal.timeout(20_000);
  const effective = signal ? AbortSignal.any([signal, deadline]) : deadline;
  effective.throwIfAborted();
  // DNS/PAC resolution is not abortable itself; do not let it defeat the overall deadline.
  return new Promise((resolve, reject) => {
    const abort = () => reject(effective.reason);
    effective.addEventListener('abort', abort, { once: true });
    fetchFeedHop(url, effective, redirects, network).then(resolve, reject).finally(() => effective.removeEventListener('abort', abort));
  });
}
async function fetchFeedHop(url: string, signal: AbortSignal, redirects: number, network: FeedNetwork): Promise<string> {
  signal?.throwIfAborted();
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || redirects > 4) throw new Error('Feed URL must be public HTTP(S), without credentials');
  const host = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literal = net.isIP(host);
  if (literal && !isPublicAddress(host) || !literal && (!host.includes('.') || /(?:^|\.)(localhost|local|localdomain|internal|intranet|lan|home|test|invalid|arpa|onion)$/i.test(host))) throw new Error('Feed URL resolves to a non-public address');
  const resolved = literal ? [{ address: host, family: literal }] : await (network.lookup?.(host) ?? dns.lookup(host, { all: true }));
  if (!resolved.length || resolved.some(r => !isPublicAddress(r.address) && !isFakeAddress(r.address))) throw new Error('Feed URL resolves to a non-public address');
  const proxy = await network.proxy?.resolve(target.href);
  signal.throwIfAborted();
  if (resolved.some(r => isFakeAddress(r.address)) && !proxy) {
    if (!network.proxy?.hasFakeIpTunnel()) throw new Error('RSS 检测到 fake-IP，但未发现系统代理或 TUN 网卡；请开启代理，或让该域名返回真实公网 DNS 地址');
    if (target.protocol !== 'https:') throw new Error('RSS 的 TUN fake-IP 路径需要 HTTPS；请使用 HTTPS 订阅地址或开启系统代理');
    // Keep Host/SNI and normal certificate verification; pin the synthetic IP handed to the OS tunnel.
  }
  const headers = { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml', 'Accept-Encoding': 'identity', 'User-Agent': 'Muster-RSS/1' };
  if (proxy && network.proxy) {
    const response = await network.proxy.fetch(target.href, proxy, { signal, headers, redirect: 'manual', credentials: 'omit' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      return fetchFeedHop(new URL(location, target).href, signal, redirects + 1, network);
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Feed server returned HTTP ${response.status}`); }
    // Chromium decodes content-encoding; bound the decoded stream, not the advertised size.
    const reader = response.body?.getReader(); if (!reader) throw new Error('Feed response has no body');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_BYTES) throw new Error('Feed exceeds 2 MB');
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel(); }
  }
  const pinned = resolved[0];
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { signal, timeout: 20_000, headers,
      lookup: ((_hostname: unknown, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as never
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) { response.resume(); void fetchFeedHop(new URL(response.headers.location, target).href, signal, redirects + 1, network).then(resolve, reject); return; }
      if (status !== 200) { response.resume(); reject(new Error(`Feed server returned HTTP ${status}`)); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new Error('Feed server ignored identity encoding')); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) { response.destroy(); reject(new Error('Feed exceeds 2 MB')); } else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => request.destroy(new Error('Feed request timed out'))); request.on('error', reject);
  });
}

type RunCli = (args: string[], options?: { input?: string; timeoutMs?: number; profile?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
async function cliData(run: RunCli, args: string[], profile?: string): Promise<Record<string, any>> {
  const result = await run(args, { timeoutMs: 30_000, ...(profile ? { profile } : {}) });
  let body: Record<string, any>;
  try { body = JSON.parse(result.code === 0 ? result.stdout : result.stderr || result.stdout); }
  catch { throw new Error(result.code === -2 ? '飞书 CLI 超时' : '飞书 CLI 未返回有效 JSON，请检查飞书连接'); }
  if (result.code !== 0 || body.ok !== true) throw new Error(String(body.error?.message || '飞书 CLI 操作失败').slice(0, 300));
  return body.data ?? {};
}
function mailConfig(connection: AppConnection): MailConnectionConfig {
  if (connection.kind !== 'imap-smtp') throw new Error('Expected an IMAP/SMTP connection'); return connection;
}
function client(config: MailConnectionConfig, secret: ConnectionSecret | undefined, transport: ImapTransport): ImapFlow {
  if (!secret?.password) throw new Error('Mailbox credentials unavailable');
  const imap = new ImapFlow({ host: config.imapHost, port: config.imapPort, secure: config.imapTls === 'tls', ...(config.imapTls === 'starttls' ? { doSTARTTLS: true } : {}),
    clientInfo: { name: 'muster-console', version: '0.1' },
    auth: { user: config.user, pass: secret.password }, logger: false, transport, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, disableAutoIdle: true });
  imap.on('error', () => { /* ImapFlow also rejects the active command; never print server/auth buffers. */ });
  return imap;
}
async function openMailbox(imap: ImapFlow, mailbox: string) {
  try {
    const box = await imap.mailboxOpen(mailbox, { readOnly: true });
    // Some command/state failures resolve false at runtime despite mailboxOpen's declared type.
    if (!box || typeof box !== 'object' || !box.path) throw new Error('server did not open the mailbox');
    const validUids = () => /^[1-9]\d*$/.test(String(box.uidValidity)) && Number.isSafeInteger(box.uidNext) && box.uidNext! >= 1;
    // UIDNEXT is not provided by every server's EXAMINE response (including NetEase).
    if (!validUids()) {
      const status = await imap.status(mailbox, { uidValidity: true, uidNext: true });
      if (status && status.uidValidity !== undefined) box.uidValidity = status.uidValidity;
      if (status && status.uidNext !== undefined) box.uidNext = status.uidNext;
    }
    if (!/^[1-9]\d*$/.test(String(box.uidValidity))) throw new Error('server returned invalid UIDVALIDITY');
    if (box.uidNext !== undefined && (!Number.isSafeInteger(box.uidNext) || box.uidNext < 1)) throw new Error('server returned invalid UIDNEXT');
    return box;
  } catch (error) {
    const response = error && typeof error === 'object' && 'responseText' in error && typeof error.responseText === 'string' ? error.responseText : '';
    const message = response || (error instanceof Error ? error.message : String(error));
    throw new Error(`IMAP EXAMINE failed: ${message.slice(0, 350)}`);
  }
}
function smtp(config: MailConnectionConfig, secret?: ConnectionSecret) {
  if (!secret?.password) throw new Error('Mailbox credentials unavailable');
  return nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpTls === 'tls', requireTLS: config.smtpTls === 'starttls',
    auth: { user: config.user, pass: secret.smtpPassword || secret.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, logger: false, debug: false,
    disableFileAccess: true, disableUrlAccess: true });
}
function addresses(value: { address?: string; name?: string }[] | undefined): string { return (value ?? []).map(a => a.address || a.name || '').filter(Boolean).join(', '); }

export function createAppConnectors(runCli: RunCli, feedProxy?: FeedProxy,
  claimMailbox?: (mailbox: MailConnectionConfig, owner: string) => () => void): AppConnectors {
  const pendingImapClose = new Map<string, Set<() => Promise<void>>>();
  const retryClose = async (work: Set<() => Promise<void>>) => {
    for (const close of work) { await close(); work.delete(close); }
  };
  async function withImap<T>(config: MailConnectionConfig, secret: ConnectionSecret | undefined, workspaceId: string | undefined,
    signal: AbortSignal | undefined, work: (imap: ImapFlow) => Promise<T>): Promise<T> {
    if (claimMailbox && !workspaceId) throw new Error('App workspace is unavailable');
    const owner = legacyImapOwner(workspaceId ?? '', config.id);
    const key = `${owner}:${imapMailboxKey(config)}`;
    const pendingClose = pendingImapClose.get(key);
    if (pendingClose?.size) await retryClose(pendingClose);
    signal?.throwIfAborted();
    const owned = createOwnedImapTransport();
    const imap = client(config, secret, owned.transport);
    const release = claimMailbox?.(config, owner);
    const abort = () => { try { imap.close(); } catch { /* shutdown observes and retries close */ } };
    const close = async () => {
      try { imap.close(); }
      finally { await owned.close(); }
      release?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try { return await work(imap); }
    finally {
      signal?.removeEventListener('abort', abort);
      try { await close(); }
      catch (error) {
        const retained = pendingImapClose.get(key) ?? new Set();
        retained.add(close); pendingImapClose.set(key, retained);
        throw new Error('imap-mailbox-close-unconfirmed', { cause: error });
      }
      if (!pendingImapClose.get(key)?.size) pendingImapClose.delete(key);
    }
  }
  return {
    async closeImap() {
      const results = await Promise.allSettled([...pendingImapClose].map(async ([key, pending]) => { await retryClose(pending); pendingImapClose.delete(key); }));
      if (results.some(result => result.status === 'rejected')) throw new Error('imap-mailbox-close-unconfirmed');
    },
    async feishuBotId(profile) {
      const result = await cliData(runCli, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'json'], profile);
      const id = result.open_id ?? result.bot?.open_id;
      if (typeof id !== 'string' || !/^ou_[\w-]+$/.test(id)) throw new Error('无法取得手机机器人身份，不能判断群里的 @ 消息');
      return id;
    },
    async feishuConversationName(chatId, messageId, type, profile) {
      const result = await cliData(runCli, type === 'group'
        ? ['im', 'chats', 'get', '--chat-id', chatId, '--as', 'bot', '--format', 'json']
        : ['im', '+messages-mget', '--message-ids', messageId, '--no-reactions', '--as', 'bot', '--format', 'json'], profile);
      const name = type === 'group' ? result.name : result.messages?.[0]?.sender?.name;
      return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : undefined;
    },
    async listFeishuChats(identity, pageToken, profile) {
      if (!profile?.startsWith('muster-phone-')) throw new Error('请选择手机专用机器人');
      const args = ['im', '+chat-list', '--as', identity, '--page-size', '100', '--format', 'json'];
      if (identity === 'user') args.push('--types', 'p2p,group');
      if (pageToken) args.push('--page-token', pageToken);
      const result = await cliData(runCli, args, profile);
      // lark-cli serializes an empty Go slice as null for accounts with no joined groups.
      const rows = result.chats === null ? [] : result.chats;
      if (!Array.isArray(rows)) throw new Error('飞书会话响应缺少 chats，请刷新重试');
      if (result.has_more && (typeof result.page_token !== 'string' || !result.page_token || result.page_token === pageToken)) throw new Error('飞书会话分页异常，请刷新重试');
      const chats = rows.filter((chat: Record<string, unknown>) => !chat.chat_status || chat.chat_status === 'normal').map((chat: Record<string, unknown>) => {
        if (typeof chat.chat_id !== 'string' || !/^oc_[a-zA-Z0-9_-]+$/.test(chat.chat_id)) throw new Error('飞书会话缺少有效标识，请刷新重试');
        const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim().slice(0, 200) : undefined;
        return { chatId: chat.chat_id, name: name ?? appConnectionNameSource('feishu-unnamed'), ...(!name ? { namePlaceholder: 'feishu-unnamed' as const } : {}) };
      });
      return { chats, ...(result.has_more ? { pageToken: result.page_token } : {}) };
    },
    feed: async (url, signal) => parseFeedBatch(await fetchFeed(url, signal, 0, { proxy: feedProxy }), url),
    async test(connection, secret, workspaceId, signal) {
      if (connection.kind === 'feishu') { await cliData(runCli, ['im', '+chat-messages-list', '--as', connection.identity, '--chat-id', connection.chatId, '--page-size', '1', '--no-reactions', '--format', 'json'], connection.profile); return; }
      const config = mailConfig(connection), transport = smtp(config, secret);
      try { await withImap(config, secret, workspaceId, signal, async imap => { await imap.connect(); await openMailbox(imap, config.mailbox); await transport.verify(); }); }
      finally { transport.close(); }
    },
    async sync(connection, secret, cursor, signal, workspaceId): Promise<AppImportedBatch & { cursor: Record<string, string | number> }> {
      signal?.throwIfAborted();
      if (connection.kind === 'feishu') {
        const args = ['im', '+chat-messages-list', '--as', connection.identity, '--chat-id', connection.chatId, '--order', 'asc', '--page-size', '50', '--no-reactions', '--format', 'json'];
        if (cursor.start) args.push('--start', String(cursor.start));
        if (cursor.pageToken) args.push('--page-token', String(cursor.pageToken));
        const result = await cliData(runCli, args, connection.profile); signal?.throwIfAborted();
        if (!Array.isArray(result.messages)) throw new Error('飞书消息响应缺少 messages');
        let latest = Number(cursor.latest ?? 0);
        const placeholderFields: Array<AppPlaceholderFields | null> = [];
        const records: AppValues[] = result.messages.map((m: Record<string, any>) => {
          if (!m.message_id) throw new Error('飞书消息缺少持久身份');
          const stamp = Number(m.create_time); if (Number.isFinite(stamp)) latest = Math.max(latest, stamp < 10_000_000_000 ? stamp * 1000 : stamp);
          const body = typeof m.content === 'string' ? m.content : m.content?.text ?? JSON.stringify(m.content ?? m.body ?? {});
          const sender = m.sender?.name || m.sender?.id;
          const fields: AppPlaceholderFields = {};
          if (!sender) fields.sender = 'message-unknown-sender';
          if (m.deleted) fields.body = 'message-withdrawn';
          placeholderFields.push(Object.keys(fields).length ? fields : null);
          return { sender: sender || appPlaceholderSource('message-unknown-sender'), body: m.deleted ? appPlaceholderSource('message-withdrawn') : String(body).slice(0, 120_000), messageId: String(m.message_id), chatId: connection.chatId, date: Number.isFinite(stamp) ? new Date(stamp < 10_000_000_000 ? stamp * 1000 : stamp).toISOString() : '', mine: false, status: 'received' };
        });
        if (result.has_more && !result.page_token) throw new Error('飞书分页未完成且没有续收游标');
        return { records, ...(placeholderFields.some(Boolean) ? { placeholderFields } : {}), cursor: result.has_more ? { ...cursor, pageToken: String(result.page_token), latest } : { ...(latest ? { start: new Date(latest).toISOString() } : {}), latest } };
      }
      const config = mailConfig(connection);
      return withImap(config, secret, workspaceId, signal, async imap => {
        await imap.connect(); signal?.throwIfAborted();
        const box = await openMailbox(imap, config.mailbox);
        const validity = String(box.uidValidity), next = box.uidNext;
        const previous = cursor.validity === validity ? Number(cursor.uid ?? 0) : undefined;
        let first = previous !== undefined ? previous + 1 : next !== undefined ? Math.max(1, next - 50) : 1;
        if (next !== undefined && first >= next) return { records: [], cursor: { validity, uid: first - 1 } };
        // Some servers omit UIDNEXT even from STATUS. Enumerate actual UIDs rather than assuming an empty mailbox.
        const found = await imap.search(next !== undefined || previous !== undefined ? { uid: `${first}:*` } : { all: true }, { uid: true });
        if (!Array.isArray(found)) throw new Error('IMAP SEARCH failed: server refused the search or no mailbox is open');
        const sorted = found.filter(uid => uid >= first).sort((a, b) => a - b);
        const uids = next === undefined && previous === undefined ? sorted.slice(-50) : sorted.slice(0, 50);
        if (next === undefined && previous === undefined && uids.length) first = uids[0];
        const records: AppValues[] = [], placeholderFields: Array<AppPlaceholderFields | null> = []; let last = first - 1;
        for (const uid of uids) {
          signal?.throwIfAborted();
          const meta = await imap.fetchOne(String(uid), { envelope: true, size: true }, { uid: true });
          if (!meta) { last = uid; continue; }
          const envelope = meta.envelope; let body = appPlaceholderSource('mail-body-omitted'), attachments = '[]', omitted = true;
          if ((meta.size ?? 0) <= MAX_BYTES) {
            const fetched = await imap.fetchOne(String(uid), { source: true }, { uid: true });
            if (fetched && fetched.source && fetched.source.length <= MAX_BYTES) {
              const parsed = await simpleParser(fetched.source, { skipHtmlToText: true, skipTextToHtml: true });
              body = (parsed.text || plain(parsed.html || '')).slice(0, 120_000);
              omitted = false;
              attachments = JSON.stringify(parsed.attachments.map(a => ({ name: a.filename || 'attachment', size: a.size, contentType: a.contentType, checksum: a.checksum })));
            }
          }
          const fields: AppPlaceholderFields = {};
          if (!envelope?.subject) fields.subject = 'mail-no-subject';
          if (omitted) fields.body = 'mail-body-omitted';
          placeholderFields.push(Object.keys(fields).length ? fields : null);
          records.push({ subject: envelope?.subject || appPlaceholderSource('mail-no-subject'), from: addresses(envelope?.from), to: addresses(envelope?.to), body, attachments,
            date: envelope?.date ? new Date(envelope.date).toISOString() : '', messageId: envelope?.messageId || `${validity}:${uid}`, uid: `${validity}:${uid}`, folder: 'inbox', status: 'received' }); last = uid;
        }
        return { records, ...(placeholderFields.some(Boolean) ? { placeholderFields } : {}), cursor: { validity, uid: last } };
      });
    },
    async send(connection, secret, values, requestId, signal) {
      signal?.throwIfAborted();
      if (connection.kind === 'feishu') {
        const idempotency = createHash('sha256').update(`${connection.id}:${requestId}`).digest('hex').slice(0, 32);
        const target = values.replyTo ? ['+messages-reply', '--message-id', String(values.replyTo)] : ['+messages-send', '--chat-id', connection.chatId];
        const result = await cliData(runCli, ['im', ...target, '--as', connection.identity, '--content', JSON.stringify({ text: String(values.body) }), '--msg-type', 'text', '--idempotency-key', idempotency, '--format', 'json'], connection.profile);
        const id = result.message_id || result.message?.message_id; if (!id) throw new Error('飞书发送响应缺少 message_id，请核对远端状态');
        return { messageId: String(id) };
      }
      const config = mailConfig(connection), transport = smtp(config, secret);
      const messageId = `<${createHash('sha256').update(`${connection.id}:${requestId}`).digest('hex')}@muster.local>`;
      // A timeout after SMTP submission is ambiguous; the service persists 'uncertain' and never blindly retries.
      try {
        const sent = await transport.sendMail({ from: config.address, to: String(values.to), subject: String(values.subject || ''), text: String(values.body), messageId,
          ...(values.replyTo ? { inReplyTo: String(values.replyTo), references: String(values.replyTo) } : {}) });
        if (!sent.accepted.length || sent.rejected.length) throw new Error('SMTP did not accept all recipients; inspect delivery before retrying');
        return { messageId: sent.messageId };
      } finally { transport.close(); }
    }
  };
}
