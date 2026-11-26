import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
/**
 * 模型服务商页的 pi 目录驱动契约：
 * - 添加供应商菜单列出目录 provider（模型数徽章、oauth-only 过滤、已添加置灰）；
 * - 选中目录项只落 id/name（api 与能力字段不预填——协议由 pi 目录决定、显式能力会钉死目录值）；
 * - 模型徽章（价格/窗口/多模态/思考）优先取目录元数据；
 * - 「从目录添加模型」面板按未添加模型增量加入；
 * - 目录不可用（null/undefined）回落静态 preset 菜单。
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelProviderPane } from '../../src/renderer/src/components/settings/ModelProviderPane';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig, LlmConfig } from '../../src/shared/types';
import type { PiCatalogView } from '../../src/shared/piCatalog';

beforeEach(() => dismissTip());

function makeCfg(llm?: Partial<LlmConfig>): { cfg: AppConfig; patches: Array<Partial<AppConfig>> } {
  const patches: Array<Partial<AppConfig>> = [];
  const cfg = {
    defaultRuntime: 'pi',
    workspace: 'E:/ws',
    workspaces: [{ id: 'w1', name: 'WS', path: 'E:/ws' }],
    activeWorkspaceId: 'w1',
    locale: 'zh-CN',
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-x',
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
          enabled: true
        },
        {
          id: 'my-relay',
          name: 'My Relay',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-relay',
          models: [{ id: 'relay-model', name: 'Relay' }],
          enabled: true
        }
      ],
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-v4-pro',
      ...llm
    }
  } as unknown as AppConfig;
  return { cfg, patches };
}

const CATALOG: PiCatalogView = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      authMethods: ['apiKey'],
      models: [
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
          contextWindow: 1048576,
          reasoning: true,
          input: ['text', 'image']
        },
        { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, reasoning: false, input: ['text'] }
      ]
    },
    {
      id: 'zai',
      name: 'Z.AI',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      authMethods: ['apiKey'],
      models: [{ id: 'glm-5.3', contextWindow: 200000, reasoning: true, input: ['text'] }]
    },
    // oauth-only：不进一键添加菜单
    { id: 'radius', name: 'Radius', authMethods: ['oauth'], models: [{ id: 'r-1' }] }
  ]
};

function renderPane(cfg: AppConfig, patches: Array<Partial<AppConfig>>): HTMLElement {
  render(
    <KeybindingProvider>
      <ModelProviderPane cfg={cfg} set={(p) => patches.push(p)} />
    </KeybindingProvider>
  );
  return document.querySelector('.llm-provider-list') as HTMLElement;
}

async function openAddMenu(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '＋ 添加供应商' }));
  return await waitFor(() => document.querySelector('.llm-add-menu-panel') as HTMLElement);
}

describe('模型服务商 · pi 目录驱动', () => {
  const tokenPlan = {
    id: 'qwen-token-plan-cn', name: 'Qwen Token Plan CN', apiKey: 'fixture-key',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen4-max', name: 'Qwen4-Max' }]
  };

  it('shows the input fallback when both model catalogs are missing the entry', async () => {
    currentApiMock().override('config.piCatalog', async () => CATALOG);
    const { cfg, patches } = makeCfg({ providers: [tokenPlan], activeProviderId: tokenPlan.id, activeModelId: 'qwen4-max' });
    renderPane(cfg, patches);
    const row = screen.getByText('qwen4-max', { exact: true }).closest('.llm-model-row-item') as HTMLElement;
    const user = userEvent.setup();
    expect(within(row).getByText('1M')).toBeTruthy();
    expect(within(row).getByText('多模态')).toBeTruthy();
    await user.click(within(row).getByTitle('编辑模型配置'));
    const dialog = screen.getByText('编辑模型配置', { exact: true }).closest('.llm-model-dialog') as HTMLElement;
    expect((within(dialog).getByLabelText('上下文窗口') as HTMLInputElement).value).toBe('1000000');
    await user.click(within(dialog).getByRole('button', { name: /高级/ }));
    expect((within(dialog).getByRole('checkbox', { name: '支持图片输入（多模态）' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(patches.at(-1)!.llm!.providers[0]!.models[0]).toEqual({ id: 'qwen4-max', name: 'Qwen4-Max' });
  });

  it('allows clearing an image setting saved by an older Token Plan configuration', async () => {
    const model = { ...tokenPlan.models[0]!, contextWindow: 64000, multimodal: false };
    const { cfg, patches } = makeCfg({ providers: [{ ...tokenPlan, models: [model] }], activeProviderId: tokenPlan.id, activeModelId: model.id });
    renderPane(cfg, patches);
    const user = userEvent.setup();
    await user.click(screen.getByTitle('编辑模型配置'));
    await user.click(screen.getByRole('button', { name: /高级$/ }));
    const images = screen.getByRole('checkbox', { name: '支持图片输入（多模态）' }) as HTMLInputElement;
    expect(images.checked).toBe(false);
    await user.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(images.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: '保存' }));
    const saved = patches.at(-1)!.llm!.providers[0]!.models[0]!;
    expect(saved.multimodal).toBeUndefined();
    expect(saved.contextWindow).toBe(64000);
  });

  it('keeps picture input automatic when manually adding Qwen4-Max to Token Plan', async () => {
    const { cfg, patches } = makeCfg({ providers: [{ ...tokenPlan, models: [] }], activeProviderId: tokenPlan.id });
    renderPane(cfg, patches);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '＋ 添加模型' }));
    await user.type(screen.getByPlaceholderText('例如: mimo-v2.5-pro / gpt-4o'), 'qwen4-max');
    await user.click(screen.getByRole('button', { name: /高级$/ }));
    expect((screen.getByRole('checkbox', { name: '支持图片输入（多模态）' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(patches.at(-1)!.llm!.providers[0]!.models[0]!.multimodal).toBeUndefined();
  });

  it('applies an online text-only specification while preserving an open context window edit', async () => {
    let snapshot: PiCatalogView = CATALOG;
    currentApiMock().override('config.piCatalog', async () => snapshot);
    const { cfg, patches } = makeCfg({ providers: [tokenPlan], activeProviderId: tokenPlan.id, activeModelId: 'qwen4-max' });
    renderPane(cfg, patches);
    const user = userEvent.setup();
    await user.click(screen.getByTitle('编辑模型配置'));
    const context = screen.getByRole('spinbutton', { name: '上下文窗口' }) as HTMLInputElement;
    expect(context.value).toBe('1000000');
    await user.clear(context);
    await user.type(context, '123456');
    await user.click(screen.getByRole('button', { name: /高级$/ }));
    const image = screen.getByRole('checkbox', { name: '支持图片输入（多模态）' }) as HTMLInputElement;
    expect(image.checked).toBe(true);
    snapshot = { ...CATALOG, capabilities: [{ providerId: tokenPlan.id, baseUrl: tokenPlan.baseUrl,
      protocol: 'openai-completions', modelId: 'qwen4-max', contextWindow: 65536, input: ['text'],
      sources: ['https://fixture.example/models'] }] };
    currentApiMock().emit('agentSession:coreReasoningCatalogUpdated', {});
    await waitFor(() => expect(image.checked).toBe(false));
    expect(context.value).toBe('123456');
    expect(screen.getByText('64k', { selector: '.llm-model-badge-ctx' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存' }));
    const saved = patches.at(-1)!.llm!.providers[0]!.models[0]!;
    expect(saved.contextWindow).toBe(123456);
    expect(saved.multimodal).toBeUndefined();
  });

  it('lets an account-scoped Pi provider accept and retain its real Base URL', async () => {
    const azure = { id: 'azure', name: 'Azure OpenAI', apiKey: 'fixture-key', baseUrl: '', models: [{ id: 'gpt-5', name: 'GPT-5' }] };
    const { cfg, patches } = makeCfg({ providers: [azure], activeProviderId: 'azure', activeModelId: 'gpt-5' });
    currentApiMock().override('config.piCatalog', async () => ({ providers: [{ id: 'azure', name: azure.name,
      authMethods: ['apiKey'], api: 'azure-openai-responses', accountEndpointExample: 'https://{resource}.openai.azure.com/openai/v1',
      models: azure.models }] }));
    function Fixture() {
      const [value, setValue] = React.useState(cfg);
      return <KeybindingProvider><ModelProviderPane cfg={value} set={patch => {
        patches.push(patch); setValue(previous => ({ ...previous, ...patch }));
      }} /></KeybindingProvider>;
    }
    const { container } = render(<Fixture />);
    await screen.findByText('pi 目录');
    const input = screen.getByRole('textbox', { name: 'Base URL' });
    expect(input.getAttribute('placeholder')).toBe('https://{resource}.openai.azure.com/openai/v1');
    await userEvent.setup().type(input, 'https://fixture.openai.azure.com');
    expect(patches.at(-1)?.llm?.providers[0]?.baseUrl).toBe('https://fixture.openai.azure.com');
    expect(container.querySelector('[data-provider-id="azure"]')?.getAttribute('data-catalog')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Base URL' })).toBe(input);
    expect(patches.at(-1)?.llm?.providers[0]?.api).toBeUndefined();
  });

  it('refreshes an official provider with its native catalog protocol, without saving the draft', async () => {
    currentApiMock().override('config.piCatalog', async () => ({ ...CATALOG,
      providers: CATALOG.providers.map(item => item.id === 'deepseek' ? { ...item, api: 'anthropic-messages' } : item) }));
    currentApiMock().override('config.providerModelCatalog', async () => ({ ok: true, snapshot: null }));
    const { cfg, patches } = makeCfg();
    renderPane(cfg, patches);
    await screen.findByRole('button', { name: '从目录添加（1）' });
    await userEvent.setup().click(await screen.findByRole('button', { name: '刷新目录' }));
    expect(currentApiMock().mockOf('config.providerModelCatalog')).toHaveBeenLastCalledWith({
      id: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', api: 'anthropic-messages'
    }, true);
    expect(patches).toHaveLength(0);
  });

  it('preserves explicit developer-role support and allows returning to the custom endpoint default', async () => {
    currentApiMock().override('config.piCatalog', async () => CATALOG);
    const { cfg, patches } = makeCfg({ activeProviderId: 'my-relay', activeModelId: 'relay-model' });
    function Fixture() {
      const [value, setValue] = React.useState(cfg);
      return <KeybindingProvider><ModelProviderPane cfg={value} set={patch => {
        patches.push(patch); setValue(previous => ({ ...previous, ...patch }));
      }} /></KeybindingProvider>;
    }
    render(<Fixture />);
    const user = userEvent.setup();
    await user.click(screen.getByText('高级 · 思考强度映射'));
    const select = () => screen.getByRole('button', { name: 'developer 角色支持' });
    expect(select().textContent).toContain('默认（system）');
    for (const [label, expected] of [
      ['支持（developer）', true], ['不支持（system）', false], ['默认（system）', undefined]
    ] as const) {
      await user.click(select());
      await user.click(screen.getByRole('option', { name: label }));
      const provider = patches.at(-1)!.llm!.providers.find(item => item.id === 'my-relay')!;
      expect(provider.compat?.supportsDeveloperRole).toBe(expected);
      expect(select().textContent).toContain(label);
    }
    const provider = patches.at(-1)!.llm!.providers.find(item => item.id === 'my-relay')!;
    expect(provider.compat).toBeUndefined();
    await user.click(within(screen.getByRole('navigation', { name: '供应商' })).getByRole('button', { name: /DeepSeek/ }));
    expect(screen.queryByRole('button', { name: 'developer 角色支持' })).toBeNull();
  });

  it('uses the common browser and detail groups; filtering never clears the selected provider draft', async () => {
    currentApiMock().override('config.piCatalog', async () => CATALOG);
    const { cfg, patches } = makeCfg();
    renderPane(cfg, patches);
    const user = userEvent.setup();
    const browser = document.querySelector('.llm-provider-list.settings-resource-layout')!;
    expect(browser.querySelector('.settings-resource-nav')).toBeTruthy();
    expect(browser.querySelector('.settings-resource-detail')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '供应商' });
    expect(within(nav).getByRole('button', { name: /My Relay/ }).classList.contains('settings-resource-item')).toBe(true);
    const detail = screen.getByRole('region', { name: '基本信息' });
    expect(within(detail).getByLabelText('供应商名称')).toBeTruthy();
    expect(screen.getByRole('region', { name: '连接配置' })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: '搜索供应商' }), 'Relay');
    expect(within(nav).queryByRole('button', { name: /DeepSeek/ })).toBeNull();
    expect((screen.getByLabelText('供应商名称') as HTMLInputElement).value).toBe('DeepSeek');
    await user.clear(screen.getByRole('searchbox', { name: '搜索供应商' }));
    expect(within(nav).getByRole('button', { name: /DeepSeek/ }).getAttribute('aria-pressed')).toBe('true');
    expect(patches).toHaveLength(0);
  });
  it('左右分栏切换保持草稿和默认项，重复选择不收起；新增和删除自动定位', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg();
    let draft = cfg;
    function Harness() {
      const [value, setValue] = React.useState(cfg);
      return <KeybindingProvider><ModelProviderPane cfg={value} set={(patch) => {
        draft = { ...draft, ...patch };
        setValue(draft);
      }} /></KeybindingProvider>;
    }
    render(<Harness />);
    const user = userEvent.setup();
    const nav = screen.getByRole('navigation', { name: '供应商' });
    await user.click(within(nav).getByRole('button', { name: /My Relay/ }));
    await user.clear(screen.getByLabelText('供应商名称'));
    await user.type(screen.getByLabelText('供应商名称'), 'Relay edited');
    await user.clear(screen.getByPlaceholderText('sk-…'));
    await user.type(screen.getByPlaceholderText('sk-…'), 'draft-key');
    await user.click(within(nav).getByRole('button', { name: /DeepSeek/ }));
    await user.click(within(nav).getByRole('button', { name: /Relay edited/ }));
    await user.click(within(nav).getByRole('button', { name: /Relay edited/ }));
    expect(screen.getByPlaceholderText('sk-…').getAttribute('value')).toBe('draft-key');
    expect(document.querySelectorAll('.llm-provider-body')).toHaveLength(1);
    const detail = document.querySelector('.llm-provider.settings-split-main')!;
    expect(detail.classList.contains('mp-panel')).toBe(true);
    expect(detail.classList.contains('xfade')).toBe(false);
    expect(detail.getAttribute('data-mp-stage')).toBe('in');
    expect(draft.llm!.activeProviderId).toBe('deepseek');
    expect(within(nav).getByRole('button', { name: /Relay edited/ }).getAttribute('aria-pressed')).toBe('true');
    const menu = await openAddMenu();
    await user.click(within(menu).getByText('添加自定义供应商'));
    expect(screen.getByLabelText('供应商名称').getAttribute('value')).toBe('自定义供应商');
    expect(draft.llm!.providers.find((provider) => provider.id.startsWith('custom'))!.models).toEqual([]);
    expect(screen.getByText('尚未添加模型，请从目录选择或手动添加。')).toBeTruthy();
    await user.click(screen.getByTitle('删除此供应商'));
    const confirmation = await screen.findByRole('dialog', { name: '删除此供应商' });
    expect(screen.getByLabelText('供应商名称').getAttribute('value')).toBe('自定义供应商');
    await user.click(within(confirmation).getByRole('button', { name: '确认删除' }));
    expect(screen.getByLabelText('供应商名称').getAttribute('value')).toBe('DeepSeek');
    expect(draft.llm!.providers).toHaveLength(2);
  });

  it('添加菜单列出目录 provider（含模型数），oauth-only 过滤，已添加置灰', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg();
    renderPane(cfg, []);
    const panel = await openAddMenu();
    // 目录项 + 模型数；radius（oauth-only）不出现
    const dsItem = within(panel).getByText('DeepSeek', { exact: false }).closest('button');
    expect(dsItem).toBeTruthy();
    expect(within(panel).getByText('2')).toBeTruthy(); // DeepSeek 模型数徽章
    expect(within(panel).getByText('Z.AI')).toBeTruthy();
    expect(within(panel).queryByText('Radius')).toBeNull();
    // 已存在 deepseek → 置灰 + 已添加标记
    expect(dsItem!.getAttribute('data-already-added')).toBe('true');
    expect(within(panel).getByText('已添加')).toBeTruthy();
    // 本地与其他（目录没有的静态项）+ 自定义入口常驻
    expect(within(panel).getByText('添加自定义供应商')).toBeTruthy();
  });

  it('选中目录项：provider 只落基础信息，模型由用户从目录选择', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    renderPane(cfg, patches);
    const panel = await openAddMenu();
    const user = userEvent.setup();
    await user.click(within(panel).getByText('Z.AI'));
    const patch = patches.at(-1) as { llm: LlmConfig };
    const zai = patch.llm.providers.find((p) => p.id === 'zai')!;
    expect(zai.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(zai.api).toBeUndefined();
    expect(zai.models).toEqual([]);
  });

  it('模型徽章优先取目录元数据（价格/窗口/多模态/思考），显式配置仍生效', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-x',
          models: [
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, // 无显式字段 → 目录真值
            { id: 'deepseek-flash', name: 'Flash', contextWindow: 131072 } // 显式窗口压过目录
          ],
          enabled: true
        }
      ],
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-v4-pro'
    });
    const list = renderPane(cfg, []);
    // activeProvider（deepseek）默认展开，无需点 summary（再点反而收起）
    // 等 useEffect 拉到目录后的重渲染（首帧目录未到，窗口走正则回落）
    await waitFor(() => {
      const pro = Array.from(list.querySelectorAll('.llm-model-row-item')).find((r) =>
        r.textContent?.includes('deepseek-v4-pro')
      );
      expect(within(pro as HTMLElement).getByText('1M')).toBeTruthy();
    });
    const rows = Array.from(list.querySelectorAll('.llm-model-row-item'));
    // v4-pro：目录窗口 1M + 多模态 + 思考
    const pro = rows.find((r) => r.textContent?.includes('deepseek-v4-pro')) as HTMLElement;
    expect(within(pro).getByText('1M')).toBeTruthy();
    expect(within(pro).getByText('多模态')).toBeTruthy();
    expect(within(pro).getByText('思考')).toBeTruthy();
    // flash：显式 131072 → 128k 压过目录
    const flash = rows.find((r) => r.textContent?.includes('deepseek-flash')) as HTMLElement;
    expect(within(flash).getByText('128k')).toBeTruthy();
  });

  it('「从目录添加模型」列出未添加模型，点击即加入（只落 id/name）', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    const list = renderPane(cfg, patches);
    // activeProvider（deepseek）默认展开；目录 2 模型已含 v4-pro，剩 flash 1 条
    const btn = await screen.findByRole('button', { name: '从目录添加（1）' });
    const user = userEvent.setup();
    await user.click(btn);
    const item = await screen.findByText('deepseek-flash');
    await user.click(item.closest('button') as HTMLElement);
    const patch = patches.at(-1) as { llm: LlmConfig };
    const models = patch.llm.providers[0]!.models;
    expect(models.some((m) => m.id === 'deepseek-flash' && m.name === 'DeepSeek Flash')).toBe(true);
  });

  it('内置服务商刷新失败时回退到 pi 默认目录，而不是清空候选', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    currentApiMock().override('config.providerModelCatalog', async (_provider, refresh) => refresh
      ? { ok: false, error: 'HTTP 401: invalid key' }
      : { ok: true, snapshot: null });
    const { cfg } = makeCfg();
    const list = renderPane(cfg, []);
    const user = userEvent.setup();
    const provider = await waitFor(() => {
      const element = list.querySelector('.llm-provider[data-provider-id="deepseek"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    const refresh = await within(provider).findByRole('button', { name: '刷新目录' });
    await user.click(refresh);
    await waitFor(() => expect(getTipSnapshot()?.text).toContain('HTTP 401'));
    expect(within(provider).getByRole('status').textContent).toContain('回退到内置目录');
    await user.click(within(provider).getByRole('button', { name: '从目录添加（1）' }));
    expect(within(provider).getByRole('button', { name: /deepseek-flash/ })).toBeTruthy();
  });

  it('目录供应商收成填 Key 即用：无 API 格式/思考面板、URL 只读；自定义供应商保留全部调节', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg();
    const list = renderPane(cfg, []);
    // 目录供应商（deepseek，默认展开）——等 useEffect 拉到目录后 data-catalog 才置位
    const ds = await waitFor(() => {
      const el = list.querySelector('.llm-provider[data-provider-id="deepseek"][data-catalog="true"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(within(ds).getByText('pi 目录')).toBeTruthy();
    expect(within(ds).getByText('https://api.deepseek.com')).toBeTruthy(); // URL 只读展示
    expect(within(ds).queryByText('API 格式')).toBeNull();
    expect(within(ds).queryByText('高级 · 思考强度映射')).toBeNull();
    expect(within(ds).getByPlaceholderText('sk-…')).toBeTruthy(); // API Key 仍可填
    // 自定义供应商（点开手风琴）：调节项齐全
    const user = userEvent.setup();
    await user.click(within(list).getByRole('button', { name: /My Relay/ }));
    const relay = list.querySelector('.llm-provider[data-provider-id="my-relay"]') as HTMLElement;
    expect(relay.getAttribute('data-catalog')).toBe(null);
    expect(within(relay).getByText('API 格式')).toBeTruthy();
    expect(within(relay).getByText('高级 · 思考强度映射')).toBeTruthy();
  });

  it('添加菜单搜索：按名称/模型 id 过滤，空态提示，清词恢复', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg();
    renderPane(cfg, []);
    const panel = await openAddMenu();
    const user = userEvent.setup();
    // 按模型 id 搜：glm → 命中 Z.AI（glm-5.3），DeepSeek 消失；自定义组隐藏
    await user.type(within(panel).getByPlaceholderText('搜索供应商或模型…'), 'glm');
    expect(within(panel).getByText('Z.AI')).toBeTruthy();
    expect(within(panel).queryByText(/DeepSeek/)).toBeNull();
    expect(within(panel).queryByText('添加自定义供应商')).toBeNull();
    // 无命中 → 空态
    await user.clear(within(panel).getByPlaceholderText('搜索供应商或模型…'));
    await user.type(within(panel).getByPlaceholderText('搜索供应商或模型…'), '不存在的供应商');
    expect(within(panel).getByText('无匹配供应商')).toBeTruthy();
    // 清词恢复全列表与自定义入口
    await user.clear(within(panel).getByPlaceholderText('搜索供应商或模型…'));
    expect(within(panel).getByText('Z.AI')).toBeTruthy();
    expect(within(panel).getByText('添加自定义供应商')).toBeTruthy();
  });

  it('目录不可用回落静态 preset 菜单', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(undefined));
    const { cfg } = makeCfg();
    renderPane(cfg, []);
    const panel = await openAddMenu();
    // 静态回落包含 PRESET 项（如本地 Ollama）且无「本地与其他」分组
    expect(within(panel).getByText('本地 Ollama')).toBeTruthy();
    expect(within(panel).queryByText('本地与其他')).toBeNull();
    expect(within(panel).queryByText('pi 模型目录')).toBeNull();
  });
});

/** 目录经 useEffect 异步到达：等目录驱动的徽章（v4-pro 窗口 1M）出现再继续，避免空目录下的假绿 */
async function waitForCatalog(list: HTMLElement): Promise<void> {
  await waitFor(() => {
    const row = Array.from(list.querySelectorAll('.llm-model-row-item')).find((r) =>
      r.textContent?.includes('deepseek-v4-pro')
    );
    expect(within(row as HTMLElement).getByText('1M')).toBeTruthy();
  });
}

describe('模型服务商 · 目录化接缝（F-02/F-03）', () => {
  it('F-02: 编辑目录模型仅改显示名保存——未改字段不落盘（点一次保存不再钉死目录值）', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    const list = renderPane(cfg, patches);
    await waitForCatalog(list);
    const user = userEvent.setup();
    await user.click(screen.getByTitle('编辑模型配置'));
    const nameInput = await screen.findByDisplayValue('DeepSeek V4 Pro');
    await user.clear(nameInput);
    await user.type(nameInput, 'My Alias');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const patch = patches.at(-1) as { llm: LlmConfig };
    const m = patch.llm.providers[0]!.models[0]!;
    expect(m.name).toBe('My Alias');
    // 预填的目录 contextWindow(1048576)/maxTokens/reasoning/multimodal 未被用户改动 → 不落盘
    expect(m.contextWindow).toBeUndefined();
    expect(m.maxTokens).toBeUndefined();
    expect(m.reasoning).toBeUndefined();
    expect(m.multimodal).toBeUndefined();
  });

  it('F-02: 用户显式改动的字段仍落盘（差异写入不受影响）', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    const list = renderPane(cfg, patches);
    await waitForCatalog(list);
    const user = userEvent.setup();
    await user.click(screen.getByTitle('编辑模型配置'));
    const ctxInput = await screen.findByPlaceholderText('留空自动使用模型的上下文窗口');
    await user.clear(ctxInput);
    await user.type(ctxInput, '131072');
    await user.click(screen.getByLabelText('支持图片输入（多模态）')); // 预填 true → 显式关闭
    await user.click(screen.getByRole('button', { name: '保存' }));
    const patch = patches.at(-1) as { llm: LlmConfig };
    const m = patch.llm.providers[0]!.models[0]!;
    expect(m.contextWindow).toBe(131072);
    expect(m.multimodal).toBe(false);
    expect(m.name).toBe('DeepSeek V4 Pro'); // 未改字段保持原值
  });

  it('清空已配置的窗口后保存，模型重新跟随目录', async () => {
    currentApiMock().override('config.piCatalog', async () => CATALOG);
    const { cfg, patches } = makeCfg();
    cfg.llm!.providers[0]!.models[0]!.contextWindow = 32000;
    const list = renderPane(cfg, patches);
    await waitFor(() => expect(list.querySelector('.llm-provider[data-provider-id="deepseek"]')?.getAttribute('data-catalog')).toBe('true'));
    const user = userEvent.setup();
    await user.click(screen.getByTitle('编辑模型配置'));
    await user.clear(await screen.findByDisplayValue('32000'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(patches.at(-1)!.llm!.providers[0]!.models[0]!.contextWindow).toBeUndefined();
  });

  it('F-03: 存量「目录 id + 网关端点」不被目录收编（baseUrl 可编辑、协议/思考面板保留）', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg } = makeCfg({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek via 网关',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'sk-gw',
          api: 'openai-responses',
          models: [{ id: 'deepseek-v4-pro', name: 'V4P' }],
          enabled: true
        }
      ],
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-v4-pro'
    });
    const list = renderPane(cfg, []);
    await waitForCatalog(list);
    const ds = list.querySelector('.llm-provider[data-provider-id="deepseek"]') as HTMLElement;
    expect(ds.getAttribute('data-catalog')).toBe(null);
    expect(within(ds).queryByText('pi 目录')).toBeNull();
    expect(within(ds).getByDisplayValue('https://gw.example.com/v1')).toBeTruthy(); // 可编辑 input 而非只读 span
    expect(within(ds).getByText('API 格式')).toBeTruthy();
    expect(within(ds).getByText('高级 · 思考强度映射')).toBeTruthy();
  });
});

describe('模型服务商 · 添加重复模型 ID 的覆盖确认（F-06）', () => {
  it('第一次保存只亮提示不落盘，改按钮为「确认覆盖」，二次点击才替换同 ID 模型', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    renderPane(cfg, patches);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '＋ 添加模型' }));
    const dialog = (await waitFor(() => {
      const el = document.querySelector('.llm-model-dialog') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;
    await user.type(
      within(dialog).getByPlaceholderText('例如: mimo-v2.5-pro / gpt-4o'),
      'deepseek-v4-pro'
    );
    // 输入即提示同 ID（未保存前只是警示）
    expect(await within(dialog).findByText('模型 ID 已存在：deepseek-v4-pro')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    // 第一次保存：不落盘、不关弹窗，转为覆盖确认面（还原即红：旧实现直接覆盖且关弹窗）
    expect(
      await within(dialog).findByText(/再次点击「确认覆盖」将替换同 ID 的现有模型配置/)
    ).toBeTruthy();
    expect(patches).toHaveLength(0);
    const confirm = within(dialog).getByRole('button', { name: '确认覆盖' });
    await user.click(confirm);
    const patch = patches.at(-1) as { llm: LlmConfig };
    expect(patch.llm.providers[0]!.models.filter((m) => m.id === 'deepseek-v4-pro')).toHaveLength(1);
    await waitFor(() => expect(document.querySelector('.llm-model-dialog')).toBeNull());
  });

  it('改用未占用 ID 时直接保存，不出现覆盖确认面', async () => {
    currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
    const { cfg, patches } = makeCfg();
    renderPane(cfg, patches);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '＋ 添加模型' }));
    const dialog = (await waitFor(() => {
      const el = document.querySelector('.llm-model-dialog') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;
    await user.type(
      within(dialog).getByPlaceholderText('例如: mimo-v2.5-pro / gpt-4o'),
      'brand-new-model'
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const patch = patches.at(-1) as { llm: LlmConfig };
    expect(patch.llm.providers[0]!.models.some((m) => m.id === 'brand-new-model')).toBe(true);
    expect(document.querySelector('.llm-model-dialog')).toBeNull();
  });
});


it('模型服务商与文件输入作为纵向分区同时显示并保留草稿和搜索锚点', async () => {
  currentApiMock().override('config.piCatalog', () => Promise.resolve(CATALOG));
  const user = userEvent.setup();
  const { cfg } = makeCfg();
  function Harness() {
    const [draft, setDraft] = React.useState(cfg);
    return <KeybindingProvider><ModelProviderPane cfg={draft} set={patch => setDraft(current => ({ ...current, ...patch }))}/></KeybindingProvider>;
  }
  const { rerender } = render(<Harness/>);
  expect(screen.queryByRole('group', { name: '模型与输入分类' })).toBeNull();
  const providerRegion = screen.getByRole('region', { name: '模型服务商' });
  const inputRegion = screen.getByRole('region', { name: '文件与输入' });
  expect(within(providerRegion).getByRole('heading', { name: '模型服务商', level: 2 })).toBeTruthy();
  expect(within(inputRegion).getByRole('heading', { name: '文件与输入', level: 2 })).toBeTruthy();
  expect(providerRegion.compareDocumentPosition(inputRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.clear(screen.getByLabelText('供应商名称'));
  await user.type(screen.getByLabelText('供应商名称'), 'Draft provider');
  expect(within(inputRegion).getByRole('heading', { name: '文件限制', level: 3 })).toBeTruthy();
  expect(within(inputRegion).getByRole('heading', { name: '文档预览', level: 3 })).toBeTruthy();
  expect(within(inputRegion).getByRole('heading', { name: '视频画面', level: 3 })).toBeTruthy();
  expect(inputRegion.querySelector('[data-settings-item="agent-input-processing"]')).toBeTruthy();
  expect(inputRegion.querySelector('[data-settings-item="agent-input-tools"]')).toBeTruthy();
  const frames = within(inputRegion).getByLabelText('视频最多抽帧数') as HTMLInputElement;
  await user.clear(frames); await user.type(frames, '3');
  expect((screen.getByLabelText('供应商名称') as HTMLInputElement).value).toBe('Draft provider');
  rerender(<Harness/>);
  expect((within(screen.getByRole('region', { name: '文件与输入' })).getByLabelText('视频最多抽帧数') as HTMLInputElement).value).toBe('3');
});
