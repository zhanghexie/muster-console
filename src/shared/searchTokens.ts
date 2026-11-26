/**
 * 检索/去重共用的纯分词器（零依赖，test/*.mjs 即时转译导入）。
 * - 连续拉丁/数字段 → 小写词元（含 #tag 去前缀、[[link]] 内文本）
 * - 连续 CJK 段 → bigram（单字成段时退化为单字）
 * 供 memory.search BM25（M-C）与记忆面板重复检测（Jaccard）共用，保证口径一致。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** 文本 → 词元数组（有序，含重复；BM25/去重各自再聚合） */
export function tokenize(text: string): string[] {
  const src = (text ?? '').toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s|[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.test(ch)) {
      i += 1;
      continue;
    }
    if (CJK_RE.test(ch)) {
      // 连续 CJK（夹在中间的标点/空白已断开）
      let j = i;
      while (j < src.length && CJK_RE.test(src[j])) j += 1;
      const run = src.slice(i, j);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k < run.length - 1; k += 1) out.push(run.slice(k, k + 2));
      i = j;
      continue;
    }
    // 拉丁/数字/下划线连缀词（#tag 已在外层按空白切分后去前缀？不——这里直接吃掉非分隔符）
    let j = i;
    while (j < src.length && !/[\s\x00-\x20]/.test(src[j]) && !CJK_RE.test(src[j])) j += 1;
    const word = src.slice(i, j).replace(/^[#＃@【[]+/, '').replace(/[\]】]+$/, '');
    if (word) out.push(word);
    i = j;
  }
  return out;
}

/** 词 → 集合（Jaccard 用） */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Jaccard 相似度 0..1（空集对空集 = 0） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
