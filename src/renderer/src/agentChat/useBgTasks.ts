/**
 * 后台任务数据订阅：agentSession:bgTask 推送（快照 + 子代理消息整包）+ list 首帧兜底。
 * 一个会话挂载一个 BgTasksArea，只订阅一路。
 *
 * 消息整包按需订阅：payload 是全量 GuiChatMessage[]（含工具卡与输出，与主聊天 sync
 * 同构、真机可到 MB 级），而只有 BgTasksPanel 挂载时才消费它——胶囊只用 tasks 快照。
 * 故 wantMessages=false 时告诉主进程别推，面板打开时再订阅 + 走 list 补齐全量。
 */
import { useEffect, useState } from 'react';
import type { BgTaskPush, BgTaskRecord } from '../../../shared/backgroundTasks';
import type { GuiChatMessage } from '../../../shared/guiWorker';

export interface BgTasksState {
  tasks: BgTaskRecord[];
  messagesByTask: Record<string, GuiChatMessage[]>;
}

export function useBgTasks(sessionId: string, wantMessages = true): BgTasksState {
  const [tasks, setTasks] = useState<BgTaskRecord[]>([]);
  const [messagesByTask, setMessagesByTask] = useState<Record<string, GuiChatMessage[]>>({});

  useEffect(() => {
    let alive = true;
    setTasks([]);
    setMessagesByTask({});
    void window.api.bgTasks.list(sessionId).then((r) => {
      if (!alive || !r) return;
      setTasks(r.tasks ?? []);
      setMessagesByTask(r.messages ?? {});
    });
    const off = window.api.on('agentSession:bgTask', (payload: BgTaskPush) => {
      if (!payload || payload.sessionId !== sessionId) return;
      if (payload.kind === 'snapshot') {
        setTasks(payload.tasks);
      } else {
        setMessagesByTask((prev) => ({ ...prev, [payload.taskId]: payload.messages }));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);

  // 订阅开关独立于数据订阅：面板开合不该重拉 tasks 快照
  useEffect(() => {
    if (!wantMessages) return;
    void window.api.bgTasks.subscribeMessages(sessionId, true);
    // 订阅期间任务可能已跑过若干轮（关面板时主进程没推）：补齐一次全量
    let alive = true;
    void window.api.bgTasks.list(sessionId).then((r) => {
      if (alive && r?.messages) setMessagesByTask(r.messages);
    });
    return () => {
      alive = false;
      void window.api.bgTasks.subscribeMessages(sessionId, false);
    };
  }, [sessionId, wantMessages]);

  return { tasks, messagesByTask };
}
