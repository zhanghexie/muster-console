import { snapshotTaskAttachments } from '../../../src/main/attachments/taskDraft';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardTodoStore } from '../../../src/main/boardTodoStore';
import type { BoardTodoInput } from '../../../src/shared/boardTodo';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-todo-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const input: BoardTodoInput = { name: ' 待处理 ', task: ' 原文\n第二行 ', runtime: 'pi', surface: 'chat', advanced: { guiMode: 'plan' }, isolate: false };
it('重启恢复原文与设置，更新保留身份，删除不影响其他 TODO', async () => {
  const file = path.join(dir, 'todos.json'); const store = new BoardTodoStore(file);
  expect(store.list()).toEqual([]);
  const first = await store.save(input); const other = await store.save({ ...input, name: '另一项' });
  const restored = new BoardTodoStore(file);
  expect(restored.list()).toEqual([first, other]);
  const updated = await restored.save({ ...input, task: '修改' }, first.id);
  expect(updated.id).toBe(first.id); expect(updated.createdAt).toBe(first.createdAt);
  restored.delete(first.id); expect(restored.list()).toEqual([other]);
  await expect(restored.save(input, first.id)).rejects.toThrow('TODO 已删除');
});
it('坏数据和写盘失败显式报错，不覆盖之前保存的内容', async () => {
  const file = path.join(dir, 'todos.json'); const store = new BoardTodoStore(file);
  await store.save(input); const original = fs.readFileSync(file, 'utf8');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(store.save({ ...input, task: '新内容' })).rejects.toThrow('disk full');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  fs.writeFileSync(file, '{broken');
  await expect(store.save(input)).rejects.toThrow(); expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});
it('拒绝空内容、过长和无效数据，不落盘', async () => {
  const file = path.join(dir, 'todos.json'); const store = new BoardTodoStore(file);
  await expect(store.save({ ...input, task: ' \n ' })).rejects.toThrow();
  await expect(store.save({ ...input, task: 'a'.repeat(256_001) })).rejects.toThrow('TODO 内容过长');
  await expect(store.save({ ...input, surface: 'invalid' } as unknown as BoardTodoInput)).rejects.toThrow();
  expect(fs.existsSync(file)).toBe(false);
});

it('保存仅附件的代办，队列快照和重开时的内容独立于原文件', async () => {
  const file = path.join(dir, 'todos.json');
  const sourcePath = path.join(dir, 'note.txt');
  fs.writeFileSync(sourcePath, 'first version');
  const upload = [{ id: 'one', mimeType: 'text/plain', data: '', name: 'note.txt', sourcePath }];
  await expect(snapshotTaskAttachments(upload, false)).rejects.toThrow();
  const attachments = await snapshotTaskAttachments(upload, true);
  const store = new BoardTodoStore(file);
  const saved = await store.save({ ...input, task: '', attachments });
  fs.unlinkSync(sourcePath);
  expect(store.list()[0]).not.toHaveProperty('attachments');
  const reopened = new BoardTodoStore(file);
  const loaded = await reopened.loadAttachments(saved.id, saved.attachmentKey!);
  expect(Buffer.from(loaded[0].data, 'base64').toString()).toBe('first version');
  const replacement = await reopened.save({ ...input, attachments: loaded }, saved.id);
  await expect(reopened.loadAttachments(saved.id, saved.attachmentKey!)).rejects.toThrow();
  reopened.delete(replacement.id);
  expect(fs.readdirSync(dir)).toEqual(['todos.json']);
});
