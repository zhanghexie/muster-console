/**
 * B3 结构化压缩摘要模板 + transcript 回读指针（zcode-adoption-plan B3）。
 *
 * **摘要指令接管**：pi 的 session.compact(customInstructions) 把自定义指令以
 * 「Additional focus:」追加在内置摘要提示词后（pi-coding-agent
 * dist/core/compaction/compaction.js:492-493），宿主借此注入调度场景的结构化
 * 摘要要求（对齐 ZCode compact/prompt.ts 9 节精神，适配调度场景）。
 * 微压缩（B1）与全量压缩两处共用同一套核心节（本文件导出），全量版更完整、
 * 微压缩版在其上保留轮询清理指令。LLM 面文案豁免 i18n（R2 先例：摘要是发给
 * 模型的指令，不是 UI 文案）；R5 起统一英文（模型面英文化收编）。
 *
 * **与 scheduler-memory 桶的分工**：MEMORY.md/SITUATION.md 桶=结论（压缩后态势
 * 重建，每回合前缀重注入）；transcript 快照=细节（完整历史在盘上，模型按需用
 * 文件工具回读）。桶给态势，快照给证据，互不替代（plan B3 §3）。
 */

/**
 * 六节核心（全量/微压缩共用的结构骨架；ZCode 9 节 → 调度场景 6 节）：
 * 1. 核心诉求与意图（← Primary Request and Intent）
 * 2. 关键事实与决策：工作区、会话名、任务状态（← Key Technical Concepts/Files/Errors 合并调度化）
 * 3. 用户全局规约与安全约束——逐字保留（← All user messages 的安全条款；ZCode
 *    prompt.ts:30/40 「MUST be preserved verbatim」同款硬措辞）
 * 4. 派活与验收链路在途状态（← Pending Tasks 调度化：派给了谁、验收卡在哪）
 * 5. 压缩前正在做什么（← Current Work）
 * 6. 下一步建议（← Optional Next Step：须与最近诉求一致，不另起炉灶）
 */
export const COMPACT_SUMMARY_CORE_SECTIONS: readonly string[] = [
  'Primary request and intent: what the user/scheduler chain explicitly asked for in this session (itemized, including how it changed)',
  'Key facts and decisions: workspace paths, scheduler session names, key decisions made and why (file paths, session ids and task ids kept verbatim)',
  'User global rules and safety constraints: every rule, prohibition and safety constraint the user stated must be preserved verbatim (copy the original wording; never rewrite, summarize or omit)',
  'Delegation and acceptance pipeline status: dispatched Worker tasks (session name/task id/current state), items awaiting acceptance or integration, pending needs_you questions',
  'Current work at compaction time: the task in flight when compaction happened, conclusions of the latest tool results, the last unfinished step',
  'Suggested next step: directly consistent with the most recent request (no new directions; do not restart finished tasks)'
];

/** 逐字保留条款（全量版显式独立成节；两版共用同一份措辞） */
export const COMPACT_SUMMARY_VERBATIM_CLAUSE =
  'User global rules and safety constraints are preserved verbatim: every rule, prohibition and sensitive-operation limit in the user\'s own words must be copied into the summary and stays in force after compaction.';

/**
 * 全量压缩摘要指令（手动 /compact 未带自定义说明、0.8 自动压缩时随
 * compact(customInstructions) 下发）。extra 为用户自定义补充（/compact <说明>），
 * 追加在模板之后（ZCode buildCompactPrompt 的 Additional Instructions 同布局）。
 */
export function buildFullCompactInstructions(extra?: string): string {
  const sections = COMPACT_SUMMARY_CORE_SECTIONS.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const lines = [
    'When compacting this scheduler session, produce the summary in the following six sections (every section must have content; write "none" when there is nothing):',
    sections,
    COMPACT_SUMMARY_VERBATIM_CLAUSE,
    'The summary must stand on its own to resume orchestration after compaction: keep session names, workspaces, task ids and file paths verbatim — never refer to them as "some session/task".'
  ];
  const trimmed = extra?.trim();
  if (trimmed) lines.push(`Additional instructions (user-specified, highest priority): ${trimmed}`);
  return lines.join('\n');
}

/** transcript 快照指针的提示词标签（与 C1 date-change 同款 reminder 形态） */
export const TRANSCRIPT_POINTER_TAG = '<system-reminder>';

/**
 * compact 后下一回合的前缀注入行：告诉模型完整历史快照的盘上路径，摘要丢的
 * 细节用文件工具按需读取（ZCode buildCompactSummaryMessage 的 transcriptPath
 * 条款同思路，改走回合前缀通道——pi 摘要消息由引擎生成，宿主不掺写）。
 */
export function buildTranscriptPointerLine(snapshotPath: string): string {
  return `${TRANSCRIPT_POINTER_TAG}The full-history snapshot is stored at ${snapshotPath}; details lost from the summary can be read back on demand with your file tool.${TRANSCRIPT_POINTER_TAG}`;
}
