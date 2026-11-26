/** Real SettingsModal/GeneralPane with memory-only configuration and explicit save settlement.
 * No preload bridge, host configuration, credentials or native window is used.
 * Capture with base,skel,float,settings,responsive in the production stylesheet order.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AppConfig, CapabilitiesView } from '@workbench/src/shared/types';

let config: AppConfig = {
  openai: { baseUrl: '', apiKey: '', model: '' },
  workspace: 'E:/settings-save-fixture',
  workspaces: [{ id: 'settings-save-fixture', name: '隔离设置夹具', path: 'E:/settings-save-fixture', openedAt: 1 }],
  activeWorkspaceId: 'settings-save-fixture',
  defaultRuntime: 'cursor', runtimeOverrides: {},
  mcp: { enabled: false, servers: [] }, mcpByWorkspace: {},
  dispatcherAppendPrompt: '', locale: 'zh-CN', tasksKeepAwake: true,
  journalExitSummaryEnabled: false,
  // 长规则用于验证规约行摘要的省略号截断（不得顶到右侧动作上）
  agentRules: [
    { id: 'rule-long', enabled: true, text: '异常上报：执行中发现异常或疑点时，必须在对话中及时告知用户，不得静默绕过、自作主张换方案或假成功。典型情形包括引用的文件失效、文档与行为矛盾、需要删除其他组件依赖的契约文件、任务无法完成等。' },
    { id: 'rule-short', enabled: false, text: '每轮的最后一次输出记得把重要的信息都说一下。' }
  ],
  // 供应商列表：停用/启用/默认/超长名各一条，用于看折叠行的排版与徽标
  llm: {
    activeProviderId: 'bigmodel',
    activeModelId: 'glm-5.3',
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', enabled: false, models: [{ id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 65536 }] },
      { id: 'amd', name: 'AMD', baseUrl: 'https://api.amd.example/v1', apiKey: '', models: [{ id: 'amd-mi300', name: 'amd-mi300', contextWindow: 131072 }] },
      { id: 'mimo', name: '小米 MiMo 开放平台（官方）', baseUrl: 'https://api.mimo.example/v1', apiKey: '', models: [{ id: 'mimo-7b', name: 'mimo-7b' }] },
      { id: 'bigmodel', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/v1', apiKey: '', models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 977000, reasoning: true }] },
      { id: 'anthropic-mimo', name: '小米 MiMo 开放平台 (Anthropic)', baseUrl: 'https://api.mimo.example/anthropic', apiKey: '', models: [{ id: 'mimo-claude', name: 'mimo-claude' }] }
    ]
  }
};
const capabilities: CapabilitiesView = {
  catalog: { version: 'settings-save-fixture', tools: [] },
  workerToolAllowlist: [], injections: [],
  dispatcher: {
    body: '隔离夹具默认提示词', defaultBody: '隔离夹具默认提示词', customBody: '',
    isCustom: false, catalogAppendix: '', fullPreview: '隔离夹具默认提示词', initNotes: []
  }
};
type SaveRecord = {
  id: number; patch: Partial<AppConfig>; startedAt: number; endedAt?: number;
  outcome?: 'success' | 'failure';
};
const diagnostics = {
  calls: [] as { path: string; args: unknown[]; at: number }[],
  unmocked: [] as string[], updates: [] as SaveRecord[],
  closeCalls: [] as number[],
  inputs: [] as { type: string; trusted: boolean; text: string; at: number }[],
  desktopMinimumWidth: 1100,
  config: (): AppConfig => structuredClone(config)
};
let pending: { record: SaveRecord; resolve: (value: AppConfig) => void; reject: (reason: Error) => void } | null = null;
function settle(outcome: 'success' | 'failure'): void {
  if (!pending) throw new Error('Settings save fixture has no pending config.update');
  const operation = pending;
  pending = null;
  operation.record.endedAt = performance.now();
  operation.record.outcome = outcome;
  if (outcome === 'failure') operation.reject(new Error('隔离夹具模拟保存失败'));
  else {
    config = { ...config, ...structuredClone(operation.record.patch) };
    operation.resolve(structuredClone(config));
  }
}
/** 结构化克隆会拒绝函数/Proxy。设置页里订阅类 IPC（如 theme.subscribe）会把回调当参数传进来，
 * 不处理就会在组件渲染期抛错并整棵树中止，导致外观等页无法截图。回调只登记不执行。 */
function cloneSafe(value: unknown): unknown {
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.map(cloneSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = cloneSafe(item);
    return out;
  }
  return value;
}

/** 需要真实模块（如内置主题）的桩在挂载后才注册，避免在模块顶层引用渲染层代码。 */
const lateMocks: Record<string, (...args: unknown[]) => unknown> = {};

function bridge(route = ''): unknown {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : bridge(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args: unknown[]) => {
      diagnostics.calls.push({ path: route, args: cloneSafe(args) as unknown[], at: performance.now() });
      if (route === 'config.get') return Promise.resolve(structuredClone(config));
      if (route === 'capabilities.get') return Promise.resolve(structuredClone(capabilities));
      if (route === 'app.setChromeTheme') return Promise.resolve({ ok: true, material: 'solid' });
      // 事件订阅：返回退订函数，不能让 useEffect 的 cleanup 拿到 rejected Promise
      if (route === 'on') return () => {};
      if (lateMocks[route]) return Promise.resolve(lateMocks[route](...args));
      if (route === 'config.update') {
        if (pending) return Promise.reject(new Error('Settings save fixture received overlapping config.update'));
        const patch = args[0];
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return Promise.reject(new Error('Settings save fixture requires a config patch object'));
        }
        const record: SaveRecord = {
          id: diagnostics.updates.length + 1,
          patch: structuredClone(patch) as Partial<AppConfig>, startedAt: performance.now()
        };
        diagnostics.updates.push(record);
        return new Promise<AppConfig>((resolve, reject) => { pending = { record, resolve, reject }; });
      }
      if (!diagnostics.unmocked.includes(route)) diagnostics.unmocked.push(route);
      const error = new Error(`Unmocked settings-save fixture IPC: ${route}`);
      // Production catches must not silently turn a missing fixture route into a pass.
      console.error(error.message);
      return Promise.reject(error);
    }
  });
}
Object.assign(window, {
  api: bridge(), __uiFixture: diagnostics,
  __settingsSaveFixture: {
    diagnostics, settle,
    pendingId: (): number | null => pending?.record.id ?? null
  }
});

// Match desktop App's viewport marker, including subsequent viewport resize.
// This fixture intentionally does not mount MobileApp or impersonate a mobile device.
const narrow = matchMedia('(max-width: 820px)');
const syncNarrow = (): void => { document.documentElement.classList.toggle('is-narrow', narrow.matches); };
narrow.addEventListener('change', syncNarrow);
syncNarrow();
for (const kind of ['click', 'keydown'] as const) document.addEventListener(kind, event => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest('.settings-page')) return;
  diagnostics.inputs.push({
    type: kind === 'keydown' ? `key:${(event as KeyboardEvent).key}` : 'click',
    trusted: event.isTrusted,
    text: target.closest('button, input')?.getAttribute('aria-label') ?? target.closest('button')?.textContent?.trim() ?? '',
    at: performance.now()
  });
}, true);

async function mount(): Promise<void> {
  // Install the strict bridge before evaluating any production renderer module,
  // including theme initialization that can synchronize native chrome colors.
  await import('@workbench/src/renderer/src/i18n');
  const [{ SettingsModal }, { usePresence }, { KeybindingProvider },
    { setInteractionPreferences }, { applyTheme }, { builtinTheme }] = await Promise.all([
    import('@workbench/src/renderer/src/components/settings/SettingsModal'),
    import('@workbench/src/renderer/src/components/motion'),
    import('@workbench/src/renderer/src/keybindings/KeybindingHost'),
    import('@workbench/src/renderer/src/interactionPreferences'),
    import('@workbench/src/renderer/src/theme'),
    import('@workbench/src/shared/theme')
  ]);
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  // 外观页从 themes.list / themes.get 读主题清单与正文；只给内置深/浅两套，
  // 够看清配色分组、折叠列表与动作行的结构（不写任何主题文件）。
  const builtins = [builtinTheme('dark')!, builtinTheme('light')!];
  const meta = (t: (typeof builtins)[number]) => ({
    id: t.id, name: t.name, appearance: t.appearance, builtin: true,
    preview: { bg: t.colors['bg-canvas'], ink: t.colors.ink, accent: t.colors.purple }
  });
  lateMocks['themes.list'] = () => ({
    activeId: 'dark', active: builtins[0], themes: builtins.map(meta), dir: '',
    globalThemeId: 'dark', workspaceThemeId: undefined,
    activeWorkspaceId: 'settings-save-fixture', activeWorkspaceName: '隔离设置夹具'
  });
  lateMocks['themes.get'] = (id) => {
    const theme = builtins.find(t => t.id === id) ?? builtins[0];
    return { ok: true, theme };
  };
  lateMocks['themes.activate'] = () => ({ ok: true });
  // Worker 列表：三条足够看折叠行的排版（开/关、可用性徽标、右侧 runtime id）
  lateMocks['runtimes.list'] = () => ([
    { id: 'cursor-cli', label: 'Cursor CLI', script: 'cursor-cli.ps1', builtin: true, enabled: true },
    { id: 'claude-code', label: 'Claude Code', script: 'claude-code.ps1', builtin: true, enabled: true },
    { id: 'gemini', label: 'Gemini', script: 'gemini.ps1', builtin: true, enabled: false },
    // chat 呈现面（GUI）与 pty（TUI）各一条，用于看「开箱 / GUI|TUI / 可用」胶囊列
    { id: 'cursor', label: 'Cursor', script: '', builtin: true, enabled: true, surface: 'chat' }
  ]);
  setInteractionPreferences({ scrollFeel: 'native', scrollDistance: 1, motion: 'system' });
  function Fixture(): React.JSX.Element {
    const [open, setOpen] = React.useState(true);
    const presence = usePresence(open);
    return <div className="app-shell">
      <main className="main-view">
        <button type="button" className="btn" onClick={() => setOpen(true)}>重新打开隔离设置页</button>
      </main>
      {presence.mounted ? <SettingsModal stage={presence.stage} initialTab="general" onClose={() => {
        diagnostics.closeCalls.push(performance.now());
        setOpen(false);
      }} /> : null}
    </div>;
  }
  createRoot(document.getElementById('root')!).render(<KeybindingProvider><Fixture /></KeybindingProvider>);
}
void mount().catch(error => { console.error('Settings-save production fixture failed to mount', error); });
