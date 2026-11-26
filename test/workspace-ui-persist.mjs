/**
 * workspace.json UI 持久化字段：解析/夹紧 + merge 缺省 + App/面板接线守卫。
 * 虚拟屏页位本机存储行为另见 test/unit/virtual-screen-page-preference.spec.ts。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ui-persist-'));
const compile = createSharedCompiler(root, compileTmp);

const persist = await import(pathToFileURL(compile('shared/workspaceUiPersist.ts')).href);
const {
  parseHDock,
  visualHDock,
  parseHiddenView,
  cycleHiddenViewExcludeInclude,
  toggleHiddenViewOnly,
  clampSplitRatio,
  FILES_SPLIT_RATIO_DEFAULT,
  GIT_REPO_SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_MAX
} = persist;

assert.equal(parseHDock('git'), 'git');
assert.equal(parseHDock('terminal'), 'terminal');
assert.equal(parseHDock('browser'), 'terminal');
assert.equal(parseHDock(undefined), 'terminal');

assert.equal(
  visualHDock({ stored: 'git', hVirtualScreen: true, focusMode: false }),
  'git'
);
assert.equal(
  visualHDock({ stored: 'git', hVirtualScreen: false, focusMode: false }),
  'terminal',
  'VS 关闭时视觉钳到终端页，避免 Git 页宽 0 却标成当前页'
);
assert.equal(
  visualHDock({ stored: 'git', hVirtualScreen: true, focusMode: true }),
  'terminal',
  '专注布局视觉钳到终端页'
);
assert.equal(
  visualHDock({ stored: 'terminal', hVirtualScreen: true, focusMode: false }),
  'terminal'
);

assert.equal(parseHiddenView('only'), 'only');
assert.equal(parseHiddenView('include'), 'include');
assert.equal(parseHiddenView('exclude'), 'exclude');
assert.equal(parseHiddenView('nope'), 'exclude');
assert.equal(cycleHiddenViewExcludeInclude('exclude'), 'include');
assert.equal(cycleHiddenViewExcludeInclude('include'), 'exclude');
assert.equal(cycleHiddenViewExcludeInclude('only'), 'exclude');
assert.equal(toggleHiddenViewOnly('include'), 'only');
assert.equal(toggleHiddenViewOnly('only'), 'include');

assert.equal(clampSplitRatio(0.4, 0.28), 0.4);
assert.equal(clampSplitRatio(0.01, 0.28), SPLIT_RATIO_MIN);
assert.equal(clampSplitRatio(0.99, 0.28), SPLIT_RATIO_MAX);
assert.equal(clampSplitRatio('x', FILES_SPLIT_RATIO_DEFAULT), FILES_SPLIT_RATIO_DEFAULT);
assert.equal(clampSplitRatio(NaN, GIT_REPO_SPLIT_RATIO_DEFAULT), GIT_REPO_SPLIT_RATIO_DEFAULT);

// R-21 调度分组展开态（schedulerGroupOpen）已随左栏版/看板分组版整体移除：
// 两版都不再折叠，字段解析/落盘/接线全链删除（看板状态卡版无持久化 UI 态）

const { mergeWorkspaceDefaults, patchWorkspaceFile, readWorkspaceFile } = await import(
  pathToFileURL(compile('main/metaAgent/workspaceFile.ts')).href
);

const merged = mergeWorkspaceDefaults({ sideToolsTab: 'git' });
assert.equal(merged.hDock, undefined);
assert.equal(merged.filesSplitRatio, 0.28);
assert.equal(merged.git.hiddenView, 'exclude');
assert.equal(merged.git.repoListSplitRatio, 0.28);
assert.equal(merged.sideToolsTab, 'git');

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ui-root-'));
const written = patchWorkspaceFile(wsRoot, {
  hDock: 'git',
  filesSplitRatio: 0.42,
  git: { hiddenView: 'only', repoListSplitRatio: 0.33 }
});
assert.equal(written.hDock, 'git');
assert.equal(written.filesSplitRatio, 0.42);
assert.equal(written.git.hiddenView, 'only');
assert.equal(written.git.repoListSplitRatio, 0.33);
// schedulerGroupOpen 已删字段：merge/patch 不再写、回读不带（旧盘残留靠类型缺省忽略）
const writtenNoGroup = patchWorkspaceFile(wsRoot, { focusMode: true });
assert.equal('schedulerGroupOpen' in writtenNoGroup, false);
assert.equal('schedulerGroupOpen' in writtenNoGroup.git, false);
const reread = readWorkspaceFile(wsRoot);
assert.equal(reread.hDock, 'git', '旧版页位保留给无本机偏好的读取方');
assert.equal(reread.git.hiddenView, 'only');

const appSrc = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8');
assert.match(appSrc, /visualHDock\(/, 'App 必须用 visualHDock hydrate 当前页');
assert.match(appSrc, /loadVirtualScreenPage\(wsFileWorkspaceId, cfg\.hDock\)/, 'App 水合应优先读取本机页位');
assert.match(appSrc, /loadVirtualScreenPage\(id, config\.hDock\)/, '工作区过场应使用目标工作区的本机页位');
assert.doesNotMatch(appSrc, /patchWsFile\(\{[^}]*\bhDock\s*:/, 'App 布局补丁不能写入旧页位');
assert.match(
  appSrc,
  /if \(!focusMode\) saveWorkspacePage\(dock\)/,
  '专注期间不得改写保存的页位'
);

// 2026-09-26 GitPanel 拆分：prefs 水合/写盘在 gitpanel/useGitPrefs.ts，SplitPane 落盘在 gitpanel/GitPanelCore.tsx
const gitPrefsSrc = fs.readFileSync(
  path.join(root, 'src/renderer/src/panels/gitpanel/useGitPrefs.ts'),
  'utf8'
);
assert.match(gitPrefsSrc, /parseHiddenView\(git\.hiddenView\)/, 'Git 面板必须从 workspace.json hydrate hiddenView');
assert.match(gitPrefsSrc, /git:\s*\{\s*hiddenView/, 'Git 面板必须 patch hiddenView');
const gitCoreSrc = fs.readFileSync(
  path.join(root, 'src/renderer/src/panels/gitpanel/GitPanelCore.tsx'),
  'utf8'
);
assert.match(gitCoreSrc, /repoListSplitRatio/, 'Git 仓列表 SplitPane 必须落盘 repoListSplitRatio');

const filesSrc = fs.readFileSync(path.join(root, 'src/renderer/src/panels/FilesPanel.tsx'), 'utf8');
assert.match(filesSrc, /filesSplitRatio/, 'Files 面板必须落盘 filesSplitRatio');

// R-21 重做（看板状态卡版）：左栏调度分组已整体移除——LeftPanel 不得残留任何
// 分组接线（SchedulerGroupEntry / schedulerGroupOpen / parseSchedulerGroupOpen）
const leftSrc = fs.readFileSync(path.join(root, 'src/renderer/src/panels/LeftPanel.tsx'), 'utf8');
assert.doesNotMatch(
  leftSrc,
  /SchedulerGroupEntry|schedulerGroupOpen|parseSchedulerGroupOpen|scheduler-group/,
  '左栏调度分组接线已删干净：不得残留分组条目/持久化字段/样式类'
);
// 字段整链删除：共享解析器与 workspace.json 配置类型不得再有 schedulerGroupOpen
const persistSrc = fs.readFileSync(
  path.join(root, 'src/shared/workspaceUiPersist.ts'),
  'utf8'
);
assert.doesNotMatch(persistSrc, /schedulerGroupOpen/, 'parseSchedulerGroupOpen 应已删除');
const metaAgentSrc = fs.readFileSync(path.join(root, 'src/shared/metaAgent.ts'), 'utf8');
assert.doesNotMatch(
  metaAgentSrc,
  /schedulerGroupOpen/,
  'WorkspaceFileConfig.schedulerGroupOpen 应已删除'
);
