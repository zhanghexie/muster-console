/**
 * pi 工作区 context 文件扫描（政策层去重门的数据源，prompt.ts pi 分支专用）。
 *
 * 复刻 pi resource-loader 的加载规则（@earendil-works/pi-coding-agent
 * dist/core/resource-loader.js loadProjectContextFiles）：cwd 逐级向上、每目录按
 * 候选序取第一个存在的文件——AGENTS.override.md > AGENTS.md > AGENTS.MD >
 * CLAUDE.md > CLAUDE.MD。与 pi 的两处已知差异（均不影响判定结果，见 fail-open）：
 * - 不实现嵌套 worktree 阴影剔除（findShadowedContextFile）：隔离 worktree 与主仓
 *   同仓，两边托管段同渲染出口同内容，任一被加载判定一致；
 * - agentDir 全局档（userData/agents/pi/home）为 app 自有隔离目录、不落 context
 *   文件，不在扫描范围；若未来手工放置，fail-open 侧只会多注入不会丢。
 *
 * 零 electron 依赖（test/*.mjs 即时转译导入）；任何读取异常一律 fail-open——
 * 去重门宁可回到「政策层重复注入」，绝不静默丢规约。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 与 pi resource-loader candidates 同序同集 */
const CONTEXT_CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD'
] as const;

/** cwd 逐级向上到盘根，每目录取第一个存在的 context 文件（自近及远） */
export function collectPiContextFiles(cwd: string): string[] {
  const files: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of CONTEXT_CANDIDATES) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          files.push(full);
          break;
        }
      } catch {
        /* stat 失败视同不存在，试下一候选 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/**
 * 规约去重门：pi 将内联的 context 文件中是否已含**逐字一致**的全局行为规约节。
 * 逐字匹配（同渲染出口 renderAgentRulesSection 的产物）而非仅认标题——托管段
 * stale（设置改了规约、AGENTS.md 尚未重写）时返回 false，政策层照旧注入。
 * rulesSection 为空（无启用规则）返回 false（无规约即无去重可言）。
 */
export function contextHasRulesText(cwd: string, rulesSection: string): boolean {
  if (!rulesSection.trim()) return false;
  for (const file of collectPiContextFiles(cwd)) {
    try {
      if (fs.readFileSync(file, 'utf8').includes(rulesSection)) return true;
    } catch {
      /* 读失败换下一个；全失败 = false = 政策层照旧注入 */
    }
  }
  return false;
}
