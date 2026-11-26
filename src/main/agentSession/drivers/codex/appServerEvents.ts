import { TURN_FILE_LIMIT } from '../../../../shared/turnChanges';

/** Codex app-server v0.166 item notifications projected to the Host event vocabulary. */
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';

export class CodexAppServerEventMapper {
  private readonly text = new Map<string, string>();
  private readonly thinking = new Map<string, string>();
  private readonly toolInputs = new Map<string, RecordValue>();
  private readonly startedTools = new Set<string>();
  private readonly fileChanges = new Map<string, RecordValue[]>();
  private fileDiffBytes = 0;
  private fileCoverageWarning = false;

  input(itemId: string): RecordValue { return this.toolInputs.get(itemId) ?? {}; }

  map(method: string, params: RecordValue): unknown[] {
    const itemId = str(params.itemId);
    if ((this.text.size + this.thinking.size + this.toolInputs.size) > 4096) throw new Error('Codex 回合条目数量超限');
    if (method === 'item/agentMessage/delta' && itemId) {
      const next = (this.text.get(itemId) ?? '') + str(params.delta);
      if (next.length > 4 * 1024 * 1024) throw new Error('Codex 消息超限');
      this.text.set(itemId, next);
      return [{ type: 'item.updated', item: { type: 'agent_message', id: itemId, text: next } }];
    }
    if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && itemId) {
      const next = (this.thinking.get(itemId) ?? '') + str(params.delta);
      if (next.length > 4 * 1024 * 1024) throw new Error('Codex 思考输出超限');
      this.thinking.set(itemId, next);
      return [{ type: 'item.updated', item: { type: 'reasoning', id: itemId, text: next } }];
    }
    if (method === 'item/reasoning/summaryPartAdded' && itemId && Number(params.summaryIndex) > 0) {
      const next = `${this.thinking.get(itemId) ?? ''}\n\n`;
      this.thinking.set(itemId, next);
      return [{ type: 'item.updated', item: { type: 'reasoning', id: itemId, text: next } }];
    }
    if (method === 'item/commandExecution/outputDelta' && itemId && str(params.delta)) {
      if (!this.startedTools.has(itemId)) return [{ type: 'app.warning', message: 'Codex 工具输出早于对应工具开始事件，已忽略该片段' }];
      return [{ type: 'app.tool-progress', toolCallId: itemId, delta: str(params.delta) }];
    }
    if (method === 'item/fileChange/patchUpdated' && itemId && Array.isArray(params.changes)) {
      const changes = this.rememberFileChanges(itemId, params.changes);
      return this.withFileWarning({ type: 'item.updated', item: { type: 'file_change', id: itemId, changes, status: 'in_progress' } });
    }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    const item = object(params.item), id = str(item.id), kind = str(item.type);
    if (!id) return [];
    const completed = method === 'item/completed';
    if (kind === 'agentMessage' || kind === 'plan') {
      const final = str(item.text) || this.text.get(id) || '';
      this.text.set(id, final);
      return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item: { type: 'agent_message', id, text: final } }];
    }
    if (kind === 'reasoning') return [];
    let converted: RecordValue | undefined;
    if (kind === 'commandExecution') {
      converted = { type: 'command_execution', id, command: str(item.command), aggregated_output: str(item.aggregatedOutput),
        exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
        status: item.status === 'failed' || item.status === 'declined' ? 'failed' : completed ? 'completed' : 'in_progress' };
      this.toolInputs.set(id, { command: str(item.command), cwd: str(item.cwd) });
    } else if (kind === 'fileChange') {
      const changes = this.rememberFileChanges(id, Array.isArray(item.changes) ? item.changes : []);
      converted = { type: 'file_change', id, changes, status: item.status === 'failed' || item.status === 'declined' ? 'failed' : completed ? 'completed' : 'in_progress' };
    } else if (kind === 'mcpToolCall') {
      converted = { type: 'mcp_tool_call', id, server: str(item.server), tool: str(item.tool), arguments: item.arguments,
        result: item.result, error: item.error, status: item.status === 'failed' ? 'failed' : completed ? 'completed' : 'in_progress' };
      this.toolInputs.set(id, { server: str(item.server), tool: str(item.tool), arguments: item.arguments });
    } else if (kind === 'webSearch') {
      converted = { type: 'web_search', id, query: str(item.query) };
    }
    if (converted && !completed) this.startedTools.add(id);
    if (completed) this.startedTools.delete(id);
    return converted ? this.withFileWarning({ type: completed ? 'item.completed' : 'item.started', item: converted }) : [];
  }

  private withFileWarning(event: unknown): unknown[] {
    if (!this.fileCoverageWarning) return [event];
    this.fileCoverageWarning = false;
    return [{ type: 'app.review-warning', message: '引擎差异达到大小上限，部分改动未记录' }, event];
  }

  private rememberFileChanges(id: string, incoming: unknown[]): RecordValue[] {
    const files = new Map((this.fileChanges.get(id) ?? []).map(change => [str(change.path), change]));
    let bytes = this.fileDiffBytes;
    if (incoming.length > 201) this.fileCoverageWarning = true;
    for (const value of incoming.slice(0, 201)) {
      const change = object(value), file = str(change.path), rawKind = object(change.kind);
      if (!file || file.length > 4096) { this.fileCoverageWarning = true; continue; }
      if (!files.has(file) && files.size >= 201) { this.fileCoverageWarning = true; continue; }
      const kind = typeof change.kind === 'string' ? change.kind : str(rawKind.type);
      const movePath = str(rawKind.move_path) || str(rawKind.movePath);
      const previous = files.get(file) ?? {};
      const next: RecordValue = { ...previous, path: file, kind: kind || previous.kind || 'update', ...(movePath ? { movePath } : {}) };
      if (typeof change.diff === 'string' && change.diff) {
        const oldBytes = typeof previous.diff === 'string' ? Buffer.byteLength(previous.diff) : 0;
        const size = Buffer.byteLength(change.diff);
        bytes -= oldBytes;
        if (size <= TURN_FILE_LIMIT && bytes + size <= 2 * 1024 * 1024) { next.diff = change.diff; delete next.diffOmitted; bytes += size; }
        else { delete next.diff; next.diffOmitted = true; }
      }
      files.set(file, next);
    }
    const changes = [...files.values()];
    this.fileDiffBytes = bytes;
    this.fileChanges.set(id, changes);
    this.toolInputs.set(id, { changes });
    return changes;
  }
}
