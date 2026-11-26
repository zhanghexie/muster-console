/**
 * 转写消息来源：用户手打 vs 调度注入。
 * 纯函数，主进程 / 渲染层 / 自测共用（禁止碰 process）。
 *
 * 引擎侧仍按 role=user 投递（Worker 看的是用户回合）；身份只在转写渲染。
 * 宿主通栏走 ChatMessage.host，不走本字段。
 */

/** 缺省 / 省略 = 用户真输入；scheduler/agent 用于历史及已有来源展示 */
export type ChatTranscriptSource = 'user' | 'scheduler' | 'agent';

export function isSchedulerMessageSource(source?: string): boolean {
  return source === 'scheduler';
}
