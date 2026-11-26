import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * B2 always 规则存储（主进程）：dangerous 工具确认门的「总是允许」持久化与匹配。
 * 规则形状走 shared/permissionOption 的 AlwaysRule（纯函数层 build/match 同源）。
 *
 * 指纹纪律（防预授权放大）：
 * - fingerprint = 工具名 + 参数身份——command 预览→归一化命令文本；
 *   file 预览→排序去小写路径列表；generic/无预览**不出指纹**（不落库不匹配，
 *   「同工具任意参数」不得被一条 always 放大放行）。
 * - scope 只收 global/project（executor 无会话键；session 作用域不在本门提供）。
 * - 存储 userData/permission-always-rules.json（原子写；读失败=空表 fail-closed）。
 */
import fs from 'node:fs';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  buildAlwaysRule,
  matchAlwaysRule,
  parseAlwaysRules,
  type AlwaysRule,
  type PermissionDecision
} from '../../shared/permissionOption';

const RULES_MAX = 200;

let store: AlwaysRuleStore | null = null;

/** index.ts 启动注入 userData；未注入（测试/非宿主）时本门不生效（fail-closed） */
export function setAlwaysRulesUserDataDir(userDataDir: string): void {
  store = new AlwaysRuleStore(userDataStorage(userDataDir).file('permission-always-rules'));
}

function storeOrNull(): AlwaysRuleStore | null {
  if (store) return store;
  // 惰性兜底取 electron userData（require 惰性：纯 node 测试环境编译本模块不炸）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    setAlwaysRulesUserDataDir(app.getPath('userData'));
    return store;
  } catch {
    return null;
  }
}

export class AlwaysRuleStore {
  private rules: AlwaysRule[] | null = null;

  constructor(private readonly file: string) {}

  private load(): AlwaysRule[] {
    if (this.rules) return this.rules;
    try {
      this.rules = parseAlwaysRules(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (err) {
      // X3-F11：损坏回 [] 不改（fail-safe：逐次审批即可），但留一条诊断线索区分
      // 「损坏回空」与「从未写过」（ENOENT 静默）
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[always-rules] 规则文件损坏/不可读，按空规则起步（下次放行可重建）：${this.file}`,
          err instanceof Error ? err.message : err
        );
      }
      this.rules = [];
    }
    return this.rules;
  }

  private save(): void {
    try {
      writeJsonAtomicSync(this.file, { version: 1, rules: this.load() });
    } catch {
      /* 落盘失败不阻断：本次放行照常，重启后规则丢失 */
    }
  }

  /** 命中 allow 规则（scope 适用 + 指纹相等）才 true */
  match(query: { fingerprint: string; projectKey?: string }): boolean {
    const hit = matchAlwaysRule(this.load(), query);
    return hit?.effect === 'allow';
  }

  /** allowAlways 决策落库（同指纹+scope 覆盖旧的；超上限裁最旧） */
  record(decision: PermissionDecision, opts: { fingerprint: string; projectKey?: string }): void {
    const rule = buildAlwaysRule(decision, opts);
    if (!rule) return;
    const rules = this.load().filter(
      (r) =>
        !(r.fingerprint === rule.fingerprint && r.scope === rule.scope && r.scopeKey === rule.scopeKey)
    );
    rules.push(rule);
    this.rules = rules.slice(-RULES_MAX);
    this.save();
  }

  get size(): number {
    return this.load().length;
  }
}

const FP_PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'file', 'dir'] as const;

/** 从工具参数全量收集路径（不设展示上限——指纹不得因截断碰撞） */
function collectArgPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  // 结构化 patch 形态（ApplyPatch files[]：filePath/path + movePath）
  const patchList = args.files ?? args.patch;
  if (Array.isArray(patchList)) {
    for (const row of patchList) {
      if (!row || typeof row !== 'object') continue;
      const o = row as Record<string, unknown>;
      push(o.filePath);
      push(o.path);
      push(o.movePath);
      push(o.destination);
    }
  }
  for (const key of FP_PATH_KEYS) {
    const v = args[key];
    push(v);
    if (Array.isArray(v)) for (const p of v) push(p);
  }
  return out;
}

/**
 * 危险工具门指纹（从**原始入参**构造，不经预览的 FILE_PATHS_MAX 截断——
 * 截断会让「前 6 路径相同、尾部任意」的两批改动共享指纹，预授权被放大）：
 * - command 预览语义 → 工具名 + 归一化命令；
 * - file 预览语义 → 工具名 + 全量排序去小写路径列表；
 * - generic/无参数身份 → 不出指纹（不提供 always，防同工具任意参数放大放行）。
 */
export function dangerousGateFingerprint(
  dotName: string,
  args: Record<string, unknown>
): string | null {
  const cmd = typeof args.command === 'string' && args.command.trim()
    ? args.command
    : typeof args.cmd === 'string' && args.cmd.trim()
      ? args.cmd
      : null;
  if (cmd) {
    return `${dotName}|cmd:${cmd.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  }
  const paths = collectArgPaths(args);
  if (paths.length) {
    const sorted = [...new Set(paths)]
      .map((p) => p.replace(/\\/g, '/').toLowerCase())
      .sort()
      .join(',');
    return `${dotName}|file:${sorted}`;
  }
  return null;
}

/** 执行器消费：指纹命中已批准的 always 规则（无存储/无指纹恒 false） */
export function matchesAlwaysRule(fingerprint: string | null, projectKey?: string): boolean {
  if (!fingerprint) return false;
  return storeOrNull()?.match({ fingerprint, projectKey }) ?? false;
}

/** 执行器消费：用户点了「总是允许」后落库 */
export function recordAlwaysRule(
  decision: PermissionDecision,
  fingerprint: string | null,
  projectKey?: string
): void {
  if (!fingerprint) return;
  storeOrNull()?.record(decision, { fingerprint, projectKey });
}

/** 测试/诊断 */
export function alwaysRulesStoreOrNull(): AlwaysRuleStore | null {
  return storeOrNull();
}
