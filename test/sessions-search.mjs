/**
 * sessions.search：按路径/关键词/提交命中、无命中、只读、跨区范围。
 * 运行: node test/sessions-search.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(root, '.tmp');
fs.mkdirSync(tempRoot, {recursive:true});
const tmp = fs.mkdtempSync(path.join(tempRoot, 'sessions-search-'));
const compile = createSharedCompiler(root, tmp);
  // This integration import graph uses both WS default and named ESM exports;
  // the pure shared compiler's CJS default-only shim cannot provide the latter.
  const require=createRequire(import.meta.url);
  const wsDir=path.join(tmp,'node_modules','ws');
  fs.writeFileSync(path.join(wsDir,'package.json'),JSON.stringify({name:'ws',type:'module',main:'index.mjs'}));
  fs.writeFileSync(path.join(wsDir,'index.mjs'),`import ws from ${JSON.stringify(pathToFileURL(require.resolve('ws')).href)};
    export default ws;export const WebSocket=ws.WebSocket,WebSocketServer=ws.WebSocketServer;`);

  // Main-process fixtures can import electron before the scheduler-specific
  // assertions below, so seed the native-module shim before the first load.
  const electronDir = path.join(tmp, 'node_modules/electron'); fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electronDir, 'index.mjs'), `
    export const app = {getPath:()=>${JSON.stringify(tmp)}};
    const unavailable = new Proxy({}, {get(_target,key){throw new Error('Search fixture must not use Electron '+String(key));}});
    // Complete runtime named-import set from src/main Electron imports. Every
    // capability remains fail-closed if observation unexpectedly invokes it.
    export const BrowserWindow=unavailable,Menu=unavailable,Notification=unavailable,Tray=unavailable,
      clipboard=unavailable,crashReporter=unavailable,desktopCapturer=unavailable,dialog=unavailable,ipcMain=unavailable,
      nativeImage=unavailable,nativeTheme=unavailable,net=unavailable,powerMonitor=unavailable,powerSaveBlocker=unavailable,
      protocol=unavailable,safeStorage=unavailable,screen=unavailable,session=unavailable,shell=unavailable,webContents=unavailable;
  `);


const {
  parseSessionSearchQuery,
  parseSessionSearchScope,
  sessionBelongsToSearchScope,
  buildSessionHaystack,
  searchSessionDocs,
  haystackMatchesPath,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_HAYSTACK_MAX
} = await import(pathToFileURL(compile('shared/sessionSearch.ts')).href);

const { sessionsHost } = await import(
  pathToFileURL(compile('main/capabilities/hosts/sessions.ts')).href
);

const { CATALOG_VERSION, getToolDef, WORKER_TOOL_ALLOWLIST } = await import(
  pathToFileURL(compile('main/capabilities/catalog.ts')).href
);

assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);
assert.ok(getToolDef('sessions.search'));
assert.equal(WORKER_TOOL_ALLOWLIST.includes('sessions.search'), true);
assert.equal(getToolDef('sessions.search').dangerous, false);

const sha = 'a1b2c3d4e5f6789012345678901234567890abcd';

function msg(text, extraParts = []) {
  return { parts: [{ kind: 'text', text }, ...extraParts] };
}

const pathDoc = {
  sessionId: 'se-path',
  name: '改 catalog',
  workspaceId: 'ws-1',
  workspaceName: '仓甲',
  createdAt: 100,
  lastUsedAt: 300,
  runtime: 'cursor',
  haystack: buildSessionHaystack({
    name: '改 catalog',
    cwd: 'E:/ws/proj',
    worktreePath: 'E:/ws/proj/.worktrees/ao-path',
    messages: [
      msg('请改 src/main/capabilities/catalog.ts 的版本号'),
      {
        parts: [
          {
            kind: 'tool',
            tool: {
              id: 't1',
              name: 'edit',
              input: { path: 'src/main/capabilities/catalog.ts' },
              status: 'ok',
              output: 'ok'
            }
          }
        ]
      }
    ]
  })
};

const keywordDoc = {
  sessionId: 'se-kw',
  name: '修 compact 分割线',
  workspaceId: 'ws-1',
  createdAt: 110,
  lastUsedAt: 250,
  haystack: buildSessionHaystack({
    name: '修 compact 分割线',
    messages: [msg('上下文已压缩后分割线常驻底部')]
  })
};

const commitDoc = {
  sessionId: 'se-commit',
  name: '对账提交',
  workspaceId: 'ws-2',
  workspaceName: '仓乙',
  createdAt: 90,
  lastUsedAt: 400,
  archived: true,
  haystack: buildSessionHaystack({
    name: '对账提交',
    worktreeBranch: 'ao/se-commit',
    messages: [msg(`合入基线 ${sha} 后 typecheck 绿`)]
  })
};

const otherDoc = {
  sessionId: 'se-other',
  name: '无关会话',
  workspaceId: 'ws-1',
  createdAt: 80,
  lastUsedAt: 200,
  haystack: buildSessionHaystack({
    name: '无关会话',
    messages: [msg('今天天气不错')]
  })
};

const docs = [pathDoc, keywordDoc, commitDoc, otherDoc];
const frozen = JSON.stringify(docs);

// ---------------------------------------------------------------------------
// 路径命中（正文 + 工具入参；反斜杠等价）
// ---------------------------------------------------------------------------
{
  const hits = searchSessionDocs(docs, parseSessionSearchQuery({ path: 'src/main/capabilities/catalog.ts' }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'se-path');
  assert.deepEqual(hits[0].matchedBy, ['path']);
  assert.match(hits[0].summary, /catalog\.ts/);
  assert.equal(hits[0].workspaceName, '仓甲');

  const slash = searchSessionDocs(docs, parseSessionSearchQuery({ path: 'src\\main\\capabilities\\catalog.ts' }));
  assert.equal(slash[0].sessionId, 'se-path');

  const base = searchSessionDocs(docs, parseSessionSearchQuery({ path: 'catalog.ts' }));
  assert.ok(base.some((h) => h.sessionId === 'se-path'));
  assert.equal(JSON.stringify(docs), frozen, '只读：不改源文档');
  console.log('ok: 路径命中');
}

assert.equal(haystackMatchesPath('E:\\ws\\proj\\src\\foo.ts', 'src/foo.ts'), true);

// ---------------------------------------------------------------------------
// 关键词命中
// ---------------------------------------------------------------------------
{
  const hits = searchSessionDocs(docs, parseSessionSearchQuery({ q: '分割线常驻' }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'se-kw');
  assert.deepEqual(hits[0].matchedBy, ['keyword']);
  assert.equal(JSON.stringify(docs), frozen, '只读：关键词检索不改源');
  console.log('ok: 关键词命中');
}

// ---------------------------------------------------------------------------
// 提交命中（短 SHA）+ 归档仍可查
// ---------------------------------------------------------------------------
{
  const hits = searchSessionDocs(docs, parseSessionSearchQuery({ commit: sha.slice(0, 7) }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'se-commit');
  assert.equal(hits[0].archived, true);
  assert.deepEqual(hits[0].matchedBy, ['commit']);
  const short = parseSessionSearchQuery({ commit: 'abc' });
  assert.equal(short.error, 'short-commit', 'session-search F-01：1–6 位 commit 入口报 short-commit（不再静默零命中）');
  assert.equal(parseSessionSearchQuery({ commit: 'abcdef' }).error, 'short-commit');
  assert.equal(parseSessionSearchQuery({ commit: sha.slice(0, 7) }).commit, sha.slice(0, 7), '恰 7 位照常通过');
  console.log('ok: 提交命中');
}

// ---------------------------------------------------------------------------
// 无命中 + 多条件交集
// ---------------------------------------------------------------------------
{
  assert.equal(searchSessionDocs(docs, parseSessionSearchQuery({ q: '不存在的词xyz' })).length, 0);
  const both = searchSessionDocs(
    docs,
    parseSessionSearchQuery({ path: 'catalog.ts', q: '天气' })
  );
  assert.equal(both.length, 0, '多条件取交集');
  const andHit = searchSessionDocs(
    docs,
    parseSessionSearchQuery({ path: 'catalog.ts', q: '版本号' })
  );
  assert.equal(andHit.length, 1);
  assert.deepEqual(andHit[0].matchedBy, ['path', 'keyword']);
  console.log('ok: 无命中与交集');
}

{
  const empty = parseSessionSearchQuery({});
  assert.equal(empty.error, 'empty');
  assert.equal(parseSessionSearchQuery({ q: 'x' }).limit, SESSION_SEARCH_DEFAULT_LIMIT);
  assert.equal(parseSessionSearchScope(undefined, 'ws-1'), 'ws-1');
  assert.equal(parseSessionSearchScope('*', 'ws-1'), '*');
  assert.equal(parseSessionSearchScope('all', 'ws-1'), '*');
  assert.equal(sessionBelongsToSearchScope('ws-2', '*', 'ws-1'), true);
  assert.equal(sessionBelongsToSearchScope('ws-2', 'ws-1', 'ws-1'), false);
  console.log('ok: 查询与范围解析');
}

// ---------------------------------------------------------------------------
// handler：路径命中 / 默认本区不串台 / * 跨区 / 只读
// ---------------------------------------------------------------------------
const writes = [];
const store = new Map([
  [
    'se-path',
    {
      id: 'se-path',
      name: '改 catalog',
      type: 'terminal',
      runtime: 'cursor',
      workspaceId: 'ws-1',
      createdAt: 100,
      lastUsedAt: 300,
      cwd: 'E:/ws/proj',
      archived: false
    }
  ],
  [
    'se-commit',
    {
      id: 'se-commit',
      name: '对账提交',
      type: 'terminal',
      runtime: 'cursor',
      workspaceId: 'ws-2',
      createdAt: 90,
      lastUsedAt: 400,
      archived: true
    }
  ],
  [
    'se-pty',
    {
      id: 'se-pty',
      name: '终端工人',
      type: 'terminal',
      runtime: 'cursor-cli',
      workspaceId: 'ws-1',
      createdAt: 70,
      lastUsedAt: 180,
      cwd: 'E:/ws/proj',
      archived: false
    }
  ]
]);

const getHistoryCalls = [];

function mockCtx() {
  return {
    resolveBubbleWorkspaceId: () => 'ws-1',
    workspaces: {
      list: () => [
        { id: 'ws-1', name: '仓甲', path: 'E:/ws/proj' },
        { id: 'ws-2', name: '仓乙', path: 'E:/other' }
      ]
    },
    sessions: {
      list: () => [...store.values()],
      isChatRuntime: (runtime) => runtime === 'cursor' || runtime === 'pi',
      select: (id) => writes.push({ kind: 'select', id }),
      get: (id) => store.get(id)
    },
    agentSessions: {
      getHistory: () => { throw new Error('full history forbidden'); },
      getHistoryRange: (id, before, limit) => {
        getHistoryCalls.push({ id, before, limit });
        const messages = id === 'se-path' ? [msg('请改 src/main/capabilities/catalog.ts')]
          : id === 'se-commit' ? [msg(`合入基线 ${sha}`)] : [];
        const end = Math.min(before ?? messages.length, messages.length), start = Math.max(0, end - limit);
        return { messages: messages.slice(start, end), before: start, total: messages.length, hasEarlier: start > 0 };
      },
      save: () => writes.push({ kind: 'save' })
    }
  };
}

{
  getHistoryCalls.length = 0;
  const r = sessionsHost['sessions.search'](mockCtx(), { path: 'catalog.ts' });
  assert.equal(r.selected, false);
  assert.equal(r.workspaceId, 'ws-1');
  assert.ok(r.sessions.some((s) => s.sessionId === 'se-path'));
  assert.ok(!r.sessions.some((s) => s.sessionId === 'se-commit'), '默认不跨区');
  assert.equal(writes.length, 0, '只读：不 select/不写');
  assert.equal(getHistoryCalls.length > 0, true);
  assert.equal(
    getHistoryCalls.every((c) => c.limit <= 120),
    true,
    '搜索必须只读有界页，不加载完整转写'
  );
  console.log('ok: handler 路径命中且默认本区');
}

{
  const r = sessionsHost['sessions.search'](mockCtx(), { commit: sha.slice(0, 8), workspaceId: '*' });
  assert.equal(r.workspaceId, '*');
  assert.ok(r.sessions.some((s) => s.sessionId === 'se-commit'), '* 可跨区命中归档');
  assert.equal(writes.length, 0);
  console.log('ok: handler 跨区提交命中');
}

{
  const r = sessionsHost['sessions.search'](mockCtx(), { q: '天气不错也不存在' });
  assert.equal(r.count, 0);
  assert.deepEqual(r.sessions, []);
  console.log('ok: handler 无命中');
}

{
  assert.throws(
    () => sessionsHost['sessions.search'](mockCtx(), {}),
    /sessions\.search 需要 path、commit 或 q 之一/
  );
  console.log('ok: handler 缺参拒绝');
}

// ---------------------------------------------------------------------------
// session-search F-01：短 commit 入口报错（可区分「没有会话」与「输入太短」）
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => sessionsHost['sessions.search'](mockCtx(), { commit: 'a1b2c3' }),
    /commit 线索至少需要 7 位/
  );
  assert.throws(
    () => sessionsHost['sessions.search'](mockCtx(), { commit: 'a1b2c3', q: 'x' }),
    /commit 线索至少需要 7 位/,
    'commit 与 q 同给时短 commit 仍拒绝'
  );
  console.log('ok: handler 短 commit 拒绝');
}

// ---------------------------------------------------------------------------
// session-search F-02：全区扫描带会话数预算（新→旧截最旧）+ truncated 信号
// ---------------------------------------------------------------------------
{
  const {
    planSessionSearchScan,
    SESSION_SEARCH_SCAN_MAX_SESSIONS
  } = await import(pathToFileURL(compile('shared/sessionSearch.ts')).href);

  // 纯函数：正常量不截断；超预算截掉最旧并置 truncated
  const rows = Array.from({ length: SESSION_SEARCH_SCAN_MAX_SESSIONS + 5 }, (_, i) => ({
    sessionId: `se-${i}`,
    createdAt: i,
    lastUsedAt: i + 1
  }));
  const normal = planSessionSearchScan(rows.slice(0, 10));
  assert.equal(normal.truncated, false);
  assert.equal(normal.ordered.length, 10);
  const clipped = planSessionSearchScan(rows);
  assert.equal(clipped.truncated, true, '超出会话数预算标记 truncated');
  assert.equal(clipped.ordered.length, SESSION_SEARCH_SCAN_MAX_SESSIONS);
  assert.equal(
    clipped.ordered[0].sessionId,
    `se-${rows.length - 1}`,
    '新→旧排序，最新的在最前'
  );
  assert.ok(
    !clipped.ordered.some((r) => Number(r.sessionId.slice(3)) < 5),
    '被截掉的是最旧的 5 个'
  );

  // handler：>300 会话的全区搜返回 truncated 且仍命中；正常量不带 truncated 字段
  const many = [];
  for (let i = 0; i < SESSION_SEARCH_SCAN_MAX_SESSIONS + 20; i++) {
    many.push({
      id: `se-many-${i}`,
      name: `海量会话 ${i}`,
      type: 'terminal',
      runtime: 'cursor-cli',
      workspaceId: 'ws-1',
      createdAt: i,
      lastUsedAt: i + 1,
      cwd: 'E:/ws/proj',
      archived: false
    });
  }
  // 最新且可命中的会话用 chat runtime 走 getHistory（其余 pty 只拼元数据）
  many[many.length - 1] = {
    ...many[many.length - 1],
    runtime: 'cursor',
    name: '最新会话 needles-here'
  };
  const ctx = mockCtx();
  const origList = ctx.sessions.list;
  ctx.sessions.list = () => many;
  const r = sessionsHost['sessions.search'](ctx, { q: 'needles-here', workspaceId: '*' });
  assert.equal(r.truncated, true, '预算截断时结果带已截断信号');
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].sessionId, `se-many-${many.length - 1}`, '新会话优先被扫描命中');
  assert.equal(r.count, 1);

  const small = sessionsHost['sessions.search'](mockCtx(), { path: 'catalog.ts' });
  assert.equal(small.truncated, undefined, '正常量不带 truncated 字段');
  assert.equal(origList !== undefined, true);
  console.log('ok: 全区扫描预算与截断信号');
}

// ---------------------------------------------------------------------------
// Lazy prefix reads stop at the character budget and never duplicate a partial last page.
{
  const ctx = mockCtx();
  ctx.sessions.list = () => [{ id: 'large', name: 'large', runtime: 'pi', workspaceId: 'ws-1', createdAt: 1 }];
  const reads = [];
  ctx.agentSessions.getHistoryRange = (_id, before, limit) => {
    reads.push({ before, limit });
    assert.equal(before, 120, 'must not read past a full first-page character budget');
    return { before: 0, total: 10000, hasEarlier: false, messages: [msg('needle'+ 'x'.repeat(SESSION_SEARCH_HAYSTACK_MAX))] };
  };
  assert.equal(sessionsHost['sessions.search'](ctx, { q: 'needle' }).count, 1);
  assert.equal(reads.length, 1);
  reads.length = 0;
  const all = Array.from({ length: 140 }, (_, i) => msg(i === 139 ? 'last-page-needle' : String(i)));
  ctx.agentSessions.getHistoryRange = (_id, before, limit) => {
    reads.push({ before, limit });
    const end = Math.min(before, all.length), start = Math.max(0, end - limit);
    return { before: start, total: all.length, hasEarlier: start > 0, messages: all.slice(start, end) };
  };
  assert.equal(sessionsHost['sessions.search'](ctx, { q: 'last-page-needle' }).count, 1);
  assert.deepEqual(reads, [{ before: 120, limit: 120 }, { before: 140, limit: 20 }]);
  console.log('ok: bounded lazy prefix and partial-page search');
}

// 落盘转写只读：hash 前后不变
// ---------------------------------------------------------------------------
{
  const userData = fs.mkdtempSync(path.join(tmp, 'ud-'));
  const sid = '11111111-2222-4333-8444-555555555555';
  const { GuiSessionStore } = await import(
    pathToFileURL(compile('main/agentSession/persist.ts')).href
  );
  const dir = path.join(userData, 'agent-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.json`);
  const payload = {
    version: 2,
    messages: [
      {
        id: 'm1',
        role: 'user',
        ts: 1,
        parts: [{ kind: 'text', text: '请改 src/shared/sessionSearch.ts' }]
      }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const storeOnDisk = new GuiSessionStore(userData);
  const loaded = storeOnDisk.load(sid);
  const hay = buildSessionHaystack({ name: '检索', messages: loaded });
  const hits = searchSessionDocs(
    [
      {
        sessionId: sid,
        name: '检索',
        createdAt: 1,
        lastUsedAt: 2,
        haystack: hay
      }
    ],
    parseSessionSearchQuery({ path: 'src/shared/sessionSearch.ts' })
  );
  assert.equal(hits.length, 1);
  const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(after, before, '只读：不改落盘转写');
  console.log('ok: 落盘转写只读');
}

// ---------------------------------------------------------------------------
// haystack 增量裁剪：超预算即停，但产出与「join 全量再裁」逐字节一致
// ---------------------------------------------------------------------------
{
  const bigText = 'x'.repeat(150_000);
  const tail = '尾巴 needle-XYZ';
  const hay = buildSessionHaystack({ name: 'n', messages: [msg(bigText), msg(bigText), msg(tail)] });
  assert.equal(hay.length, SESSION_SEARCH_HAYSTACK_MAX, '超预算仍裁到上限');
  const expected = ['n', bigText, bigText, tail].join('\n').slice(0, SESSION_SEARCH_HAYSTACK_MAX);
  assert.equal(hay, expected, '增量裁剪与 join 全量再裁语义一致（前缀逐字节相同）');
  assert.ok(!hay.includes('needle-XYZ'), '超预算尾部不进语料（两种实现一致）');

  const small = buildSessionHaystack({ name: '小会话', messages: [msg('正常长度')] });
  assert.ok(!small.includes('…'), '小会话不裁剪');
  assert.equal(
    buildSessionHaystack({ name: 'a', cwd: '', worktreePath: undefined, messages: [] }),
    'a',
    '空字段不产生多余分隔'
  );
  console.log('ok: haystack 增量裁剪');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] sessions-search');
