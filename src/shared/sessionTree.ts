/**
 * 会话父子链（子代理通用化）：深度计算与树构建。
 *
 * 「子代理」不是特殊会话类别，只是带 `parentSessionId` 的普通 worker 会话。
 * 链深度 = 从顶层会话数到该会话的层数（顶层 = 1），不设固定层数政策。
 * 创建并发由宿主派活队列统一管理；环与断链仍拒绝继续扩展。
 *
 * 深度不在 SessionMeta 冗余存储——按 parentSessionId 回溯算，父改名/归档/删除
 * 都不会让缓存深度漂移。零依赖纯函数，供主进程守卫与渲染层树构建共用。
 */

export interface SessionParentRef {
  id: string;
  parentSessionId?: string;
}

/** 父引用查找器；缺省实现从会话表取。 */
export type ParentLookup = (sessionId: string) => SessionParentRef | undefined;

/**
 * 链深度：顶层 = 1，带父的 = 父深度 + 1。
 *
 * 环与断链返回 Infinity（无有效深度），使创建守卫拒绝损坏归属链。
 */
export function sessionDepth(session: SessionParentRef, lookup: ParentLookup): number {
  let depth = 1;
  let current = session;
  const seen = new Set<string>([session.id]);
  while (current.parentSessionId) {
    const parentId = current.parentSessionId;
    // 环：回到已访问的会话，判定为损坏链。
    if (seen.has(parentId)) return Infinity;
    seen.add(parentId);
    const parent = lookup(parentId);
    // 断链：父不存在，不当作顶层放行。
    if (!parent) return Infinity;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** 归属链有效即可拉子会话；不叠加与并发队列重复的固定层数限制。 */
export function canSpawnChild(session: SessionParentRef, lookup: ParentLookup): boolean {
  return Number.isFinite(sessionDepth(session, lookup));
}

/** 层级展示名：顶层「会话」、第二层「子代理」、第三层「孙代理」。 */
export function sessionDepthLabel(depth: number): string {
  if (depth <= 1) return '会话';
  if (depth === 2) return '子代理';
  if (depth === 3) return '孙代理';
  return Number.isFinite(depth) ? `第${depth}层子代理` : '子代理';
}

/** 树构建结果的一层。 */
export interface SessionTreeNode<T extends SessionParentRef> {
  session: T;
  /** 0 = 顶层 */
  level: number;
  children: SessionTreeNode<T>[];
}

export interface SessionTreeOptions<T extends SessionParentRef> {
  /** 是否纳入结果；缺省全要。用于过滤已归档等。 */
  include?(session: T): boolean;
  /** 顶层排序比较；缺省保持输入顺序。 */
  compareRoots?(a: T, b: T): number;
  /** 子会话排序比较；缺省保持输入顺序。 */
  compareChildren?(a: T, b: T): number;
}

/**
 * 按 parentSessionId 把扁平会话列表构建成森林。
 *
 * 三类「看不见父」的情形一律**提升为顶层**，保证会话不凭空消失：
 * 父不在列表内（已归档 / 被过滤 / 别的分区）、父即自身、以及 `parentSessionId` 成环。
 * 环必须在此自愈（而非要求调用方先断环）——否则 x→y→x 会让整对进入彼此的
 * children 且谁也不在 roots，整枝从列表里消失。
 */
export function buildSessionTree<T extends SessionParentRef>(
  sessions: readonly T[],
  options: SessionTreeOptions<T> = {}
): Array<SessionTreeNode<T>> {
  const included = breakParentCycles(
    options.include ? sessions.filter(options.include) : sessions.slice()
  );
  const byId = new Map(included.map((s) => [s.id, s]));

  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of included) {
    const parentId = session.parentSessionId;
    // 父缺失、父被过滤、父即自身 → 提升为顶层
    if (!parentId || !byId.has(parentId) || parentId === session.id) {
      roots.push(session);
      continue;
    }
    const bucket = childrenOf.get(parentId);
    if (bucket) bucket.push(session);
    else childrenOf.set(parentId, [session]);
  }

  const rootsSorted = options.compareRoots ? roots.slice().sort(options.compareRoots) : roots;
  return rootsSorted.map((root) => buildNode(root, 0));

  function buildNode(session: T, level: number): SessionTreeNode<T> {
    const kids = childrenOf.get(session.id) ?? [];
    const sorted = options.compareChildren ? kids.slice().sort(options.compareChildren) : kids;
    return {
      session,
      level,
      children: sorted.map((child) => buildNode(child, level + 1))
    };
  }
}

/** 展平后的一行：会话 + 层级 + 直接父 id。 */
export interface FlatSessionRow<T extends SessionParentRef> {
  session: T;
  /** 0 = 顶层 */
  level: number;
  parentId: string | null;
}

export interface FlattenTreeOptions {
  /** 折叠的父 id 集合；命中的父其子树整枝跳过（父自身仍渲染） */
  collapsed?: ReadonlySet<string>;
  /**
   * 是否把子会话提升到顶层渲染（搜索过滤态用）。
   * 提升后按原 level 保留缩进量，避免层级感丢失。
   */
  promoteOrphans?: boolean;
}

/**
 * 展平为渲染序（深度优先，父在子前）。
 *
 * 父被折叠时子树跳过——注意是整枝跳过而非只跳一层：折叠的语义是
 * 「收起来」，孙层级不该从折叠的父下面冒出来。
 */
export function flattenSessionTree<T extends SessionParentRef>(
  forest: readonly SessionTreeNode<T>[],
  options: FlattenTreeOptions = {}
): Array<FlatSessionRow<T>> {
  const { collapsed } = options;
  const rows: Array<FlatSessionRow<T>> = [];
  const walk = (nodes: readonly SessionTreeNode<T>[], parentId: string | null): void => {
    for (const node of nodes) {
      rows.push({ session: node.session, level: node.level, parentId });
      if (collapsed?.has(node.session.id)) continue;
      walk(node.children, node.session.id);
    }
  };
  walk(forest, null);
  return rows;
}

/** 树中每个父 id 的直接子节点数（决定是否渲染 twisty）。 */
export function countChildSessions<T extends SessionParentRef>(
  forest: readonly SessionTreeNode<T>[]
): Map<string, number> {
  const map = new Map<string, number>();
  const walk = (nodes: readonly SessionTreeNode<T>[]): void => {
    for (const node of nodes) {
      if (node.children.length) map.set(node.session.id, node.children.length);
      walk(node.children);
    }
  };
  walk(forest);
  return map;
}

/**
 * 祖先链（自根到自身，含自身）。父不在索引内时链到此为止。
 *
 * 用于中栏的层级路径面包屑：子代理会话要能一路回跳到它的祖先。
 */
export function sessionAncestry<T extends SessionParentRef>(
  sessionId: string,
  byId: ReadonlyMap<string, T>
): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(sessionId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
  }
  return chain;
}

/** 指定会话及其所有后代，叶子在前；不跨到父/兄弟，坏数据成环时每个 id 只处理一次。 */
export function sessionSubtreePostOrder<T extends SessionParentRef>(sessions: readonly T[], rootId: string): T[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const children = new Map<string, T[]>();
  for (const s of sessions) {
    if (!s.parentSessionId) continue;
    const rows = children.get(s.parentSessionId) ?? [];
    rows.push(s); children.set(s.parentSessionId, rows);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    const row = byId.get(id);
    if (!row || seen.has(id)) return;
    seen.add(id);
    for (const child of children.get(id) ?? []) walk(child.id);
    result.push(row);
  };
  walk(rootId);
  return result;
}

/**
 * 环检测：若 parentSessionId 构成环，把环上**最靠后**的会话提升为顶层，
 * 使其余环成员能挂到它下面（而不是整环消失）。
 */
export function breakParentCycles<T extends SessionParentRef>(sessions: readonly T[]): T[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const broken = new Set<string>();
  for (const session of sessions) {
    if (broken.has(session.id)) continue;
    // 从该会话向上走，若回到自身则成环
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: SessionParentRef | undefined = session;
    let cycleStart: string | undefined;
    while (current?.parentSessionId) {
      if (onPath.has(current.id)) {
        cycleStart = current.id;
        break;
      }
      onPath.add(current.id);
      path.push(current.id);
      const next = byId.get(current.parentSessionId);
      if (!next) break;
      current = next;
      if (current.id === session.id) {
        cycleStart = session.id;
        break;
      }
    }
    if (cycleStart !== undefined) {
      // 环上除起点外的都指向环起点；把起点提升为顶层（去掉它的 parentSessionId）
      broken.add(cycleStart);
    }
  }
  if (broken.size === 0) return sessions.slice();
  return sessions.map((s) => (broken.has(s.id) ? { ...s, parentSessionId: undefined } : s));
}
