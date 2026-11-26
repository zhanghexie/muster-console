/**
 * Lane2 深检索（memory-refactor §7，B5；仅调度面）：回忆意图 && Lane1（trigger 注入
 * + bootstrap）无强命中 → 起**确定性深检索子回合**（零模型调用）：
 * 查询扩展（原句 + 时间词剥离变体 + 关键词重组）多查询打 searchMemory + 转录检索，
 * 合并去重取 top-K 有界净化摘录注入；弱关联（得分低于阈值）注入有界「未找到相关
 * 记录」说明。超时/异常静默降级为不注入（记忆检索绝不拖垮回合）。
 *
 * 命中落 recall_stats kind=escalation_hit（Lane2=升级面；searchMemory 内部的
 * search_hit 落账经 recordStats:false 关闭，避免同一次暴露双计）。
 *
 * 纯编排 + 依赖注入（检索函数由调用方给——service.search 或测试 mock），
 * test/*.mjs 直跑。
 */
import { detectRecallIntent } from './recallIntent';

export const LANE2_CONSTANTS = {
  /** 深检索整体超时（ms）：超时静默降级为不注入 */
  TIMEOUT_MS: 1_500,
  /** 合并去重后的 top-K */
  TOP_K: 4,
  /** 单条摘录净化截断（有界） */
  EXCERPT_CHARS: 240,
  /** 注入块总字符上限（有界；超限从尾部裁条目） */
  BLOCK_MAX_CHARS: 1_600,
  /**
   * 强相关阈值：最佳命中 bm25Norm 低于此值视为
   * 「未找到相关记录」。**不得比 finalScore**——final = bm25Norm × recency × importance
   * × repo，旧 journal/转录命中会被 recency 压扁而误判「未找到」。
   * B5 评审 MINOR-4 连动上调（0.05→0.15），探针定值依据（合成语料 + BM25-only，
   * 见 progress B5 评审修复节）：
   * - 语料支撑的意图问句（正例探针 7 条）best bm25Norm ∈ {0.68, 1.0}，min=0.68；
   * - 意图为真但语料无支撑的残余查询呈双峰：完全无词法重叠≈0（0.05 档也拦不住的
   *   是它，但 0.15 同样拦住）；部分重叠的池内归一伪高分 ≥0.73——任何绝对阈值都
   *   分不开这一段，靠 MAJOR-4 意图形态约束前置合围（探针 21 条任务指令负例
   *   误报 18/21→0/21）；
   * - 0.15 裁掉 (0.05,0.15] 弱尾巴（弱相对命中不再伪装成「找到相关记录」），
   *   距正例下界 0.68 有 4.5× 余量，不伤真命中。
   */
  MIN_RELEVANT_SCORE: 0.15,
  /** 多查询各自候选池 */
  PER_QUERY_TOP_K: 6
} as const;

/** 检索命中最小面（MemorySearchHit 的投影；service.search / 测试 mock 均满足） */
export interface Lane2SearchHit {
  chunkId: number;
  sourceType: string;
  sourcePath: string | null;
  text: string;
  /** 排序分（含 recency/importance/repo 衰减；仅展示/排序，不作阈值） */
  finalScore: number;
  /** 绝对相关性 bm25Norm；阈值判定用。缺省回落 finalScore（测试桩兼容） */
  bm25Norm?: number | null;
}

/** 检索依赖（调用方注入：service.search 或测试桩） */
export interface Lane2SearchDeps {
  search: (query: string, topK: number, signal?: AbortSignal) => Promise<Lane2SearchHit[]>;
}

/** 阈值/展示用绝对相关性：优先词法分，缺省回落 finalScore */
function hitRelevance(h: Lane2SearchHit): number {
  return h.bm25Norm != null && Number.isFinite(h.bm25Norm) ? h.bm25Norm : h.finalScore;
}

/** 时间词剥离（查询扩展：把时间措辞剥掉形成变体，覆盖「当时未必用了时间词」的语料） */
const TEMPORAL_STRIP_RE =
  /(上周|上礼拜|上个月|上月|去年|前年|上次|上回|上一回|上一轮|昨天|前天|大前天|前几天|前些天|前阵子|早先|更早|此前|最近一次|上一次|last\s+(?:week|month|year|time|turn|session|conversation)|previously|earlier|yesterday|the\s+other\s+day)/gi;

/** 中英文停用词（关键词重组用：只留实词重组成紧凑查询） */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '我们', '你', '您', '他', '她', '它', '们', '这', '那', '这个',
  '那个', '一下', '什么', '怎么', '为什么', '为啥', '为何', '吗', '呢', '吧', '请', '帮',
  '看看', '查查', '告诉', '说说', '回忆', '记得', '记不记得', '想', '下', '还', '又', '再',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'what', 'why', 'how',
  'did', 'do', 'does', 'was', 'were', 'is', 'are', 'we', 'you', 'it', 'they', 'me', 'us',
  'tell', 'recall', 'remember', 'please'
]);

/**
 * 查询扩展（确定性；返回去重变体序列，首项恒为原句）：
 * ① 原句；② 时间词剥离变体；③ 关键词重组（实词 ≤8 个空格连接——CJK 二元组分词
 * 在检索侧对连续中文串本就按二元组展开，重组主要压缩问句噪声）。
 */
export function expandRecallQueries(message: string): string[] {
  const text = (message ?? '').trim();
  if (!text) return [];
  const out = [text];
  const stripped = text.replace(TEMPORAL_STRIP_RE, '').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== text) out.push(stripped);
  const tokens = text
    .split(/[\s，。！？；、,.!?;:：""''()\[\]{}]+/)
    .map((s) => s.trim())
    .filter((s) => s && !STOPWORDS.has(s) && !STOPWORDS.has(s.toLowerCase()));
  const keywords = tokens.slice(0, 8);
  if (keywords.length >= 2) {
    const rebuilt = keywords.join(' ');
    if (!out.includes(rebuilt)) out.push(rebuilt);
  }
  return out.slice(0, 3);
}

function sanitizeExcerpt(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > LANE2_CONSTANTS.EXCERPT_CHARS
    ? `${flat.slice(0, LANE2_CONSTANTS.EXCERPT_CHARS)}…`
    : flat;
}

export interface Lane2Result {
  /** 是否执行了深检索（false=条件不满足/超时/异常——整段不注入） */
  ran: boolean;
  /** ran 且找到相关记录 */
  found: boolean;
  /** 注入块文本（found=false 时为「未找到」或 degraded 说明；ran=false 恒空串） */
  block: string;
  /** 注入块涉及的 chunk id（escalation_hit 落账面） */
  injectedChunkIds: number[];
  /** 变体查询数（诊断） */
  queryCount: number;
  skipped?: 'no_intent' | 'lane1_strong_hit' | 'timeout' | 'error';
  /** true=至少一查询失败（全失败或部分失败）——不得与真无命中同文案 */
  degraded?: boolean;
  /** 失败的查询变体数（诊断） */
  failedQueries?: number;
}

const NOT_FOUND_BLOCK =
  '### 历史记录检索（Lane2 深检索）\n已在长期记忆、工作日志与调度会话转录里深检索，未找到与本次提问强相关的记录。若你确信存在该记录，可能是未被记下或措辞差异过大——请直接说明你记得的线索，不要编造历史。';

/** 全查询失败/检索通道异常时的 degraded 说明（≠「未找到」） */
const DEGRADED_BLOCK =
  '### 历史记录检索（Lane2 深检索）\n检索通道异常，深检索未能完成。请勿把「未检索到」当成「不存在」——可稍后重试或改述问题，不要编造历史。';

/** 超时哨兵错误（runLane2WithTimeout 内部辨识用，与外部检索异常区分） */
const LANE2_TIMEOUT_MARKER = 'lane2-timeout';

/**
 * Lane2 深检索编排（依赖注入；纯逻辑不含定时器——超时由 runLane2WithTimeout 包装）。
 * 条件判定在入口：无回忆意图 → skipped:no_intent；Lane1 强命中（lane1StrongHit=true）
 * → skipped:lane1_strong_hit。
 */
export async function runLane2DeepRecall(
  deps: Lane2SearchDeps,
  message: string,
  opts: { lane1StrongHit?: boolean; now?: number; signal?: AbortSignal } = {}
): Promise<Lane2Result> {
  const intent = detectRecallIntent(message);
  if (!intent.intent) {
    return { ran: false, found: false, block: '', injectedChunkIds: [], queryCount: 0, skipped: 'no_intent' };
  }
  if (opts.lane1StrongHit) {
    return { ran: false, found: false, block: '', injectedChunkIds: [], queryCount: 0, skipped: 'lane1_strong_hit' };
  }
  const queries = expandRecallQueries(message);
  // 多查询并行 → 合并去重（同 chunk 保最高相关）→ top-K；单查询失败不伪装「未找到」
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      // search 调用本身在 try 外：同步抛错（依赖未就绪等）冒泡到编排层（skipped:error）；
      // 仅返回的 promise 异步拒绝按单查询失败吞成 degraded
      const p = deps.search(q, LANE2_CONSTANTS.PER_QUERY_TOP_K, opts.signal);
      try {
        const hits = await p;
        return { ok: true as const, hits: hits ?? [] };
      } catch {
        return { ok: false as const, hits: [] as Lane2SearchHit[] };
      }
    })
  );
  const failedQueries = perQuery.filter((r) => !r.ok).length;
  const degraded = failedQueries > 0;
  const byId = new Map<number, Lane2SearchHit>();
  for (const { hits } of perQuery) {
    for (const h of hits) {
      const prev = byId.get(h.chunkId);
      if (!prev || hitRelevance(h) > hitRelevance(prev)) byId.set(h.chunkId, h);
    }
  }
  const merged = [...byId.values()].sort((a, b) => hitRelevance(b) - hitRelevance(a));
  const best = merged[0] ? hitRelevance(merged[0]) : 0;
  // 全查询失败：degraded 说明（≠「未找到」）；部分失败但无可信命中同样 degraded
  if (best < LANE2_CONSTANTS.MIN_RELEVANT_SCORE) {
    const block = degraded ? DEGRADED_BLOCK : NOT_FOUND_BLOCK;
    return {
      ran: true,
      found: false,
      block,
      injectedChunkIds: [],
      queryCount: queries.length,
      degraded,
      failedQueries
    };
  }
  const picked: Lane2SearchHit[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const h of merged) {
    if (picked.length >= LANE2_CONSTANTS.TOP_K) break;
    const rel = Math.min(1, hitRelevance(h));
    const line = `- [${h.sourcePath ?? h.sourceType}]（相关度 ${rel.toFixed(2)}）${sanitizeExcerpt(h.text)}`;
    if (used + line.length > LANE2_CONSTANTS.BLOCK_MAX_CHARS && picked.length > 0) break;
    picked.push(h);
    lines.push(line);
    used += line.length;
  }
  const block = [
    '### 历史记录检索（Lane2 深检索命中，净化摘录——以原始文件为准，路径可直接读取）',
    ...lines
  ].join('\n');
  return {
    ran: true,
    found: true,
    block,
    injectedChunkIds: picked.map((h) => h.chunkId),
    queryCount: queries.length,
    degraded,
    failedQueries
  };
}

/**
 * 带超时的 Lane2 入口（宿主调用面）：整体 Promise.race 定时器，超时/异常静默降级为
 * 不注入（skipped 按因区分 timeout / error——B5 评审 MINOR-④，诊断与调参要看清是
 * 检索挂起还是检索抛错）。escalation_hit 落账由调用方（有 db 句柄）执行。
 */
export async function runLane2WithTimeout(
  deps: Lane2SearchDeps,
  message: string,
  opts: { lane1StrongHit?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Lane2Result> {
  const timeoutMs = opts.timeoutMs ?? LANE2_CONSTANTS.TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 尽量取消贯通：超时 abort 底层检索（deps.search 须尊重 signal；不尊重也至少 race 退场）
  const ac = new AbortController();
  const onOuterAbort = (): void => ac.abort(opts.signal?.reason);
  opts.signal?.addEventListener?.('abort', onOuterAbort, { once: true });
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort(new Error(LANE2_TIMEOUT_MARKER));
        reject(new Error(LANE2_TIMEOUT_MARKER));
      }, timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([
      runLane2DeepRecall(deps, message, { ...opts, signal: ac.signal }),
      timeout
    ]);
  } catch (err) {
    const skipped = err instanceof Error && err.message === LANE2_TIMEOUT_MARKER ? 'timeout' : 'error';
    return { ran: false, found: false, block: '', injectedChunkIds: [], queryCount: 0, skipped };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener?.('abort', onOuterAbort);
  }
}
