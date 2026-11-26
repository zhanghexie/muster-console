/**
 * CJK 二元组预分词（memory-refactor §4.2/§8）。
 *
 * 历史：B1 时住在 db.ts；B2 排序引擎（ranking.ts，纯函数无 db 依赖）与索引构建器
 * 也需要同一 tokenizer（MMR Jaccard / journal 语料 token），为避免「无 db 依赖」的
 * 排序模块反向拖入 node:sqlite，抽到独立模块，db.ts 原样 re-export 保持 B1 API。
 *
 * 预分词：CJK 连续段切二元组（单字段补齐单字），拉丁/数字按词，其余为分隔。
 * 「嵌套仓容器」→ ['嵌套','套仓','仓容','容器']；`pnpm typecheck` → ['pnpm','typecheck']。
 * 二元组按**码点**切（扩展 B 区等增补面字符不拆代理对，避免产生半截乱码 token）。
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x3040, 0x30ff], // 平假名/片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xac00, 0xd7af], // 谚文音节
  [0x20000, 0x3134f] // CJK 扩展 B 及以降
];

export function isCjkCodePoint(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function cjkBigramTokenize(text: string): string[] {
  const tokens: string[] = [];
  let cjkRun: string[] = [];
  let word = '';
  const flushCjk = (): void => {
    if (!cjkRun.length) return;
    if (cjkRun.length === 1) tokens.push(cjkRun[0]);
    else {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) tokens.push(cjkRun[i] + cjkRun[i + 1]);
    }
    cjkRun = [];
  };
  const flushWord = (): void => {
    if (word) {
      tokens.push(word);
      word = '';
    }
  };
  for (const ch of text ?? '') {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      flushWord();
      cjkRun.push(ch);
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return tokens;
}

/** 预分词文本写入 chunks.fts 列的形态（token 空格拼接） */
export function ftsColumnText(text: string): string {
  return cjkBigramTokenize(text).join(' ');
}

/** 查询文本 → FTS5 MATCH 表达式（token 双引号转义 + 空格 AND；空查询返回 ''） */
export function ftsMatchExpr(queryText: string): string {
  return cjkBigramTokenize(queryText)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** OR 形态 MATCH 表达式（任一 token 命中即候选，bm25 负责排序）。
 *  长自然语言问句的二元组 AND 会因某个组合词不在语料而整查询 0 命中（B2 评测
 *  实测 BM25 recall@5=0%），检索门面按「AND 无命中→OR 兜底」两段式使用。 */
export function ftsMatchExprAny(queryText: string, maxTokens = 24): string {
  const tokens = cjkBigramTokenize(queryText).slice(0, maxTokens);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
