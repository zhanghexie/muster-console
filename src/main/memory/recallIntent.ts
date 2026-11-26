/**
 * 回忆意图判定（memory-refactor §7 Lane2，B5）：确定性词法启发——判定用户消息是否
 * 在「回忆过去」（时间措辞 / 指代过去 / 问句模式），作为 Lane2 深检索的触发条件之一
 * （另一条件：Lane1 无强命中）。零模型调用、纯函数。
 *
 * 设计立场：宁可召回偏宽（深检索本身零模型成本且有界——弱命中注入「未找到」说明），
 * 但三类证据都要求**指向过去的语义形态**。B5 评审 MAJOR-4 实证：裸子串（「之前那/
 * 先前的/更早/上次」、英文裸 earlier）会把大量**普通任务指令**误判成回忆——「切回
 * 之前那个分支 / 恢复到之前那个版本 / 用先前的配置再跑一次 / 回退到更早的提交 /
 * 按上次的参数重新构建 / check the logs from earlier today」。故时间指 δεῖξις 一律
 * 加**名词锚定**的形态约束（照既有「之前…的…」先例）：裸词必须后接回忆域名词
 * （决定/方案/任务/会话/问题/结论…——分支/版本/配置/提交/参数等操作对象不算）才
 * 成立；英文裸 earlier 须带回忆语态（疑问词/回忆动词，时间语境如 earlier today /
 * earlier this week 只作必要成分不作充分条件——纯时间状语的执行指令仍会误报）。
 */

export type RecallIntentEvidenceKind = 'temporal' | 'anaphora' | 'question';

export interface RecallIntentResult {
  intent: boolean;
  /** 命中的证据（去重；空=intent=false） */
  matched: Array<{ kind: RecallIntentEvidenceKind; phrase: string }>;
}

/**
 * 回忆域名词（形态约束的锚定清单，沿既有「之前…的…」先例的收窄口径）：操作对象
 * （分支/版本/配置/提交/参数/构建产物/容器…）刻意不在列——「切回之前那个分支」
 * 这类指令引用过去产物但不是回忆提问。
 */
const RECALL_NOUNS =
  '决定|决策|方案|任务|会话|问题|结论|内容|东西|事儿?|讨论|排查|修复|教训|改动|做法|说法|口径|思路|约定';

/** 时间措辞：显式过去时间状语（自身难以被任务指令合法复用），不加锚定 */
const TEMPORAL_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  { re: /上周|上礼拜|上周一|上周二|上周三|上周四|上周五|上周六|上周日/, phrase: '上周' },
  { re: /上个月|上月/, phrase: '上个月' },
  { re: /去年|前年/, phrase: '去年' },
  { re: /昨天|前天|大前天/, phrase: '昨天' },
  { re: /前几天|前些天|前阵子/, phrase: '前几天' },
  { re: /\b(last|previous|prior)\s+(week|month|year|time|turn|session|conversation)\b/i, phrase: 'last <period>' },
  { re: /\bpreviously\b|\byesterday\b|\bthe\s+other\s+day\b/i, phrase: 'previously' },
  { re: /\bago\b/i, phrase: 'ago' }
];

/**
 * 时间指代 + 名词锚定（「上次/之前那/先前的/更早」类裸词不再单独成立）：
 * 裸词后须接回忆域名词（可隔「那(个)/的」等连接成分）才算指向一次可回忆的对象。
 */
const ANCHORED_TEMPORAL_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  {
    re: new RegExp(
      `(?:上次|上回|上一?[回次轮]|前一回|最近一次)(?:那|这)?(?:一)?(?:个|次|回|轮|件)?的?(?:${RECALL_NOUNS})`
    ),
    phrase: '上次…（名词锚定）'
  },
  {
    re: new RegExp(`之前那(?:一?个|次|回|件)?的?(?:${RECALL_NOUNS})`),
    phrase: '之前那…（名词锚定）'
  },
  {
    re: new RegExp(`(?:之前|先前|早先|此前|更早)的(?:${RECALL_NOUNS})`),
    phrase: '先前的…（名词锚定）'
  },
  { re: /更早的?时候(?:我们|你|大家)?(?:是)?(?:怎么|为什么|为啥|如何|靠什么)/, phrase: '更早的时候…' },
  {
    re: /\b(?:what|how|why|which)\b[^?\n]{0,80}?\bearlier\b/i,
    phrase: '…earlier（疑问语态）'
  },
  {
    re: /\bearlier\b[^.\n?]{0,60}?\b(?:we|you|I)\s+(?:said|mentioned|discussed|talked|decided|agreed)\b/i,
    phrase: 'earlier…（回忆动词）'
  },
  {
    re: /\b(?:as|like)\s+(?:we|I|you)\s+(?:said|mentioned|discussed|talked|agreed|decided)\b[^.\n]{0,30}?\bearlier\b/i,
    phrase: 'as … earlier（回指）'
  },
  {
    re: /\bearlier\s+(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening|week|month|year)|that\s+(?:day|week|month|year)|in\s+(?:the|that|this|our)\s)[^?\n]{0,80}\?/i,
    phrase: 'earlier <time>?（时间语境+疑问）'
  }
];

/** 指代过去（指向一个已发生的决定/任务/会话/方案） */
const ANAPHORA_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  { re: /那个(决定|方案|任务|会话|问题|结论|改动|讨论|排查|修复|教训)/, phrase: '那个…' },
  { re: /这次?(决定|方案|任务)的?(时候|当时)/, phrase: '当时' },
  { re: /当时(是|为什么|怎么|怎么想|的考虑|的决策)/, phrase: '当时' },
  { re: /(那次|这一?次|上次)(任务|会话|讨论|排查|修复)/, phrase: '那次…' },
  {
    re: new RegExp(
      `(?:之前|先前|早先|此前)(?:的|说过|提起过?|提到过?|提过|聊过|谈过|讲过|定过|定下|做过|商量过?)(?:的)?(?:${RECALL_NOUNS})`
    ),
    phrase: '之前…的…'
  },
  { re: /\bthat\s+(decision|task|session|conversation|fix|change|issue)\b/i, phrase: 'that <noun>' },
  { re: /\bwhat\s+we\s+(decided|discussed|concluded|did)\b/i, phrase: 'what we …' }
];

/** 问句模式（就既有安排/选择追问理由——典型「翻旧账」形态） */
const QUESTION_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  { re: /为什么(这么|这样|是这么)(排|安排|排序|定|决定|选)/, phrase: '为什么这么排' },
  { re: /为什么(选|用|不用|弃|选了|用的是)/, phrase: '为什么选' },
  { re: /(为何|为啥)(选|用|这么)/, phrase: '为何选' },
  { re: /是怎么(定|决定|选|排)(的|出来)?/, phrase: '怎么定的' },
  { re: /\bwhy\s+(did|do|was|were|is|are)\s+(we|you|it|they)\b/i, phrase: 'why did we' },
  { re: /\bwhy\s+(not|choose|use|pick)\b/i, phrase: 'why not/choose' }
];

function collect(
  text: string,
  patterns: ReadonlyArray<{ re: RegExp; phrase: string }>,
  kind: RecallIntentEvidenceKind,
  seen: Set<string>,
  out: Array<{ kind: RecallIntentEvidenceKind; phrase: string }>
): void {
  for (const p of patterns) {
    if (!p.re.test(text)) continue;
    const key = `${kind}:${p.phrase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, phrase: p.phrase });
  }
}

/**
 * 回忆意图判定（纯函数）：三类证据任一命中即 intent=true。
 * 空串/纯空白=false；判定只看文本形态，不做概率估计。
 */
export function detectRecallIntent(message: string): RecallIntentResult {
  const text = (message ?? '').trim();
  const out: Array<{ kind: RecallIntentEvidenceKind; phrase: string }> = [];
  if (!text) return { intent: false, matched: out };
  const seen = new Set<string>();
  collect(text, TEMPORAL_PATTERNS, 'temporal', seen, out);
  collect(text, ANCHORED_TEMPORAL_PATTERNS, 'temporal', seen, out);
  collect(text, ANAPHORA_PATTERNS, 'anaphora', seen, out);
  collect(text, QUESTION_PATTERNS, 'question', seen, out);
  return { intent: out.length > 0, matched: out };
}
