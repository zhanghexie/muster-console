/**
 * window.api（preload 桥）的 Proxy mock：组件单测用。
 *
 * 设计：
 * - 任意 `api.a.b.c(...)` 都自动得到一个 vi.fn，默认 resolve 出 DEFAULTS 里的形状
 *   （store 启动会解构 sessions.list/workspaces.list/config.get 等返回值，缺省必须合法）；
 * - 未知通道默认 resolve(undefined)——比逐通道手写省维护，缺形状时用例里覆盖；
 * - `api.on(channel, cb)` 返回真卸载函数，`emit(channel, payload)` 模拟主进程推送；
 * - `mockOf('sessions.list')` 取 vi.fn 断言调用参数/次数。
 *
 * 真实契约以 src/preload/index.ts 的 WorkbenchApi 为准（type-only import，
 * 不执行 preload 代码）。
 */
import { vi, type Mock } from 'vitest';
import type { WorkbenchApi } from '../../../src/preload/index';

type AnyMock = Mock<(...args: any[]) => any>;

/** store 启动即解构的通道：默认值必须是可解构的合法形状 */
const DEFAULTS: Record<string, unknown> = {
  'shell.revealPath': { ok: true },
  'browser.setOwner': { ok: true },
  'capabilityManagement.previewSkillConsolidation': { scope: { kind: 'global' }, name: '', destination: '', candidates: [], removePaths: [], linkPaths: [], fingerprint: '' },
  'capabilityManagement.consolidateSkill': { snapshot: { scope: { kind: 'global' }, revision: 0, skills: [], directories: [], conflicts: [], errors: [] }, backupPath: '' },
  'capabilityManagement.usageList': { revision: 0, resources: [], runtimes: [], categories: {
    skill: { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true },
    mcp: { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true }
  } },
  'shell.clipboardFiles': [],
  'chat.state': { busy: false },
  'chat.historyRange': { messages: [], before: 0, total: 0, hasEarlier: false },
  'chat.search': { hits: [], truncated: false },
  'agentSession.historyRange': { messages: [], mode: 'auto', busy: false, before: 0, total: 0, hasEarlier: false },
  'agentSession.search': { hits: [], truncated: false },
  'fs.openFile': { ok: true },
  'fs.closeFile': { ok: true },
  'sessions.list': { sessions: [], activeId: null },
  'boardTodos.list': [],
  'workspaces.list': { workspaces: [], activeWorkspaceId: null },
  'config.waitingTips': { ok: true, path: 'waiting-tips.json', tips: [] },
  'config.providerModelCatalog': { ok: true, snapshot: null },
  'config.get': { workspaces: [], activeWorkspaceId: null, locale: 'zh-CN' },
  'feedback.credentialStatus': { configured: false },
  'feedback.snapshot': { entries: [] },
  'sessionReminders.list': { scope: null, items: [] },
  'runtimes.list': [],
  'agentSession.getHarnessModelSelections': {},
  'notify.list': [],
  // 本机默认按「有系统通知能力」模拟（F-01 兜底提示条默认不出现；用例 override false 覆盖）
  'notify.capability': true,
  'workspaces.switch': { ok: true, workspaces: [], activeWorkspaceId: null },
  'workspaces.open': { ok: true, workspaces: [], activeWorkspaceId: null },
  'workspaces.close': { ok: true, workspaces: [], activeWorkspaceId: null },
  // 左栏（R-21 调度分组）挂载即拉 workspace.json；config 空对象=全走解析缺省
  'workspaceFile.get': { workspaceId: 'ws-a', config: {} },
  'workspaceFile.patch': { ok: true, workspaceId: 'ws-a', config: {} },
  'workspaceBookmarks.read': { ok: true, snapshot: { version: 1, bookmarks: [], bookmarkDefaultsVersion: 1 } }
};

export interface ApiMock {
  api: WorkbenchApi;
  /** 模拟主进程 → 渲染层事件推送（IPC_EVENT_CHANNELS） */
  emit: (channel: string, payload: unknown) => void;
  /** 取某通道叶子的 vi.fn（如 mockOf('sessions.list')）；未调用过也会创建 */
  mockOf: (path: string) => AnyMock;
  /** 覆盖某通道默认返回（同步值或 Promise 均可） */
  override: (path: string, impl: (...args: any[]) => unknown) => void;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function createApiMock(): ApiMock {
  const registry = new Map<string, AnyMock>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const ensureMock = (path: string): AnyMock => {
    let m = registry.get(path);
    if (!m) {
      const def = DEFAULTS[path];
      m = vi.fn(() => Promise.resolve(clone(def)));
      registry.set(path, m);
    }
    return m;
  };

  /** 可调用节点：自身走 vi.fn，属性访问继续生成子节点 */
  const makeNode = (path: string): any =>
    new Proxy((...args: unknown[]) => ensureMock(path)(...args) as any, {
      get(target: any, prop: string | symbol) {
        if (prop === 'then') return undefined; // 防止被 await 当成 thenable
        if (prop === 'apiPath') return path;
        const childPath = `${path}.${String(prop)}`;
        return makeNode(childPath);
      }
    });

  const root: any = {
    on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    off: (channel: string, cb: (payload: unknown) => void): void => {
      listeners.get(channel)?.delete(cb);
    }
  };

  return {
    api: new Proxy(root, {
      get(target: any, prop: string | symbol) {
        if (prop in target) return target[prop as keyof typeof target];
        return makeNode(String(prop));
      }
    }) as unknown as WorkbenchApi,
    emit: (channel: string, payload: unknown) => {
      for (const cb of listeners.get(channel) ?? []) cb(payload);
    },
    mockOf: (path: string) => ensureMock(path),
    override: (path: string, impl: (...args: any[]) => unknown) => {
      registry.set(path, vi.fn(impl as any) as AnyMock);
    }
  };
}

let current: ApiMock | null = null;

export function installApiMock(): ApiMock {
  const mock = createApiMock();
  (window as unknown as { api: WorkbenchApi }).api = mock.api;
  current = mock;
  return mock;
}

/** 用例内取 setup.ts 装的当前 mock（mockOf/emit/override） */
export function currentApiMock(): ApiMock {
  if (!current) throw new Error('currentApiMock(): setup 尚未安装 mock');
  return current;
}
