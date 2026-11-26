/**
 * GUI 会话后台任务 IPC：渲染层动作面（面板首帧 list / kill / markRead / 删除已完成）。
 * 状态与消息流走 push 通道 agentSession:bgTask，这里只是拉取兜底。
 */
import { handle } from './handle';
import type { AppContext } from '../context';

export function registerBgTasksIpc(ctx: AppContext): void {
  handle('bgTasks:list', (_e, sessionId: string) =>
    ctx.bgTasks ? ctx.bgTasks.getListResult(String(sessionId ?? '')) : { tasks: [], messages: {} }
  );
  handle('bgTasks:kill', (_e, taskId: string) =>
    ctx.bgTasks ? ctx.bgTasks.killAndWait(String(taskId ?? ''), 'user') : false
  );
  handle('bgTasks:remove', (_e, taskId: string) =>
    ctx.bgTasks ? ctx.bgTasks.remove(String(taskId ?? '')) : false
  );
  handle('bgTasks:clearFinished', (_e, sessionId: string) =>
    ctx.bgTasks ? ctx.bgTasks.clearFinished(String(sessionId ?? '')) : 0
  );
  handle('bgTasks:markRead', (_e, sessionId: string) => {
    if (ctx.bgTasks) ctx.bgTasks.markRead(String(sessionId ?? ''));
    return true;
  });
  // 子代理消息整包只推给打开着面板的会话（payload 与主聊天 sync 同构，可达 MB 级）
  handle('bgTasks:subscribeMessages', (_e, sessionId: string, on: boolean) => {
    ctx.bgTasks?.setMessagesSubscribed(String(sessionId ?? ''), on === true);
    return true;
  });
}
