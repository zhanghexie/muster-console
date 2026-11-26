import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { t } from '../../shared/i18n';
import type { GuiChatMessage } from '../../shared/guiWorker';
import { canvasHandoverBackground, type CanvasHandoverDraft, type HandoverLineRange, type HandoverOverview } from '../../shared/canvasHandover';
import type { SessionMeta } from '../../shared/types';
import { attachmentDir } from '../attachments/service';
import type { AppContext } from '../context';
import { assertSessionTargetCurrent, resolveSessionTarget } from '../sessions/targets';
import { deleteSessionHandover, existingHandoverDirectory, handoverSessionDirectory } from './paths';
import { pathKey } from '../pathKey';
import { truncateToolOutput, truncateToolPayload } from './output';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pending = new Map<string, { draft: CanvasHandoverDraft; state: 'draft' | 'submitting' | 'submitted' }>();

function fenced(text: string, language = ''): string {
  const runs = text.match(/`+/g) ?? [];
  let length = 3;
  for (const run of runs) length = Math.max(length, run.length + 1);
  const fence = '`'.repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

async function copySourceAttachments(userData: string, sourceId: string, target: string): Promise<(text: string) => string> {
  const source = attachmentDir(userData, `gui:${sourceId}`);
  if (!fs.existsSync(source)) return text => text;
  const destination = path.join(target, 'attachments');
  await fs.promises.cp(source, destination, { recursive: true, errorOnExist: true, force: false,
    filter: async item => {
      const stat = await fs.promises.lstat(item);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(t('源会话附件包含链接或特殊文件，无法安全复制'));
      return true;
    } });
  for (const name of await fs.promises.readdir(destination)) {
    if (!/^(?:[a-f0-9]{12}|[a-f0-9]{64})\.json$/i.test(name)) continue;
    const file = path.join(destination, name);
    const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { path?: unknown };
    if (typeof manifest.path !== 'string') throw new Error(t('源会话附件清单无效：{{name}}', { name }));
    manifest.path = path.join(destination, path.basename(manifest.path));
    await fs.promises.writeFile(file, JSON.stringify(manifest), 'utf8');
  }
  return text => text.split(JSON.stringify(source).slice(1, -1)).join(JSON.stringify(destination).slice(1, -1)).split(source).join(destination);
}

type MessageRole = '用户' | '助手' | '宿主' | '调度' | '代理';
type ToolDetail = { number: string; name: string; owner: string; raw: string; results: string[] };
type RenderedConversation = {
  body: string;
  tools?: string;
  native?: string;
  toolOutputsTruncated: boolean;
  counts: Pick<HandoverOverview, 'rounds' | 'userMessages' | 'queuedUserMessages' | 'assistantMessages' | 'otherMessages' | 'toolCalls'>;
};

const ordinal = (value: number): string => String(value).padStart(4, '0');
const oneLine = (value: string): string => value.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
/** Escape only headings that could masquerade as generated message markers. */
const textContent = (value: string): string => value.replace(/\r\n?/g, '\n')
  .replace(/^(?=## \[(?:用户|助手|宿主|调度|代理|工具详情) #\d+\])/gm, '\\');
const jsonBlock = (value: unknown): string => fenced(JSON.stringify(value, null, 2), 'json');

function timeLabel(value: unknown): string {
  const time = typeof value === 'number' || typeof value === 'string' ? new Date(value) : undefined;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : '未知';
}

/** Keep message order and replace tool payloads with numbered references. */
class HandoverTranscript {
  private sections: string[] = [];
  private messagesByRole: Record<MessageRole, number> = { 用户: 0, 助手: 0, 宿主: 0, 调度: 0, 代理: 0 };
  private details: ToolDetail[] = [];
  private detailsByNativeId = new Map<string, ToolDetail>();
  private unmatchedResults: string[] = [];
  private approvals: string[] = [];
  private rounds = 0;
  private queued = 0;
  private truncated = false;

  noteTruncated(): void { this.truncated = true; }

  message(role: MessageRole, timestamp: unknown, queued = false): { owner: string; lines: string[] } {
    const number = ordinal(++this.messagesByRole[role]);
    if (role === '用户') {
      if (queued) this.queued++;
      else this.rounds++;
    }
    const owner = `[${role} #${number}]`;
    const round = queued && role === '用户' ? '（排队中，尚未发送）' : this.rounds ? ` 第 ${this.rounds} 轮` : '（无对应用户轮次）';
    return { owner, lines: [`## ${owner}${round}`, `时间：${timeLabel(timestamp)}`] };
  }

  finishMessage(lines: string[]): void { this.sections.push(lines.join('\n\n')); }

  tool(name: string, owner: string, raw: string, nativeId?: string): string {
    const number = ordinal(this.details.length + 1);
    const detail = { number, name: oneLine(name) || '未知工具', owner, raw, results: [] as string[] };
    this.details.push(detail);
    if (nativeId) this.detailsByNativeId.set(nativeId, detail);
    return `[工具 #${number}] ${detail.name}`;
  }

  toolResult(nativeId: string | undefined, raw: string): void {
    const detail = nativeId ? this.detailsByNativeId.get(nativeId) : undefined;
    if (detail) detail.results.push(raw);
    else this.unmatchedResults.push(raw);
  }

  approval(owner: string, raw: string): void {
    this.approvals.push(`## [审批详情 #${ordinal(this.approvals.length + 1)}]\n\n所属消息：${owner}\n\n${raw}`);
  }

  render(native?: string): RenderedConversation {
    const details = this.details.map(detail => [
      `## [工具详情 #${detail.number}] ${detail.name}`,
      `所属消息：${detail.owner}`,
      '调用记录：', detail.raw,
      ...detail.results.flatMap(result => ['返回结果：', result])
    ].join('\n\n'));
    const other = this.unmatchedResults.map((result, index) => `## [未匹配的工具结果 #${ordinal(index + 1)}]\n\n${result}`);
    const appendix = [...details, ...this.approvals, ...other];
    return {
      body: this.sections.join('\n\n'),
      ...(appendix.length ? { tools: `# 附录：工具调用详情\n\n${appendix.join('\n\n')}` } : {}),
      ...(native !== undefined ? { native: `# 附录：原生记录\n\n${fenced(native.trimEnd(), 'jsonl')}` } : {}),
      toolOutputsTruncated: this.truncated,
      counts: { rounds: this.rounds, userMessages: this.messagesByRole.用户, queuedUserMessages: this.queued,
        assistantMessages: this.messagesByRole.助手, otherMessages: this.messagesByRole.宿主 + this.messagesByRole.调度 + this.messagesByRole.代理,
        toolCalls: this.details.length }
    };
  }
}

/** Preserve messages, tool inputs and images; bound lengthy tool outputs in the snapshot. */
export async function renderGuiHandover(messages: readonly GuiChatMessage[], directory: string, remap: (s: string) => string = s => s): Promise<RenderedConversation> {
  const transcript = new HandoverTranscript();
  for (const [index, message] of messages.entries()) {
    const role: MessageRole = message.host || message.steering === 'host' ? '宿主'
      : message.role === 'user' && message.source === 'scheduler' ? '调度'
        : message.role === 'user' && message.source === 'agent' ? '代理' : message.role === 'user' ? '用户' : '助手';
    const { owner, lines } = transcript.message(role, message.ts, message.queued);
    if (message.source) lines.push(`来源：${oneLine(message.source)}`);
    if (message.host) lines.push('来源：宿主');
    if (message.queued) lines.push('状态：排队中，尚未确认发送');
    if (message.aborted) lines.push('状态：已中止');
    if (message.error) lines.push(`错误：${textContent(message.error)}`);
    for (const part of message.parts ?? []) {
      if (part.kind === 'text') lines.push(textContent(remap(part.text)));
      else if (part.kind === 'thinking') lines.push('### 思考记录', textContent(remap(part.text)));
      else if (part.kind === 'tool') {
        const output = part.tool.output === undefined ? undefined : truncateToolOutput(part.tool.output);
        const patch = part.tool.patch === undefined ? undefined : truncateToolOutput(part.tool.patch);
        if (output?.truncated || patch?.truncated) transcript.noteTruncated();
        const exported = { ...part.tool, ...(output ? { output: output.value } : {}), ...(patch ? { patch: patch.value } : {}) };
        lines.push(transcript.tool(part.tool.name, owner, fenced(remap(JSON.stringify(exported, null, 2)), 'json')));
      }
    }
    if (message.approval) transcript.approval(owner, fenced(remap(JSON.stringify(message.approval, null, 2)), 'json'));
    for (const [imageIndex, image] of (message.images ?? []).entries()) {
      if (!image.data) throw new Error(t('第 {{n}} 条消息的图片数据不可用，无法完整生成交接文档', { n: index + 1 }));
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[image.mimeType] ?? 'bin';
      const relative = `images/${index + 1}-${imageIndex + 1}.${ext}`;
      await fs.promises.mkdir(path.join(directory, 'images'), { recursive: true });
      const bytes = Buffer.from(image.data, 'base64');
      if (!bytes.length) throw new Error(t('第 {{n}} 条消息的图片数据无效', { n: index + 1 }));
      await fs.promises.writeFile(path.join(directory, relative), bytes);
      lines.push(`图片：${oneLine(image.name ?? relative)}（${relative}）`);
    }
    if (message.userQuestion) lines.push('### 提问与回答', fenced(remap(JSON.stringify(message.userQuestion, null, 2)), 'json'));
    if (message.plan) lines.push('### 计划', fenced(remap(JSON.stringify(message.plan, null, 2)), 'json'));
    transcript.finishMessage(lines);
  }
  return transcript.render();
}

function claudeHistoryPath(source: SessionMeta): string {
  const id = source.externalSessionId?.trim() ?? '';
  if (!UUID.test(id) || !source.cwd || !path.isAbsolute(source.cwd)) throw new Error(t('Claude Code 会话缺少可读取的原生会话标识或目录'));
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', path.resolve(source.cwd).replace(/[^a-zA-Z0-9-]/g, '-'), `${id}.jsonl`);
}

async function renderClaudeHandover(source: SessionMeta): Promise<RenderedConversation> {
  let raw: string;
  try {
    const file = claudeHistoryPath(source);
    const before = await fs.promises.stat(file);
    raw = await fs.promises.readFile(file, 'utf8');
    const after = await fs.promises.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new Error(t('源会话记录正在变化，请等待当前回合结束后重试'));
    }
  }
  catch (error) { throw new Error(t('无法读取 Claude Code 原生聊天记录：{{error}}', { error: (error as Error).message })); }
  if (!raw.trim()) throw new Error(t('Claude Code 原生聊天记录为空'));
  const rows = raw.split(/\r?\n/);
  const transcript = new HandoverTranscript();
  const results: Array<{ id?: string; raw: string }> = [];
  const nativeRows: string[] = [];
  let messageCount = 0;
  for (const [index, line] of rows.entries()) {
    if (!line.trim()) { nativeRows.push(line); continue; }
    let row: any;
    try { row = JSON.parse(line); } catch { throw new Error(t('Claude Code 聊天记录第 {{n}} 行不完整或无法解析', { n: index + 1 })); }
    let changed = false;
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      if ('toolUseResult' in row) {
        const clipped = truncateToolPayload(row.toolUseResult);
        if (clipped.truncated) { row.toolUseResult = clipped.value; changed = true; }
      }
      if (Array.isArray(row.message?.content)) {
        for (const block of row.message.content) {
          if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.type !== 'string' ||
            (block.type !== 'tool_result' && !block.type.endsWith('_tool_result')) || !('content' in block)) continue;
          const clipped = truncateToolPayload(block.content);
          if (clipped.truncated) { block.content = clipped.value; changed = true; }
        }
      }
    }
    if (changed) transcript.noteTruncated();
    nativeRows.push(changed ? JSON.stringify(row) : line);
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    if (row.isSidechain === true) continue;
    const content = row.message?.content;
    if (typeof content !== 'string' && !Array.isArray(content)) continue;
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const visible: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        visible.push({ type: 'unknown', value: block });
        continue;
      }
      const item = block as Record<string, unknown>;
      if (typeof item.type === 'string' && (item.type === 'tool_result' || item.type.endsWith('_tool_result'))) {
        results.push({ ...(typeof item.tool_use_id === 'string' ? { id: item.tool_use_id } : {}), raw: jsonBlock(item) });
      } else visible.push(item);
    }
    // A Claude "user" row containing only tool results is not a human message or a new round.
    if (!visible.length) continue;
    const role: MessageRole = row.type === 'assistant' ? '助手' : row.isMeta === true ? '宿主' : '用户';
    const { owner, lines } = transcript.message(role, row.timestamp);
    for (const block of visible) {
      if (block.type === 'text' && typeof block.text === 'string') lines.push(textContent(block.text));
      else if (block.type === 'thinking' && typeof block.thinking === 'string') lines.push('### 思考记录', textContent(block.thinking));
      else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        lines.push(transcript.tool(typeof block.name === 'string' ? block.name : '未知工具', owner, jsonBlock(block),
          typeof block.id === 'string' ? block.id : undefined));
      } else lines.push('### 其他原生内容', jsonBlock(block));
    }
    transcript.finishMessage(lines);
    messageCount++;
  }
  if (!messageCount) throw new Error(t('Claude Code 原生记录中没有可交接的聊天消息'));
  for (const result of results) transcript.toolResult(result.id, result.raw);
  return transcript.render(nativeRows.join('\n').replace(/\r\n?/g, '\n'));
}

function makeHandoverDocument(source: SessionMeta, snapshotAt: string, rendered: RenderedConversation, documentPath: string): {
  content: string; overview: HandoverOverview;
} {
  const chunks: string[] = [];
  let lastLine = 1;
  const append = (chunk: string): HandoverLineRange => {
    if (chunks.length) { chunks.push('\n\n'); lastLine += 2; }
    const start = lastLine;
    chunks.push(chunk);
    lastLine += (chunk.match(/\n/g) ?? []).length;
    return { start, end: lastLine };
  };
  const truncationNote = rendered.toolOutputsTruncated ? '\n\n部分超长工具输出已截断，仅保留首尾；原始大小和省略量见工具记录。' : '';
  append(`# 会话交接历史\n\n来源：${oneLine(source.name)}\n\n原会话 ID：${oneLine(source.id)}\n\n快照时间：${snapshotAt}${truncationNote}`);
  const conversation = append(rendered.body);
  const native = rendered.native ? append(rendered.native) : undefined;
  const tools = rendered.tools ? append(rendered.tools) : undefined;
  return { content: `${chunks.join('')}\n`, overview: { sourceName: oneLine(source.name), sourceId: oneLine(source.id), documentPath,
    ...rendered.counts, conversation, toolOutputsTruncated: rendered.toolOutputsTruncated,
    ...(tools ? { tools } : {}), ...(native ? { native } : {}) } };
}

export async function prepareCanvasHandover(ctx: AppContext, source: SessionMeta, userData: string): Promise<CanvasHandoverDraft> {
  const identity = JSON.stringify([source.runtime, source.workspaceId, source.cwd]);
  const sourceName = source.name;
  const target = await resolveSessionTarget(ctx.config.get(), { workspaceId: source.workspaceId, cwd: source.cwd }, source);
  const chat = ctx.sessions.isChatRuntime(source.runtime);
  const history = chat ? ctx.agentSessions?.getHistory(source.id) : undefined;
  if (chat && (!history || !history.messages.length)) throw new Error(t('源会话没有可交接的聊天记录'));
  if (chat && history?.busy) throw new Error(t('源会话正在回复，请等待当前回合结束后交接'));
  if (!chat && source.runtime !== 'claude-code') throw new Error(t('此终端类型尚不能读取完整聊天记录，无法交接'));
  const snapshotAt = new Date().toISOString();
  const messages = history ? structuredClone(history.messages) : undefined;
  const id = randomUUID();
  const root = userDataStorage(userData).resolve('app', 'session-handovers');
  const directory = handoverSessionDirectory(userData, id);
  await fs.promises.mkdir(root, { recursive: true });
  if (pathKey(await fs.promises.realpath(root)) !== pathKey(userDataStorage(await fs.promises.realpath(userData)).resolve('app', 'session-handovers'))) {
    throw new Error(t('交接文档根目录已指向其他位置'));
  }
  await fs.promises.mkdir(directory);
  try {
    const remap = messages ? await copySourceAttachments(userData, source.id, directory) : (text: string) => text;
    const rendered = messages ? await renderGuiHandover(messages, directory, remap) : await renderClaudeHandover(source);
    const documentPath = path.join(directory, 'history.md');
    const document = makeHandoverDocument(source, snapshotAt, rendered, documentPath);
    await fs.promises.writeFile(documentPath, document.content, { encoding: 'utf8', flag: 'wx' });
    const current = ctx.sessions.get(source.id);
    if (!current || JSON.stringify([current.runtime, current.workspaceId, current.cwd]) !== identity) {
      throw new Error(t('准备交接期间源会话已变化，请重试'));
    }
    assertSessionTargetCurrent(ctx.config.get(), target);
    const draft: CanvasHandoverDraft = { id, sourceId: source.id, workspaceId: target.workspaceId,
      sourceRoot: { rootId: target.sourceRoot.rootId, path: target.sourceRoot.path }, name: `${sourceName} ·交接`,
      documentPath, lockedTask: canvasHandoverBackground(document.overview) };
    pending.set(id, { draft, state: 'draft' });
    return draft;
  } catch (error) {
    try { await deleteSessionHandover(userData, id); }
    catch (cleanup) { throw new Error(t('生成交接文档失败：{{error}}；临时数据清理失败：{{cleanup}}', { error: (error as Error).message, cleanup: (cleanup as Error).message })); }
    throw error;
  }
}

export function beginHandoverSubmission(userData: string, id: string, workspaceId: string): CanvasHandoverDraft {
  const entry = pending.get(id);
  if (!entry || entry.state !== 'draft' || entry.draft.workspaceId !== workspaceId) throw new Error(t('交接草稿已失效或不属于当前工作区'));
  if (!existingHandoverDirectory(userData, id)) throw new Error(t('交接历史文档不存在'));
  entry.state = 'submitting';
  return entry.draft;
}

export function finishHandoverSubmission(id: string, submitted: boolean): void {
  const entry = pending.get(id);
  if (submitted) pending.delete(id);
  else if (entry) entry.state = 'draft';
}

export async function discardHandoverDraft(userData: string, id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry || entry.state !== 'draft') return;
  await deleteSessionHandover(userData, id);
  pending.delete(id);
}
