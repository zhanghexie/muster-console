/** Production settings shell and panes. All IPC is isolated in memory; no engine or native process runs. */
import React from 'react';
import { createRoot } from 'react-dom/client';

const themeId = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
let config: any = {
  locale: 'zh-CN', defaultRuntime: 'pi', openai: { baseUrl: '', apiKey: '', model: '' }, tasksKeepAwake: true,
  workspace: '/projects/demo', activeWorkspaceId: 'demo', workspaces: [{ id: 'demo', name: '示例项目', path: '/projects/demo' }],
  keybindings: {}, systemShortcuts: [{ id: 'capture', name: '系统截图', chord: 'Ctrl+Alt+A' }],
  agentRules: [{ id: 'rule', text: '发现异常时及时说明原因和影响。', enabled: true }],
  llm: { activeProviderId: 'example', activeModelId: 'reasoner', providers: [
    { id: 'example', name: '示例模型服务', enabled: true, baseUrl: 'https://models.example.test/v1', apiKey: '', models: [
      { id: 'reasoner', name: 'Reasoner', reasoning: true, contextWindow: 200000 }, { id: 'fast', name: 'Fast', input: ['text', 'image'] }
    ] },
    { id: 'relay', name: '团队网关', baseUrl: 'https://relay.example.test/v1', apiKey: '', models: [{ id: 'team', name: 'Team model' }] }
  ] },
  textTools: { functions: [{ id: 'translate', name: '翻译', prompt: '将选中的文字翻译成中文。' }, { id: 'summary', name: '整理要点', prompt: '提取要点并列出行动项。' }] },
  mcp: { enabled: true, servers: [] }, notify: { dnd: { start: '22:00', end: '08:00' } }
};
const tools = [{ name: 'browser.run', description: '浏览网页并与页面交互。', parameters: {}, dangerous: false,
  exposure: { kind: 'domain', scheduler: true, workerPresets: ['gui-full'], entry: 'browser.run', actions: [{ action: 'click', target: 'browser.click' }] } }];
const capabilities = { catalog: { version: 'fixture', tools }, injections: [], workerToolAllowlist: ['browser.run'],   dispatcher: { body: '分析目标，选择合适的 Agent 并跟进结果。', defaultBody: '分析目标，选择合适的 Agent 并跟进结果。', customBody: '', catalogAppendix: '', fullPreview: '', initNotes: ['按需加载工具与上下文。'] } };
const skills = ['code-review', 'release-notes', 'project-guide', 'apps', 'automations', 'browser', 'client-log-pull', 'code-analysis', 'company-gitlab-mr', 'concept-glossary', 'dispatch', 'extensions'].map((name, index) => ({
  id: name, name, description: ['审查变更并指出需要处理的问题。', '根据提交整理发布说明。', '项目约定与常用工作流。'][index] ?? (name === 'automations' ? '创建和管理定时任务，配置执行策略、时间安排与启用状态。' : '按需加载此技能，完成相关工作流。'),
  filePath: `/skills/${name}/SKILL.md`, directoryPath: `/skills/${name}`, hash: 'fixture', status: 'valid', hostOwned: name === 'automations', scope: { kind: 'global' }, inherited: false,
  sources: [{ path: `/skills/${name}`, directoryId: 'common', scope: { kind: 'global' }, label: '用户技能', managed: true }], preferred: false, files: ['SKILL.md']
}));
const fixtureRuntimes = ['pi', 'claude', 'codex-gui', 'cursor'].map(id => ({ id, label: id, surface: 'chat', enabled: true, builtin: true, script: '', updatedAt: 1 }));
const state = { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true };
const handlers: Record<string, (...args: any[]) => any> = {
  'config.get': () => structuredClone(config), 'config.update': patch => (config = { ...config, ...patch }),
  'runtimes.list': () => fixtureRuntimes,
  'runtimes.availability': () => ({ runtimes: fixtureRuntimes, checkedAt: 1, acpAgents: [], runtimePreflights: Object.fromEntries(fixtureRuntimes.map(entry => [entry.id, { id: entry.id, status: 'available', ok: true, checkedAt: 1, surface: 'chat', problems: [] }])), acpPreflights: {}, cliPrograms: {} }),
  'agentSession.getHarnessModelSelections': () => ({}),
  'agentSession.describeModelParameters': () => ({ runtimeId: 'pi', parameters: [] }),
  'agentSession.listLocalHarnessModels': () => ({ ok: true, items: [] }),
  'shell.getInfo': () => ({ platform: 'win32', profiles: [], bgShellMode: 'auto', manualGitBashPath: '', manualGitBashPathExists: false }),
  'config.piCatalog': () => null, 'config.waitingTips': () => ({ ok: true, path: '/config/waiting-tips.json', tips: [] }),
  'capabilities.get': () => capabilities, 'catalog.get': () => ({ tools, version: 'fixture' }),
  'app.setChromeTheme': () => ({ ok: true, material: 'solid' }),
  'shell.revealPath': () => ({ ok: true }), 'notify.capability': () => true,
  'capabilityManagement.skillsList': scope => ({ scope, revision: 1, skills, directories: [], conflicts: [], errors: [] }),
  'capabilityManagement.mcpList': () => ({ enabled: true, servers: [{ id: 'docs', scope: 'global', revision: '1', server: { name: 'docs-reader', transport: 'http', url: 'https://docs.example.test/mcp', enabled: true } }] }),
  'config.providerModelCatalog': () => [],
  'feedback.snapshot': () => ({ entries: [] }),
  'capabilityManagement.testMcp': () => ({ ok: true, status: 'connected', tools: [{ name: 'search_docs', description: 'Search documentation' }], checkedAt: '2026-11-01T01:00:00Z', durationMs: 24 }),
  'capabilityManagement.usageList': () => ({ revision: 1, categories: { skill: state, mcp: state }, runtimes: [], resources: [
    ...skills.map(skill => ({ id: skill.id, name: skill.name, kind: 'skill', state })), { id: 'docs-reader', name: 'docs-reader', kind: 'mcp', state }
  ] }),
  'inboundMcp.status': () => ({ ok: true, engines: [{ id: 'claude', label: 'Claude Code', state: 'session' }] }),
  'webAccess.status': () => ({ running: true, port: 7950, token: 'fixture', urls: ['http://127.0.0.1:7950/?token=fixture'], qrDataUrl: '', hook: { path: '/hook/fixture', urls: ['http://127.0.0.1:7950/hook/fixture'], secret: '', signatureEnabled: false } }),
  'messaging.call': (channel, method) => {
    if (channel !== 'channels' || !['list', 'sources.list'].includes(method)) throw new Error('Unexpected Channel operation in settings fixture');
    return { ok: true, value: [] };
  },
  'messaging.cancel': () => ({ ok: true }),
  'updater.getState': () => ({ currentVersion: '1.0.0', state: 'idle' }),
};
const fixture = { calls: [] as any[], unmocked: [] as string[], sent: [] };
(window as any).__uiFixture = fixture;
function bridge(route = ''): any { return new Proxy(() => {}, {
  get: (_, key) => key === 'then' ? undefined : bridge(route ? `${route}.${String(key)}` : String(key)),
  apply: (_, __, args) => {
    if (route === 'on') return () => {};
    fixture.calls.push({ path: route, args });
    if (!handlers[route]) { fixture.unmocked.push(route); return Promise.reject(new Error(`Unmocked settings fixture IPC: ${route}`)); }
    return Promise.resolve(handlers[route](...args));
  }
}); }
(window as any).api = bridge();
const media = matchMedia('(max-width: 820px)');
const syncNarrow = () => document.documentElement.classList.toggle('is-narrow', media.matches);
media.addEventListener('change', syncNarrow); syncNarrow();
async function mount() {
  await import('../../src/renderer/src/i18n');
  const [{ SettingsModal }, { KeybindingProvider }, { applyTheme }, { builtinTheme }] = await Promise.all([
    import('../../src/renderer/src/components/settings/SettingsModal'), import('../../src/renderer/src/keybindings/KeybindingHost'),
    import('../../src/renderer/src/theme'), import('../../src/shared/theme')
  ]);
  const themes = [builtinTheme('dark')!, builtinTheme('light')!, { ...builtinTheme(themeId)!, id: 'custom', name: '自定义主题', builtin: false }];
  handlers['themes.list'] = () => ({ activeId: themeId, active: builtinTheme(themeId), themes: themes.map(theme => ({ id: theme.id, name: theme.name, appearance: theme.appearance, builtin: !!theme.builtin, preview: { bg: theme.colors['bg-canvas'], ink: theme.colors.ink, accent: theme.colors.purple } })), dir: '/themes', globalThemeId: themeId });
  handlers['themes.get'] = id => ({ ok: true, theme: themes.find(theme => theme.id === id)! });
  handlers['themes.activate'] = () => ({ ok: true });
  applyTheme(builtinTheme(themeId)!);
  createRoot(document.getElementById('root')!).render(<KeybindingProvider><div className="app-shell"><SettingsModal onClose={() => {}}/></div></KeybindingProvider>);
}
void mount();
