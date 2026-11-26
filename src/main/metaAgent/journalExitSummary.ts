/** Optional exit summary: host-bound control root, shared transactional journal writer.
 * Disabled by default. Existing session records suppress redundant summaries.
 * Generation/storage failures notify the user; release remains nonblocking.
 */
import { t } from '../../shared/i18n';
import { validateSingleEntryText, type JournalEntry } from '../../shared/journalFormat';
import { runTextTool } from '../textTools/runTextTool';
import {writeJournal,hasJournalForActor} from '../memory/journal';
import type { AppContext } from '../context';
import type { GuiChatMessage } from '../../shared/guiWorker';
import { guiMessageText } from '../../shared/guiWorker';

const MIN_MESSAGES = 4;
const MAX_CONVERSATION_CHARS = 16_000;
const MARKER_PREFIX = '<!-- exit-summary:';

const SYSTEM_PROMPT = [
  '把下面的会话记录整理成一条工作日志（journal）条目。',
  '只输出 markdown，格式严格如下（不含代码块）：',
  '## [主题≤20字] 进行中|已完成|阻塞|搁置',
  '- 问题：<本次会话要解决的问题/任务目标，1-2 句>',
  '- 要点：<结论或进展关键点>',
  '- 要点：（可多条；没有结论就写当前进展与卡点）',
  '主题要具体（如「审批流 webhook 排查」）；无实质内容时只输出 None。'
].join('\n');

/** 进程内已写摘要的会话（updateKey 去重第一层） */
const summarized = new Set<string>();

function buildConversation(messages: GuiChatMessage[]): {
  text: string;
  count: number;
  /** 摩擦信号：报错/被中止的消息数（TeamAI 启发：有摩擦的会话更值得沉淀） */
  friction: number;
} {
  const parts: string[] = [];
  let friction = 0;
  for (const m of messages) {
    if (m.error || m.aborted) friction += 1;
    const text = guiMessageText(m).trim();
    if (!text) continue;
    parts.push(m.role === 'user' ? `【用户】${text}` : `【助手】${text}`);
  }
  const joined = parts.join('\n\n');
  const text =
    joined.length > MAX_CONVERSATION_CHARS
      ? `${joined.slice(0, MAX_CONVERSATION_CHARS)}\n…[后文截断]`
      : joined;
  return { text, count: parts.length, friction };
}

function extractEntry(response: string): JournalEntry | null {
  // 模型可能裹代码块或多余说明：优先取代码块内，再退全文，交给格式校验单源判定
  const fenced = response.match(/```[a-z]*\n([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], response] : [response];
  for (const c of candidates) {
    const cleaned = c.replace(new RegExp(`${MARKER_PREFIX.replace(/[<!!-]/g, '\\$&')}[\\s\\S]*?-->\\s*`, 'g'), '');
    const v = validateSingleEntryText(cleaned);
    if (v.ok) return v.entry;
  }
  return null;
}

/**
 * release 时调用：不满足条件直接返回；满足则后台生成（不阻塞 release），
 * 完成后通过宿主事务保存 journal；失败写诊断并通知。
 */
export function maybeWriteExitSummary(
  ctx: AppContext,
  input: {
    sessionId: string;
    sessionName: string;
    workspaceId?: string;
    workspaceRoot: string;
    messages: GuiChatMessage[];
  }
): void {
  try {
    const config = ctx.config.get();
    if (config.journalExitSummaryEnabled !== true) return;
    if (summarized.has(input.sessionId)) return;
    const { text: conversation, count, friction } = buildConversation(input.messages);
    // 触发：常规（消息数 ≥4）或摩擦信号（报错/中止 ≥1 且至少 2 条消息——有摩擦的会话更值得沉淀）
    if (!conversation.trim() || count < (friction > 0 ? 2 : MIN_MESSAGES)) return;
    if (hasJournalForActor(input.workspaceRoot,input.sessionId)) return;
    summarized.add(input.sessionId);

    const sessionName = input.sessionName || input.sessionId.slice(0, 8);
    const run = (retryHint: string): Promise<JournalEntry | null> =>
      runTextTool(config, {
        name: 'journal-exit-summary',
        prompt: SYSTEM_PROMPT + (retryHint ? `\n\n上一次输出不合法（${retryHint}），请严格按格式重写。` : ''),
        text: `会话名：${sessionName}\n\n<conversation>\n${conversation}\n</conversation>`,
        noThinking: true
      })
        .then((r) => extractEntry(r.text))
        .catch(() => null);

    void (async () => {
      let entry = await run('');
      if (!entry) entry = await run('缺「## [主题] 状态」标题行或缺 - 问题：/- 要点：行');
      if (!entry) {
        ctx.notify.push({
          workspaceId: input.workspaceId ?? 'app',
          sessionId: input.sessionId,
          sessionName: '工作台',
          text: t('会话退出摘要生成失败，已跳过（设置 → Worker 终端可关闭该功能）'),
          toast: true
        });
        return;
      }
      try {
        if (!hasJournalForActor(input.workspaceRoot,input.sessionId)) writeJournal(input.workspaceRoot,input.sessionId,entry);
      } catch (err) {
        summarized.delete(input.sessionId);
        ctx.notify.push({workspaceId:input.workspaceId??'app',sessionId:input.sessionId,sessionName:'工作台',text:`工作日志保存失败：${String(err)}`,toast:true});
        console.error('[journal-exit-summary] write failed', err);
      }
    })();
  } catch (err) {
    console.error('[journal-exit-summary] unexpected', err);
  }
}
