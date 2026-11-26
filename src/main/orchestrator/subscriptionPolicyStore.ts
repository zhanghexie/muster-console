/**
 * 订阅策略文件读写（agent-comms-evolution-plan C1）：每工作区
 * `.muster/scheduler/subscription-policy.json`，调度经 scheduler.policy.set 写、人可直接改。
 * 读按 mtime+size 缓存（事件泵每个事件都要问一次）；写原子落盘并追加变更历史
 * （`subscription-policy.history.jsonl`，含改前改后全文，供回看与回滚）。
 * 规则命中计数只在内存（进程重启清零），给调度判断「哪条规则在起作用」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  emptySubscriptionPolicy,
  parseSubscriptionPolicy,
  serializeSubscriptionPolicy,
  SUBSCRIPTION_POLICY_FILE,
  SUBSCRIPTION_POLICY_HISTORY_FILE,
  type PolicyAction,
  type PolicyParseResult,
  type PolicyRuleStat,
  type SubscriptionPolicy
} from '../../shared/subscriptionPolicy';

type Cached = PolicyParseResult & { mtimeMs: number; size: number };

/** history JSONL 轮转阈值（X3-F05；dynamicSync/skillInject 审计账 256KB 同范式） */
const HISTORY_MAX_BYTES = 256 * 1024;

function relToAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

export class SubscriptionPolicyStore {
  private cache = new Map<string, Cached>();
  private stats = new Map<string, Record<string, PolicyRuleStat>>();

  filePath(root: string): string {
    return relToAbs(root, SUBSCRIPTION_POLICY_FILE);
  }

  historyPath(root: string): string {
    return relToAbs(root, SUBSCRIPTION_POLICY_HISTORY_FILE);
  }

  /** 缺失 → 空策略（全部内置默认）；坏文件 → 宽容解析（坏条目丢弃并记日志） */
  load(root: string): PolicyParseResult {
    const file = this.filePath(root);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.cache.delete(root);
      return { policy: emptySubscriptionPolicy(), warnings: [], notices: [] };
    }
    const hit = this.cache.get(root);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let parsed: PolicyParseResult;
    let readFailed = false;
    try {
      parsed = parseSubscriptionPolicy(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      readFailed = true;
      parsed = {
        policy: emptySubscriptionPolicy(),
        warnings: [`策略文件读取失败，按空策略处理：${String((err as Error)?.message ?? err)}`],
        notices: []
      };
    }
    if (parsed.warnings.length) {
      console.warn('[subscription-policy]', file, parsed.warnings.join('；'));
    }
    if (readFailed) {
      // F-01（subscription-policy）：stat 成功但读取失败（EACCES/EBUSY 等，Windows 文件被
      // 占用现实发生）时不得把空策略写进缓存——mtime/size 未变期间会一直命中空策略，
      // 用户自定义规则静默失效。失败不缓存（顺带清掉可能过期的旧条目），下次重读。
      this.cache.delete(root);
      return parsed;
    }
    this.cache.set(root, { ...parsed, mtimeMs: st.mtimeMs, size: st.size });
    return parsed;
  }

  get(root: string): SubscriptionPolicy {
    return this.load(root).policy;
  }

  write(
    root: string,
    policy: SubscriptionPolicy,
    meta: { by: string; reason: string; now: number }
  ): { file: string; history: string; historyError?: string } {
    const previous = this.load(root).policy;
    const next: SubscriptionPolicy = {
      ...policy,
      updatedAt: meta.now,
      updatedBy: meta.by,
      reason: meta.reason
    };
    writeJsonAtomicSync(this.filePath(root), serializeSubscriptionPolicy(next));
    this.cache.delete(root);
    let historyError: string | undefined;
    try {
      const historyPath = this.historyPath(root);
      // X3-F05：history 全量 append 无界 → 超 256KB 先滚动为 .old（保守阈值，同审计账范式）
      if (fs.existsSync(historyPath) && fs.statSync(historyPath).size > HISTORY_MAX_BYTES) {
        fs.rmSync(`${historyPath}.old`, { force: true });
        fs.renameSync(historyPath, `${historyPath}.old`);
      }
      fs.appendFileSync(
        historyPath,
        `${JSON.stringify({
          ts: meta.now,
          by: meta.by,
          reason: meta.reason,
          previous: serializeSubscriptionPolicy(previous),
          next: serializeSubscriptionPolicy(next)
        })}\n`,
        'utf8'
      );
    } catch (err) {
      // sub-policy F-02：失败信号进返回值（工具层转述），不再只留主进程日志
      historyError = err instanceof Error ? err.message : String(err);
      console.error('[subscription-policy] history append failed（策略本体已写入）', err);
    }
    return {
      file: SUBSCRIPTION_POLICY_FILE,
      history: SUBSCRIPTION_POLICY_HISTORY_FILE,
      ...(historyError !== undefined ? { historyError } : {})
    };
  }

  noteHit(root: string, ruleId: string, action: PolicyAction, now: number): void {
    const byRule = this.stats.get(root) ?? {};
    const cur = byRule[ruleId] ?? { hits: 0, lastAt: 0, byAction: {} };
    cur.hits += 1;
    cur.lastAt = now;
    cur.byAction[action] = (cur.byAction[action] ?? 0) + 1;
    byRule[ruleId] = cur;
    this.stats.set(root, byRule);
  }

  getStats(root: string): Record<string, PolicyRuleStat> {
    const byRule = this.stats.get(root) ?? {};
    return Object.fromEntries(
      Object.entries(byRule).map(([id, s]) => [id, { ...s, byAction: { ...s.byAction } }])
    );
  }
}

let singleton: SubscriptionPolicyStore | null = null;

export function getSubscriptionPolicyStore(): SubscriptionPolicyStore {
  if (!singleton) singleton = new SubscriptionPolicyStore();
  return singleton;
}
