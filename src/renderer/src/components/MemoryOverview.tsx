/**
 * 按需自动记忆总览：候选→专用 Pi 会话→长期知识；任务历史与提醒独立。
 * 实际账本事件驱动边计数与近五分钟脉冲，系统进度不作为人工待办。
 * 保留既有画布缩放、平移、适配与动态列表的交互。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MemoryCenterEntriesResult,
  MemoryCenterEvent,
  MemoryCenterEventKind,
  MemoryCenterEventsResult,
  MemoryCenterIntentState
} from '../../../shared/memoryCenterIpc';
import {
  KNOWLEDGE_CENTER_TABS,
  requestMemoryCenterTab,
  type MemoryCenterTabId
} from '../memoryCenterRoute';
import { hm as fmtClock } from '../format';
import { usePresence } from './motion';
import { CanvasHelp } from '../panels/freeCanvas/CanvasControls';
import {PROFILE_INJECTION_BUDGET} from '../../../shared/knowledge';

type Pt = readonly [number, number];

const R = 16;
const BRAIN_D =
  'M29.75 27.625s2.184-.443 3.542-2.229c1.583-2.083 1.375-4.312 1.375-4.312 1.604-3-.5-5.813-.5-5.813C33.958 12.104 32 10.792 32 10.792c-1.271-3.021-4.083-3.833-4.083-3.833-2.208-2.583-6.125-2.5-6.125-2.5s-3.67-1.345-8.708.167c-.833.25-3.625.833-5.667 2.083C.981 10.649.494 16.793.584 17.792 1.083 23.375 5 24.375 7.5 24.958c.583 1.583 2.729 4.5 6.583 3.417 4.75-.833 6.75-2.25 7.917-2.25s4.417 1.25 7.75 1.5z';

const NODES: ReadonlyArray<{
  id: string;
  tab?: MemoryCenterTabId;
  x: number;
  y: number;
  w: number;
  h: number;
  titleKey: string;
  subKey: string;
  tipTitleKey: string;
  tipKey: string;
  dot?: 'green' | 'yellow' | 'purple';
  badgeTone?: 'green' | 'yellow' | 'purple';
}> = [
  {
    id: 'n-session',
    x: 90,
    y: 620,
    w: 210,
    h: 80,
    titleKey: '对话会话',
    subKey: '外部输入 · 有用发现 / 明确记住',
    tipTitleKey: '对话会话 —— 一切记忆的源头',
    tipKey: '工作 Agent 发现有原始依据和未来用途的内容时主动提交；普通对话结束不会触发整理。你也可以明确要求记住偏好或删除记忆。'
  },
  {
    id: 'n-staging',
    tab: 'index',
    x: 320,
    y: 450,
    w: 215,
    h: 85,
    titleKey: '记忆候选',
    subKey: '记忆的排队区 · 不会自动带进对话',
    tipTitleKey: '记忆候选 —— 等待后台整理',
    tipKey: '新事件先排队，按原始依据、未来用途和新增信息审查；任务事实留历史，重复内容不反复提案。',
    dot: 'yellow',
    badgeTone: 'yellow'
  },
  {
    id: 'n-consolidation',
    tab: 'index',
    x: 565,
    y: 310,
    w: 245,
    h: 100,
    titleKey: '记忆子系统',
    subKey: '按需整理 · 自动判断是否保存',
    tipTitleKey: '记忆子系统 —— 调度的记忆管理模块',
    tipKey: '核对依据、适用条件和新增信息，自动保存、判重、合并与处理冲突。无保留价值可不收录。今日生效按当地日期对条目去重，含恢复生效；不受动态窗口限制。工具和提示词只服务记忆，无需人工审批。',
    badgeTone: 'green'
  },
  {
    id: 'n-curated',
    tab: 'entries',
    x: 710,
    y: 175,
    w: 240,
    h: 85,
    titleKey: '长期知识',
    subKey: '长期记忆库 · 注入对话有字数预算',
    tipTitleKey: '长期知识 —— 有依据的可复用内容',
    tipKey: '每条知识独立保存版本与依据；持续约束小预算常驻，经验按当前任务召回，任务事实不进入长期核心。',
    dot: 'green'
  },
  {
    id: 'n-usermd',
    tab: 'profile',
    x: 380,
    y: 175,
    w: 240,
    h: 85,
    titleKey: '用户画像',
    subKey: '基本信息、联系方式与偏好',
    tipTitleKey: '用户画像 —— 按条件和预算注入',
    tipKey: '用户提供的基本信息、联系方式与偏好保存在这里；跨工作区生效，可查看来源、修订或删除。',
    dot: 'purple',
    badgeTone: 'purple'
  },
  {
    id: 'n-intents',
    tab: 'intent',
    x: 265,
    y: 300,
    w: 230,
    h: 85,
    titleKey: '主动提醒',
    subKey: '「以后每当…就提醒我」· 防骚扰限频',
    tipTitleKey: '主动提醒 —— 以后每当…就提醒我',
    tipKey: '让 Agent 记住一句话，消息里出现关键词或任务事件发生时提醒你；冷却、次数上限、过期防骚扰；取消是持久的，要手动重新打开。',
    dot: 'purple'
  },
  {
    id: 'n-approval',
    tab: 'index',
    x: 590,
    y: 450,
    w: 210,
    h: 85,
    titleKey: '处理状态',
    subKey: '自动处理冲突 · 失败可重试',
    tipTitleKey: '处理状态 —— 系统进度与异常',
    tipKey: '候选处理、冲突暂停和错误都可追溯。系统进度不作为人工待办；不确定的知识可以不保存，已有内容仍可删除。',
    dot: 'yellow',
    badgeTone: 'yellow'
  },
  {
    id: 'n-recycle',
    tab: 'history',
    x: 820,
    y: 450,
    w: 180,
    h: 85,
    titleKey: '任务历史',
    subKey: '整理出的任务事实 · 按需追溯',
    tipTitleKey: '任务历史 —— 事实与原始依据',
    tipKey: '记忆子系统可将候选中的任务事实留入历史；原始会话仍在原会话中，不会在对话结束时整段送来整理。任务事实不进入常驻上下文。'
  }
];

const EDGES: ReadonlyArray<{
  id: string;
  pts: ReadonlyArray<Pt>;
  tone: 'neutral' | 'green' | 'yellow' | 'blue' | 'purple' | 'fade';
  dash?: boolean;
  both?: boolean;
  glow?: boolean;
  casing?: boolean;
  hit?: boolean;
  tipTitleKey?: string;
  tipKey?: string;
}> = [
  { id: 'e-note', pts: [[300, 660], [350, 660], [350, 535]], tone: 'neutral' },
  { id: 'e-cand', pts: [[535, 490], [550, 490], [550, 360], [565, 360]], tone: 'neutral' },
  { id: 'e-auto', pts: [[750, 310], [750, 260]], tone: 'green' },
  { id: 'e-usermd-branch', pts: [[650, 310], [650, 218], [620, 218]], tone: 'green' },
  { id: 'e-cortex-branch', pts: [[810, 390], [910, 390], [910, 450]], tone: 'neutral' },
  { id: 'e-review', pts: [[670, 410], [670, 450]], tone: 'yellow' },
  {
    id: 'e-compare', pts: [[950, 225], [990, 225], [990, 350], [810, 350]], tone: 'neutral', dash: true, hit: true,
    tipTitleKey: '查重与核对 —— 读取已有记忆',
    tipKey: '记忆子系统检索已有知识后判断新增、补依据、合并或不保留。通过关键词检索已有知识。'
  },
  {
    id: 'e-inject',
    pts: [[880, 175], [880, 95], [200, 95], [200, 585], [140, 585], [140, 620]],
    tone: 'blue',
    glow: true,
    casing: true,
    hit: true,
    tipTitleKey: '注入回路 —— 记忆怎么回到对话',
    tipKey: '已生效约束和用户画像按预算注入，经验按当前任务召回；任务事实不进入长期核心，主动提醒遵守独立的触发条件。'
  },
  { id: 'e-inject-ustub', pts: [[500, 175], [500, 95]], tone: 'blue', glow: true, casing: true },
  {
    id: 'e-fire',
    pts: [[265, 340], [245, 340], [245, 585], [235, 585], [235, 620]],
    tone: 'purple',
    dash: true,
    glow: true,
    hit: true,
    tipTitleKey: '主动提醒触发',
    tipKey: '命中后先复查：没过期、不在冷却、次数没用完才提醒；取消是持久状态，「重新武装」是唯一恢复入口。'
  }
];

const LABELS: ReadonlyArray<{
  id: string;
  x: number;
  y: number;
  rot?: number;
  key: string;
  tone?: 'green' | 'yellow' | 'blue' | 'purple';
  rest?: boolean;
}> = [
  { id: 'e-note', x: 392, y: 580, key: '提交候选', rest: true },
  { id: 'e-cand', x: 550, y: 435, key: '整理', rest: true },
  { id: 'e-auto', x: 786, y: 289, key: '保存', tone: 'green', rest: true },
  { id: 'e-usermd-branch', x: 682, y: 277, key: '保存偏好', tone: 'green', rest: true },
  { id: 'e-compare', x: 900, y: 333, key: '查重 · 核对已有记忆', rest: true },
  { id: 'e-cortex-branch', x: 865, y: 420, key: '仅留事实', rest: true },
  { id: 'e-review', x: 727, y: 435, key: '异常与冲突', tone: 'yellow', rest: true },
  { id: 'e-inject', x: 555, y: 80, key: '带进对话 · 按预算注入 / 按任务检索', tone: 'blue', rest: true },
  { id: 'e-fire', x: 228, y: 455, rot: -90, key: '独立触发提醒', tone: 'purple', rest: true }
];

const ADJ: Record<string, string[]> = {
  'n-session': ['e-note', 'e-inject', 'e-fire'],
  'n-staging': ['e-note', 'e-cand'],
  'n-consolidation': ['e-cand', 'e-auto', 'e-usermd-branch', 'e-compare', 'e-cortex-branch', 'e-review'],
  'n-approval': ['e-review'],
  'n-curated': ['e-auto', 'e-compare', 'e-inject'],
  'n-usermd': ['e-usermd-branch', 'e-inject-ustub', 'e-inject'],
  'n-intents': ['e-fire'],
  'n-recycle': ['e-cortex-branch']
};

const FLOW: ReadonlyArray<{ id: string; n: number; speed: number; color: string }> = [
  { id: 'e-note', n: 1, speed: 26, color: 'var(--fg-secondary)' },
  { id: 'e-usermd-branch', n: 1, speed: 28, color: 'var(--fg-secondary)' },
  { id: 'e-cortex-branch', n: 1, speed: 32, color: 'var(--fg-secondary)' },
  { id: 'e-cand', n: 1, speed: 24, color: 'var(--fg-secondary)' },
  { id: 'e-auto', n: 1, speed: 30, color: 'color-mix(in srgb, var(--status-success-fg) 55%, transparent)' },
  { id: 'e-review', n: 1, speed: 26, color: 'color-mix(in srgb, var(--status-warning-fg) 55%, transparent)' },
  { id: 'e-inject', n: 3, speed: 48, color: 'color-mix(in srgb, var(--status-info-fg) 60%, transparent)' },
  { id: 'e-inject-ustub', n: 1, speed: 30, color: 'color-mix(in srgb, var(--status-info-fg) 60%, transparent)' },
  { id: 'e-fire', n: 2, speed: 36, color: 'color-mix(in srgb, var(--purple) 55%, transparent)' }
];

const ACTIVE_INTENT: ReadonlySet<MemoryCenterIntentState> = new Set(['pending', 'armed', 'fired']);

// ── M3 条目 1B：事件流 / 边流量 / 真信号脉冲 ──────────────────────────────────
// 边-事件映射（渲染层常量，计划条目 1B 定稿清单）：计数与脉冲共用。
// 只挂实际保存/补依据/暂停/提醒事件；读取比较本身无账本，不虚构脉冲。
// e-inject / e-inject-ustub 无对应 kind（注入不落账，条目 1A 定稿）——不挂计数、不参与脉冲，
// 后续账本收录注入类事件时再接。
const EDGE_EVENT_MAP: ReadonlyArray<{ edge: string; kinds: ReadonlyArray<MemoryCenterEventKind> }> = [
  { edge: 'e-note', kinds: ['staged'] },
  { edge: 'e-usermd-branch', kinds: ['profile_write'] },
  { edge: 'e-auto', kinds: ['auto_admitted', 'evidence_linked', 'direct_write'] },
  { edge: 'e-review', kinds: ['conflict_suspended'] },
  { edge: 'e-fire', kinds: ['intent_fired'] }
];

/** 边流量芯片锚点（边长段中点旁；静态定值——jsdom 无 path 测长，几何改动时随手核） */
const EDGE_FLOW_POS: Record<string, Pt> = {
  'e-note': [350, 600],
  'e-usermd-branch': [634, 245],
  'e-auto': [750, 285],
  'e-review': [651, 431],
  'e-fire': [245, 515]
};

/** 事件 kind → 图例语义色（feed 色点 + 边芯片同源） */
const KIND_TONE: Record<MemoryCenterEventKind, 'neutral' | 'green' | 'yellow' | 'red' | 'purple'> = {
  auto_admitted: 'green', evidence_linked: 'neutral', conflict_suspended: 'yellow', user_deleted: 'red',
  staged: 'neutral',
  promoted: 'green',
  superseded: 'neutral',
  approval_queued: 'yellow',
  approval_decided: 'yellow',
  direct_write: 'red',
  profile_write: 'purple',
  intent_fired: 'purple',
  intent_cancelled: 'purple'
};

/** 事件 kind → 人话短词（边芯片 hover 标题用；feed 行直接渲 summary 人话句） */
const KIND_LABEL_KEY: Record<MemoryCenterEventKind, string> = {
  auto_admitted: '自动保存', evidence_linked: '关联依据', conflict_suspended: '冲突暂停', user_deleted: '用户删除',
  staged: '候选入池',
  promoted: '晋升入库',
  superseded: '旧条目取代',
  approval_queued: '旧版审查记录',
  approval_decided: '旧版处理记录',
  direct_write: '直写入库',
  profile_write: '画像更新',
  intent_fired: '意图触发',
  intent_cancelled: '意图取消'
};

/** 脉冲窗口：账本近 5 分钟有对应 kind 事件该边才流动（条目 1B 定稿） */
export const PULSE_WINDOW_MS = 5 * 60_000;

const EMPTY_FLOW_EDGES: ReadonlySet<string> = new Set<string>();

/**
 * 真信号脉冲门控（条目 1B，纯函数便于 jsdom 断言）：
 * 近 5 分钟存在映射 kind 事件的边进集合，其余静默（rAF 循环保留但 movers 只挂集合内的边）。
 */
export function activeFlowEdges(
  items: ReadonlyArray<Pick<MemoryCenterEvent, 'kind' | 'ts'>>,
  now: number
): Set<string> {
  const out = new Set<string>();
  for (const { edge, kinds } of EDGE_EVENT_MAP) {
    if (items.some((it) => kinds.includes(it.kind) && now - it.ts >= 0 && now - it.ts <= PULSE_WINDOW_MS)) {
      out.add(edge);
    }
  }
  return out;
}

/** 事件实体 → 跳页签（entryRef 前缀判定：staging:/approval:/intent: 前缀；USER.md 走画像页；其余按条目 id 定位） */
function navOfEvent(ev: MemoryCenterEvent): { tab: MemoryCenterTabId; entryId?: string } | null {
  const ref = ev.entryRef;
  if (!ref) return null;
  if (ref.startsWith('staging:')) return { tab: 'index' };
  if (ref.startsWith('approval:')) return { tab: 'entries' };
  if (ref.startsWith('intent:')) return { tab: 'intent' };
  if (ref === 'USER.md') return { tab: 'profile' };
  return { tab: 'entries', entryId: ref };
}

/** 节点活徽标轮询节奏：沿用 MemoryCenterBadge 的 30s，不另造 */
const POLL_MS = 30_000;

/** 展示最多50条；200条返回窗口与完整聚合统计互相独立。 */
const FEED_RENDER_LIMIT = 50;

function rounded(pts: ReadonlyArray<Pt>): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const l1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]) || 1;
    const l2 = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1;
    const rr = Math.min(R, l1 / 2, l2 / 2);
    const t1x = p[0] - ((p[0] - prev[0]) / l1) * rr;
    const t1y = p[1] - ((p[1] - prev[1]) / l1) * rr;
    const t2x = p[0] + ((next[0] - p[0]) / l2) * rr;
    const t2y = p[1] + ((next[1] - p[1]) / l2) * rr;
    d += ` L ${t1x.toFixed(1)} ${t1y.toFixed(1)} Q ${p[0]} ${p[1]} ${t2x.toFixed(1)} ${t2y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

function markerFor(tone: (typeof EDGES)[number]['tone']): string | undefined {
  if (tone === 'green') return 'url(#mflow-m-green)';
  if (tone === 'yellow') return 'url(#mflow-m-yellow)';
  if (tone === 'blue') return 'url(#mflow-m-blue)';
  if (tone === 'purple') return 'url(#mflow-m-purple)';
  if (tone === 'fade') return undefined;
  return 'url(#mflow-m-neutral)';
}

function fmtProfileBadge(chars: number, max: number): string {
  const n = chars >= 1000 ? `${(chars / 1000).toFixed(chars >= 10000 ? 0 : 1)}K` : String(chars);
  return `${n} / ${max}`;
}

interface OverviewStats {
  curated: number;
  profileChars: number;
  profileMax: number;
  pending: number;
  intents: number;
  recycle: number;
  lastConsolAt: number | null;
}
export interface MemoryOverviewLive {
  stats:OverviewStats;
  feed:MemoryCenterEventsResult;
  backlog:number;
  processing?: { failed: number; suspended: number; running?: boolean; paused?: boolean };
}

interface TipState {
  title: string;
  body: string;
  nav: string;
  x: number;
  y: number;
}

export function MemoryOverview({
  center,
  pending,
  onSelectTab,
  onOpenCurator,
  onInspectQueue,
  live
}: {
  center: MemoryCenterEntriesResult | null;
  pending: number;
  onSelectTab: (id: MemoryCenterTabId) => void;
  onOpenCurator?: () => void;
  onInspectQueue?: (view: 'candidates' | 'status') => void;
  live?:MemoryOverviewLive;
}): React.JSX.Element {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [feedOverride, setFeedOverride] = useState<boolean | null>(null);
  const feedOpen = feedOverride ?? !compact;
  const feedPresence = usePresence(feedOpen);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const scale = zoom ?? fitScale;

  useEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card) return;
    const measure = () => {
      // Observe the whole panel for disclosure, so opening the feed cannot cause a resize loop.
      if (root.clientWidth && root.clientHeight) {
        setCompact(root.clientWidth < 1100 || root.clientHeight < 520);
      }
      if (card.clientWidth && card.clientHeight) {
        setFitScale(Math.max(0.05, Math.min(1400 / 1090,
          (card.clientWidth - 24) / 1090, (card.clientHeight - 24) / 700)));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const changeZoom = (factor: number) => {
    setTip(null);
    setHoverId(null);
    setZoom(Math.max(0.05, Math.min(2, scale * factor)));
  };
  const gestureRef = useRef<{
    pointerId: number; mode: 'select' | 'pan'; x: number; y: number;
    left: number; top: number; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const focusAfterZoom = useRef<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const resetView = () => {
    focusAfterZoom.current = null;
    setZoom(null);
    setTip(null);
    setHoverId(null);
    cardRef.current?.scrollTo?.(0, 0);
  };
  const isBlank = (target: EventTarget) => target instanceof Element &&
    !target.closest('.mflow-node, .mflow-hit, .mflow-gate-hit, .mflow-tip');
  const cancelGesture = () => {
    gestureRef.current = null;
    setSelection(null);
    setPanning(false);
  };
  useEffect(() => {
    window.addEventListener('blur', cancelGesture);
    return () => window.removeEventListener('blur', cancelGesture);
  }, []);
  useLayoutEffect(() => {
    const focus = focusAfterZoom.current;
    const card = cardRef.current;
    const svg = card?.querySelector('.memory-overview-svg');
    if (!focus || !card || !svg) return;
    focusAfterZoom.current = null;
    const bounds = svg.getBoundingClientRect();
    const viewport = card.getBoundingClientRect();
    card.scrollLeft += bounds.left + bounds.width * focus.x - (viewport.left + card.clientLeft + card.clientWidth / 2);
    card.scrollTop += bounds.top + bounds.height * focus.y - (viewport.top + card.clientTop + card.clientHeight / 2);
  }, [zoom]);
  const startGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || (event.button !== 0 && event.button !== 2)) return;
    if (event.button === 0 && !isBlank(event.target)) return;
    const card = event.currentTarget;
    // Ignore scrollbar tracks.
    const rect = card.getBoundingClientRect();
    if (event.clientX >= rect.left + card.clientLeft + card.clientWidth ||
        event.clientY >= rect.top + card.clientTop + card.clientHeight) return;
    suppressClick.current = false;
    gestureRef.current = { pointerId: event.pointerId, mode: event.button === 2 ? 'pan' : 'select',
      x: event.clientX, y: event.clientY, left: card.scrollLeft, top: card.scrollTop, moved: false };
    card.setPointerCapture(event.pointerId);
    setTip(null);
    setHoverId(null);
    setPanning(event.button === 2);
    event.preventDefault();
  };
  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const card = event.currentTarget;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (gesture.mode === 'pan') {
      card.scrollLeft = gesture.left - dx;
      card.scrollTop = gesture.top - dy;
    } else if (gesture.moved) {
      const rect = card.getBoundingClientRect();
      const x = Math.max(rect.left + card.clientLeft, Math.min(event.clientX, rect.left + card.clientLeft + card.clientWidth));
      const y = Math.max(rect.top + card.clientTop, Math.min(event.clientY, rect.top + card.clientTop + card.clientHeight));
      setSelection({ x: Math.min(x, gesture.x) - rect.left - card.clientLeft + card.scrollLeft,
        y: Math.min(y, gesture.y) - rect.top - card.clientTop + card.scrollTop,
        width: Math.abs(x - gesture.x), height: Math.abs(y - gesture.y) });
    }
  };
  const finishGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const card = event.currentTarget;
    if (gesture.mode === 'select' && gesture.moved) {
      suppressClick.current = true;
      const svg = card.querySelector('.memory-overview-svg');
      const bounds = svg?.getBoundingClientRect();
      if (selection && bounds && selection.width >= 8 && selection.height >= 8) {
        const rect = card.getBoundingClientRect();
        const x = selection.x - card.scrollLeft + rect.left + card.clientLeft + selection.width / 2;
        const y = selection.y - card.scrollTop + rect.top + card.clientTop + selection.height / 2;
        const nextZoom = Math.min(2, scale * Math.min((card.clientWidth - 24) / selection.width,
          (card.clientHeight - 24) / selection.height));
        if (nextZoom > scale) {
          focusAfterZoom.current = { x: (x - bounds.left) / bounds.width, y: (y - bounds.top) / bounds.height };
          setZoom(nextZoom);
        }
      }
    }
    cancelGesture();
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
  };
  const pathRefs = useRef<Record<string, SVGPathElement | null>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [extra, setExtra] = useState<{ intents: number; recycle: number; lastConsolAt: number | null }>({
    intents: 0,
    recycle: 0,
    lastConsolAt: null
  });
  const [feed, setFeed] = useState<MemoryCenterEventsResult | null>(null);
  const [stagingBacklog, setStagingBacklog] = useState(0);

  useEffect(() => {
    if(live)return;
    let cancelled = false;
    void (async () => {
      try {
        const [intents, recycle, log] = await Promise.all([
          window.api.memoryCenter.intents(),
          window.api.memoryCenter.recycle(),
          window.api.memoryCenter.log()
        ]);
        if (cancelled) return;
        const last = log.items[0]?.finishedAt ?? null;
        setExtra({
          intents: intents.items.filter((it) => ACTIVE_INTENT.has(it.state)).length,
          recycle: recycle.preimages.length,
          lastConsolAt: last
        });
      } catch {
        /* 角标失败不挡图 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [center?.files.worker.hash,!!live]);

  // 事件账本 + 暂存积压：30s 轮询（沿用 MemoryCenterBadge 节奏）；失败静默保持上次值
  useEffect(() => {
    if(live)return;
    let alive = true;
    const pull = (): void => {
      Promise.all([window.api.memoryCenter.events({ limit: 200 }), window.api.memoryCenter.stagingList()])
        .then(([ev, st]) => {
          if (!alive) return;
          setFeed(ev ?? null);
          setStagingBacklog(st?.pendingCount ?? 0);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [!!live]);

  useEffect(()=>{if(live){setFeed(live.feed);setStagingBacklog(live.backlog);}},[live]);

  const stats: OverviewStats = useMemo(
    () => live?.stats??({
      curated: center?.entries.length ?? 0,
      profileChars: 0,
      profileMax: PROFILE_INJECTION_BUDGET,
      pending,
      intents: extra.intents,
      recycle: extra.recycle,
      lastConsolAt: extra.lastConsolAt
    }),
    [center, pending, extra,live]
  );

  // 动态窗口仅负责展示；今日生效由后端全量按记录去重，不能从窗口反推。
  const streamItems: ReadonlyArray<MemoryCenterEvent> = useMemo(
    () => feed?.items.slice(0, FEED_RENDER_LIMIT) ?? [],
    [feed]
  );
  const feedTotal24h = useMemo(
    () => Object.values(feed?.kindCounts24h ?? {}).reduce((sum, n) => sum + n, 0),
    [feed]
  );
  // 边流量芯片（近 24h 按 kind 聚合；计数 0 不挂芯片；n7=近 7 日，hover 标题展示）
  const edgeChips = useMemo(
    () =>
      EDGE_EVENT_MAP.map(({ edge, kinds }) => ({
        edge,
        n: kinds.reduce((sum, k) => sum + (feed?.kindCounts24h[k] ?? 0), 0),
        n7: kinds.reduce((sum, k) => sum + (feed?.kindCounts7d?.[k] ?? 0), 0),
        kinds
      })).filter((c) => c.n > 0),
    [feed]
  );
  // 真信号脉冲：近 5 分钟有映射 kind 事件的边才挂粒子（静默期全静止）
  const flowEdges = useMemo(
    () => (feed ? activeFlowEdges(feed.items, Date.now()) : EMPTY_FLOW_EDGES),
    [feed]
  );

  const paths = useMemo(() => EDGES.map((e) => ({ ...e, d: rounded(e.pts) })), []);

  useEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    const movers: Array<{ el: SVGCircleElement; path: SVGPathElement; len: number; speed: number; t: number }> = [];
    const layer = cardRef.current?.querySelector('#mflow-particles');
    if (!layer) return;
    layer.replaceChildren();
    for (const cfg of FLOW) {
      if (!flowEdges.has(cfg.id)) continue; // 真信号门控：无近期事件不挂粒子
      const path = pathRefs.current[cfg.id];
      if (!path) continue;
      let len = 1;
      try {
        len = path.getTotalLength() || 1;
      } catch {
        len = 1;
      }
      for (let i = 0; i < cfg.n; i++) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', '2.1');
        c.setAttribute('class', 'mflow-particle');
        c.setAttribute('fill', cfg.color);
        layer.appendChild(c);
        movers.push({ el: c, path, len, speed: cfg.speed, t: Math.random() * (len / cfg.speed) });
      }
    }
    let last = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const m of movers) {
        m.t = (m.t + dt) % (m.len / m.speed);
        try {
          const pt = m.path.getPointAtLength(Math.min(m.len, m.t * m.speed));
          m.el.setAttribute('cx', String(pt.x));
          m.el.setAttribute('cy', String(pt.y));
        } catch {
          /* jsdom 无 path 测长 */
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      layer.replaceChildren();
    };
  }, [paths, flowEdges]);

  const showTip = useCallback(
    (el: Element, title: string, body: string, nav: string) => {
      const card = cardRef.current;
      if (!card || gestureRef.current) return;
      const cRect = card.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const approxW = 320;
      const approxH = 110;
      let x = r.left - cRect.left + r.width / 2 - approxW / 2;
      x = Math.max(8, Math.min(x, card.clientWidth - approxW - 8));
      let y = r.top - cRect.top - approxH - 10;
      if (y < 8) y = r.bottom - cRect.top + 10;
      setTip({ title, body, nav, x: x + card.scrollLeft, y: y + card.scrollTop });
    },
    []
  );

  const hideTip = useCallback(() => {
    setTip(null);
    setHoverId(null);
  }, []);

  const litEdges = hoverId ? ADJ[hoverId] ?? [] : null;

  const badgeOf = (id: string): string | null => {
    if (id === 'n-curated') return t('{{n}} 条', { n: stats.curated });
    if (id === 'n-usermd') return fmtProfileBadge(stats.profileChars, stats.profileMax);
    if (id === 'n-approval') return live?.processing?.failed ? t('失败 {{n}}', { n: live.processing.failed }) : null;
    if (id === 'n-intents') return stats.intents > 0 ? t('{{n}} 在途', { n: stats.intents }) : null;
    if (id === 'n-recycle') return stats.recycle > 0 ? String(stats.recycle) : null;
    if (id === 'n-staging') return stagingBacklog > 0 ? t('积压 {{n}}', { n: stagingBacklog }) : null;
    if (id === 'n-consolidation') return feed?.todayActivations != null ? t('今日生效 {{n}}', { n: feed.todayActivations }) : null;
    return null;
  };

  const subOf = (node: (typeof NODES)[number]): string => {
    if (node.id === 'n-consolidation') {
      if (live?.processing?.paused) return t('记忆整理已暂停');
      if (live?.processing?.running) return t('正在整理记忆');
      if(live)return live.backlog>0?t('待处理 {{n}} 个候选',{n:live.backlog}):t('有候选时才整理');
      if (stats.lastConsolAt) {
        return t('上次记忆活动 {{time}}', { time: fmtClock(stats.lastConsolAt) });
      }
      return t('有候选时才整理');
    }
    if (node.id === 'n-approval') return live?.processing
      ? t('知识暂停 {{n}} 条 · 失败可重试', { n: live.processing.suspended })
      : t('自动处理冲突 · 失败可重试');
    return t(node.subKey);
  };

  return (
    <div className="memory-overview" data-testid="memory-overview" ref={rootRef}>
      <div className="memory-overview-toolbar">
        <div className="memory-overview-zoom" role="group" aria-label={t('总览图缩放')}>
          <button className="ui-btn tiny" aria-label={t('缩小总览图')} onClick={() => changeZoom(1 / 1.2)}>−</button>
          <span className="memory-overview-scale" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button className="ui-btn tiny" aria-label={t('放大总览图')} onClick={() => changeZoom(1.2)}>＋</button>
          <button className="ui-btn tiny" onClick={resetView}>{t('适应画布')}</button>
        </div>
        <button className="ui-btn tiny" aria-expanded={feedOpen} aria-controls="memory-overview-feed"
          onClick={() => setFeedOverride(!feedOpen)}>{t(feedOpen ? '收起最近动态' : '展开最近动态')}</button>
      </div>
      <div className="memory-overview-body">
      <div className="memory-overview-graph">
      <div className={`memory-overview-card${panning ? ' is-panning' : ''}${selection ? ' is-selecting' : ''}`}
        ref={cardRef} onScroll={hideTip}
        onDoubleClick={event => { if (isBlank(event.target)) resetView(); }}
        onPointerDown={startGesture} onPointerMove={moveGesture} onPointerUp={finishGesture}
        onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
        onContextMenu={event => event.preventDefault()}
        onClickCapture={event => { if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        } }}>
        {selection && <div className="memory-overview-selection" data-testid="overview-selection" aria-hidden="true"
          style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}
        <div className="memory-overview-stage">
        <svg
          style={{ width: 1090 * scale, height: 700 * scale }}
          className="memory-overview-svg"
          viewBox="50 8 1090 700"
          preserveAspectRatio="xMidYMid meet"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id="mflow-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <linearGradient id="mflow-brain" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="color-mix(in srgb, var(--fg-primary) 8%, transparent)" />
              <stop offset="0.55" stopColor="color-mix(in srgb, var(--fg-primary) 3%, transparent)" />
              <stop offset="1" stopColor="transparent" />
            </linearGradient>
            <marker id="mflow-m-neutral" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="var(--fg-secondary)" />
            </marker>
            <marker id="mflow-m-green" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="color-mix(in srgb, var(--status-success-fg) 80%, transparent)" />
            </marker>
            <marker id="mflow-m-yellow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="color-mix(in srgb, var(--status-warning-fg) 82%, transparent)" />
            </marker>
            <marker id="mflow-m-blue" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="color-mix(in srgb, var(--status-info-fg) 85%, transparent)" />
            </marker>
            <marker id="mflow-m-purple" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="color-mix(in srgb, var(--purple) 80%, transparent)" />
            </marker>
            <linearGradient id="mflow-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--fg-secondary)" />
              <stop offset="1" stopColor="transparent" />
            </linearGradient>
          </defs>

          <g aria-hidden="true">
            <g transform="translate(62 -51.9) scale(29.2 23.5176)">
              <path className="mflow-brain" d={BRAIN_D} />
            </g>
          </g>

          <g>
            {paths.map((e) => {
              const dim = !!litEdges && !litEdges.includes(e.id);
              const cls = [
                'mflow-edge',
                e.tone === 'green' ? 'is-green' : '',
                e.tone === 'yellow' ? 'is-yellow' : '',
                e.tone === 'blue' ? 'is-blue' : '',
                e.tone === 'purple' ? 'is-purple' : '',
                e.tone === 'fade' ? 'is-fade' : '',
                e.dash ? 'is-dash' : '',
                dim ? 'is-dim' : ''
              ]
                .filter(Boolean)
                .join(' ');
              const marker = markerFor(e.tone);
              return (
                <g key={e.id}>
                  {e.casing ? <path className={`mflow-casing${dim ? ' is-dim' : ''}`} d={e.d} /> : null}
                  {e.glow ? (
                    <path
                      className={`mflow-glow${e.tone === 'purple' ? ' is-purple' : ' is-blue'}${dim ? ' is-dim' : ''}`}
                      d={e.d}
                    />
                  ) : null}
                  <path
                    id={e.id}
                    ref={(el) => {
                      pathRefs.current[e.id] = el;
                    }}
                    className={cls}
                    d={e.d}
                    markerEnd={marker}
                    markerStart={e.both ? marker : undefined}
                    stroke={e.tone === 'fade' ? 'url(#mflow-fade)' : undefined}
                  />
                  {e.hit && e.tipTitleKey ? (
                    <path
                      className="mflow-hit"
                      d={e.d}
                      data-testid={`overview-edge-${e.id}`}
                      onMouseEnter={(ev) => {
                        showTip(ev.currentTarget, t(e.tipTitleKey!), t(e.tipKey!), '');
                        setHoverId(null);
                      }}
                      onMouseLeave={hideTip}
                    />
                  ) : null}
                </g>
              );
            })}
          </g>

          <g>
            {LABELS.map((L) => {
              const lit = !!litEdges && litEdges.includes(L.id);
              const dim = !!litEdges && !lit && (L.rest || false);
              return (
                <text
                  key={L.id}
                  className={`mflow-elabel${L.rest ? ' is-rest' : ''}${lit ? ' is-lit' : ''}${dim ? ' is-dim' : ''}${
                    L.tone ? ` is-${L.tone}` : ''
                  }`}
                  x={L.x}
                  y={L.y}
                  textAnchor="middle"
                  transform={L.rot ? `rotate(${L.rot} ${L.x} ${L.y})` : undefined}
                >
                  {t(L.key)}
                </text>
              );
            })}
          </g>

          <g>
            {/* 边流量小计数：近 24h 按 kind 聚合（kindCounts24h），计数 0 不挂芯片；hover 加近 7 日 */}
            {edgeChips.map((c) => {
              const pos = EDGE_FLOW_POS[c.edge];
              if (!pos) return null;
              const label = c.kinds.map((k) => t(KIND_LABEL_KEY[k])).join(t('、'));
              return (
                <g key={c.edge} className="mflow-chip" data-testid={`overview-edgecount-${c.edge}`}>
                  <title>{`${t('近 24 小时 {{n}} 次', { n: c.n })} · ${t('近 7 日 {{n}} 次', { n: c.n7 })} · ${label}`}</title>
                  <circle cx={pos[0]} cy={pos[1]} r="9.5" />
                  <text x={pos[0]} y={pos[1] + 3.2} textAnchor="middle">
                    {c.n > 99 ? '99+' : c.n}
                  </text>
                </g>
              );
            })}
          </g>

          {NODES.map((n) => {
            const badge = badgeOf(n.id);
            const dim = !!hoverId && hoverId !== n.id;
            return (
              <foreignObject
                key={n.id}
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                className={dim ? 'is-dim' : undefined}
                overflow="hidden"
              >
                <div
                  className={`mflow-node${n.tab ? ' is-link' : ''}`}
                  data-testid={`overview-node-${n.id}`}
                  role={n.tab ? 'button' : undefined}
                  tabIndex={n.tab ? 0 : undefined}
                  onClick={() => {
                    if (n.id === 'n-consolidation' && onOpenCurator) onOpenCurator();
                    else if (n.id === 'n-staging' && onInspectQueue) onInspectQueue('candidates');
                    else if (n.id === 'n-approval' && onInspectQueue) onInspectQueue('status');
                    else if (n.tab) onSelectTab(n.tab);
                  }}
                  onKeyDown={(ev) => {
                    if (!n.tab) return;
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      if (n.id === 'n-consolidation' && onOpenCurator) onOpenCurator();
                      else if (n.id === 'n-staging' && onInspectQueue) onInspectQueue('candidates');
                      else if (n.id === 'n-approval' && onInspectQueue) onInspectQueue('status');
                      else onSelectTab(n.tab);
                    }
                  }}
                  onMouseEnter={(ev) => {
                    const nav = n.id === 'n-consolidation' && onOpenCurator ? t('打开记忆子系统对话') : n.tab ? t('点击进入「{{tab}}」页签 →', { tab: t(tabLabel(n.tab)) }) : '';
                    showTip(ev.currentTarget, t(n.tipTitleKey), t(n.tipKey), nav);
                    setHoverId(n.id);
                  }}
                  onMouseLeave={hideTip}
                >
                  <div className="mflow-head">
                    {n.id === 'n-consolidation' ? (
                      <svg className="mflow-glyph" width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                        <path
                          d="M2.5 8 C2.3 4.6 5.2 2.2 8.4 3.1 C11.2 3.9 11.8 7.6 9.2 9.2 C7.2 10.4 4.8 9.4 4.5 7.2 C4.3 5.4 5.9 4.3 7.6 4.9"
                          stroke="var(--text-3)"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      <span className={`mflow-dot${n.dot ? ` is-${n.dot}` : ''}`} />
                    )}
                    <span className="mflow-title">{t(n.titleKey)}</span>
                    {badge ? <span className={`mflow-badge${n.badgeTone ? ` is-${n.badgeTone}` : ''}`}>{badge}</span> : null}
                  </div>
                  <div className="mflow-sub">{subOf(n)}</div>
                </div>
              </foreignObject>
            );
          })}

          <g id="mflow-particles" filter="url(#mflow-glow)" aria-hidden="true" />
        </svg>
        </div>
        {tip ? (
          <div className="mflow-tip is-show" style={{ left: tip.x, top: tip.y }}>
            <h3>{tip.title}</h3>
            <p>{tip.body}</p>
            {tip.nav ? <div className="mflow-tip-nav">{tip.nav}</div> : null}
          </div>
        ) : null}
      </div>
        <CanvasHelp hint={t('空白左键拖动框选放大 · 按住右键拖动平移 · 双击空白自适应 · 点击节点查看详情')} />
      </div>
        {feedPresence.mounted && <aside id="memory-overview-feed" className="mflow-feed mp-panel" {...feedPresence.spread}
          ref={element => { if (element) { if (!feedOpen) element.setAttribute('inert', ''); else element.removeAttribute('inert'); } }} aria-hidden={!feedOpen} data-testid="overview-feed" aria-label={t('最近动态')}>
          <div className="mflow-feed-head">
            <h3 className="mflow-feed-title">{t('最近动态')}</h3>
            {feedTotal24h > 0 ? (
              <span className="mflow-feed-count">{t('近 24h {{n}} 条', { n: feedTotal24h })}</span>
            ) : null}
          </div>
          <div className="mflow-feed-list">
            {streamItems.length === 0 ? (
              <p className="mflow-feed-empty">{t('还没有动态——记忆系统的每个动作都会记到这里')}</p>
            ) : (
              streamItems.map((ev) => {
                const nav = navOfEvent(ev);
                const row = (
                  <>
                    <span className="mflow-row-time">{fmtClock(ev.ts)}</span>
                    <span className={`mflow-row-dot is-${KIND_TONE[ev.kind]}`} aria-hidden="true" />
                    <span className="mflow-row-text">{t(ev.summary, ev.summaryArgs ?? {})}</span>
                  </>
                );
                return nav ? (
                  <button
                    key={ev.id}
                    type="button"
                    className="mflow-row is-link"
                    data-testid={`feed-row-${ev.id}`}
                    title={t(KIND_LABEL_KEY[ev.kind])}
                    onClick={() =>
                      requestMemoryCenterTab(nav.tab, nav.entryId ? { entryId: nav.entryId } : undefined)
                    }
                  >
                    {row}
                  </button>
                ) : (
                  <div key={ev.id} className="mflow-row" data-testid={`feed-row-${ev.id}`}>
                    {row}
                  </div>
                );
              })
            )}
          </div>
        </aside>}
      </div>
      <div className="memory-overview-legend">
        {/* 条目 7B：六色收敛四色——砍「门禁」（图上无线条对应）与「记录流转」（含义过泛） */}
        <span>
          <i style={{ background: 'var(--status-success-fg)' }} />
          {t('自动保存')}
        </span>
        <span>
          <i style={{ background: 'var(--status-warning-fg)' }} />
          {t('处理与冲突')}
        </span>
        <span>
          <i style={{ background: 'var(--status-info-fg)' }} />
          {t('带进对话')}
        </span>
        <span>
          <i style={{ background: 'var(--purple)' }} />
          {t('主动提醒')}
        </span>
      </div>
    </div>
  );
}

function tabLabel(id: MemoryCenterTabId): string {
  if(id==='profile')return '长期知识';
  return KNOWLEDGE_CENTER_TABS.find((tb) => tb.id === id)?.labelKey ?? KNOWLEDGE_CENTER_TABS[0].labelKey;
}
