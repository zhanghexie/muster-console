/**
 * 测试文件内分片：把一个慢文件里互相独立的场景块摊到多个进程并行跑。
 *
 * 用法（文件头声明分片数，场景块按序号包进 inShard）：
 *   // @test-shards 3
 *   import { inShard } from './helpers/shard.mjs';
 *   if (inShard(0)) { ...场景 A... }
 *   if (inShard(1)) { ...场景 B... }
 *
 * run.mjs 读到 `// @test-shards N` 就把该文件起 N 个进程，各带 TEST_SHARD=i/N；
 * 块序号按 k % N 分配，每个块恰好落在一个分片里。直接 `node test/x.mjs`（无 TEST_SHARD）
 * 时全部块都跑。块之间不得共享可变状态——各分片是独立进程，前一块的副作用后一块看不到。
 */
const spec = process.env.TEST_SHARD;
const [index, total] = spec ? spec.split('/').map(Number) : [0, 1];

export function inShard(k) {
  return total <= 1 || k % total === index;
}
