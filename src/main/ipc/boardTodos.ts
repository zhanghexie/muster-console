import { app } from 'electron';
import type { AppContext } from '../context';
import type { BoardTodoInput } from '../../shared/boardTodo';
import { BoardTodoStore } from '../boardTodoStore';
import { snapshotTaskAttachments } from '../attachments/taskDraft';
import { handle, ipcCaller } from './handle';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

export function registerBoardTodosIpc(ctx: AppContext): void {
  const store = new BoardTodoStore(userDataStorage(app.getPath('userData')).manifestPath('board-todos'));
  const changed = (): void => ctx.getWindow()?.webContents.send('boardTodos:changed', {});
  handle('boardTodos:list', () => store.list());
  handle('boardTodos:loadAttachments', (_event, id: string, key: string) => store.loadAttachments(id, key));
  handle('boardTodos:save', async (event, input: BoardTodoInput, id?: string) => {
    const attachments = input?.attachments?.length
      ? await snapshotTaskAttachments(input.attachments, ipcCaller(event).id.startsWith('desktop:')) : undefined;
    const todo = await store.save({ ...input, attachments }, id);
    changed();
    return todo;
  });
  handle('boardTodos:delete', (_event, id: string) => { store.delete(id); changed(); });
}
