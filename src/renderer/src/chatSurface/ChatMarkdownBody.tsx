/**
 * 会话消息正文的路径链接化渲染层：语法候选（linkifyWorkspacePaths）之上加一道
 * stat 二次校验——先渲染原文，挂载后把有限候选路径批量 `shell:statPaths`（微批合并 +
 * 模块级缓存 + in-flight 去重），磁盘存在的才包成 muster-file: 链接。语法像路径但磁盘没有的词
 * （PDF/DOCX/PPTX、Marker/pdftotext、散文斜杠 /word 等）不再产出「点了才 toast」
 * 的死链；相对路径的 stat 以会话 cwd 解析（与点击路由同源）。
 * 流式期间跳过（与旧映射层行为一致）：文本每拍都变，正则扫描与 stat 都等回合结束。
 */
import React from 'react';
import { MarkdownBody } from '../components/MarkdownBody';
import {
  findWorkspacePathLinks,
  linkifyWorkspacePaths
} from '../../../shared/linkifyWorkspacePaths';
import { resolvePathCandidate } from '../../../shared/terminalSelectionText';

interface Props {
  text: string;
  className?: string;
  streaming?: boolean;
  /** 会话 cwd：相对路径候选 stat 与点击路由同源解析 */
  cwd?: string;
  onFileLink?: (href: string) => void;
}

/** stat 结果缓存（解析后的绝对路径 → {exists, 过期时刻}）：会话切回/消息重渲不重复 IPC。
 *  无法订阅 fs 事件，用惰性 TTL 兜底陈旧值（「先提到、后创建」的文件最迟 60s 出链接），
 *  超限整体清空。 */
const TTL_MS = 60_000;
const existsCache = new Map<string, { v: boolean; exp: number }>();
const CACHE_CAP = 5000;
const MAX_CANDIDATES = 256;
/** 微批窗口（ms）：转写一次挂载 N 条消息的候选合并进同一次 statPaths IPC */
const FLUSH_MS = 20;

type Waiter = { resolve: (v: boolean) => void; cancelled: boolean; signal?: AbortSignal; onAbort?: () => void };
type StatBatch = { waiters: Set<Waiter>; dispatched: boolean };
const pending = new Map<string, StatBatch>();
const inFlight = new Map<string, StatBatch>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  flushTimer = null;
  const entries = [...pending.entries()].filter(([, batch]) => batch.waiters.size > 0);
  for (const [abs, batch] of entries) {
    pending.delete(abs);
    batch.dispatched = true;
    inFlight.set(abs, batch);
  }
  if (!entries.length) return;
  const absList = entries.map(([abs]) => abs);
  const settle = (stats: Record<string, { exists?: boolean }>, cache: boolean): void => {
    const exp = Date.now() + TTL_MS;
    for (const [abs, batch] of entries) {
      if (cache) existsCache.set(abs, { v: stats[abs]?.exists ?? false, exp });
      inFlight.delete(abs);
      for (const waiter of batch.waiters) {
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        if (!waiter.cancelled) waiter.resolve(cache ? (stats[abs]?.exists ?? false) : false);
      }
      batch.waiters.clear();
    }
    if (existsCache.size > CACHE_CAP) existsCache.clear();
  };
  void window.api.shell
    .statPaths(absList)
    .then((stats) => settle(stats, true))
    .catch(() => settle({}, false));
}

function statExists(abs: string, signal?: AbortSignal): Promise<boolean> {
  const hit = existsCache.get(abs);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.v);
  if (hit) existsCache.delete(abs);
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    let batch = pending.get(abs) ?? inFlight.get(abs);
    if (!batch) {
      batch = { waiters: new Set(), dispatched: false };
      pending.set(abs, batch);
    }
    const waiter: Waiter = { resolve, cancelled: false, signal };
    const cancel = (): void => {
      waiter.cancelled = true;
      batch!.waiters.delete(waiter);
      if (!batch!.dispatched && batch!.waiters.size === 0) pending.delete(abs);
      resolve(false);
    };
    waiter.onAbort = cancel;
    batch.waiters.add(waiter);
    signal?.addEventListener('abort', cancel, { once: true });
    if (!batch.dispatched && flushTimer == null) flushTimer = setTimeout(flush, FLUSH_MS);
  });
}

/** 候选路径 → 存在性表（key 为 linkify 的 path 原文）；无 cwd 的相对路径解析不出，按不存在 */
function usePathLinkifiedText(text: string, cwd: string | undefined, streaming: boolean): string {
  const [existsMap, setExistsMap] = React.useState<Map<string, boolean> | null>(null);
  const candidateKey = React.useMemo(() => {
    if (streaming || !text) return '';
    return [...new Set(findWorkspacePathLinks(text).map((l) => l.path))].slice(0, MAX_CANDIDATES).join('\u0000');
  }, [text, streaming]);

  React.useEffect(() => {
    if (!candidateKey) return;
    const controller = new AbortController();
    setExistsMap(null); // 文本/cwd 变化先退回纯文本，旧结果不跨版本复用
    const paths = candidateKey.split('\u0000');
    void Promise.all(
      paths.map((p) => {
        const abs = resolvePathCandidate(p, cwd);
        return abs ? statExists(abs, controller.signal) : Promise.resolve(false);
      })
    ).then((results) => {
      if (controller.signal.aborted) return;
      setExistsMap(new Map(paths.map((p, i) => [p, results[i] ?? false])));
    });
    return () => controller.abort();
  }, [candidateKey, cwd]);

  if (streaming || !existsMap || !text) return text;
  return linkifyWorkspacePaths(text, { exists: (p) => existsMap.get(p) ?? false });
}

function ChatMarkdownBodyInner({
  text,
  className,
  streaming,
  cwd,
  onFileLink
}: Props): React.JSX.Element {
  const display = usePathLinkifiedText(text, cwd, streaming === true);
  return <MarkdownBody className={className} text={display} onFileLink={onFileLink} localImages imageCwd={cwd} />;
}

export const ChatMarkdownBody = React.memo(ChatMarkdownBodyInner);
