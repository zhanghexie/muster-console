/**
 * 泳道布局（SourceTree / GitHub Desktop / devframe 同款）。
 * 输入须为 topo 序（子在前、父在后，即 git log --topo-order）。
 */

export interface GraphInput {
  hash: string;
  parents: string[];
}

export interface GraphLink {
  from: number;
  to: number;
  color: string;
}

export interface GraphRow {
  col: number;
  color: string;
  topLinks: GraphLink[];
  bottomLinks: GraphLink[];
}

export interface CommitGraphLayout {
  rows: GraphRow[];
  columns: number;
}

/* 泳道色板：只用既有 token（design.md §10 Git 面板——graph 线条用 --text-3 与状态色，不引入新色）。
 * SVG 内联渲染可直接消费 CSS 变量；分支胶囊的 borderColor/color 同样兼容。 */
const GRAPH_COLORS = [
  'var(--blue)',
  'var(--yellow)',
  'var(--red)',
  'var(--purple)',
  'var(--green)',
  'var(--text-3)'
];

interface Lane {
  hash: string;
  color: string;
}

/** 可恢复的增量计算状态：lanes 数组 + 下一个颜色索引。用于 appendCommits 续算。 */
export interface GraphIncrementalState {
  lanes: (Lane | null)[];
  colorIndex: number;
}

export function emptyGraphState(): GraphIncrementalState {
  return { lanes: [], colorIndex: 0 };
}

/**
 * 全量计算（初始化用）。输入须为 topo 序。
 * 翻页追加场景请用 appendCommits，避免对全部历史重算。
 */
export function computeGraph(commits: GraphInput[]): CommitGraphLayout {
  const state = emptyGraphState();
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    rows.push(appendRow(commit, state));
  }
  return { rows, columns: computeColumns(rows) };
}

/**
 * 增量追加 commits：复用上次的 lanes 状态，只对新 commit 生成新行。
 * 返回新增的 rows 与更新后的状态，调用方负责 append 到已有 rows。
 */
export function appendCommits(
  commits: GraphInput[],
  prevState: GraphIncrementalState
): { newRows: GraphRow[]; state: GraphIncrementalState } {
  // 复制状态，避免外部持有的 prevState 被污染（多次 append 同一基线时安全）
  const state: GraphIncrementalState = {
    lanes: prevState.lanes.slice(),
    colorIndex: prevState.colorIndex
  };
  const newRows: GraphRow[] = [];
  for (const commit of commits) {
    newRows.push(appendRow(commit, state));
  }
  return { newRows, state };
}

function appendRow(commit: GraphInput, state: GraphIncrementalState): GraphRow {
  const lanes = state.lanes;
  const nextColor = () => GRAPH_COLORS[state.colorIndex++ % GRAPH_COLORS.length];
  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  const { hash } = commit;
  const parents = commit.parents;

  const incoming: { col: number; hash: string; color: string }[] = [];
  for (let k = 0; k < lanes.length; k++) {
    const lane = lanes[k];
    if (lane) incoming.push({ col: k, hash: lane.hash, color: lane.color });
  }

  let col = lanes.findIndex((l) => l?.hash === hash);
  let color: string;
  if (col === -1) {
    col = firstFree();
    color = nextColor();
  } else {
    color = lanes[col]!.color;
  }

  for (let k = 0; k < lanes.length; k++) {
    if (lanes[k]?.hash === hash) lanes[k] = null;
  }
  lanes[col] = null;

  const parentCols: { col: number; color: string }[] = [];
  parents.forEach((parent, index) => {
    if (index === 0) {
      lanes[col] = { hash: parent, color };
      parentCols.push({ col, color });
      return;
    }
    let pc = lanes.findIndex((l) => l?.hash === parent);
    if (pc === -1) {
      pc = firstFree();
      lanes[pc] = { hash: parent, color: nextColor() };
    }
    parentCols.push({ col: pc, color: lanes[pc]!.color });
  });
  if (parents.length === 0) lanes[col] = null;

  while (lanes.length > 0 && lanes[lanes.length - 1] == null) lanes.pop();

  const topLinks: GraphLink[] = incoming.map((lane) => ({
    from: lane.col,
    to: lane.hash === hash ? col : lane.col,
    color: lane.color
  }));

  const bottomLinks: GraphLink[] = [];
  for (const lane of incoming) {
    if (lane.hash !== hash) {
      bottomLinks.push({ from: lane.col, to: lane.col, color: lane.color });
    }
  }
  for (const parent of parentCols) {
    bottomLinks.push({ from: col, to: parent.col, color: parent.color });
  }

  return { col, color, topLinks, bottomLinks };
}

function computeColumns(rows: GraphRow[]): number {
  let columns = 0;
  for (const row of rows) {
    columns = Math.max(columns, row.col + 1);
    for (const link of row.topLinks) {
      columns = Math.max(columns, link.from + 1, link.to + 1);
    }
    for (const link of row.bottomLinks) {
      columns = Math.max(columns, link.from + 1, link.to + 1);
    }
  }
  return columns;
}
