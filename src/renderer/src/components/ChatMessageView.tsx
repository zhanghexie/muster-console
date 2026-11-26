import { useLiveThinkingOnly } from '../thinkingDisplayPreference';
import React, { useSyncExternalStore } from 'react';
import { readMailPresentations } from '../../../shared/mailReadPresentation';
import { ReadMailCards } from './ReadMailCards';
import { useTranslation } from 'react-i18next';
import { localizeGuiHostError } from '../../../shared/guiHostError';
import { ErrorTipDetails } from './ErrorTip';
import { localizeKnowledgeHostText } from '../../../shared/knowledgeDisplayText';
import type { ChatDisplayPart, ChatMessage, ToolCallRecord } from '../../../shared/types';
import { attachmentDisplay } from '../../../shared/attachmentDisplay';
import { buildWorkspaceFileHref } from '../../../shared/linkifyWorkspacePaths';
import { ChatAttachmentCard } from './ChatAttachmentCard';
import {
  chatAvatarSender,
  hasChatMessageAvatar,
  resolveAvatarFace,
  resolveAvatarTooltip,
  type ChatAvatarContext
} from '../../../shared/userAvatar';
import { getUserAvatar, subscribeUserAvatar } from '../userAvatar';
import { ChatMessageAvatar } from './ChatMessageAvatar';
import { subagentAvatarUrl } from '../subagentAvatars';
import { workspaceIconUrl } from '../workspaceIcons';
import { DEFAULT_SUBAGENT_CHARACTER_ID, getSubagentCharacter } from '../../../shared/subagentCharacters';
import { t } from '../../../shared/i18n';
import {
  firstPlanHeading,
  isPlanToolName,
  planMarkdownFromInput
} from '../../../shared/planExtract';
import { MarkdownBody } from './MarkdownBody';
import { ChatMarkdownBody } from '../chatSurface/ChatMarkdownBody';
import { useStreamReveal } from '../chatSurface/useStreamReveal';
import { useTranscriptFoldState } from '../chatSurface/transcriptFoldState';
import { MOTION, prefersReducedMotion, usePresence } from './motion';
import { prefersReducedMotionPreference, subscribeInteractionPreferences } from '../interactionPreferences';
import { AnimatedDetails } from './AnimatedDetails';
import { UiWidgetCard } from '../chatSurface/UiWidgetCard';
import { uiRenderWidgetFromToolCall, type UiArtifactLinkMatch } from '../../../shared/uiArtifactLink';
import { uiWidgetIdentity } from '../../../shared/uiWidgetProtocol';
import { uiMessageArtifacts } from '../../../shared/uiMessageArtifacts';
import { UiArtifactSuppressionContext, useUiArtifactSuppressionPaths } from '../chatSurface/UiArtifactContext';
import { HarnessMetricsChips, useHarnessInputText } from '../chatSurface/harnessAnnotations';
import { makeNoteToken } from '../../../shared/noteAnnotations';
import { summarizeWorkerModelMentions, workerModelInvocation, workerModelMentions } from '../../../shared/workerModelMention';
import { ImageLightbox } from './ImageLightbox';
import { TerminalActivityIcon, ThinkingActivityIcon, ToolActivityIcon, WriteActivityIcon } from './ActivityIcons';
import { WaitingTip } from './WaitingTip';
import {
  buildReplaceDiffText,
  classifyTool,
  MiniDiffView,
  ToolTitleTarget
} from './ToolVisuals';
import {
  IconPlan,
  IconCheckSquare,
  IconSquare,
  IconPlay,
  IconHourglass,
  IconCopy,
  IconBookmark,
  IconFork,
  IconPencil,
  IconChevronDown
} from './icons';

/** 计划状态文案：取值函数内查 i18n（对齐 liteToolVerb；比较/兜底值不翻译） */
function planStatusLabel(status: string, isActive = true): string {
  if (status === 'pending' && !isActive) return t('已更新');
  switch (status) {
    case 'pending':
      return t('待确认');
    case 'executing':
      return t('执行中');
    case 'done':
      return t('已完成');
    case 'abandoned':
      return t('已放弃');
    default:
      return status;
  }
}

function PlanCardView({
  plan,
  disabled,
  mode,
  cwd,
  onFileLink,
  onAction
}: {
  plan: NonNullable<ChatMessage['plan']>;
  disabled?: boolean;
  /** 会话当前模式：非 plan 档下卡只读（执行/修改的承诺只在计划档成立） */
  mode?: string | null;
  /** 会话 cwd：计划 markdown 里的路径链接化用 */
  cwd?: string;
  onFileLink?: (href: string) => void;
  /** revise = 提出修改（feedback 为修改意见，由上层转发消息通道） */
  onAction?: (action: 'execute' | 'abandon' | 'revise', feedback?: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const isActive = plan.active !== false;
  const pending = plan.status === 'pending' && isActive;
  const modeAllows = !mode || mode === 'plan';
  // 执行需要可执行的步骤列表（executePlan 按步骤拼执行 prompt）；修改/放弃不受限
  const canExecute = pending && modeAllows && plan.steps.length > 0;
  const [expanded, setExpanded] = React.useState(pending && !!plan.markdown);
  const [revising, setRevising] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // 卡片从待确认转入执行中/被取代时收起全文（执行态默认只看步骤进度）
  React.useEffect(() => {
    if (plan.status !== 'pending' || !isActive) setExpanded(false);
  }, [plan.status, isActive]);
  const doneCount = plan.steps.filter((s) => s.completed).length;
  const showSteps =
    plan.steps.length > 0 && (plan.status !== 'pending' || !plan.markdown || !expanded);
  const submitRevise = (): void => {
    const feedback = draft.trim();
    if (!feedback || !onAction) return;
    onAction('revise', feedback);
    setDraft('');
    setRevising(false);
  };
  return (
    <div className={`plan-card ${plan.status}${isActive ? '' : ' is-superseded'}`}>
      <div className="plan-card-title">
        <IconPlan size={13} />
        {plan.steps.length > 0 ? t('计划（{{n}} 步）', { n: plan.steps.length }) : t('计划')}
        <span className="plan-card-status">{planStatusLabel(plan.status, isActive)}</span>
        {plan.markdown ? (
          <button
            type="button"
            className="plan-card-fold"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t('收起全文') : t('展开全文')}
          </button>
        ) : null}
      </div>
      {plan.markdown ? (
        <div className={`acc plan-card-body${expanded ? ' is-open' : ''}`}>
          <div className="acc-body">
            <div className="plan-card-body-scroll">
              <ChatMarkdownBody text={plan.markdown} cwd={cwd} onFileLink={onFileLink} />
            </div>
          </div>
        </div>
      ) : null}
      {showSteps ? (
        <ol className="plan-card-steps">
          {plan.steps.map((s) => (
            <li key={s.step} className={s.completed ? 'is-done' : undefined}>
              {s.completed ? <IconCheckSquare size={12} /> : <IconSquare size={12} />} {s.text}
            </li>
          ))}
        </ol>
      ) : null}
      {plan.status === 'executing' ? (
        <div className="plan-card-progress">
          {t('{{done}}/{{total}} 已完成（完成后按 [DONE:n] 自动勾选）', {
            done: doneCount,
            total: plan.steps.length
          })}
        </div>
      ) : null}
      {pending && onAction && modeAllows ? (
        <>
          <div className="plan-card-actions">
            {canExecute ? (
              <button
                type="button"
                className="plan-card-exec"
                disabled={disabled}
                title={t('恢复完整工具并按计划逐步执行')}
                onClick={() => onAction('execute')}
              >
                <IconPlay size={12} /> {t('执行计划')}
              </button>
            ) : null}
            <button
              type="button"
              className={`plan-card-revise${revising ? ' is-active' : ''}`}
              disabled={disabled}
              onClick={() => setRevising((v) => !v)}
            >
              {t('提出修改')}
            </button>
            <button
              type="button"
              className="plan-card-abandon"
              disabled={disabled}
              onClick={() => onAction('abandon')}
            >
              {t('放弃')}
            </button>
            {!revising ? (
              <span className="plan-card-hint">{t('修改意见会发给 Agent，修订后出新版计划')}</span>
            ) : null}
          </div>
          {revising ? (
            <div className="plan-card-revise-box">
              <textarea
                className="plan-card-revise-input"
                placeholder={t('对计划的修改意见，如：第 2 步先补测试…')}
                value={draft}
                disabled={disabled}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="plan-card-revise-actions">
                <button
                  type="button"
                  className="plan-card-exec"
                  disabled={disabled || !draft.trim()}
                  onClick={submitRevise}
                >
                  {t('发送')}
                </button>
                <button
                  type="button"
                  className="plan-card-abandon"
                  disabled={disabled}
                  onClick={() => {
                    setDraft('');
                    setRevising(false);
                  }}
                >
                  {t('取消')}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {pending && onAction && !modeAllows ? (
        <div className="plan-card-hint">{t('切回计划档后可执行或提出修改')}</div>
      ) : null}
    </div>
  );
}

/** 摘要动词轻量化（对齐 Cursor 活动流用词）；比较用中文原词（classifyTool 词表），只翻展示值 */
function liteToolVerb(verb: string): string {
  if (verb === '执行命令') return t('终端');
  if (verb === '搜索') return t('探索');
  if (verb === '列目录') return t('浏览');
  return verb;
}

/** 路径/命令截短，用作轻量一行的副标题 */
function liteToolDetail(visual: ReturnType<typeof classifyTool>, tc: ToolCallRecord): string {
  if (tc.status === 'error') return t('失败');
  if (tc.status === 'cancelled') return t('已取消');
  if (visual.detail) return visual.detail;
  const raw = visual.path?.trim();
  if (!raw) return tc.status === 'running' ? '' : t('已完成');
  if (visual.isCommand) {
    const one = raw.split(/\r?\n/)[0].trim();
    return one.length > 64 ? `${one.slice(0, 64)}…` : one;
  }
  const base = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;
  return base;
}

/** The visual's isCommand also covers a few non-shell status tools; keep those as tools. */
function toolActivityKind(visual: ReturnType<typeof classifyTool>, name: string, isPlan: boolean): 'terminal' | 'write' | 'tool' {
  const normalized = name.toLowerCase();
  if (isPlan) return 'tool';
  if (visual.verb === '写入' || visual.verb === '编辑' ||
      /^(file_change|write_file|edit_file|create_file|apply_patch|multiedit|set_file_contents)$/.test(normalized)) return 'write';
  if (/^(bgtasks[._](wait|kill|list)|askquestion|ask_user_question)$/.test(normalized)) return 'tool';
  return visual.isCommand || normalized === 'command_execution' ? 'terminal' : 'tool';
}

type ToolCallPresentation = {
  visual: ReturnType<typeof classifyTool>;
  prettyArgs: string;
  prettyResult: string;
  planMarkdown: string | null;
  uiWidget: ReturnType<typeof uiRenderWidgetFromToolCall>;
};

function presentToolCall(tc: ToolCallRecord): ToolCallPresentation {
  const input = tc.input ?? safeParseObject(tc.arguments);
  const visual = classifyTool(tc.name, input);
  let prettyArgs = tc.arguments;
  try {
    let args = tc.input ?? JSON.parse(tc.arguments || '{}');
    if (visual.commandParam) {
      const { [visual.commandParam]: _command, ...rest } = args;
      args = rest;
    }
    prettyArgs = args && typeof args === 'object' && !Array.isArray(args) && !Object.keys(args).length
      ? ''
      : JSON.stringify(args, null, 2);
  } catch {
    // 保留原始串
  }
  let prettyResult = tc.result ?? '';
  try {
    if (tc.result) prettyResult = JSON.stringify(JSON.parse(tc.result), null, 2);
  } catch {
    // 保留原始串
  }
  // 计划类工具（cursor createPlan 等）：参数就是计划全文，卡面只给一行标题
  const planMarkdown = isPlanToolName(tc.name) ? planMarkdownFromInput(input) : null;
  // 智能界面双轨（决策 2026-10-11）：ui.render 工具卡直挂部件（模型零搬运）
  const uiWidget = tc.status !== 'running' ? uiRenderWidgetFromToolCall(tc.name, tc.result) : null;
  return { visual, prettyArgs, prettyResult, planMarkdown, uiWidget };
}

function ToolCallSummary({
  tc,
  parsed,
  onFileLink,
  prefix
}: {
  tc: ToolCallRecord;
  parsed: ToolCallPresentation;
  onFileLink?: (href: string) => void;
  prefix?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { visual, planMarkdown } = parsed;
  const live = tc.status === 'running';
  const planTitle = planMarkdown ? firstPlanHeading(planMarkdown) : null;
  const verb = planMarkdown ? t('提交计划') : liteToolVerb(visual.verb);
  const detail = planTitle ?? liteToolDetail(visual, tc);
  const activityKind = toolActivityKind(visual, tc.name, !!planMarkdown);

  return (
    <>
      {activityKind === 'terminal' ? <TerminalActivityIcon active={live} />
        : activityKind === 'write' ? <WriteActivityIcon active={live} />
        : <ToolActivityIcon active={live} />}
      <span className="tool-lite-label">
        {prefix ? <span className="tool-call-summary-prefix">{prefix}</span> : null}
        {prefix && (verb || detail) ? <span className="tool-lite-sep"> · </span> : null}
        <span className="tool-lite-verb">{verb}</span>
        {detail ? <span className="tool-lite-sep"> · </span> : null}
        {detail && visual.path && !visual.detail && !visual.isCommand && onFileLink && tc.status === 'ok' ? (
          <ToolTitleTarget visual={visual} label={detail} onFileLink={onFileLink} />
        ) : detail ? (
          <span className="tool-lite-detail" title={visual.detail ?? visual.path}>
            {detail}
          </span>
        ) : null}
        {live ? <span className="tool-activity-label">{t('执行中')}</span> : null}
      </span>
    </>
  );
}

const ToolCallCard = React.memo(function ToolCallCard({
  tc,
  onFileLink
}: {
  tc: ToolCallRecord;
  onFileLink?: (href: string) => void;
}): React.JSX.Element {
  // 解析/分类/美化都依赖原始字符串：流式期间父组件每拍重渲，这里必须按内容缓存
  // （JSON.parse + stringify 是卡片渲染的大头，几百文件的工具卡不缓存会连着重解析）
  const parsed = React.useMemo(() => presentToolCall(tc), [tc.input, tc.arguments, tc.name, tc.result, tc.status, tc.patch]);
  const { visual, prettyArgs, prettyResult, planMarkdown, uiWidget } = parsed;
  const diffText =
    tc.patch ??
    (visual.edits?.length
      ? buildReplaceDiffText(visual.path ?? tc.name, visual.edits)
      : undefined);
  return (
    <div className="tool-call-block">
      {tc.previewPath ? <CapturePreview path={tc.previewPath} /> : null}
      <AnimatedDetails
        className={`tool-card tool-lite ${tc.status}${tc.status === 'running' ? ' is-live' : ''}`}
        summary={<ToolCallSummary tc={tc} parsed={parsed} onFileLink={onFileLink} />}
      >
        <div className="tool-detail">
          {uiWidget ? <span className="tool-ui-artifact-note">{t('交互内容已在回答中展示')}</span> : null}
          {diffText ? (
            <>
              <label>{t('改动')}</label>
              <MiniDiffView diffText={diffText} />
            </>
          ) : null}
          {visual.content !== undefined ? (
            <>
              <label>{t('内容')}</label>
              <pre className="tool-content-pre">{clipLines(visual.content, 80)}</pre>
            </>
          ) : null}
          {!diffText && visual.isCommand && visual.path ? (
            <>
              <label>{t('命令')}</label>
              <pre>{visual.path}</pre>
            </>
          ) : null}
          {/* 命令单独展示，参数区保留超时、工作目录等其他入参。 */}
          {prettyArgs &&
          !diffText &&
          visual.content === undefined &&
          (!visual.isCommand || !visual.path || visual.commandParam) &&
          !planMarkdown ? (
            <>
              <label>{t('参数')}</label>
              <pre>{prettyArgs}</pre>
            </>
          ) : null}
          {tc.result && visual.verb !== '写入' ? (
            <>
              <label>{visual.verb === '读取' && tc.status === 'ok' ? t('内容') : t('结果')}</label>
              <pre>{clipLines(prettyResult, 200)}</pre>
            </>
          ) : null}
          {planMarkdown ? (
            <>
              <label>{t('计划')}</label>
              <pre>{clipLines(planMarkdown, 80)}</pre>
            </>
          ) : null}
        </div>
      </AnimatedDetails>
    </div>
  );
});

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function UiArtifactOutputs({ matches }: { matches: readonly UiArtifactLinkMatch[] }): React.JSX.Element | null {
  if (matches.length === 0) return null;
  return <>{matches.map(match => <UiWidgetCard key={uiWidgetIdentity(match.path)} match={match} />)}</>;
}

function clipLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n${t('…（共 {{n}} 行，已截断）', { n: lines.length })}`;
}

function CapturePreview({ path }: { path: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const [src, setSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void window.api.captures.readPreview(path).then((r) => {
      if (!cancelled && r.ok) setSrc(r.dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!src) return null;
  return (
    <div className="tool-capture-preview">
      <img src={src} alt={t('终端截图')} />
    </div>
  );
}

/** 大栈渐进挂载：数百张卡一次性挂载会冻结主线程（切会话/展开大回合首帧），
 *  先放行首屏量、余下每帧补一批；流式期列表增长同走此节奏（每帧 +160 远快于工具产出） */
const TOOL_MOUNT_FIRST = 40;
const TOOL_MOUNT_STEP = 160;

type ToolStackItem = ToolCallRecord | { thinking: string };

function ToolCallStack({
  items,
  onFileLink,
  streaming = false,
  activeThinking,
  liveThinkingOnly = true
}: {
  items: ToolStackItem[];
  onFileLink?: (href: string) => void;
  streaming?: boolean;
  activeThinking?: string;
  liveThinkingOnly?: boolean;
}): React.JSX.Element | null {
  let currentTool: ToolCallRecord | undefined;
  let latestTool: ToolCallRecord | undefined;
  let toolCount = 0;
  for (const item of items) {
    if ('thinking' in item) continue;
    latestTool = item;
    toolCount += 1;
    if (item.status === 'running') currentTool = item;
  }
  latestTool = currentTool ?? latestTool;
  const [budget, setBudget] = React.useState(TOOL_MOUNT_FIRST);
  React.useEffect(() => {
    if (budget >= items.length) return;
    const raf = requestAnimationFrame(() =>
      setBudget((b) => Math.min(b + TOOL_MOUNT_STEP, items.length))
    );
    return () => cancelAnimationFrame(raf);
  }, [budget, items.length]);
  const latestPresentation = React.useMemo(
    () => latestTool ? presentToolCall(latestTool) : null,
    [latestTool?.input, latestTool?.arguments, latestTool?.name, latestTool?.result, latestTool?.status, latestTool?.patch]
  );
  if (!latestTool || !latestPresentation) return null;
  const isThinking = activeThinking !== undefined;
  const isRunning = streaming && !!currentTool;
  const summary = isThinking ? (
    <>
      <ThinkingActivityIcon active />
      <LiveThinkingText text={activeThinking} />
    </>
  ) : isRunning ? (
    <ToolCallSummary
      tc={latestTool}
      parsed={latestPresentation}
      onFileLink={onFileLink}
      prefix={t('工具调用')}
    />
  ) : (
    <>
      <ToolActivityIcon active={false} />
      <span className="tool-call-group-label">{t('调用了工具')}</span>
      {toolCount > 1 ? <span className="tool-call-group-count">{t('{{n}} 个工具调用', { n: toolCount })}</span> : null}
    </>
  );
  return (
    <div className="tool-call-group">
      <AnimatedDetails
        className={`tool-call-group-details${isThinking ? ' is-thinking' : isRunning ? ' is-live' : ''}`}
        summary={summary}
      >
        <div className="tool-call-group-list">
          {items.slice(0, budget).map((item, idx) => 'thinking' in item ? (
            liveThinkingOnly ? (
              <div key={`thinking-${idx}`} className="tool-call-group-thought">
                <ThinkingActivityIcon active={false} />
                <span>{t('进行了一段思考')}</span>
              </div>
            ) : (
              <ThinkingCard
                key={`thinking-${idx}`}
                text={item.thinking}
                streaming={false}
                contentStarted
                liveThinkingOnly={false}
                historyLabel={t('进行了一段思考')}
              />
            )
          ) : (
            <ToolCallCard key={item.id} tc={item} onFileLink={onFileLink} />
          ))}
        </div>
      </AnimatedDetails>
    </div>
  );
}

/** 思考时长文案（折叠摘要用，贴近 Cursor「持续了几秒」轻量语气） */
function formatThinkingDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 10) return t('持续了几秒');
  if (sec < 60) return t('持续了 {{n}} 秒', { n: sec });
  const min = Math.max(1, Math.round(sec / 60));
  return t('持续了 {{n}} 分钟', { n: min });
}

/**
 * 流式思考仅占一行；保留历史思考时，结束后仍可展开查看原文。
 */
function LiveThinkingText({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  const viewportRef = React.useRef<HTMLSpanElement>(null);
  const contentRef = React.useRef<HTMLSpanElement>(null);
  const positionedRef = React.useRef(false);
  const previousRef = React.useRef({ text: '', offset: 0 });
  const exitTimerRef = React.useRef<number | null>(null);
  const [exiting, setExiting] = React.useState<{ text: string; offset: number } | null>(null);
  const exitPresence = usePresence(exiting !== null, MOTION.exitMs);
  const reducedMotion = useSyncExternalStore(subscribeInteractionPreferences, prefersReducedMotionPreference);
  const preview = text.replace(/\s+/g, ' ').trim();

  // Wrap normally, then move only when another visual line is added. Keeping
  // the viewport fixed prevents the rest of the transcript from shifting.
  const updatePosition = React.useCallback((animate: boolean, nextText: string) => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const offset = Math.max(0, content.offsetHeight - viewport.clientHeight);
    const transform = `translateY(${-offset}px)`;
    const previous = previousRef.current;
    if (positionedRef.current && animate && offset > previous.offset && previous.text &&
      nextText.startsWith(previous.text) && !prefersReducedMotion() && !document.hidden &&
      getComputedStyle(viewport).visibility !== 'hidden' && exitTimerRef.current == null) {
      setExiting({ text: previous.text, offset: previous.offset });
      exitTimerRef.current = window.setTimeout(() => { exitTimerRef.current = null; setExiting(null); }, MOTION.exitMs);
    }
    content.style.transform = transform;
    positionedRef.current = true;
    previousRef.current = { text: nextText, offset };
  }, []);

  React.useLayoutEffect(() => { updatePosition(true, preview); }, [preview, updatePosition]);
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let width = viewportRef.current?.clientWidth ?? 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = viewportRef.current?.clientWidth ?? 0;
      if (nextWidth !== width && exitTimerRef.current != null) {
        window.clearTimeout(exitTimerRef.current); exitTimerRef.current = null; setExiting(null);
      }
      width = nextWidth;
      updatePosition(false, previousRef.current.text);
    });
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [updatePosition]);
  React.useEffect(() => {
    if (!reducedMotion || exitTimerRef.current == null) return;
    window.clearTimeout(exitTimerRef.current); exitTimerRef.current = null; setExiting(null);
  }, [reducedMotion]);
  React.useEffect(() => () => { if (exitTimerRef.current != null) window.clearTimeout(exitTimerRef.current); }, []);

  return <span className="thinking-live-text" ref={viewportRef}>
    <span className="thinking-live-content" ref={contentRef} dir="auto" style={exiting ? { opacity: 0 } : undefined}>{preview || t('思考中…')}</span>
    {exitPresence.mounted && exiting ? <span className="thinking-live-exit" {...exitPresence.spread} aria-hidden="true">
      <span className="thinking-live-exit-content" dir="auto" style={{ transform: `translateY(${-exiting.offset}px)` }}>{exiting.text}</span>
    </span> : null}
  </span>;
}

function ThinkingCard({
  text,
  streaming,
  contentStarted,
  liveThinkingOnly,
  historyLabel
}: {
  text: string;
  streaming: boolean;
  contentStarted: boolean;
  liveThinkingOnly: boolean;
  historyLabel?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const live = streaming && !contentStarted;
  const [open, setOpen] = React.useState(live);
  const userToggledRef = React.useRef(false);
  const startedAtRef = React.useRef(Date.now());
  const [durationLabel, setDurationLabel] = React.useState(t('持续了几秒'));

  React.useEffect(() => {
    if (userToggledRef.current) return;
    setOpen(live);
  }, [live]);

  React.useEffect(() => {
    if (!live) {
      setDurationLabel(formatThinkingDuration(Date.now() - startedAtRef.current));
    }
  }, [live]);

  if (live) {
    return (
      <div className="thinking-card thinking-live" aria-label={t('思考中')}>
        <ThinkingActivityIcon active />
        <LiveThinkingText text={text} />
      </div>
    );
  }

  return (
    <AnimatedDetails
      className={`thinking-card${open ? ' is-open' : ''}`}
      open={open}
      onToggle={(next) => {
        userToggledRef.current = true;
        setOpen(next);
      }}
      summary={
        <>
          <ThinkingActivityIcon active={false} />
          <span className="thinking-title">
            {historyLabel ?? (liveThinkingOnly ? t('思考过程 · {{label}}', { label: durationLabel }) : t('正在思考中'))}
          </span>
        </>
      }
    >
      <div className="thinking-body">
        {text}
      </div>
    </AnimatedDetails>
  );
}

/** 消息操作行上的批注入口（与复制/分叉同款按钮，不依赖文字锚点量位） */
export type ChatHoverbarNote = { id: string; seq: number };

/** 悬浮操作条：常驻占位，悬停或聚焦时显示时间、复制、收藏、重新编辑、分叉和批注。 */
export function ChatHoverbar({
  timeLabel,
  message,
  favorited = false,
  onToggleFavorite,
  onFork,
  onEditAborted,
  notes,
  onNoteClick,
  openNoteId,
  harnessMetrics,
  engineInput
}: {
  timeLabel?: string;
  message: ChatMessage;
  engineInput?: string;
  favorited?: boolean;
  onToggleFavorite?: () => void;
  onFork?: (messageId: string) => void;
  onEditAborted?: (messageId: string) => void;
  notes?: readonly ChatHoverbarNote[];
  onNoteClick?: (id: string) => void;
  openNoteId?: string | null;
  /** Harness 透明计量 chips（§6.3；仅在透明模式开启时由转写层传入） */
  harnessMetrics?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; durationMs?: number };
}): React.JSX.Element {
  const { t } = useTranslation();
  const [copyStatus, setCopyStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const copyLife = React.useRef({ mounted: true, request: 0, timer: null as number | null });
  React.useEffect(() => {
    const life = copyLife.current;
    life.mounted = true;
    return () => {
      life.mounted = false;
      life.request++;
      if (life.timer != null) window.clearTimeout(life.timer);
      life.timer = null;
    };
  }, []);
  const copy = async (): Promise<void> => {
    const text =
      message.role === 'user'
        ? engineInput ?? message.content
        : (message.parts ?? [])
            .filter((p) => p.kind === 'text')
            .map((p) => p.text ?? '')
            .join('\n\n')
            .trim() || message.content;
    if (!text) return;
    const life = copyLife.current;
    const request = ++life.request;
    if (life.timer != null) window.clearTimeout(life.timer);
    life.timer = null;
    setCopyStatus('idle');
    try {
      await navigator.clipboard.writeText(text);
      if (!life.mounted || life.request !== request) return;
      setCopyStatus('copied');
      // Business feedback lifetime, independent of the animation token duration.
      life.timer = window.setTimeout(() => {
        if (!life.mounted || life.request !== request) return;
        life.timer = null;
        setCopyStatus('idle');
      }, 1500);
    } catch {
      if (life.mounted && life.request === request) setCopyStatus('failed');
    }
  };
  const copied = copyStatus === 'copied';
  const copyLabel = copied ? t('已复制') : t('复制内容');
  return (
    <div className="chat-hoverbar">
      {harnessMetrics ? <HarnessMetricsChips {...harnessMetrics} /> : null}
      {timeLabel ? (
        <span className="chat-time" title={new Date(message.createdAt).toLocaleString()}>
          {timeLabel}
        </span>
      ) : null}
      <button
        type="button"
        className="chat-hoverbar-btn"
        title={copyStatus === 'failed' ? t('复制失败') : copyLabel}
        aria-label={copyLabel}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        <span className="copy-feedback" data-copied={copied ? 'true' : undefined} aria-hidden="true">
          <IconCopy size={12} />
        </span>
      </button>
      {onToggleFavorite ? (
        <button
          type="button"
          className="chat-hoverbar-btn msg-favorite-btn"
          title={favorited ? t('取消收藏') : t('收藏')}
          aria-label={t('收藏')}
          aria-pressed={favorited}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
        >
          <IconBookmark size={12} />
        </button>
      ) : null}
      {onEditAborted && !message.queued ? (
        <button
          type="button"
          className="chat-hoverbar-btn"
          title={t('重新编辑终止消息')}
          aria-label={t('重新编辑')}
          onClick={(e) => {
            e.stopPropagation();
            onEditAborted(message.id);
          }}
        >
          <IconPencil size={12} />
        </button>
      ) : null}
      {onFork && !message.queued ? (
        <button
          type="button"
          className="chat-hoverbar-btn"
          title={t('从这里分叉出新会话')}
          aria-label={t('分叉会话')}
          onClick={(e) => {
            e.stopPropagation();
            onFork(message.id);
          }}
        >
          <IconFork size={12} />
        </button>
      ) : null}
      {onNoteClick
        ? (notes ?? []).map((n) => {
            const label = makeNoteToken(n.seq);
            return (
              <button
                key={n.id}
                type="button"
                className={`chat-hoverbar-btn is-note${openNoteId === n.id ? ' is-note-open' : ''}`}
                data-note-entry=""
                title={t('批注 {{n}}', { n: n.seq })}
                aria-label={label}
                aria-pressed={openNoteId === n.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onNoteClick(n.id);
                }}
              >
                {label}
              </button>
            );
          })
        : null}
    </div>
  );
}

/**
 * 回合工作折叠头（对齐 Cursor「Worked for 1m 19s」）：回合结束后工具/思考收成
 * 一行轻量摘要；点开后条目在原位现身（与正文按真实发生顺序交错），再点单条看详情。
 * 实测时长优先（仅本会话亲历流式可得）；历史重载拿不到时长时退回条数摘要。
 */
function TurnFold({
  toolCount,
  thinkingCount,
  workedMs,
  open,
  onToggle,
  disabled
}: {
  toolCount: number;
  thinkingCount: number;
  /** 回合工作时长（毫秒）；历史轮为 null */
  workedMs?: number | null;
  open: boolean;
  onToggle: () => void;
  /** 时间衰减（R-23）：超期旧回合只读归档——强制收起且点击不展开 */
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bits: string[] = [];
  if (workedMs != null) {
    const sec = Math.max(1, Math.round(workedMs / 1000));
    bits.push(
      sec < 60
        ? t('工作了 {{n}} 秒', { n: sec })
        : t('工作了 {{m}} 分 {{s}} 秒', { m: Math.floor(sec / 60), s: sec % 60 })
    );
  }
  if (toolCount > 0) bits.push(t('{{n}} 个工具调用', { n: toolCount }));
  if (thinkingCount > 0) bits.push(t('{{n}} 段思考', { n: thinkingCount }));
  const label = bits.join(' · ');
  return (
    <button
      type="button"
      className={`turn-fold${open ? ' is-open' : ''}${disabled ? ' is-stale' : ''}`}
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      title={disabled ? t('较早的回合已折叠归档') : undefined}
      onClick={disabled ? undefined : onToggle}
    >
      <span className="turn-fold-label">{label}</span>
      <IconChevronDown size={14} className="turn-fold-caret" />
    </button>
  );
}

/**
 * parts 消息渲染（GUI Worker v2）：按到达顺序交错展示思考 / 工具 / 文本；
 * 工具调用与其后的思考合并为一个可展开分组；实时思考占用分组摘要，结束后进入组内。
 * range 渲染 [start, end) 下标区间——审批/提问卡按 anchorPartIndex 插进 parts 流
 * 时把一条消息切成两段渲染（卡不再是「永远沉在消息底部」）。
 * collapsedTurn：回合结束后插入一行折叠摘要头（Cursor 式 Worked for），中间正文
 * 与活动项**真卸载**、只保留最后一段正文——折叠不占挂载成本（切重会话首开的
 * 277 工具卡冻结主因）；展开重挂（卡内瞬态按约定复位），大栈由 ToolCallStack
 * 分批渐进挂载补齐。
 * staleTurn（时间衰减，R-23）：超期旧回合折叠头转只读——open 恒为 false、点击
 * 不展开（aria-disabled + title 说明），中间项维持真卸载（只留最后一段正文）。
 */
function PartsBody({
  message,
  suppressedArtifacts,
  streaming,
  onFileLink,
  cwd,
  range,
  collapsedTurn,
  activityOnly,
  workedMs,
  foldOpen,
  onFoldToggle,
  staleTurn,
  liveThinkingOnly
}: {
  liveThinkingOnly: boolean;
  message: ChatMessage;
  suppressedArtifacts: readonly string[];
  streaming: boolean;
  onFileLink?: (href: string) => void;
  /** 会话 cwd：路径链接化的 stat 校验与点击路由同源 */
  cwd?: string;
  range?: [number, number];
  collapsedTurn?: boolean;
  activityOnly?: boolean;
  /** 回合工作时长（折叠头摘要用，见 TurnFold） */
  workedMs?: number | null;
  /** 折叠体展开态（消息级持有，同消息多段共享） */
  foldOpen: boolean;
  onFoldToggle: () => void;
  /** 时间衰减（R-23）：强制收起且不可展开，优先于 foldOpen */
  staleTurn?: boolean;
}): React.JSX.Element | null {
  const parts = message.parts ?? [];
  const start = range ? Math.max(0, range[0]) : 0;
  const end = range ? Math.min(parts.length, range[1]) : parts.length;
  const folded = (!!collapsedTurn || !!activityOnly) && !streaming;
  // 时间衰减：超期回合 open 恒为 false（展开态被门住，elide 依此真卸载）
  const effOpen = staleTurn ? false : foldOpen;
  // 折叠只保留最后一段正文（Cursor 同款）：中间正文与活动项一并隐藏。两个消息级
  // 前置量（跨审批/提问卡分段也一致）：最后一段正文的下标；消息里是否存在可折叠
  // 活动项——纯正文消息没有折叠头，中间正文绝不能藏（否则没有展开入口）
  let lastTextIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && p.kind === 'text' && p.text) {
      lastTextIdx = i;
      break;
    }
  }
  // 折叠前置量按全消息扫描（审批/提问卡切段渲染时各段口径一致）：
  // 是否存在可折叠条目、首个可折叠条目下标（折叠头随它所在的段渲染）、
  // 折叠头计数（整回合合计，与单段渲染时的旧口径等价）
  let msgHasFold = false;
  let firstFoldableIdx = -1;
  let foldToolCount = 0;
  let foldThinkingCount = 0;
  if (folded) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.kind === 'thinking' && !liveThinkingOnly) {
        msgHasFold = true;
        if (firstFoldableIdx < 0) firstFoldableIdx = i;
        foldThinkingCount += 1;
      } else if (
        p.kind === 'tool' &&
        (p as Extract<ChatDisplayPart, { kind: 'tool' }>).toolCall?.status !== 'running'
      ) {
        msgHasFold = true;
        if (firstFoldableIdx < 0) firstFoldableIdx = i;
        foldToolCount += 1;
      }
    }
  }
  // ── 折叠头置顶 + acc 折叠体（2026-10-31）──
  // 折叠头固定在回合内容最前（此前插在首个可折叠 part 处，落在第一段正文下面）；
  // 可折叠前缀（末段正文之前的条目）装进 acc 折叠体：grid 0fr↔1fr + opacity 纯
  // transition（可打断），展开/收起丝滑。稳态收起 wrapper 不挂载——真卸载与
  // 「折叠条目 el 不创建」契约不变；收起瞬态由 presence 延迟卸载播完退场再卸内容。
  // 执行中的工具栈不参与折叠（保持可见，旧契约）：foldMode 下随尾部渲染。
  // key 用 part 下标派生：插入/移除折叠头不位移其余条目的 key。
  const foldMode = folded && msgHasFold;
  const foldPresence = usePresence(effOpen, MOTION.exitMs);
  /** 折叠体内容当前是否挂载（展开中 / 收起退场窗口）；稳态收起=条目 el 不创建 */
  const foldBodyLive = foldMode && foldPresence.mounted;
  const elide = (hideWhenFolded: boolean): boolean => hideWhenFolded && !effOpen;
  /** 折叠态可见性（单一来源）：进折叠体的条目随 foldBodyLive（稳态收起即不创建）；
   *  尾部与非折叠模式沿用旧 elide 规则（含「执行中工具栈保持可见」契约） */
  const foldVisible = (inBody: boolean, hideWhenFolded: boolean): boolean =>
    inBody && foldMode ? foldBodyLive : !elide(hideWhenFolded);
  /** 折叠前缀（末段正文之前）与尾部（末段正文及其后罕见条目）分列 */
  const bodyRuns: Array<{ key: string; el: React.JSX.Element | null }> = [];
  const tailRuns: Array<{ key: string; el: React.JSX.Element | null }> = [];
  const orderedRuns: Array<{ key: string; el: React.JSX.Element | null; inBody: boolean }> = [];
  const attachedArtifactPaths = new Set<string>();
  const artifactsForTools = (tools: readonly ToolCallRecord[]): UiArtifactLinkMatch[] => {
    const matches: UiArtifactLinkMatch[] = [];
    for (const tool of tools) {
      if (tool.status === 'running') continue;
      const match = uiRenderWidgetFromToolCall(tool.name, tool.result);
      if (!match) continue;
      const key = uiWidgetIdentity(match.path);
      if (attachedArtifactPaths.has(key)) continue;
      attachedArtifactPaths.add(key);
      matches.push(match);
    }
    return matches;
  };
  const addRun = (inBody: boolean, run: { key: string; el: React.JSX.Element | null }): void => {
    (inBody ? bodyRuns : tailRuns).push(run);
    orderedRuns.push({ ...run, inBody });
  };
  let pastLastText = false;
  let i = start;
  while (i < end) {
    const idx = i;
    const part = parts[i];
    const isLast = idx === parts.length - 1;
    if (part.kind === 'tool') {
      const stack: ToolCallRecord[] = [];
      const items: ToolStackItem[] = [];
      let activeThinking: string | undefined;
      while (i < end) {
        const current = parts[i];
        if (current.kind === 'tool') {
          if (current.toolCall) {
            stack.push(current.toolCall);
            items.push(current.toolCall);
          }
          i += 1;
          continue;
        }
        if (current.kind === 'thinking' && stack.length > 0) {
          if (streaming && i === parts.length - 1) {
            activeThinking = current.text ?? '';
          } else {
            items.push({ thinking: current.text ?? '' });
          }
          i += 1;
          continue;
        }
        break;
      }
      if (stack.length) {
        const foldable = folded && !stack.some((tc) => tc.status === 'running');
        // 执行中的分组不参与回合级折叠，仍随尾部渲染；分组自身继续默认收起。
        const toBody = activityOnly ? foldable : !pastLastText && (!foldMode || foldable);
        const visible = foldVisible(toBody, foldable);
        const attachedKeys = new Set(message.displayItems?.flatMap(item => item.kind === 'mail' ? item.pages.map(page => page.key) : []) ?? []);
        const letters = readMailPresentations(stack).filter(page => !attachedKeys.has(page.key));
        addRun(toBody, {
          key: `p-${idx}`,
          el: visible ? (
            <ToolCallStack
              items={items}
              onFileLink={onFileLink}
              streaming={streaming}
              activeThinking={activeThinking}
              liveThinkingOnly={liveThinkingOnly}
            />
          ) : null
        });
        const artifacts = artifactsForTools(stack);
        if (artifacts.length) {
          // The artifact belongs to this tool run, but stays outside the fold
          // body so collapsing tool activity never hides the rendered UI.
          addRun(false, { key: `ui-${idx}`, el: <UiArtifactOutputs matches={artifacts} /> });
        }
        if (letters.length) {
          // A read letter is an output, not a tool-activity detail. Keep it
          // visible while the activity is folded, then restore its original
          // position when expanded. Moving it avoids duplicate copies during
          // the fold body's exit transition.
          const mailInBody = !activityOnly && toBody && !(foldMode && !effOpen);
          addRun(mailInBody, {
            key: `mail-${idx}`,
            el: <ReadMailCards pages={letters} />
          });
        }
      }
      continue;
    }
    if (part.kind === 'thinking') {
      if (liveThinkingOnly && !(streaming && isLast)) { i += 1; continue; }
      const toBody = activityOnly ? true : !pastLastText;
      const visible = foldVisible(toBody, folded);
      addRun(toBody, {
        key: `p-${idx}`,
        el: visible ? (
          <ThinkingCard
            text={part.text ?? ''}
            streaming={streaming && isLast}
            liveThinkingOnly={liveThinkingOnly}
            // 回合已结束（!streaming）时思考一律按「已收成摘要」处理：不再有 live 态，
            // 否则收尾段是思考的消息会在折叠展开后常驻展开整段正文
            contentStarted={idx < parts.length - 1 || !streaming}
          />
        ) : null
      });
    } else if (part.kind === 'text' && part.text) {
      const isAssistant = message.role === 'assistant';
      if (idx === lastTextIdx) pastLastText = true;
      const inBody = !activityOnly && !pastLastText;
      const visible = foldVisible(inBody, !activityOnly && msgHasFold && idx !== lastTextIdx);
      addRun(inBody, {
        key: `p-${idx}`,
        el: visible ? isAssistant ? (
          <UiArtifactSuppressionContext.Provider value={suppressedArtifacts}><ChatMarkdownBody
            className={`chat-text${streaming && isLast ? ' is-streaming' : ''}`}
            text={part.text}
            streaming={streaming && isLast}
            cwd={cwd}
            onFileLink={onFileLink}
          /></UiArtifactSuppressionContext.Provider>
        ) : (
          <MarkdownBody
            className={`chat-text${streaming && isLast ? ' is-streaming' : ''}`}
            text={part.text}
            onFileLink={onFileLink}
            localImages
            imageCwd={cwd}
          />
        ) : null
      });
    }
    i += 1;
  }
  const renderItem = (r: { key: string; el: React.JSX.Element | null }): React.JSX.Element | null =>
    r.el == null ? null : ( // 折叠条目不挂载（真卸载）
      <div key={r.key} className="turn-fold-item">
        {r.el}
      </div>
    );
  if (!foldMode) {
    const runs = orderedRuns;
    if (runs.length === 0) return null;
    return <>{runs.map(renderItem)}</>;
  }
  if (activityOnly) return <>
    {firstFoldableIdx >= start && firstFoldableIdx < end ? <TurnFold toolCount={foldToolCount}
      thinkingCount={foldThinkingCount} workedMs={workedMs} open={effOpen} onToggle={onFoldToggle} disabled={staleTurn} /> : null}
    {orderedRuns.map(run => run.inBody ? (foldBodyLive && run.el ?
      <div key={run.key} className={`acc turn-fold-body${effOpen && foldPresence.stage === 'in' ? ' is-open' : ''}`} {...foldPresence.spread}>
        <div className="acc-body">{renderItem(run)}</div>
      </div> : null) : renderItem(run))}
  </>;
  // 折叠头只出一次（随首个可折叠条目所在的段渲染，计数为整回合合计）。
  // 保持 orderedRuns 的顺序；部件卡是 inBody=false，因此会在对应工具之后
  // 留在折叠体外，而不会被统一挪到本轮末尾或随工具折叠消失。
  const orderedFoldRuns: React.JSX.Element[] = [];
  let foldGroup: Array<{ key: string; el: React.JSX.Element | null }> = [];
  const flushFoldGroup = (): void => {
    if (foldGroup.length === 0) return;
    const group = foldGroup;
    foldGroup = [];
    if (!foldBodyLive) return;
    orderedFoldRuns.push(
      <div key={`fold-${group[0]!.key}`} className={`acc turn-fold-body${effOpen && foldPresence.stage === 'in' ? ' is-open' : ''}`} {...foldPresence.spread}>
        <div className="acc-body">{group.map(renderItem)}</div>
      </div>
    );
  };
  for (const run of orderedRuns) {
    if (run.inBody) foldGroup.push(run);
    else {
      flushFoldGroup();
      const rendered = renderItem(run);
      if (rendered) orderedFoldRuns.push(rendered);
    }
  }
  flushFoldGroup();
  return (
    <>
      {firstFoldableIdx >= start && firstFoldableIdx < end ? (
        <TurnFold
          key="fold"
          toolCount={foldToolCount}
          thinkingCount={foldThinkingCount}
          workedMs={workedMs}
          open={effOpen}
          onToggle={onFoldToggle}
          disabled={staleTurn}
        />
      ) : null}
      {orderedFoldRuns}
    </>
  );
}

function ChatMessageViewInner({
  message: sourceMessage,
  streaming = false,
  timeLabel = '',
  onRetry,
  onCancelQueued,
  onPlanAction,
  planActionDisabled,
  planMode,
  onFileLink,
  favorited,
  onToggleFavorite,
  onFork,
  onEditAborted,
  quiet = false,
  inlineApproval,
  approvalAnchor,
  inlineUserQuestion,
  questionAnchor,
  collapsedTurn,
  activityOnly,
  transcriptKey,
  forceFoldOpen,
  staleTurn,
  cwd,
  omitAvatar = false,
  avatarContext,
  notes,
  onNoteClick,
  openNoteId,
  harnessMetrics,
  engineInputRef,
  loadEngineInput
}: {
  message: ChatMessage;
  engineInputRef?: string;
  loadEngineInput?: import('../../../shared/chatSurface').HarnessViewState['engineInput'];
  streaming?: boolean;
  /** 消息时间标签（悬浮显示） */
  timeLabel?: string;
  onRetry?: () => void;
  /** 撤回排队中的用户消息 */
  onCancelQueued?: (messageId: string) => void;
  /** 计划卡操作：execute 执行 / abandon 放弃 / revise 提出修改（feedback 走发消息通道） */
  onPlanAction?: (action: 'execute' | 'abandon' | 'revise', feedback?: string) => void;
  /** 计划卡按钮在 Agent busy 时禁用 */
  planActionDisabled?: boolean;
  /** 会话当前模式：非 plan 档计划卡转只读（执行/修改承诺只在计划档成立） */
  planMode?: string | null;
  /** 工作区文件链接（muster-file:）点击回调 */
  onFileLink?: (href: string) => void;
  favorited?: boolean;
  onToggleFavorite?: () => void;
  /** 从该消息分叉出新会话（GUI Worker 传；调度面板不传） */
  onFork?: (messageId: string) => void;
  /** 重新编辑已终止回合的用户消息（取回输入框并移除该轮用户与已终止回复） */
  onEditAborted?: (messageId: string) => void;
  /** 本条消息上的会话批注（操作行「批注N」按钮；点击展开气泡） */
  notes?: readonly ChatHoverbarNote[];
  onNoteClick?: (id: string) => void;
  openNoteId?: string | null;
  /** 会话 cwd：assistant 正文的路径链接化 stat 校验用 */
  cwd?: string;
  /** Harness 透明计量 chips（§6.3；透明模式开启时由转写层传入，关闭态不传=现状零变化） */
  harnessMetrics?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    durationMs?: number;
  };
  /** 去噪观感：无角色行、悬浮操作条、助手无气泡（调度与 GUI 会话同开） */
  quiet?: boolean;
  /** 审批卡：按 approvalAnchor（缺省=消息末尾）插进 parts 流（真实发生顺序） */
  inlineApproval?: React.ReactNode;
  approvalAnchor?: number;
  /** 提问卡：同上 */
  inlineUserQuestion?: React.ReactNode;
  questionAnchor?: number;
  /** 历史轮：工具/思考聚合成折叠头，折叠态真卸载（只保留最后一段正文） */
  collapsedTurn?: boolean;
  activityOnly?: boolean;
  /** 会话查找命中本条：强制展开折叠，已归档回合仍由归档锁保持收起 */
  forceFoldOpen?: boolean;
  /** Session identity for bounded fold memory across virtual row unmounts. */
  transcriptKey?: string;
  /** 时间衰减（R-23）：超期旧回合强制折叠且不可展开，归档标记具有同等锁定效果 */
  staleTurn?: boolean;
  /** 连续同发送者省略头像（留空位对齐） */
  omitAvatar?: boolean;
  /** 调度/Worker 头像上下文；缺省按 GUI Worker 解析 */
  avatarContext?: ChatAvatarContext;
}): React.JSX.Element {
  const engineInput = useHarnessInputText(sourceMessage.id, engineInputRef, loadEngineInput);
  const attachmentView = React.useMemo(() => sourceMessage.role === 'user' && !sourceMessage.host
    ? attachmentDisplay(sourceMessage.content) : { text: sourceMessage.content, attachments: [] }, [sourceMessage]);
  const modelReferences = React.useMemo(() => sourceMessage.role === 'user' && !sourceMessage.host
    ? workerModelMentions(attachmentView.text) : [], [sourceMessage.role, sourceMessage.host, attachmentView.text]);
  const message = React.useMemo(() => {
    if (!attachmentView.attachments.length && !modelReferences.length) return sourceMessage;
    const text = modelReferences.length ? summarizeWorkerModelMentions(attachmentView.text) : attachmentView.text;
    const parts = !sourceMessage.parts ? undefined : attachmentView.attachments.length ? [{ kind: 'text' as const, text }]
      : sourceMessage.parts.map(part => part.kind === 'text' ? { ...part, text: summarizeWorkerModelMentions(part.text) } : part);
    return { ...sourceMessage, content: text, parts };
  }, [sourceMessage, attachmentView, modelReferences]);
  // 流式揭示投影（2026-10-30）：按弹簧字符预算截断的正文视图（工具行在前置
  // 正文揭示完后排整行插入）；非流式/减少动态行原样返回原引用，零额外成本
  const revealRootRef = React.useRef<HTMLDivElement | null>(null);
  const bodyMessage = useStreamReveal(message, streaming, revealRootRef);
  const { t } = useTranslation();
  const liveThinkingOnly = useLiveThinkingOnly();
  const userAvatar = useSyncExternalStore(subscribeUserAvatar, getUserAvatar);
  const isHost = !!message.host;
  const isScheduler = !isHost && message.source === 'scheduler';
  const isAgent = !isHost && message.source === 'agent';
  const isUser = message.role === 'user' && !isHost && !isScheduler && !isAgent;
  const surfaceKind = avatarContext?.surfaceKind ?? 'gui-session';
  const sender = chatAvatarSender(message, surfaceKind);
  const showAvatar = hasChatMessageAvatar(message);
  const character = isAgent ? getSubagentCharacter(message.sourceAgent?.characterId) ?? getSubagentCharacter(DEFAULT_SUBAGENT_CHARACTER_ID)! : undefined;
  const sourceAvatarContext: ChatAvatarContext = { ...avatarContext, surfaceKind,
    workspaceBuiltinAvatarUrl: workspaceIconUrl(avatarContext?.workspaceAvatar),
    ...(userAvatar.kind === 'builtin' ? { userBuiltinAvatarUrl: subagentAvatarUrl(userAvatar.value) } : {}),
    ...(character ? { agentAvatarUrl: subagentAvatarUrl(character.id),
      agentName: t('{{name}}（{{role}}）', { name: message.sourceAgent?.name || t(character.name), role: t(character.role) }) } : {})
  };
  const face = resolveAvatarFace({ sender, userAvatar, context: sourceAvatarContext });
  const avatarLabel = t(
    resolveAvatarTooltip({ sender, userAvatar, context: sourceAvatarContext })
  );
  const hasParts = !!bodyMessage.parts;
  const legacyThinking = !liveThinkingOnly || (streaming && !bodyMessage.content && !message.toolCalls?.length) ? message.thinking : undefined;
  const artifactOutputs = React.useMemo(() => uiMessageArtifacts(message), [message]);
  const suppressedArtifacts = useUiArtifactSuppressionPaths(artifactOutputs.all.map(match => match.path));
  const [lightboxSrc, setLightboxSrc] = React.useState<string | null>(null);
  // 回合工作时长（Cursor「Worked for」）：优先使用 Harness 盖章或消息的收口时间，
  // 组件亲历流式时再用本地起止时间兜底；历史旧消息缺少这些字段时只显示已有计数。
  // useLayoutEffect：折叠头出现的第一帧就要有时长文案，别先闪一下条数摘要
  const sawStreamRef = React.useRef(false);
  const streamStartRef = React.useRef(0);
  const [workedMs, setWorkedMs] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    if (streaming) {
      sawStreamRef.current = true;
      if (streamStartRef.current === 0) streamStartRef.current = Date.now();
      return;
    }
    if (sawStreamRef.current && streamStartRef.current > 0) {
      setWorkedMs((prev) => prev ?? Math.max(1000, Date.now() - streamStartRef.current));
    }
  }, [streaming]);
  const persistedDurationMs = React.useMemo(() => {
    const harnessDuration = harnessMetrics?.durationMs;
    if (typeof harnessDuration === 'number' && Number.isFinite(harnessDuration) && harnessDuration >= 0) {
      return harnessDuration;
    }
    const finishedAt = message.finishedAt;
    if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt) ||
      !Number.isFinite(message.createdAt) || finishedAt < message.createdAt) {
      return null;
    }
    return finishedAt - message.createdAt;
  }, [harnessMetrics?.durationMs, message.createdAt, message.finishedAt]);
  const foldDurationMs = persistedDurationMs ?? workedMs;
  // 折叠体展开态（消息级）：折叠头一个，同消息多段/legacy 路径共用。
  // 查找命中强制展开（露出正文高亮），已归档回合仍由 archiveLocked 关住活动体。
  const [activityOpen, setActivityOpen] = useTranscriptFoldState(transcriptKey, sourceMessage.id);
  const foldExpanded = activityOpen || !!forceFoldOpen;
  const staleLocked = !!staleTurn && !forceFoldOpen;
  const archiveLocked = message.archived === true;
  const foldLocked = archiveLocked || staleLocked;
  const toggleActivity = React.useCallback(() => setActivityOpen((v) => !v), [setActivityOpen]);
  // 汇总条/药丸点开本条上的批注：历史轮若叠着，先展开再让气泡定位（否则中间正文卸掉、像点了没反应）
  // 时间衰减回合不展开（归档态优先）：气泡走 is-from-bar 兜底定位
  React.useLayoutEffect(() => {
    if (openNoteId && !staleLocked && notes?.some((n) => n.id === openNoteId)) {
      setActivityOpen(true);
    }
  }, [openNoteId, notes, staleLocked, setActivityOpen]);
  const archivedToolCount = message.archivedTools?.length ?? 0;
  const hasAnyContent = !!bodyMessage.displayItems?.length || (hasParts
    ? bodyMessage.parts!.some((p) => (p.kind === 'text' && p.text) || p.kind === 'tool')
    : !!bodyMessage.content || !!message.archiveSummary || !!message.toolCalls?.length || archivedToolCount > 0);
  const hasLiveThinking = streaming && (hasParts
    ? bodyMessage.parts!.at(-1)?.kind === 'thinking'
    : !!legacyThinking && !bodyMessage.content && !message.toolCalls?.length);
  const empty = !hasAnyContent && !hasLiveThinking && !message.error && !isUser && !message.plan && !message.aborted;
  // 锚点插入：卡渲染在 anchorPartIndex 下标之前（提问/审批发生在两个工具之间时
  // 按真实顺序显示）；同消息两张卡（防御路径）按下标排序依次插入
  const inlineCards: Array<{ idx: number; node: React.ReactNode }> = [];
  if (inlineApproval) {
    inlineCards.push({ idx: approvalAnchor ?? bodyMessage.parts?.length ?? 0, node: inlineApproval });
  }
  if (inlineUserQuestion) {
    inlineCards.push({ idx: questionAnchor ?? bodyMessage.parts?.length ?? 0, node: inlineUserQuestion });
  }
  const displayMailKeys = new Set<string>();
  for (const item of bodyMessage.displayItems ?? []) {
    if (item.kind !== 'mail') continue;
    const pages = item.pages.filter(page => {
      if (displayMailKeys.has(page.key)) return false;
      displayMailKeys.add(page.key);
      return true;
    });
    if (pages.length && hasParts) inlineCards.push({ idx: item.anchorPartIndex, node: <ReadMailCards pages={pages} /> });
  }
  inlineCards.sort((a, b) => a.idx - b.idx);
  const partsSegments: React.JSX.Element[] = [];
  if (hasParts && inlineCards.length > 0) {
    let from = 0;
    let segKey = 0;
    for (const card of inlineCards) {
      const cut = Math.max(from, Math.min(card.idx, bodyMessage.parts!.length));
      if (cut > from) {
        partsSegments.push(
          <PartsBody
            key={`seg-${segKey++}`}
            liveThinkingOnly={liveThinkingOnly}
            message={bodyMessage}
            suppressedArtifacts={suppressedArtifacts}
            streaming={streaming}
            onFileLink={onFileLink}
            cwd={cwd}
            range={[from, cut]}
            collapsedTurn={collapsedTurn}
            activityOnly={activityOnly}
            workedMs={foldDurationMs}
            foldOpen={foldExpanded}
            onFoldToggle={toggleActivity}
            staleTurn={foldLocked}
          />
        );
        from = cut;
      }
      partsSegments.push(<React.Fragment key={`card-${segKey++}`}>{card.node}</React.Fragment>);
    }
    if (from < bodyMessage.parts!.length) {
      partsSegments.push(
        <PartsBody
          key={`seg-${segKey++}`}
          liveThinkingOnly={liveThinkingOnly}
          message={bodyMessage}
          suppressedArtifacts={suppressedArtifacts}
          streaming={streaming}
          onFileLink={onFileLink}
          cwd={cwd}
          range={[from, bodyMessage.parts!.length]}
          collapsedTurn={collapsedTurn}
          activityOnly={activityOnly}
          workedMs={foldDurationMs}
          foldOpen={foldExpanded}
          onFoldToggle={toggleActivity}
          staleTurn={foldLocked}
        />
      );
    }
  }
  return (
    <div
      ref={revealRootRef}
      className={`chat-msg ${isHost ? 'host' : isUser ? 'user' : 'assistant'}${
        message.local ? ' is-local' : ''
      }${isHost ? ' is-host' : ''}${quiet ? ' chat-quiet' : ''}${showAvatar ? (isUser ? ' is-right-aligned' : ' is-left-aligned') : ' is-avatarless'}${
        showAvatar && omitAvatar ? ' is-avatar-omitted' : ''
      }`}
      data-sender={sender}
    >
      {showAvatar && <ChatMessageAvatar
        sender={sender}
        face={face}
        omitted={omitAvatar}
        label={avatarLabel}
      />}
      <div className="chat-msg-col">
      {quiet ? null : isHost ? (
        timeLabel ? (
          <div className="chat-host-tag">
            <span className="chat-time" title={new Date(message.createdAt).toLocaleString()}>
              {timeLabel}
            </span>
          </div>
        ) : null
      ) : (
        <div className="chat-role">
          {isUser ? t('我') : isScheduler ? t('调度 Agent') : isAgent ? message.sourceAgent?.name || character?.name : message.local ? t('本地') : t('Agent')}
          {timeLabel ? (
            <span className="chat-time" title={new Date(message.createdAt).toLocaleString()}>
              {timeLabel}
            </span>
          ) : null}
        </div>
      )}
      <div className="chat-body">
        {typeof engineInput === 'string' ? (
          <div className="harness-input">
            <div className="harness-input-label">{t('发送给 Harness 的完整文本')}</div>
            <pre aria-label={t('发送给 Harness 的完整文本')} tabIndex={0}>{engineInput}</pre>
          </div>
        ) : hasParts ? (
          <>
            {inlineCards.length > 0 ? (
              partsSegments
            ) : (
              <PartsBody
                liveThinkingOnly={liveThinkingOnly}
                message={bodyMessage}
                suppressedArtifacts={suppressedArtifacts}
                streaming={streaming}
                onFileLink={onFileLink}
                cwd={cwd}
                collapsedTurn={collapsedTurn}
                activityOnly={activityOnly}
                workedMs={foldDurationMs}
                foldOpen={foldExpanded}
                onFoldToggle={toggleActivity}
                staleTurn={foldLocked}
              />
            )}
            {message.retryHint ? <div className="retry-hint">{message.retryHint}</div> : null}
          </>
        ) : (
          <>
            {legacyThinking || message.toolCalls?.length || archivedToolCount > 0 ? (
              <>
                {collapsedTurn && !streaming ? (
                  <TurnFold
                    toolCount={message.toolCalls?.length || archivedToolCount}
                    thinkingCount={legacyThinking ? 1 : 0}
                    workedMs={foldDurationMs}
                    open={foldLocked ? false : foldExpanded}
                    onToggle={toggleActivity}
                    disabled={foldLocked}
                  />
                ) : null}
                {/* 折叠=真卸载（与 parts 路径同构）：展开重挂、卡内瞬态复位；
                    大栈由 ToolCallStack 渐进挂载补齐；时间衰减和归档回合恒折叠 */}
                {collapsedTurn && !streaming && (foldLocked || !foldExpanded) ? null : (
                  <div className="turn-fold-item">
                    {legacyThinking ? (
                      <ThinkingCard
                        text={legacyThinking}
                        streaming={streaming}
                        liveThinkingOnly={liveThinkingOnly}
                        contentStarted={!!message.content}
                      />
                    ) : null}
                    {message.toolCalls?.length ? (
                      <ToolCallStack items={message.toolCalls} onFileLink={onFileLink} streaming={streaming} />
                    ) : null}
                  </div>
                )}
                <UiArtifactOutputs matches={artifactOutputs.all} />
              </>
            ) : null}
            {message.retryHint ? <div className="retry-hint">{message.retryHint}</div> : null}
            {message.archiveSummary && !bodyMessage.content ? <div className="chat-text">{message.archiveSummary}</div> : null}
            {bodyMessage.content &&
              (isHost ? (
                <div className={`chat-text${message.queued ? ' is-queued' : ''}`}>
                  {bodyMessage.content}
                </div>
              ) : isUser ? (
                <MarkdownBody className={`chat-text${message.queued ? ' is-queued' : ''}`} text={bodyMessage.content} onFileLink={onFileLink} localImages imageCwd={cwd} />
              ) : message.local ? (
                <div className="chat-text">{bodyMessage.content}</div>
              ) : (
                <UiArtifactSuppressionContext.Provider value={artifactOutputs.all.map(match => match.path)}>
                  <ChatMarkdownBody
                    className={`chat-text${streaming ? ' is-streaming' : ''}`}
                    text={bodyMessage.content}
                    streaming={streaming}
                    cwd={cwd}
                    onFileLink={onFileLink}
                  />
                </UiArtifactSuppressionContext.Provider>
              ))}
          </>
        )}
        {engineInput === null ? <div className="harness-input-label" role="status">{t('发送原文暂不可用')}</div> : null}
        {typeof engineInput !== 'string' && modelReferences.length ? <AnimatedDetails className="chat-model-reference-details" summary={t('模型引用的派活调用')}>
          {modelReferences.map(({ start, mention }) => <div key={start} className="chat-model-reference-call">
            <span>{mention.label}</span>
            <code>{workerModelInvocation(mention.targetRef)}</code>
          </div>)}
        </AnimatedDetails> : null}
        {/* Outputs survive activity folding; a final Markdown reference owns its own placement. */}
        {!message.parts && <>
          {(message.displayItems ?? []).map(item => item.kind === 'mail' ? <ReadMailCards key={item.id} pages={item.pages} /> : null)}
          <ReadMailCards pages={readMailPresentations(message.toolCalls ?? []).filter(page => !displayMailKeys.has(page.key))} />
        </>}
        {attachmentView.attachments.length > 0 ? (
          <div className="chat-msg-images chat-msg-attachments">
            {attachmentView.attachments.filter(a => a.processing !== 'native image' || !message.images?.some(img =>
              img.name === a.name || a.sourcePath.split(/[\\/]/).pop() === `${img.id}-${a.name}`)).map(a => (
              <ChatAttachmentCard key={a.sourcePath} attachment={a} onFileLink={onFileLink} />
            ))}
          </div>
        ) : null}
        {message.images && message.images.length > 0 ? (
          <div className="chat-msg-images">
            {message.images.map((img) => {
              const src = img.url || `data:${img.mimeType};base64,${img.data}`;
              const attachment = attachmentView.attachments.find(a => a.processing === 'native image' &&
                (img.name === a.name || a.sourcePath.split(/[\\/]/).pop() === `${img.id}-${a.name}`));
              const imagePath = img.sourcePath || attachment?.sourcePath;
              return (
                <div key={img.id} className="chat-msg-image-wrap">
                  <img
                    src={src}
                    alt={img.name || t('图片')}
                    className="chat-msg-image"
                    data-chat-link-target={imagePath ? buildWorkspaceFileHref(imagePath) : /^https?:\/\//i.test(src) ? src : undefined}
                    title={img.name || t('点击查看大图')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxSrc(src);
                    }}
                  />
                </div>
              );
            })}
            <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
          </div>
        ) : null}
        {message.queued ? (
          <div className="queued-box">
            <span className="queued-box-text">
              <IconHourglass size={12} /> {t('排队中，Agent 空闲后自动发送')}
            </span>
            {onCancelQueued ? (
              <button
                type="button"
                className="queued-cancel"
                onClick={() => onCancelQueued(message.id)}
              >
                {t('撤回')}
              </button>
            ) : null}
          </div>
        ) : null}
        {message.plan ? (
          <PlanCardView
            plan={message.plan}
            disabled={streaming || planActionDisabled}
            mode={planMode}
            cwd={cwd}
            onFileLink={onFileLink}
            onAction={onPlanAction}
          />
        ) : null}
        {message.outputNotice && !streaming && <div className="retry-hint" role="note">
          {message.outputNotice === 'length' ? t('本次模型调用已达到输出上限。可发送「继续」接着回答。')
            : t('最后一次模型调用的输出全部用于推理，没有生成答复正文。')}
        </div>}
        {message.aborted ? <div className="aborted-pill">{t('■ 已手动停止')}</div> : null}
        {message.error && (
          <div className="ui-row">
            <ErrorTipDetails message={localizeKnowledgeHostText(localizeGuiHostError(message.error))} />
            {onRetry ? (
              <button type="button" className="ui-btn tiny" onClick={onRetry}>
                {t('重试')}
              </button>
            ) : null}
          </div>
        )}
        {empty && streaming && <WaitingTip />}
      </div>
      {quiet ? (
        <ChatHoverbar
          timeLabel={timeLabel}
          message={message}
          favorited={favorited}
          onToggleFavorite={onToggleFavorite}
          onFork={onFork}
          onEditAborted={onEditAborted}
          notes={notes}
          onNoteClick={onNoteClick}
          openNoteId={openNoteId}
          harnessMetrics={harnessMetrics}
          engineInput={engineInput ?? undefined}
        />
      ) : null}
      </div>
    </div>
  );
}

export const ChatMessageView = React.memo(ChatMessageViewInner);
