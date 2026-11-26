/**
 * Git repo path-tree pure functions self-test.
 * Run: node test/git-repo-tree.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'gitRepoTree.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-tree-'));
  const outFile = path.join(tmp, 'gitRepoTree.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const { buildGitRepoTree, flattenGitRepoTree, buildChainById, isInsideWorkspace } = await import(
  pathToFileURL(outFile).href
);

// 必须用真实 shared/pathKey（统一 `/`），不能自造 `\` 键——否则测不过「外部」误判回归
const pkEntry = path.join(root, 'src', 'shared', 'pathKey.ts');
const pkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-pk-'));
const pkOut = path.join(pkTmp, 'pathKey.mjs');
{
  const src = fs.readFileSync(pkEntry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: pkEntry
  });
  fs.writeFileSync(pkOut, outputText, 'utf8');
}
const { pathKey: pk } = await import(pathToFileURL(pkOut).href);

const ws = 'D:\\ws';

// Multiple roots keep separate folder identities, stable source IDs and nested repos.
{
  const sources = [{ id: 'a', path: 'D:/A', label: 'Same' }, { id: 'b /中文', path: 'E:/B', label: 'Same' },
    { id: 'nested', path: 'E:/B/src/nested', label: 'Nested' }];
  const repos = [{ path: 'D:/A/src/one', name: 'one', rootId: 'a', dirty: false },
    { path: 'E:/B/src/two', name: 'two', rootId: 'b /中文', dirty: false },
    { path: 'E:/B/src/linked', name: 'linked', rootId: 'b /中文', worktree: true, dirty: false },
    { path: 'E:/B/src/nested', name: 'nested', rootId: 'nested', dirty: false },
    { path: 'E:/tasks/one', name: 'task', worktree: true, dirty: false }];
  const tree = buildGitRepoTree({ repos, workspacePath: sources[0].path, workspaceRoots: sources, repoSort: 'name', pathKey: pk });
  assert.equal(tree.length, 3, 'linked checkouts do not add an external group');
  assert.deepEqual(tree.map(n => n.kind), ['source-root', 'source-root', 'repo']);
  assert.notEqual(tree[0].children[0].id, tree[1].children[0].id, 'same subfolder name in different roots must have different IDs');
  const chains = buildChainById(tree);
  assert.equal(chains.get('repo:' + pk('E:/B/src/two'))[0], 'source:"b /中文"');
  assert.deepEqual(chains.get('repo:' + pk('E:/B/src/nested')), ['repo:' + pk('E:/B/src/nested')], 'a source root and its checkout are one row');
  assert.equal(chains.has('repo:' + pk('E:/B/src/linked')), false);
  const all = flattenGitRepoTree(tree, new Set(chains.keys())).items;
  assert.equal(all.filter(n => n.node.kind === 'repo').length, 3);
  const reordered = buildGitRepoTree({ repos, workspacePath: sources[0].path, workspaceRoots: [sources[1], { ...sources[0], label: 'Renamed' }, sources[2]], repoSort: 'name', pathKey: pk });
  assert.equal(reordered[1].id, tree[0].id, 'rename/sort preserve the source identity');
  assert.equal(isInsideWorkspace('C:/repo', 'C:/', pk), true, 'volume root contains its repository');
}

{
  const roots = [{ id: 'linked', path: '/checkouts/linked' }, { id: 'source', path: '/source' }];
  const tree = buildGitRepoTree({ workspacePath: roots[0].path, workspaceRoots: roots, repoSort: 'name', pathKey: pk, repos: [
    { path: roots[0].path, rootId: 'linked', name: 'linked', worktree: true },
    { path: roots[1].path, rootId: 'source', name: 'source' }
  ] });
  assert.deepEqual(tree.map(node => node.absPath), ['/source'], 'a registered linked checkout does not leave a source root row');
}

// 1) 多层路径
const roots1 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\a\\b', name: 'b', dirty: false },
    { path: 'D:\\ws\\a\\c', name: 'c', dirty: false }
  ]
});
assert.equal(roots1.length, 1);
assert.equal(roots1[0].kind, 'folder');
assert.equal(roots1[0].label, 'a');
assert.equal(roots1[0].absPath, 'D:\\ws\\a');
assert.equal(roots1[0].children.length, 2);
assert.ok(roots1[0].children.every((n) => n.kind === 'repo'));
assert.deepEqual(
  roots1[0].children.map((n) => n.label).sort(),
  ['b', 'c']
);

// 2) 仓根 + 子仓合并为可展开 repo
const roots2 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\pkg', name: 'pkg', dirty: false },
    { path: 'D:\\ws\\pkg\\nested', name: 'nested', dirty: false }
  ]
});
assert.equal(roots2.length, 1);
assert.equal(roots2[0].kind, 'repo');
assert.equal(roots2[0].label, 'pkg');
assert.equal(roots2[0].children.length, 1);
assert.equal(roots2[0].children[0].kind, 'repo');
assert.equal(roots2[0].children[0].label, 'nested');
assert.ok(!roots2.some((n) => n.kind === 'folder' && n.label === 'pkg'));

// 3) 外部仓
const roots3 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\in', name: 'in', dirty: false },
    { path: 'E:\\other', name: 'other', dirty: false, manual: true }
  ]
});
assert.equal(roots3[0].kind, 'external-root');
assert.equal(roots3[0].label, '外部');
assert.equal(roots3[0].absPath, undefined);
assert.equal(roots3[0].children[0].absPath, 'E:\\other');
assert.ok(roots3.some((n) => n.kind === 'repo' && n.label === 'in'));

// 4) 搜索裁剪：调用方先过滤 repos；此处验证「只传匹配仓」仍保留祖先 folder
const roots4 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'name',
  pathKey: pk,
  repos: [{ path: 'D:\\ws\\a\\b', name: 'b', dirty: false }]
});
assert.equal(roots4[0].kind, 'folder');
assert.equal(roots4[0].children[0].label, 'b');

// 5) 同级：folder 在前；repo 按 dirty
const roots5 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'dirty',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\z-repo', name: 'z-repo', dirty: false },
    { path: 'D:\\ws\\a-repo', name: 'a-repo', dirty: true },
    { path: 'D:\\ws\\mid\\x', name: 'x', dirty: false }
  ]
});
assert.equal(roots5[0].kind, 'folder');
assert.equal(roots5[0].label, 'mid');
assert.equal(roots5[1].kind, 'repo');
assert.equal(roots5[1].label, 'a-repo');
assert.equal(roots5[2].label, 'z-repo');

// 6) absPath + flatten
const flat = flattenGitRepoTree(roots2, new Set(['repo:' + pk('D:\\ws\\pkg')]));
assert.ok(flat.rows.length >= 2);
assert.equal(flat.items.length, flat.rows.length);
assert.ok(flat.items[0].node.absPath);
assert.equal(flat.rows[0].expandable, true);
assert.equal(flat.items[0].depth, 0);
assert.equal(flat.items[1].depth, 1);

// chainById：每个可见节点都能查到从根到自身的 id 链路（含自身）。
// chainById 独立于 flatten（只依赖树结构），与 expanded 无关。
const chainById = buildChainById(roots2);
assert.ok(chainById.size >= flat.rows.length);
for (const item of flat.items) {
  const chain = chainById.get(item.node.id);
  assert.ok(chain, `chain missing for ${item.node.id}`);
  assert.equal(chain[chain.length - 1], item.node.id, `chain tail mismatch for ${item.node.id}`);
  // depth 与 chain 长度一致（depth=0 → chain.length=1）
  assert.equal(chain.length, item.depth + 1, `chain length mismatch for ${item.node.id}`);
}

// chainById 必须覆盖整棵树（含折叠节点），不局限于可见行——
// 选中折叠目录下的仓时仍需查链路展开祖先。
function collectAllIds(nodes) {
  const ids = [];
  const walk = (list) => {
    for (const n of list) {
      ids.push(n.id);
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}
const allIds = collectAllIds(roots2);
assert.ok(
  chainById.size >= allIds.length,
  `chainById (${chainById.size}) should cover all tree nodes (${allIds.length})`
);
for (const id of allIds) {
  assert.ok(chainById.has(id), `chainById missing collapsed node ${id}`);
}

assert.equal(isInsideWorkspace('D:\\ws\\a', ws, pk), true);
assert.equal(isInsideWorkspace('E:\\x', ws, pk), false);

// 7) 单源本身是 Git 仓库时，目录与嵌套仓都属于该行。
const roots7 = buildGitRepoTree({
  workspacePath: ws,
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\zebra\\kit', name: 'kit', dirty: false },
    { path: 'D:\\ws\\alpha', name: 'alpha', dirty: true },
    { path: 'D:\\ws', name: 'ws', dirty: false }
  ]
});
assert.equal(roots7.length, 1);
assert.equal(roots7[0].kind, 'repo');
assert.equal(roots7[0].label, 'ws');
assert.deepEqual(roots7[0].children.map(n => n.label), ['alpha', 'zebra']);
assert.equal(roots7[0].children[1].children[0].label, 'kit');
assert.deepEqual(flattenGitRepoTree(roots7, new Set(buildChainById(roots7).keys())).items.map(({ depth }) => depth), [0, 1, 1, 2]);

// 8) 模拟 Windows 比较键：盘符、父目录大小写混用也共用同一层级。
const roots8 = buildGitRepoTree({
  workspacePath: 'D:\\ws',
  repoSort: 'name',
  pathKey: p => pk(p).toLowerCase(),
  repos: [{ path: 'D:\\ws\\PKG\\child', name: 'child' }, { path: 'd:\\ws\\pkg', name: 'pkg', dirty: false }]
});
assert.equal(roots8.length, 1);
assert.equal(roots8[0].kind, 'repo');
assert.equal(roots8[0].label, 'pkg');
assert.equal(roots8[0].children[0].label, 'child');

const posixRoots = buildGitRepoTree({ workspacePath: '/project', repoSort: 'name', pathKey: p => p,
  repos: [{ path: '/project/Module', name: 'Module' }, { path: '/project/module/nested', name: 'nested' }] });
assert.equal(posixRoots.length, 2, 'case-sensitive source paths stay distinct');

// 9) workspace 尾部反斜杠仍能正确嵌套子仓
const roots9 = buildGitRepoTree({
  workspacePath: 'D:\\ws\\\\',
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\ws\\a\\b', name: 'b', dirty: false },
    { path: 'D:\\ws\\a\\c', name: 'c', dirty: false }
  ]
});
assert.equal(roots9.length, 1);
assert.equal(roots9[0].kind, 'folder');
assert.equal(roots9[0].label, 'a');
assert.equal(roots9[0].children.length, 2);

// 10) 回归：真实 pathKey（`/`）时，工作区内仓不得进「外部」
const roots10 = buildGitRepoTree({
  workspacePath: 'D:\\MetaApp',
  repoSort: 'name',
  pathKey: pk,
  repos: [
    { path: 'D:\\MetaApp\\tools\\a', name: 'a', dirty: false },
    { path: 'E:\\outside\\b', name: 'b', dirty: false, manual: true }
  ]
});
assert.equal(roots10[0].kind, 'external-root');
assert.equal(roots10[0].children.length, 1);
assert.equal(roots10[0].children[0].label, 'b');
assert.equal(roots10[1].kind, 'folder');
assert.equal(roots10[1].label, 'tools');
assert.equal(isInsideWorkspace('D:\\MetaApp\\tools\\a', 'D:\\MetaApp', pk), true);

assert.deepEqual(buildGitRepoTree({ workspacePath: '/source', repoSort: 'name', pathKey: pk, repos: [
  { path: '/source/linked', name: 'linked', worktree: true },
  { path: '/managed/task', name: 'task', worktree: true },
  { path: '/managed/task/Plugins/Same', name: 'Same', worktree: true }
] }), [], 'linked checkouts leave no placeholder folders or worktree groups');

// 11) 插入顺序无关：子仓先列、父仓后列仍嵌套。
{
  const nested = [
    { path: 'D:\\ws\\parent\\child', name: 'child', dirty: false },
    { path: 'D:\\ws\\parent', name: 'parent', dirty: false }
  ];
  const roots = buildGitRepoTree({ workspacePath: 'D:\\ws', repoSort: 'name', pathKey: pk, repos: nested });
  assert.equal(roots.length, 1, 'parent repo appears exactly once (no duplicate folder entry)');
  assert.equal(roots[0].kind, 'repo');
  assert.equal(roots[0].label, 'parent');
  assert.ok(roots[0].expandable, 'parent repo is expandable with nested child');
  assert.equal(roots[0].children.length, 1);
  assert.equal(roots[0].children[0].repo?.name, 'child');
  // 乱序输入与正序输入产出同构树
  const ordered = buildGitRepoTree({ workspacePath: 'D:\\ws', repoSort: 'name', pathKey: pk,
    repos: [nested[1], nested[0]] });
  assert.deepEqual(
    flattenGitRepoTree(roots, new Set()).rows,
    flattenGitRepoTree(ordered, new Set()).rows
  );
}

// 隐藏父仓只移除 Git 身份。根仓和嵌套父仓都保留原地开合及子仓路径。
{
  const workspacePath = '/source';
  const parent = '/source/packages';
  const child = '/source/packages/toolbox';
  const leaf = '/source/leaf';
  const repos = [workspacePath, parent, child, leaf].map(repoPath => ({
    path: repoPath, name: path.basename(repoPath), dirty: true
  }));
  const opts = { workspacePath, repos, repoSort: 'dirty', pathKey: pk };
  const before = buildGitRepoTree(opts);
  const expanded = new Set(buildChainById(before).keys());
  const hiddenRepoKeys = new Set([workspacePath, parent, leaf].map(pk));
  const after = buildGitRepoTree({ ...opts, hiddenRepoKeys });
  const visible = flattenGitRepoTree(after, expanded).items;
  assert.deepEqual(visible.map(({ node, depth }) => [node.absPath, node.kind, depth]), [
    [workspacePath, 'folder', 0], [parent, 'folder', 1], [child, 'repo', 2]
  ]);
  assert.equal(visible[0].node.repo, undefined);
  assert.equal(visible[1].node.repo, undefined);
  const childId = `repo:${pk(child)}`;
  assert.deepEqual(buildChainById(after).get(childId), buildChainById(before).get(childId));
  assert.deepEqual(buildGitRepoTree({ ...opts, hiddenRepoKeys: new Set(repos.map(repo => pk(repo.path))) }), []);

  const workspaceRoots = [{ id: 'a', path: workspacePath, label: 'Project' }, { id: 'b', path: '/other' }];
  const multi = buildGitRepoTree({ ...opts, workspaceRoots, hiddenRepoKeys });
  assert.deepEqual(multi.map(node => [node.label, node.kind]), [['Project', 'source-root'], ['other', 'source-root']]);
  assert.deepEqual(buildChainById(multi).get(childId), buildChainById(after).get(childId));
}

console.log('git-repo-tree: ok');
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(pkTmp, { recursive: true, force: true });
