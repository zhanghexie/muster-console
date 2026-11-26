/**
 * dev-sandbox 固定测试仓库与预置状态的在机校验。
 * 收编自 test/ui-sandbox.mjs 的 CDP 分支（原脚本需手动起 app + 9222）。
 * 断言内容与原脚本一致：沙箱生效、3 个 demo 仓库、Git 分支、富媒体资产、
 * 预置会话胶囊（active/done/waiting/error）、脏写 + 一键重置还原。
 */
import { test, expect } from './fixtures/electron';

test.describe.configure({ mode: 'serial' });

test('渲染层处于沙箱模式且工作区列表含 3 个 demo 仓库', async ({ appCtx }) => {
  const { win } = appCtx;
  const sandboxInfo = await win.evaluate(() => (window as any).api.sandbox.getInfo());
  expect(sandboxInfo?.enabled, `sandboxInfo=${JSON.stringify(sandboxInfo)}`).toBe(true);

  const wsList = await win.evaluate(() => (window as any).api.workspaces.list());
  const ids = wsList.workspaces.map((w: { id: string }) => w.id);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  for (const id of ['demo-playground', 'demo-frontend', 'demo-backend']) {
    expect(ids, `workspaces=${ids}`).toContain(id);
  }
});

test('demo-frontend 可切换并读取多分支（main + feature/dark-mode）', async ({ appCtx }) => {
  const { win } = appCtx;
  const wsList = await win.evaluate(() => (window as any).api.workspaces.list());
  const fePath = wsList.workspaces.find((w: { id: string }) => w.id === 'demo-frontend').path;

  const switchRes = await win.evaluate(
    (id) => (window as any).api.workspaces.switch(id),
    'demo-frontend'
  );
  expect(switchRes.ok).toBe(true);
  expect(switchRes.activeWorkspaceId).toBe('demo-frontend');

  // GitBranchList 形状：{current, local[], remote[]}（失败会 reject）
  const branches = await win.evaluate(
    (p) => (window as any).api.git.listBranches(p),
    fePath
  );
  expect(branches?.current).toBeTruthy();
  const names = branches.local.map((b: { name: string }) => b.name);
  expect(names).toContain('main');
  expect(names).toContain('feature/dark-mode');
});

test('demo-playground 多格式文件与富媒体资产可读', async ({ appCtx }) => {
  const { win } = appCtx;
  await win.evaluate((id) => (window as any).api.workspaces.switch(id), 'demo-playground');

  const readTs = await win.evaluate(
    ({ ws, rel }) => (window as any).api.fs.readText(ws, rel),
    { ws: 'demo-playground', rel: 'src/index.ts' }
  );
  expect(readTs.ok).toBe(true);
  expect(readTs.content).toContain('runDemo');

  const readHtml = await win.evaluate(
    ({ ws, rel }) => (window as any).api.fs.readText(ws, rel),
    { ws: 'demo-playground', rel: 'docs/dashboard.html' }
  );
  expect(readHtml.ok).toBe(true);
  expect(readHtml.content).toContain('canvas');

  const statCases: Array<[string, string]> = [
    ['docs/architecture-report.pdf', 'PDF'],
    ['assets/demo-screencast.webm', 'WebM'],
    ['assets/notification-chime.wav', 'WAV'],
    ['assets/workbench-architecture.svg', 'SVG']
  ];
  for (const [rel, label] of statCases) {
    const stat = await win.evaluate(
      ({ ws, r }) => (window as any).api.fs.stat(ws, r),
      { ws: 'demo-playground', r: rel }
    );
    expect(stat.ok && stat.isFile && stat.size > 0, `${label} ${rel}`).toBe(true);
  }
});

test('预置多会话覆盖全部业务胶囊状态', async ({ appCtx }) => {
  const list = await appCtx.win.evaluate(() => (window as any).api.sessions.list());
  const kinds = list.sessions.map((s: { liveStatus?: { kind?: string } }) => s.liveStatus?.kind);
  expect(list.sessions.length).toBeGreaterThanOrEqual(4);
  for (const kind of ['active', 'done', 'waiting', 'error']) {
    expect(kinds, `kinds=${kinds}`).toContain(kind);
  }
});

test('脏写后一键沙箱重置恢复基准', async ({ appCtx }) => {
  const { win } = appCtx;
  await win.evaluate(
    ({ ws, rel, content }) => (window as any).api.fs.writeText(ws, rel, content),
    { ws: 'demo-playground', rel: 'src/index.ts', content: '// dirty test data' }
  );
  const dirty = await win.evaluate(
    ({ ws, rel }) => (window as any).api.fs.readText(ws, rel),
    { ws: 'demo-playground', rel: 'src/index.ts' }
  );
  expect(dirty.content).toBe('// dirty test data');

  const resetRes = await win.evaluate(
    (opts) => (window as any).api.sandbox.reset(opts),
    { cleanWorkspaces: true }
  );
  expect(resetRes.ok).toBe(true);

  const restored = await win.evaluate(
    ({ ws, rel }) => (window as any).api.fs.readText(ws, rel),
    { ws: 'demo-playground', rel: 'src/index.ts' }
  );
  expect(restored.content).toContain('runDemo');
});
