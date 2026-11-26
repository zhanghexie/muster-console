import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BoardTodo, BoardTodoInput } from '../shared/boardTodo';
import { writeJsonAtomic, writeJsonAtomicSync } from './atomicJson';

const inputSchema = z.object({
  name: z.string(), task: z.string(),
  workspaceId: z.string().optional(),
  source: z.object({ rootId: z.string(), path: z.string() }).optional(),
  surface: z.enum(['chat', 'pty']), runtime: z.string(),
  advanced: z.object({ configurePermissions: z.boolean().optional() }).passthrough(), isolate: z.boolean(),
  isolationGroups: z.array(z.object({ rootId: z.string(), relativePath: z.string(), repoSet: z.array(z.string()).optional() })).optional()
});
const recordSchema = inputSchema.extend({ attachmentKey: z.string().uuid().optional(), id: z.string().startsWith('todo:'), createdAt: z.number(), updatedAt: z.number() }).refine(row => !!row.task.trim() || !!row.attachmentKey, 'TODO 内容不能为空');

/** Read before each transaction, publish atomically. Failed reads/writes never clear saved work. */
export class BoardTodoStore {
  constructor(private readonly file: string) {}

  list(): BoardTodo[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return z.array(recordSchema).parse(JSON.parse(raw)) as BoardTodo[];
  }

  async loadAttachments(id: string, key: string): Promise<NonNullable<BoardTodoInput['attachments']>> {
    const row = this.list().find(item => item.id === id && item.attachmentKey === key);
    if (!row?.attachmentKey) throw new Error('TODO 附件已变化，请重新打开看板');
    const attachments = JSON.parse(await fs.promises.readFile(this.attachmentFile(row.attachmentKey), 'utf8'));
    return z.array(z.object({
      id: z.string(), name: z.string().optional(), mimeType: z.string(), data: z.string(), size: z.number().nonnegative()
    })).min(1).max(32).parse(attachments);
  }

  private attachmentFile(key: string): string { return this.file + '.' + key + '.attachments'; }

  private release(key?: string): void {
    if (!key) return;
    try { fs.rmSync(this.attachmentFile(key), { force: true }); }
    catch (error) { console.warn('[boardTodos] could not remove superseded attachments', error); }
  }

  async save(input: BoardTodoInput, id?: string): Promise<BoardTodo> {
    const data = inputSchema.parse(input) as BoardTodoInput;
    if (!data.task.trim() && !input.attachments?.length) throw new Error('TODO 内容不能为空');
    if (JSON.stringify(data).length > 256_000) throw new Error('TODO 内容过长');
    const attachmentKey = input.attachments?.length ? randomUUID() : undefined;
    if (attachmentKey) await writeJsonAtomic(this.attachmentFile(attachmentKey), input.attachments, undefined, 0);
    try {
      // Read the index after staging bytes so concurrent saves and deletions are visible.
      const items = this.list();
      const previous = id ? items.find(item => item.id === id) : undefined;
      if (id && !previous) throw new Error('TODO 已删除，请重新打开看板');
      const now = Date.now();
      const item: BoardTodo = { ...data, attachmentKey, id: previous?.id ?? `todo:${randomUUID()}`,
        createdAt: previous?.createdAt ?? now, updatedAt: now };
      writeJsonAtomicSync(this.file, previous ? items.map(row => row.id === id ? item : row) : [...items, item]);
      this.release(previous?.attachmentKey);
      return item;
    } catch (error) { this.release(attachmentKey); throw error; }
  }

  delete(id: string): void {
    if (typeof id !== 'string' || !id.startsWith('todo:')) throw new Error('无效的 TODO');
    const items = this.list();
    writeJsonAtomicSync(this.file, items.filter(item => item.id !== id));
    this.release(items.find(item => item.id === id)?.attachmentKey);
  }
}
