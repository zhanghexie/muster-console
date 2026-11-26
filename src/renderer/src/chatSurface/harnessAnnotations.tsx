/**
 * Harness 透明标注组件（pi-trajectory-plan extension §6 + §7 落地；视觉基准 =
 * docs/plans/pi-trajectory-demo/trace-demo.html——真实 DOM + 真实样式表验证过的增量样式）。
 * 三类标注：注入快照卡（§6.1）/ 插话线（§6.2）/ 计量 chips + 详情抽屉（§6.3）。
 * 全部默认 display:none，开启态由容器级 .harness-on 按组件逐个给 display（见 styles/harness.css）；
 * 开关关闭时这些组件不挂载/不可见——聊天渲染与现状完全一致（硬验收项）。
 * 样式只用既有 token（--purple 唯一语义色：插话/注入；动效 --dur-micro/--ease-hover）。
 *
 * 注入快照按代际首次生效或变化的回合定位，供缺少发送原文的消息展示。
 */
import React from 'react';
import type { GuiInjectionView, GuiInjectionDetailsResult, GuiInjectionDetailRef } from '../../../shared/guiHistoryMetadata';
import type { HarnessViewState } from '../../../shared/chatSurface';
import { useTranslation } from 'react-i18next';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { toolCatalogFingerprint } from '../../../shared/guiWorker';
import type {
  GuiHarnessSummary,
  GuiInjectionSnapshot,
  GuiInjectionSegment
} from '../../../shared/guiWorker';

export function useHarnessInputText(messageId: string, ref?: string, load?: HarnessViewState['engineInput']): string | null | undefined {
  const [result, setResult] = React.useState<{ messageId: string; ref: string; text: string | null }>();
  React.useEffect(() => {
    if (!ref || !load) return;
    let current = true;
    const complete = (text: string | null) => { if (current) setResult({ messageId, ref, text }); };
    void load(messageId, ref).then(complete, () => complete(null));
    return () => { current = false; };
  }, [messageId, ref, load]);
  return load && result?.messageId === messageId && result.ref === ref ? result.text : undefined;
}

/** token 数缩写（demo 同款：≥1000 → 46.2k） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 时长缩写（≥1s → 28.7s；不足 1s → 480ms） */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 注入代际间的变动（逐段按 hash 对比；引擎真身变化单列） */
export interface HarnessInjectionChange {
  /** 新增段的来源名 */
  added: string[];
  /** 更新段的来源名（同源不同 hash） */
  updated: string[];
  /** 移除段的来源名 */
  removed: string[];
  enginePromptChanged: boolean;
  toolsChanged: boolean;
}

export interface HarnessInjectionCardInfo {
  snapshot: GuiInjectionView;
  /** undefined = 首次生效卡；有值 = 变动卡 */
  change?: HarnessInjectionChange;
}

/** 逐段 diff（前代 → 本代） */
function diffInjectionSegments(
  prev: readonly Omit<GuiInjectionSegment, 'text'>[],
  next: readonly Omit<GuiInjectionSegment, 'text'>[]
): { added: string[]; updated: string[]; removed: string[] } {
  const prevBySource = new Map(prev.map((s) => [s.source, s]));
  const nextBySource = new Map(next.map((s) => [s.source, s]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [source, seg] of nextBySource) {
    const before = prevBySource.get(source);
    if (!before) added.push(source);
    else if (before.hash !== seg.hash) updated.push(source);
  }
  for (const source of prevBySource.keys()) {
    if (!nextBySource.has(source)) removed.push(source);
  }
  return { added, updated, removed };
}

function isSummary(value: GuiInjectionView): value is import('../../../shared/guiHistoryMetadata').GuiInjectionSummary { return 'kind' in value && value.kind === 'summary'; }
function injectionFingerprint(value: GuiInjectionView): string { return isSummary(value) ? value.toolsFingerprint : toolCatalogFingerprint(value.tools); }

function injectionsDiffer(a: GuiInjectionView, b: GuiInjectionView): boolean {
  return (
    a.segments.length !== b.segments.length ||
    a.segments.some((s, i) => {
      const o = b.segments[i]!;
      return s.source !== o.source || s.hash !== o.hash;
    }) ||
    (a.enginePrompt?.hash ?? '') !== (b.enginePrompt?.hash ?? '') ||
    injectionFingerprint(a) !== injectionFingerprint(b)
  );
}

/**
 * 按用户回合解析注入卡（纯函数）：逐个用户回合找生效代际（at ≤ 回合时刻的最后一代；
 * 早于第一代的回合回落第一代——快照物化晚于首条用户消息落转写的时序差），代际相对
 * 上一张已出卡的回合变了才出卡。只收普通用户消息（插话消息渲染为插话线，不出卡）。
 */
export function resolveInjectionCards(
  messages: ReadonlyArray<{ id: string; role: string; ts?: number; steering?: unknown }>,
  injections: readonly GuiInjectionView[] | undefined
): Map<string, HarnessInjectionCardInfo> {
  const out = new Map<string, HarnessInjectionCardInfo>();
  if (!injections?.length) return out;
  let shownIdx = -1;
  for (const m of messages) {
    if (m.role !== 'user' || m.steering) continue;
    const ts = m.ts ?? 0;
    let idx = -1;
    for (let i = 0; i < injections.length; i++) {
      if (injections[i]!.at <= ts) idx = i;
      else break;
    }
    if (idx < 0) idx = 0;
    if (idx === shownIdx) continue;
    const snap = injections[idx]!;
    if (shownIdx < 0 || injectionsDiffer(injections[shownIdx]!, snap)) {
      const change =
        shownIdx >= 0
          ? ((): HarnessInjectionChange => {
              const segDiff = diffInjectionSegments(injections[shownIdx]!.segments, snap.segments);
              return {
                ...segDiff,
                enginePromptChanged:
                  (injections[shownIdx]!.enginePrompt?.hash ?? '') !==
                  (snap.enginePrompt?.hash ?? ''),
                toolsChanged:
                  injectionFingerprint(injections[shownIdx]!) !==
                  injectionFingerprint(snap)
              };
            })()
          : undefined;
      out.set(m.id, { snapshot: snap, ...(change ? { change } : {}) });
      shownIdx = idx;
    }
  }
  return out;
}

/** 分段复制按钮（阻止冒泡触发 details 折叠） */
function CopyButton(props: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      className="h-copy"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(props.text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => {
            /* 剪贴板不可用：静默（按钮恢复原状） */
          }
        );
      }}
    >
      {copied ? t('已复制') : t('复制')}
    </button>
  );
}

/** 顶栏「Harness 透明」开关：设置页同款「已启用 | 禁用」分段胶囊（llm-capsule-btn，
 *  settings.css 全局加载直接复用）；左标签右控件，开=绿染、关=灰底 */
export function HarnessToggle(props: { on: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="harness-toggle" role="group" aria-label={t('Harness 透明')} title={t('在用户消息里显示发送给 Harness 的完整文本')}>
      <span className="harness-toggle-label">{t('Harness 透明')}</span>
      <div className="llm-status-capsule-group">
        <button
          type="button"
          className={`llm-capsule-btn ${props.on ? 'is-active-enabled' : ''}`}
          aria-pressed={props.on}
          onClick={() => {
            if (!props.on) props.onChange(true);
          }}
        >
          {t('开启')}
        </button>
        <button
          type="button"
          className={`llm-capsule-btn ${!props.on ? 'is-active-disabled' : ''}`}
          aria-pressed={!props.on}
          onClick={() => {
            if (props.on) props.onChange(false);
          }}
        >
          {t('关闭')}
        </button>
      </div>
    </div>
  );
}

/** 段落（label + 滚动 pre + 复制） */
function SnapshotSegment(props: {
  source: string;
  text: string;
  chars: number;
  badge?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="harness-seg">
      <label>
        {props.source} · {t('{{n}} 字', { n: props.chars.toLocaleString() })}
        {props.badge ? <span className="h-badge-inline">{props.badge}</span> : null}
        <CopyButton text={props.text} />
      </label>
      <pre>{props.text}</pre>
    </div>
  );
}

/** 注入快照卡（§6.1）：只在代际首次生效/变化的回合出卡；展开看全文（滚动）+ 工具目录 */
export function HarnessInjectCard(props: {
  snapshot: GuiInjectionView;
  change?: HarnessInjectionChange;
  loadDetails?: (ref: GuiInjectionDetailRef) => Promise<GuiInjectionDetailsResult>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { snapshot: view, change } = props;
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<{ key: string; loader: typeof props.loadDetails; snapshot: GuiInjectionSnapshot }>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef(0);
  const detailKey = isSummary(view) ? view.details.key : '';
  const snapshot = isSummary(view) ? detail?.key === detailKey && detail.loader === props.loadDetails ? detail.snapshot : undefined : view;
  const load = React.useCallback(() => {
    if (!isSummary(view)) return;
    const seq = ++request.current;
    setLoading(true); setError('');
    void Promise.resolve().then(() => {
      if (seq !== request.current) return undefined;
      if (!props.loadDetails) throw new Error(t('注入详情暂不可用'));
      return props.loadDetails(view.details);
    }).then(result => {
      if (seq !== request.current || !result) return;
      if (result.ok) setDetail({ key: detailKey, loader: props.loadDetails, snapshot: result.snapshot }); else setError(result.error);
    }, reason => { if (seq === request.current) setError(String(reason)); })
      .finally(() => { if (seq === request.current) setLoading(false); });
  }, [detailKey, props.loadDetails, t]);
  React.useEffect(() => {
    setDetail(undefined); setError('');
    if (open) load();
    return () => { request.current++; };
  }, [open, load]);
  const toggle = (next: boolean): void => {
    if (!next) { request.current++; setDetail(undefined); setLoading(false); setError(''); }
    setOpen(next);
  };
  const changeParts: string[] = change
    ? [
        ...change.updated.map((s) => `${s} ${t('更新')}`),
        ...change.added.map((s) => `${s} ${t('新增')}`),
        ...change.removed.map((s) => `${s} ${t('移除')}`),
        ...(change.enginePromptChanged ? [`${t('引擎系统提示词')} ${t('更新')}`] : []),
        ...(change.toolsChanged ? [`${t('工具目录')} ${t('更新')}`] : [])
      ]
    : [];
  return (
    <div className="harness-a harness-inject">
      <AnimatedDetails
        open={open} onToggle={toggle}
        summary={
          <>
            <span className="h-ico" aria-hidden>
              ⌁
            </span>
            <span className="h-title">{change
              ? t('注入变动')
              : t('本次发送 · 注入 {{n}} 段', { n: view.segments.length })}</span>
            <span className="h-segs">
              {change
                ? changeParts.join(' · ')
                : [
                    view.segments.map((s) => s.source).join(' · '),
                    (isSummary(view) ? view.toolCount : view.tools?.length)
                      ? t('工具 {{n}} 个', { n: (isSummary(view) ? view.toolCount : view.tools!.length) })
                      : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
            <span className="h-caret" aria-hidden>
              ▾
            </span>
          </>
        }
      >
        {loading ? <p className="h-metadata-status" role="status">{t('正在读取注入详情…')}</p> : null}
        {error ? <p className="h-metadata-status" role="alert">{error} <button className="h-metadata-action" type="button" onClick={load}>{t('重试')}</button></p> : null}
        {snapshot?.segments.map((seg, i) => (
          <SnapshotSegment
            key={`${seg.source}-${i}`}
            source={seg.source}
            text={seg.text}
            chars={seg.chars}
            badge={
              change
                ? change.added.includes(seg.source)
                  ? t('新增')
                  : change.updated.includes(seg.source)
                    ? t('更新')
                    : undefined
                : undefined
            }
          />
        ))}
        {snapshot?.enginePrompt ? (
          <SnapshotSegment
            source={t('引擎系统提示词')}
            text={snapshot.enginePrompt.text}
            chars={snapshot.enginePrompt.chars}
            badge={change?.enginePromptChanged ? t('更新') : undefined}
          />
        ) : null}
        {snapshot?.tools?.length ? (
          <div className="harness-seg harness-tools">
            <label>
              {t('工具 {{n}} 个', { n: snapshot.tools.length })}
              {change?.toolsChanged ? <span className="h-badge-inline">{t('更新')}</span> : null}
            </label>
            {snapshot.tools.map((tool) => (
              <AnimatedDetails
                key={tool.name}
                className="h-tool"
                summary={
                  <>
                    <code>{tool.name}</code>
                    {tool.source ? <span className="h-tool-src">{tool.source}</span> : null}
                    {tool.description ? (
                      <span className="h-tool-desc" title={tool.description}>
                        {tool.description}
                      </span>
                    ) : null}
                  </>
                }
              >
                {tool.params?.length ? (
                  <div className="h-tool-params">
                    {tool.params.map((p) => (
                      <div key={p}>{p}</div>
                    ))}
                  </div>
                ) : null}
              </AnimatedDetails>
            ))}
          </div>
        ) : null}
      </AnimatedDetails>
    </div>
  );
}

/** 插话线（§6.2）：紫徽标 + 文本 + 右对齐时间；开启态替代插话消息的普通气泡渲染 */
export function HarnessSteerLine(props: { text: string; ts: number }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="harness-a harness-steer">
      <span className="h-badge">{t('插话')}</span>
      <span className="h-steer-text">{props.text}</span>
      <span className="h-time">{hhmmss(props.ts)}</span>
    </div>
  );
}

/** 计量 chips（§6.3）：assistant 回合 hoverbar 最前的 ↑输入 ↓输出 思 总耗时（无语义彩色） */
export function HarnessMetricsChips(props: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  durationMs?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="harness-metrics">
      <span className="harness-chip up">↑ {formatTokens(props.inputTokens)}</span>
      <span className="harness-chip down">↓ {formatTokens(props.outputTokens)}</span>
      {props.reasoningTokens ? (
        <span className="harness-chip">
          {t('思')} {formatTokens(props.reasoningTokens)}
        </span>
      ) : null}
      {props.durationMs !== undefined ? (
        <span className="harness-chip">{formatDurationMs(props.durationMs)}</span>
      ) : null}
    </span>
  );
}

/** 每轮 harness 详情抽屉（§6.3）：#/模型/输入/输出/TTFT/耗时/重试 表格（数字列 tabular-nums） */
export function HarnessDrawer(props: {
  summary: GuiHarnessSummary;
  steerCount: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { summary, steerCount } = props;
  const calls = summary.calls ?? [];
  return (
    <div className="harness-a harness-drawer">
      <AnimatedDetails
        summary={
          <>
            <span aria-hidden>⚙</span>
            {t('harness 详情 · 本轮 {{calls}} 次模型调用 · 插话 {{steers}} 条', {
              calls: calls.length,
              steers: steerCount
            })}
          </>
        }
      >
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('模型')}</th>
              <th>{t('输入')}</th>
              <th>{t('输出')}</th>
              <th>TTFT</th>
              <th>{t('耗时')}</th>
              <th>{t('重试')}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{c.model ?? '—'}</td>
                <td className="num">
                  {c.usage ? c.usage.inputTokens.toLocaleString() : '—'}
                </td>
                <td className="num">
                  {c.usage ? c.usage.outputTokens.toLocaleString() : '—'}
                </td>
                <td className="num">
                  {c.ttftMs !== undefined ? formatDurationMs(c.ttftMs) : '—'}
                </td>
                <td className="num">
                  {c.durationMs !== undefined ? formatDurationMs(c.durationMs) : '—'}
                </td>
                <td className="num">{c.retry ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {summary.usage ? (
          <div className="h-note">
            {t('回合累计 ↑ {{in}} · ↓ {{out}} · 耗时 {{dur}}', {
              in: formatTokens(summary.usage.inputTokens),
              out: formatTokens(summary.usage.outputTokens),
              dur: formatDurationMs(summary.durationMs ?? 0)
            })}
          </div>
        ) : null}
      </AnimatedDetails>
    </div>
  );
}

/** 压缩分隔（§6.4）：⇡ 黄 + hairline 夹文案；规模数字来自压缩结果（未知则省略数字段） */
export function HarnessCompactDivider(props: {
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  streamIndex?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const hasScale = typeof props.tokensBefore === 'number';
  return (
    <div className="harness-a harness-compact" data-stream-index={props.streamIndex} aria-hidden>
      <span className="h-ico">⇡</span>
      <span>
        {hasScale
          ? t('此处发生上下文压缩 · {{before}} → {{after}} token（更早历史已替换为摘要）', {
              before: formatTokens(props.tokensBefore ?? 0),
              after: formatTokens(props.tokensAfter ?? 0)
            })
          : t('此处发生上下文压缩（更早历史已替换为摘要）')}
      </span>
    </div>
  );
}
