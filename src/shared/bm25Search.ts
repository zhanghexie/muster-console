/**
 * 内置 BM25 检索（M-C）：零依赖纯函数（test/*.mjs 即时转译导入）。
 * 分词用 shared/searchTokens（CJK bigram + 拉丁词），与记忆面板重复检测同口径。
 * 语料规模（工作区 journal/记忆/文档，数百文档级）下毫秒级，无需外部索引器。
 */
import { tokenize } from './searchTokens';

export interface Bm25Doc {
  /** 稳定 id（调用方自定，如 `journal/2026-09-02.md`） */
  id: string;
  /** 参与检索的正文 */
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export interface Bm25Index {
  /** 按相关度降序返回至多 limit 条（score>0 才返回） */
  search(query: string, limit?: number): Bm25Hit[];
  /** 语料文档数 */
  size(): number;
}

const K1 = 1.4;
const B = 0.75;

/** 建 BM25 索引：倒计词频 + 文档长度归一 */
export function buildBm25Index(docs: Bm25Doc[]): Bm25Index {
  const df = new Map<string, number>();
  const docTokens: Array<Map<string, number>> = [];
  const docLen: number[] = [];
  const ids: string[] = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    docTokens.push(tf);
    docLen.push(tokens.length);
    ids.push(doc.id);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = docs.length || 1;
  const avgLen = docLen.reduce((a, b) => a + b, 0) / N || 0;

  function search(query: string, limit = 5): Bm25Hit[] {
    const qTerms = [...new Set(tokenize(query))];
    if (!qTerms.length || N <= 0) return [];
    const scores: Bm25Hit[] = [];
    for (let i = 0; i < docTokens.length; i += 1) {
      let score = 0;
      for (const term of qTerms) {
        const f = docTokens[i].get(term);
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * docLen[i]) / avgLen)));
      }
      if (score > 0) scores.push({ id: ids[i], score });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { search, size: () => docTokens.length };
}
