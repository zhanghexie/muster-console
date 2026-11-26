import { SettingsResourceItem, SettingsResourceStatus, SettingsDetailSection } from './SettingsResource';
import { SearchBar } from '../SearchBar';
import { BrandLoading } from '../BrandLoader';
import type React from 'react';
import { ErrorTip } from '../ErrorTip';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppConfig,
  LlmApiProtocol,
  LlmConfig,
  LlmModelConfig,
  LlmProviderConfig,
  LlmTestResult,
  LlmThinkingFormat
} from '../../../../shared/types';
import { LLM_THINKING_FORMATS } from '../../../../shared/types';
import type { PiCatalogModel, PiCatalogView } from '../../../../shared/piCatalog';
import { indexModelInputSpecifications, normalizePiBaseUrl, piAccountEndpoint, piProviderPresetId, resolveCoreModelInput } from '../../../../shared/piCatalog';
import { CustomSelect } from '../CustomSelect';
import { AppConfirmDialog } from '../AppConfirmDialog';
import { SettingsDetailHeader } from './SettingsDetailHeader';
import { AdvancedDetails, FieldRow, SettingRow, SettingsSection, Switch } from './shared';
import { usePresence } from '../motion';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { AttachmentProcessingSettings } from './AttachmentProcessingSettings';
import { AttachmentToolsSettings } from './AttachmentToolsSettings';
import { SettingsContent } from './SettingsContent';
import { ProviderModelCatalogPicker } from './ProviderModelCatalogPicker';

/** thinking 单字段变更统一入口：改完按「四字段全空则整个收掉」归一（levels/effort 开关/方言/off 关闭） */
function mutateThinking(
  target: LlmProviderConfig,
  update: (t: NonNullable<LlmProviderConfig['thinking']>) => void
): void {
  const t: NonNullable<LlmProviderConfig['thinking']> = {
    ...(target.thinking ?? { levels: {} })
  };
  update(t);
  if (!t.levels || Object.keys(t.levels).length === 0) delete t.levels;
  // reasoningEffortField 是三态：true/false 显式下发 compat，undefined=交 pi 自动探测
  if (typeof t.reasoningEffortField !== 'boolean') delete t.reasoningEffortField;
  if (!t.thinkingFormat) delete t.thinkingFormat;
  if (t.disableAtOff !== true) delete t.disableAtOff;
  if (Object.keys(t).length === 0) delete target.thinking;
  else target.thinking = t;
}

const PRESET_PROVIDERS: Array<{
  name: string;
  id: string;
  baseUrl: string;
  api?: LlmApiProtocol;
  models: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
    multimodal?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
}> = [
  {
    name: '小米 MiMo 开放平台 (官方)',
    id: 'xiaomi',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'mimo-v2.5',
        name: 'MiMo-V2.5 (1M·多模态)',
        contextWindow: 1048576,
        maxTokens: 131072,
        reasoning: true,
        multimodal: true
      },
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro (1M·多模态旗舰)',
        contextWindow: 1000000,
        maxTokens: 131072,
        reasoning: true,
        multimodal: true
      },
      {
        id: 'mimo-v2-flash',
        name: 'MiMo-V2-Flash (256k)',
        contextWindow: 262144,
        maxTokens: 65536,
        reasoning: true,
        multimodal: false
      },
      {
        id: 'mimo-v2-pro',
        name: 'MiMo-V2-Pro (1M)',
        contextWindow: 1048576,
        maxTokens: 131072,
        reasoning: true,
        multimodal: false
      },
      {
        id: 'mimo-v2-omni',
        name: 'MiMo-V2-Omni (256k·多模态)',
        contextWindow: 262144,
        maxTokens: 131072,
        reasoning: true,
        multimodal: true
      }
    ]
  },
  {
    name: '智谱 BigModel',
    id: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', multimodal: true, contextWindow: 128000, maxTokens: 4096 },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', contextWindow: 128000, maxTokens: 4096 },
      { id: 'glm-4v-plus', name: 'GLM-4V Plus', multimodal: true, contextWindow: 128000, maxTokens: 4096 }
    ]
  },
  {
    name: 'DeepSeek 官方',
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 65536 },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, maxTokens: 65536, reasoning: true }
    ]
  },
  {
    name: 'OpenAI 官方 (Responses API)',
    id: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', multimodal: true, contextWindow: 128000, maxTokens: 16384 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', multimodal: true, contextWindow: 128000, maxTokens: 16384 },
      { id: 'o1', name: 'o1', reasoning: true, multimodal: true, contextWindow: 200000, maxTokens: 100000 },
      { id: 'o3-mini', name: 'o3-mini', reasoning: true, contextWindow: 200000, maxTokens: 100000 }
    ]
  },
  {
    name: 'OpenAI 官方 (Completions 传统)',
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', multimodal: true, contextWindow: 128000, maxTokens: 16384 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', multimodal: true, contextWindow: 128000, maxTokens: 16384 }
    ]
  },
  {
    name: 'Anthropic Claude 官方',
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', multimodal: true, contextWindow: 200000, maxTokens: 8192 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000, maxTokens: 8192 }
    ]
  },
  {
    name: 'OpenRouter',
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    models: [
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (OpenRouter)', reasoning: true, contextWindow: 65536 },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', multimodal: true, contextWindow: 200000 }
    ]
  },
  {
    name: 'SiliconFlow 硅基流动',
    id: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 65536 },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', reasoning: true, contextWindow: 65536 }
    ]
  },
  {
    name: 'Moonshot 月之暗面',
    id: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    models: [
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8192 },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32768 },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 131072 }
    ]
  },
  {
    name: '通义千问 (DashScope)',
    id: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    models: [
      { id: 'qwen-max', name: 'Qwen Max', contextWindow: 131072 },
      { id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131072 },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', multimodal: true, contextWindow: 32768 }
    ]
  },
  {
    name: '本地 Ollama',
    id: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    models: [
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
      { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', reasoning: true }
    ]
  },
  {
    name: '自定义 OpenAI 兼容',
    id: 'custom',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    models: [{ id: 'gpt-4o', name: 'gpt-4o', multimodal: true, contextWindow: 128000 }]
  }
];

import { AttachmentPolicyFields } from './AttachmentPolicyFields';

interface ModelModalState {
  attachments?: LlmModelConfig['attachments'];
  providerId: string;
  isNew: boolean;
  originalId?: string;
  id: string;
  name: string;
  contextWindow?: number | '';
  maxTokens?: number | '';
  reasoning?: boolean;
  multimodal?: boolean;
  multimodalExplicit?: true;
  advancedOpen?: boolean;
  /**
   * 编辑打开时的预填快照（model-providers F-02）：保存时逐字段与当前值比对，未改动
   * 的字段回落原模型显式值（无则不落盘）——「点一次编辑保存」不再把目录窗口/能力
   * 钉成 modelOverrides。上下文和图片输入使用独立的自动值与用户覆盖。
   */
  baseline?: { maxTokens: number | ''; reasoning: boolean };
}

/**
 * 「模型服务商」页：左侧供应商列表、右侧配置，全部随底部「保存」生效。
 * 调度提示词的编辑在「调度 Agent」页。
 */
export function ModelProviderPane({
  cfg,
  set
}: {
  cfg: AppConfig;
  set: (patch: Partial<AppConfig>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [testStates, setTestStates] = useState<
    Record<string, { testing: boolean; result?: LlmTestResult }>
  >({});
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [modelModal, setModelModal] = useState<ModelModalState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderConfig | null>(null);
  const [providerQuery, setProviderQuery] = useState('');
  /** 添加模型命中同 ID 的两步确认（F-06：静默覆盖→先提示，再次保存才覆盖） */
  const [modelOverwriteArmed, setModelOverwriteArmed] = useState(false);
  const detailPresence = usePresence(true);
  /** 添加供应商菜单搜索词（打开时清空） */
  const [addMenuQuery, setAddMenuQuery] = useState('');

  /** pi-ai 内置目录（42 provider；主进程 prime 后可用）。null=目录不可用，回落静态 preset */
  const [catalog, setCatalog] = useState<PiCatalogView | null>(null);
  useEffect(() => {
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void window.api.config.piCatalog?.().then(value => {
        if (request === generation) setCatalog(value ?? null);
      }).catch(() => { /* Retain the last usable snapshot. */ });
    };
    const off = window.api.on('agentSession:coreReasoningCatalogUpdated', load);
    load();
    return () => {
      generation++;
      off();
    };
  }, []);

  /** providerId -> modelId -> 目录元数据（徽章/预填数据源） */
  const catalogModelMap = useMemo(() => {
    const map = new Map<string, Map<string, PiCatalogModel>>();
    for (const p of catalog?.providers ?? []) {
      const inner = new Map<string, PiCatalogModel>();
      for (const m of p.models) inner.set(m.id, m);
      map.set(p.id, inner);
    }
    return map;
  }, [catalog]);

  const catalogModelOf = (providerId: string, modelId: string): PiCatalogModel | undefined =>
    (catalogModelMap.get(providerId) ?? catalogModelMap.get(piProviderPresetId(providerId)))?.get(modelId);

  const publishedInput = useMemo(() => indexModelInputSpecifications(catalog?.capabilities), [catalog?.capabilities]);
  const modelInput = (provider: LlmProviderConfig, model: LlmModelConfig) => resolveCoreModelInput(provider, model,
    publishedInput.get(model.id), catalogModelOf(provider.id, model.id),
    catalog?.providers.find(meta => meta.id === piProviderPresetId(provider.id)));

  /** providerId -> 目录官方端点（F-03 目录判定的 baseUrl 比对；缺省=目录无端点信息） */
  const catalogProviderBaseUrl = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of catalog?.providers ?? []) {
      if (p.baseUrl) map.set(p.id, p.baseUrl);
    }
    return map;
  }, [catalog]);

  /**
   * 目录供应商判定（model-providers F-03）：id 命中目录且 baseUrl 与目录官方端点一致
   * （normalizePiBaseUrl 归一化比对，与 pi 同步/探针同款真源）。存量「旧 preset id +
   * 企业网关/反代」条目不被目录收编——否则 baseUrl 只读、协议/思考控件被隐藏，
   * 端点被静默替换且无逃生门。目录无端点信息时无从比对，维持 id 命中判定（不回归）。
   */
  const isCatalogProvider = (prov: Pick<LlmProviderConfig, 'id' | 'baseUrl'>): boolean => {
    const id = catalogModelMap.has(prov.id) ? prov.id : piProviderPresetId(prov.id);
    if (!catalogModelMap.has(id)) return false;
    if (catalog?.providers.find(meta => meta.id === id)?.accountEndpointExample) {
      return !prov.baseUrl.trim() || Boolean(piAccountEndpoint(id, prov.baseUrl));
    }
    const official = catalogProviderBaseUrl.get(id);
    return !official || normalizePiBaseUrl(official) === normalizePiBaseUrl(prov.baseUrl);
  };
  const baseUrlInputId = useId();
  const modelContextInputId = useId();

  /** 添加菜单条目统一形状：目录项（api 不预填——pi 侧由目录决定协议）或静态 preset */
  interface AddMenuEntry {
    id: string;
    name: string;
    baseUrl: string;
    api?: LlmApiProtocol;
    modelCount?: number;
    /** pi 目录原生条目（模型配置只存 id/name，价格窗口等由目录与徽章按 id 查） */
    fromCatalog?: boolean;
    models: Array<{
      id: string;
      name: string;
      reasoning?: boolean;
      multimodal?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  }
  const addMenuEntries = useMemo<{ builtin: AddMenuEntry[]; extras: AddMenuEntry[] }>(() => {
    if (!catalog) {
      return {
        builtin: PRESET_PROVIDERS.filter((p) => p.id !== 'custom').map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          api: p.api,
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            multimodal: m.multimodal,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens
          }))
        })),
        extras: []
      };
    }
    const builtinIds = new Set(catalog.providers.map((p) => p.id));
    return {
      builtin: catalog.providers
        .filter((p) => p.authMethods.includes('apiKey') && p.models.length > 0)
        .map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl || '',
          modelCount: p.models.length,
          fromCatalog: true,
          models: p.models.map((m) => ({ id: m.id, name: m.name || m.id }))
        })),
      // 目录可用时常显的本地/其他项（custom 除外——底部已有自定义入口）
      extras: PRESET_PROVIDERS.filter((p) => !builtinIds.has(p.id) && p.id !== 'custom').map(
        (p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          api: p.api,
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            multimodal: m.multimodal,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens
          }))
        })
      )
    };
  }, [catalog]);

  /** 搜索过滤：按供应商名称/id/模型 id 命中（大小写不敏感） */
  const addMenuFiltered = useMemo(() => {
    const q = addMenuQuery.trim().toLowerCase();
    if (!q) return addMenuEntries;
    const hit = (e: AddMenuEntry) =>
      e.name.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.models.some((m) => m.id.toLowerCase().includes(q));
    return {
      builtin: addMenuEntries.builtin.filter(hit),
      extras: addMenuEntries.extras.filter(hit)
    };
  }, [addMenuEntries, addMenuQuery]);

  // 模型编辑弹窗打开时 Esc 关内层（overlay 栈顶，先于设置壳）
  useOverlayDismiss(!!modelModal, () => setModelModal(null));
  useOverlayDismiss(showAddMenu, () => setShowAddMenu(false));

  const getProviderInitial = (provider: { id: string; name: string }): string => {
    const name = (provider.name || provider.id || '?').trim();
    return name.charAt(0).toUpperCase();
  };

  const updateLlm = (updater: (prev: LlmConfig) => LlmConfig): void => {
    const currentLlm: LlmConfig = cfg.llm || {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: cfg.openai.baseUrl || 'https://api.deepseek.com',
          apiKey: cfg.openai.apiKey || '',
          models: [
            {
              id: cfg.openai.model || 'deepseek-v4-pro',
              name: cfg.openai.model || 'deepseek-v4-pro'
            }
          ],
          enabled: true
        }
      ],
      activeProviderId: 'deepseek',
      activeModelId: cfg.openai.model || 'deepseek-v4-pro'
    };
    const nextLlm = updater(structuredClone(currentLlm));
    const activeP =
      nextLlm.providers.find((p) => p.id === nextLlm.activeProviderId) || nextLlm.providers[0];
    const activeM =
      activeP?.models.find((m) => m.id === nextLlm.activeModelId) || activeP?.models[0];
    set({
      llm: nextLlm,
      openai: {
        baseUrl: activeP?.baseUrl || '',
        apiKey: activeP?.apiKey || '',
        model: activeM?.id || ''
      }
    });
  };

  const handleAddPreset = (entry: AddMenuEntry): void => {
    let createdId = entry.id;
    updateLlm((llm) => {
      let newId = entry.id;
      let counter = 1;
      while (llm.providers.some((p) => p.id === newId)) {
        newId = `${entry.id}_${counter++}`;
      }
      createdId = newId;
      const newProvider: LlmProviderConfig = {
        id: newId,
        name: entry.name,
        baseUrl: entry.baseUrl,
        apiKey: '',
        // 目录原生条目不预填 api：pi 侧由目录决定各模型协议；静态项保留原协议
        ...(entry.api ? { api: entry.api } : {}),
        // New providers start with no selected model. The catalog is only a source
        // of candidates; the user explicitly chooses which models to add.
        models: [],
        enabled: true
      };
      llm.providers.push(newProvider);
      return llm;
    });
    setShowAddMenu(false);
    setSelectedProviderId(createdId);
  };

  const handleAddCustomProvider = (): void => {
    let customId = 'custom';
    updateLlm((llm) => {
      let counter = 1;
      while (llm.providers.some((p) => p.id === customId)) {
        customId = `custom_${counter++}`;
      }
      const newProvider: LlmProviderConfig = {
        id: customId,
        name: t('自定义供应商'),
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        api: 'openai-completions',
        // New custom providers also start empty; add a model manually or refresh
        // the endpoint and select candidates from its returned directory.
        models: [],
        enabled: true
      };
      llm.providers.push(newProvider);
      return llm;
    });
    setShowAddMenu(false);
    setSelectedProviderId(customId);
  };

  const handleTestProvider = async (provider: LlmProviderConfig): Promise<void> => {
    setTestStates((prev) => ({ ...prev, [provider.id]: { testing: true } }));
    try {
      const res = await window.api.config.testLlm({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.models[0]?.id,
        api: provider.api
      });
      setTestStates((prev) => ({ ...prev, [provider.id]: { testing: false, result: res } }));
    } catch (e) {
      setTestStates((prev) => ({
        ...prev,
        [provider.id]: { testing: false, result: { ok: false, error: (e as Error).message } }
      }));
    }
  };

  const openAddModel = (providerId: string): void => {
    setModelModal({
      providerId,
      isNew: true,
      id: '',
      name: '',
      maxTokens: '',
      reasoning: false,
      advancedOpen: false
    });
  };

  const openEditModel = (providerId: string, model: LlmModelConfig): void => {
    // 显式缺省时预填目录当前值（未保存前不落 config）；baseline 记预填快照，保存时
    // 只落用户差异字段，预填值不当显式覆盖写回（F-02 防钉死目录）
    const cat = catalogModelOf(providerId, model.id);
    const prefill: NonNullable<ModelModalState['baseline']> = {
      maxTokens: model.maxTokens ?? cat?.maxTokens ?? '',
      reasoning: model.reasoning ?? cat?.reasoning ?? false
    };
    setModelModal({
      providerId,
      isNew: false,
      originalId: model.id,
      id: model.id,
      name: model.name || model.id,
      ...prefill,
      baseline: prefill,
      contextWindow: model.contextWindow,
      multimodal: model.multimodal,
      multimodalExplicit: model.multimodalExplicit,
      attachments: model.attachments,
      advancedOpen: !!(
        model.maxTokens ||
        model.reasoning ||
        model.multimodal ||
        cat?.maxTokens ||
        cat?.reasoning
      )
    });
  };

  const handleSaveModelModal = (): void => {
    if (!modelModal || !modelModal.id.trim()) return;
    const { providerId, isNew, originalId, id, name, contextWindow, maxTokens, reasoning, baseline } = modelModal;
    const cleanId = id.trim();
    const cleanName = name.trim() || cleanId;
    // F-06：新增命中同 ID 不再静默覆盖——第一次保存只亮提示，再次保存才覆盖（与删除供应商同款两步确认）
    if (isNew && !modelOverwriteArmed) {
      const dup = llmProviders
        .find((p) => p.id === providerId)
        ?.models.some((m) => m.id === cleanId);
      if (dup) {
        setModelOverwriteArmed(true);
        return;
      }
    }
    const ctxVal = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined;
    const maxVal = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : undefined;

    updateLlm((llm) => {
      const prov = llm.providers.find((p) => p.id === providerId);
      if (!prov) return llm;
      // F-02：与打开时的 baseline 比对——未改动字段回落原模型显式值（无则不落盘），
      // 只写用户差异。已核验端点的图片能力自动继承，只有实际选择才形成覆盖。
      const targetId = isNew ? cleanId : originalId || cleanId;
      const orig = isNew ? undefined : prov.models.find((m) => m.id === targetId);
      const sameNum = (cur: number | '' | undefined, base: number | '' | undefined) =>
        (typeof cur === 'number' && cur > 0 ? cur : '') ===
        (typeof base === 'number' && base > 0 ? base : '');
      const maxFinal = baseline
        ? sameNum(maxTokens, baseline.maxTokens)
          ? orig?.maxTokens
          : maxVal
        : maxVal;
      const reasoningFinal = baseline
        ? (reasoning ?? false) === baseline.reasoning
          ? orig?.reasoning
          : reasoning
            ? true
            : undefined
        : reasoning
          ? true
          : undefined;
      const multimodal = modalInput?.imageOverride;
      const modelPayload: LlmModelConfig = {
        id: cleanId,
        name: cleanName,
        contextWindow: ctxVal,
        maxTokens: maxFinal,
        reasoning: reasoningFinal,
        multimodal,
        ...(multimodal !== undefined && modelModal.multimodalExplicit ? { multimodalExplicit: true } : {}),
        attachments: modelModal.attachments
      };

      if (isNew) {
        const idx = prov.models.findIndex((m) => m.id === cleanId);
        if (idx >= 0) {
          prov.models[idx] = modelPayload;
        } else {
          prov.models.push(modelPayload);
        }
      } else {
        const idx = prov.models.findIndex((m) => m.id === targetId);
        if (idx >= 0) {
          prov.models[idx] = modelPayload;
        } else {
          prov.models.push(modelPayload);
        }
        if (llm.activeProviderId === providerId && llm.activeModelId === targetId) {
          llm.activeModelId = cleanId;
        }
      }
      return llm;
    });
    setModelModal(null);
  };

  // 新增模型的同 ID 确认态随 ID/弹窗变化复位：改了 ID 或重开弹窗都要重新确认
  useEffect(() => {
    setModelOverwriteArmed(false);
  }, [modelModal?.id, modelModal?.isNew, modelModal?.providerId, modelModal === null]);

  const handleRemoveModel = (providerId: string, modelId: string): void => {
    updateLlm((llm) => {
      const prov = llm.providers.find((p) => p.id === providerId);
      if (prov && prov.models.length > 1) {
        prov.models = prov.models.filter((m) => m.id !== modelId);
        if (llm.activeProviderId === providerId && llm.activeModelId === modelId) {
          llm.activeModelId = prov.models[0].id;
        }
      }
      return llm;
    });
  };

  const handleRemoveProvider = (providerId: string): void => {
    updateLlm((llm) => {
      if (llm.providers.length <= 1) return llm;
      const nextProviders = llm.providers.filter((p) => p.id !== providerId);
      llm.providers = nextProviders;
      if (llm.activeProviderId === providerId) {
        llm.activeProviderId = nextProviders[0].id;
        llm.activeModelId = nextProviders[0].models[0]?.id || 'default';
      }
      return llm;
    });
    // 如果当前选中的是被删除的服务商，自动切到第一个剩余服务商
    if (selectedProviderId === providerId) {
      const remaining = (cfg?.llm?.providers || []).filter((p) => p.id !== providerId);
      if (remaining.length > 0) {
        setSelectedProviderId(remaining[0].id);
      }
    }
  };

  const handleSetActive = (providerId: string, modelId?: string): void => {
    updateLlm((llm) => {
      llm.activeProviderId = providerId;
      const prov = llm.providers.find((p) => p.id === providerId);
      if (prov) {
        llm.activeModelId = modelId || prov.models[0]?.id || 'default';
      }
      return llm;
    });
  };

  const llmProviders: LlmProviderConfig[] = cfg.llm?.providers?.length
    ? cfg.llm.providers
    : [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: cfg.openai.baseUrl || 'https://api.deepseek.com',
          apiKey: cfg.openai.apiKey || '',
          api: 'openai-completions',
          models: [
            {
              id: cfg.openai.model || 'deepseek-v4-pro',
              name: cfg.openai.model || 'deepseek-v4-pro'
            }
          ],
          enabled: true
        }
      ];

  /** 新增模型时命中的同 ID 模型（F-06：覆盖前必须显式确认） */
  const duplicateModelId =
    modelModal?.isNew && modelModal.id.trim()
      ? llmProviders
          .find((p) => p.id === modelModal.providerId)
          ?.models.find((m) => m.id === modelModal.id.trim())?.id
      : undefined;

  const activeGlobalProviderId = cfg.llm?.activeProviderId || 'deepseek';
  const effectiveSelectedId =
    selectedProviderId && llmProviders.some((p) => p.id === selectedProviderId)
      ? selectedProviderId
      : llmProviders.some((p) => p.id === activeGlobalProviderId)
        ? activeGlobalProviderId
        : llmProviders[0]?.id || 'deepseek';

  const currentProvider = llmProviders.find((p) => p.id === effectiveSelectedId) || llmProviders[0];
  const modalProvider = modelModal && llmProviders.find(provider => provider.id === modelModal.providerId);
  const modalInput = modelModal && modalProvider && modelInput(modalProvider, {
    ...modalProvider.models.find(model => model.id === modelModal.originalId),
    id: modelModal.id.trim(), multimodal: modelModal.multimodal, multimodalExplicit: modelModal.multimodalExplicit
  });
  const isSelectedActive = activeGlobalProviderId === currentProvider.id;
  const testState = testStates[currentProvider.id];
  const isShowKey = showApiKey[currentProvider.id] ?? false;

  return (
    <SettingsContent>
    <AppConfirmDialog open={!!deleteTarget} title={t('删除此供应商')}
      detail={deleteTarget?.name} confirmLabel={t('确认删除')} danger
      onCancel={() => setDeleteTarget(null)} onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); if (target) handleRemoveProvider(target.id); }}/>
    <div className="settings-section llm-section model-input-settings">
      <SettingsSection
        title={t('模型服务商')}
        item="agent-provider"
        desc={t('配置调度 Agent 与内置 Agent 使用的模型；外部 Agent 的账号在各自设置中管理。')}
        side={
          <div className="llm-add-anchor">
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                if (!showAddMenu) setAddMenuQuery('');
                setShowAddMenu(!showAddMenu);
              }}
            >
              {t('＋ 添加供应商')}
            </button>
            {showAddMenu ? (
              <div className="llm-add-menu-panel">
                <div className="llm-add-menu-header">
                  <span>{catalog ? t('pi 模型目录（{{n}} 家，按目录配置）', { n: addMenuEntries.builtin.length }) : t('选择模板或自定义')}</span>
                  <button
                    type="button"
                    className="llm-add-menu-close"
                    aria-label={t('关闭')}
                    onClick={() => setShowAddMenu(false)}
                  >
                    ×
                  </button>
                </div>
                <input
                  type="text"
                  className="s-input llm-add-menu-search"
                  value={addMenuQuery}
                  autoFocus
                  placeholder={t('搜索供应商或模型…')}
                  aria-label={t('搜索供应商或模型')}
                  onChange={(e) => setAddMenuQuery(e.target.value)}
                />
                <div className="llm-add-menu-items">
                  {addMenuFiltered.builtin.length + addMenuFiltered.extras.length === 0 && (
                    <div className="llm-add-menu-empty">{t('无匹配供应商')}</div>
                  )}
                  {addMenuFiltered.builtin.map((entry) => {
                    const already = llmProviders.some((p) => p.id === entry.id);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        className="llm-add-menu-item"
                        disabled={already}
                        data-already-added={already || undefined}
                        title={already ? t('已添加') : entry.baseUrl}
                        onClick={() => handleAddPreset(entry)}
                      >
                        <span className="llm-sidebar-avatar llm-add-menu-avatar" aria-hidden>
                          {getProviderInitial(entry)}
                        </span>
                        <span className="llm-add-menu-label">{t(entry.name)}</span>
                        {entry.modelCount !== undefined && (
                          <span className="llm-add-menu-count">{entry.modelCount}</span>
                        )}
                        {already && <span className="llm-add-menu-added">{t('已添加')}</span>}
                      </button>
                    );
                  })}
                  {addMenuFiltered.extras.length > 0 && (
                    <div className="llm-add-menu-group-title">{t('本地与其他')}</div>
                  )}
                  {addMenuFiltered.extras.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="llm-add-menu-item"
                      disabled={llmProviders.some((p) => p.id === entry.id)}
                      onClick={() => handleAddPreset(entry)}
                    >
                      <span className="llm-sidebar-avatar llm-add-menu-avatar" aria-hidden>
                        {getProviderInitial(entry)}
                      </span>
                      <span className="llm-add-menu-label">{t(entry.name)}</span>
                    </button>
                  ))}
                  {!addMenuQuery.trim() && (
                    <>
                      <div className="llm-add-menu-group-title">{t('自定义')}</div>
                      <button
                        type="button"
                        className="llm-add-menu-item is-custom"
                        onClick={handleAddCustomProvider}
                      >
                        <span className="llm-sidebar-avatar llm-add-menu-avatar" aria-hidden>
                          +
                        </span>
                        <span className="llm-add-menu-label">{t('添加自定义供应商')}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        }
      >
        <div className="llm-provider-layout">
        <div className="settings-split llm-provider-list settings-resource-layout">
          <nav className="settings-split-nav settings-resource-nav" aria-label={t('供应商')}>
            <SearchBar aria-label={t('搜索供应商')} placeholder={t('搜索供应商…')} value={providerQuery} onChange={setProviderQuery}/>
            <div className="settings-split-list settings-resource-items">
              {llmProviders.filter(prov => `${prov.name} ${prov.id} ${prov.baseUrl}`.toLocaleLowerCase().includes(providerQuery.trim().toLocaleLowerCase())).map((prov) => (
                <SettingsResourceItem key={prov.id} name={prov.name} selected={prov.id === effectiveSelectedId}
                  className="settings-split-item llm-provider-choice" title={prov.name}
                  icon={<span className="llm-sidebar-avatar">{getProviderInitial(prov)}</span>}
                  meta={<><SettingsResourceStatus state={prov.enabled !== false ? 'success' : 'neutral'}>{prov.enabled !== false ? t('已启用') : t('已停用')}</SettingsResourceStatus>{activeGlobalProviderId === prov.id && <span>★ {t('默认')}</span>}</>}
                  onClick={() => { setSelectedProviderId(prov.id); setDeleteTarget(null); }}/>

              ))}
            </div>
          </nav>
          {llmProviders.filter((prov) => prov.id === effectiveSelectedId).map((prov) => {
            const isDefault = activeGlobalProviderId === prov.id;
            const isEnabled = prov.enabled !== false;
            // 目录供应商：baseUrl/协议/思考档由 pi 目录决定，收成「填 Key 即用」；
            // F-03：端点与目录不一致的存量条目按自定义处理（控件保留、可改端点）
            const isCatalog = isCatalogProvider(prov);
            const catalogMeta = catalog?.providers.find(meta => meta.id === piProviderPresetId(prov.id));
            const accountEndpointExample = catalogMeta?.accountEndpointExample;
            return (
              <section key={prov.id} className="llm-provider settings-split-main settings-resource-detail mp-panel" {...detailPresence.spread} aria-label={prov.name} data-provider-id={prov.id} data-catalog={isCatalog || undefined}>
                <SettingsDetailHeader title={prov.name} icon={<span className="llm-sidebar-avatar">{getProviderInitial(prov)}</span>} meta={<>
                  {isCatalog && (
                    <span className="s-tag" title={accountEndpointExample ? undefined : t('按 pi 模型目录配置：地址、协议、思考档与价格由目录决定，只需填写 API Key')}>
                      {t('pi 目录')}
                    </span>
                  )}
                  {isDefault && (
                    <span className="s-tag" title={t('默认服务商')}>
                      ★ {t('默认')}
                    </span>
                  )}
                  <SettingsResourceStatus state={isEnabled ? 'success' : 'neutral'}>{isEnabled ? t('已启用') : t('已停用')}</SettingsResourceStatus>
                </>}/>
                  <div className="llm-provider-body">
                    <SettingsDetailSection title={t('基本信息')}>
                    <FieldRow label={t('名称')}>
                      <input className="s-input" aria-label={t('供应商名称')} value={prov.name}
                        onChange={(e) => updateLlm((llm) => {
                          const target = llm.providers.find((p) => p.id === prov.id);
                          if (target) target.name = e.target.value;
                          return llm;
                        })} />
                    </FieldRow>
                    <SettingRow title={t('启用')} desc={t('禁用后聊天与定时任务都不再选用它')}>
                      <Switch
                        label={t('启用 {{name}}', { name: prov.name })}
                        checked={isEnabled}
                        onChange={(checked) => {
                          updateLlm((llm) => {
                            const target = llm.providers.find((p) => p.id === prov.id);
                            if (target) target.enabled = checked;
                            return llm;
                          });
                        }}
                      />
                    </SettingRow>
                    <SettingRow title={t('默认服务商')}>
                      {isSelectedActive ? (
                        <span className="llm-badge-default-active">{t('默认服务商')}</span>
                      ) : (
                        <button type="button" className="btn tiny" onClick={() => handleSetActive(currentProvider.id)}>
                          {t('设为默认')}
                        </button>
                      )}
                    </SettingRow>

                    </SettingsDetailSection>
                    <SettingsDetailSection title={t('连接配置')}>
                    {isCatalog && !accountEndpointExample ? (
                      <FieldRow label="Base URL" item="agent-base-url">
                        <span className="llm-readonly-url mono" title={currentProvider.baseUrl}>
                          {currentProvider.baseUrl}
                        </span>
                      </FieldRow>
                    ) : (
                      <FieldRow label={<label htmlFor={baseUrlInputId}>Base URL</label>} item="agent-base-url">
                        <input
                          id={baseUrlInputId}
                          type="url"
                          className="s-input mono"
                          value={currentProvider.baseUrl}
                          placeholder={accountEndpointExample || 'https://api.example.com/v1'}
                          onChange={(e) => {
                            const val = e.target.value;
                            updateLlm((llm) => {
                              const target = llm.providers.find((p) => p.id === currentProvider.id);
                              if (target) target.baseUrl = val;
                              return llm;
                            });
                          }}
                        />
                      </FieldRow>
                    )}

                    {!isCatalog && (
                      <SettingRow item="agent-api-format" title={t('API 格式')} desc={t('大多数三方服务选第一个就行')}>
                        <CustomSelect
                          className="s-select is-wide"
                          ariaLabel={t('API 格式')}
                          value={currentProvider.api || 'openai-completions'}
                          onChange={(v) => {
                            const val = v as LlmApiProtocol;
                            updateLlm((llm) => {
                              const target = llm.providers.find((p) => p.id === currentProvider.id);
                              if (target) target.api = val;
                              return llm;
                            });
                          }}
                          options={[
                            {
                              value: 'openai-completions',
                              label: t('Chat Completions (/v1/chat/completions) - 兼容大部分第三方')
                            },
                            { value: 'openai-responses', label: t('Responses (/responses) - OpenAI 官方新格式') },
                            { value: 'anthropic-messages', label: t('Anthropic Messages (/v1/messages) - Claude 官方格式') },
                            { value: 'google-generative-ai', label: t('Google Generative AI - Gemini 格式') },
                            { value: 'mistral-conversations', label: t('Mistral Conversations - Mistral 格式') },
                            { value: 'azure-openai-responses', label: t('Azure OpenAI Responses - 微软 Azure 格式') }
                          ]}
                        />
                      </SettingRow>
                    )}

                    <FieldRow label="API Key" item="agent-api-key">
                      <div className="llm-password-input-wrap">
                        <input
                          type={isShowKey ? 'text' : 'password'}
                          className="s-input llm-password-input"
                          value={currentProvider.apiKey}
                          placeholder="sk-…"
                          onChange={(e) => {
                            const val = e.target.value;
                            updateLlm((llm) => {
                              const target = llm.providers.find((p) => p.id === currentProvider.id);
                              if (target) target.apiKey = val;
                              return llm;
                            });
                          }}
                        />
                        <button
                          type="button"
                          className="btn tiny"
                          title={isShowKey ? t('隐藏明文') : t('显示明文')}
                          onClick={() =>
                            setShowApiKey((prev) => ({
                              ...prev,
                              [currentProvider.id]: !isShowKey
                            }))
                          }
                        >
                          {isShowKey ? t('隐藏') : t('显示')}
                        </button>
                      <button
                        type="button"
                        className="btn tiny"
                        disabled={testState?.testing || !currentProvider.baseUrl || !currentProvider.apiKey}
                        onClick={() => void handleTestProvider(currentProvider)}
                      >
                        {testState?.testing ? <BrandLoading>{t('测试中…')}</BrandLoading> : t('测试连通性')}
                      </button>
                      </div>
                      {testState?.result && (testState.result.ok ? (
                        <p className="llm-connection-result is-ok" role="status">{t('✔ 连通测试成功 ({{durationMs}}ms)', { durationMs: testState.result.durationMs })}</p>
                      ) : <ErrorTip message={t('✖ 连通失败: {{error}}', { error: testState.result.error })} />)}
                    </FieldRow>

                    {!isCatalog && (
                      <AdvancedDetails item="agent-thinking-map" summary={t('高级 · 思考强度映射')}>
                      {(currentProvider.api || 'openai-completions') === 'openai-completions' && (
                        <SettingRow title={t('developer 角色支持')} desc={t('自定义端点默认使用 system；服务商明确支持时，可为推理模型启用 developer。')}>
                          <CustomSelect
                            className="s-select"
                            ariaLabel={t('developer 角色支持')}
                            value={currentProvider.compat?.supportsDeveloperRole === undefined ? '' : String(currentProvider.compat.supportsDeveloperRole)}
                            onChange={(value) => updateLlm((llm) => {
                              const target = llm.providers.find((p) => p.id === currentProvider.id);
                              if (target) {
                                if (value === '') delete target.compat;
                                else target.compat = { supportsDeveloperRole: value === 'true' };
                              }
                              return llm;
                            })}
                            options={[
                              { value: '', label: t('默认（system）') },
                              { value: 'false', label: t('不支持（system）') },
                              { value: 'true', label: t('支持（developer）') }
                            ]}
                          />
                        </SettingRow>
                      )}
                      <div className="llm-thinking-map-row">
                        {(['off', 'low', 'medium', 'high', 'max'] as const).map((lv) => (
                          <label key={lv} className="llm-thinking-map-cell">
                            <span className="llm-thinking-map-level">
                              {lv === 'off'
                                ? t('关闭')
                                : lv === 'low'
                                  ? t('低')
                                  : lv === 'medium'
                                    ? t('中')
                                    : lv === 'high'
                                      ? t('高')
                                      : t('最高')}
                            </span>
                            <input
                              type="text"
                              className="s-input"
                              value={currentProvider.thinking?.levels?.[lv] ?? ''}
                              placeholder={t('不可用')}
                              onChange={(e) => {
                                const val = e.target.value;
                                updateLlm((llm) => {
                                  const target = llm.providers.find((p) => p.id === currentProvider.id);
                                  if (!target) return llm;
                                  mutateThinking(target, (t) => {
                                    if (!t.levels) t.levels = {};
                                    if (val) t.levels[lv] = val;
                                    else delete t.levels[lv];
                                  });
                                  return llm;
                                });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <SettingRow
                        title={t('请求以 reasoning_effort 字段发送')}
                        desc={t('默认交 pi 按端点自动探测；网关不认该字段报 400 时再关闭')}
                      >
                        <Switch
                          label={t('请求以 reasoning_effort 字段发送（默认交 pi 按端点自动探测；网关不认该字段报 400 时再关闭）')}
                          checked={currentProvider.thinking?.reasoningEffortField === true}
                          onChange={(checked) => {
                            updateLlm((llm) => {
                              const target = llm.providers.find((p) => p.id === currentProvider.id);
                              if (!target) return llm;
                              mutateThinking(target, (t) => {
                                t.reasoningEffortField = checked;
                              });
                              return llm;
                            });
                          }}
                        />
                      </SettingRow>
                      {(currentProvider.api || 'openai-completions') === 'openai-completions' && (
                        <SettingRow title={t('思考方言')} desc={t('不同厂商对思考参数的叫法不同')}>
                          <CustomSelect
                            className="s-select"
                            ariaLabel={t('思考方言')}
                            value={currentProvider.thinking?.thinkingFormat ?? ''}
                            onChange={(v) => {
                              updateLlm((llm) => {
                                const target = llm.providers.find((p) => p.id === currentProvider.id);
                                if (!target) return llm;
                                mutateThinking(target, (t) => {
                                  if (v) t.thinkingFormat = v as LlmThinkingFormat;
                                  else delete t.thinkingFormat;
                                });
                                return llm;
                              });
                            }}
                            options={[
                              { value: '', label: t('自动（按服务商 baseUrl 探测）') },
                              ...LLM_THINKING_FORMATS.map((f) => ({ value: f, label: f }))
                            ]}
                          />
                        </SettingRow>
                      )}
                      {(currentProvider.api || 'openai-completions') === 'openai-completions' &&
                        (currentProvider.id.toLowerCase().includes('deepseek') ||
                          /deepseek\.com/i.test(currentProvider.baseUrl) ||
                          currentProvider.thinking?.thinkingFormat === 'deepseek') && (
                          <SettingRow
                            title={t('off 档真正关闭思考')}
                            desc={t('DeepSeek 系专属；GLM-5.3/OpenAI 协议层禁止关闭思考')}
                          >
                            <Switch
                              label={t('off 档真正关闭思考（DeepSeek 系专属；GLM-5.3/OpenAI 协议层禁止关闭思考）')}
                              checked={currentProvider.thinking?.disableAtOff === true}
                              onChange={(checked) => {
                                updateLlm((llm) => {
                                  const target = llm.providers.find((p) => p.id === currentProvider.id);
                                  if (!target) return llm;
                                  mutateThinking(target, (t) => {
                                    if (checked) t.disableAtOff = true;
                                    else delete t.disableAtOff;
                                  });
                                  return llm;
                                });
                              }}
                            />
                          </SettingRow>
                        )}
                      </AdvancedDetails>
                    )}

                    </SettingsDetailSection>
                    <SettingsDetailSection title={t('模型列表')} desc={<>★ = {t('默认模型')}</>} item="agent-models">
                    {!currentProvider.models.length && <p className="settings-hint llm-model-empty-hint">{t('尚未添加模型，请从目录选择或手动添加。')}</p>}
                    <div className="llm-model-card-list">
                      {currentProvider.models.map((m) => {
                        const isCurrentActiveModel =
                          isSelectedActive &&
                          (cfg.llm?.activeModelId || cfg.openai.model) === m.id;
                        const cat = catalogModelOf(currentProvider.id, m.id);
                        const input = modelInput(currentProvider, m);
                        const isReasoning = m.reasoning ?? cat?.reasoning ?? false;
                        const ctxTokens = input.contextWindow;
                        const contextDisplay = ctxTokens >= 1_000_000
                          ? `${Number((ctxTokens / (ctxTokens % 1048576 === 0 ? 1048576 : 1_000_000)).toFixed(2))}M`
                          : ctxTokens >= 1024 ? `${Math.round(ctxTokens / 1024)}k` : `${ctxTokens}`;

                        return (
                          <div
                            key={m.id}
                            className={`llm-model-row-item${isCurrentActiveModel ? ' is-active' : ''}`}
                          >
                            <div className="llm-model-row-left">
                              {isCurrentActiveModel && (
                                <span className="llm-model-star-badge" title={t('当前激活模型')}>
                                  ★
                                </span>
                              )}
                              <span className="llm-model-row-id" title={m.id}>
                                {m.id}
                              </span>
                              {m.name && m.name !== m.id && (
                                <span className="llm-model-row-name">({m.name})</span>
                              )}
                            </div>

                            <div className="llm-model-row-right">
                              <span className="llm-model-badge-ctx" title={String(ctxTokens)}>{contextDisplay}</span>
                              {input.input.some(kind => kind !== 'text') && (
                                <span className="llm-model-meta-tag" title={input.input.join(' / ')}>
                                  {t('多模态')}
                                </span>
                              )}
                              {isReasoning && (
                                <span className="llm-model-meta-tag" title={t('深度思考 (Reasoning)')}>
                                  {t('思考')}
                                </span>
                              )}

                              {!isCurrentActiveModel && (
                                <button
                                  type="button"
                                  className="llm-model-tool-btn"
                                  title={t('设为此供应商默认模型')}
                                  onClick={() => handleSetActive(currentProvider.id, m.id)}
                                >
                                  {t('默认')}
                                </button>
                              )}

                              <button
                                type="button"
                                className="llm-model-tool-btn"
                                title={t('编辑模型配置')}
                                onClick={() => openEditModel(currentProvider.id, m)}
                              >
                                {t('编辑')}
                              </button>

                              {currentProvider.models.length > 1 && (
                                <button
                                  type="button"
                                  className="llm-model-tool-btn is-delete"
                                  title={t('移除模型')}
                                  onClick={() => handleRemoveModel(currentProvider.id, m.id)}
                                >
                                  {t('删除')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="llm-add-model-row">
                      <button
                        type="button"
                        className="btn ghost tiny"
                        onClick={() => {
                          openAddModel(currentProvider.id);
                        }}
                      >
                        {t('＋ 添加模型')}
                      </button>
                      <ProviderModelCatalogPicker
                        provider={{ id: currentProvider.id, baseUrl: currentProvider.baseUrl, apiKey: currentProvider.apiKey,
                          api: isCatalog ? catalogMeta?.api ?? currentProvider.api : currentProvider.api }}
                        models={currentProvider.models}
                        builtin={isCatalog ? catalogModelMap.get(catalogMeta?.id ?? currentProvider.id) : undefined}
                        onAdd={model => updateLlm(llm => {
                          const provider = llm.providers.find(item => item.id === currentProvider.id);
                          if (provider && !provider.models.some(item => item.id === model.id)) provider.models.push(model);
                          return llm;
                        })}/>
                    </div>

                    </SettingsDetailSection>
                    {llmProviders.length > 1 ? (
                      <SettingRow
                        divided
                        title={<span style={{ color: 'var(--status-danger-fg)' }}>{t('删除这个供应商')}</span>}
                        desc={t('用到它的定时任务会改用默认服务商')}
                      >
                        <button
                          type="button"
                          className="btn danger tiny"
                          title={t('删除此供应商')}
                          onClick={() => setDeleteTarget(currentProvider)}
                        >
                          {t('删除')}
                        </button>
                      </SettingRow>
                    ) : null}
                  </div>
              </section>
            );
          })}
        </div>
        </div>
      </SettingsSection>
      <SettingsSection title={t('文件与输入')}>
        <div className="attachment-input-groups">
          <AttachmentProcessingSettings value={cfg.attachmentProcessing} onChange={attachmentProcessing => set({ attachmentProcessing })} />
          <AttachmentToolsSettings value={cfg.attachmentTools} onChange={attachmentTools => set({ attachmentTools })} />
        </div>
      </SettingsSection>

      {/* ===== 编辑 / 添加模型配置 Modal 弹窗 ===== */}
      {modelModal && (
        <div
          className="modal-mask llm-modal-overlay"
          onClick={() => setModelModal(null)}
        >
          <div
            className="modal llm-model-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="llm-dialog-header">
              <h4>{modelModal.isNew ? t('添加模型配置') : t('编辑模型配置')}</h4>
              <button
                type="button"
                className="icon-btn"
                aria-label={t('关闭')}
                onClick={() => setModelModal(null)}
              >
                ×
              </button>
            </div>

            <div className="llm-dialog-body">
              <div className="llm-dialog-field">
                <label className="llm-dialog-label">{t('模型 ID')}</label>
                <input
                  type="text"
                  className="llm-field-input"
                  value={modelModal.id}
                  placeholder={t('例如: mimo-v2.5-pro / gpt-4o')}
                  onChange={(e) =>
                    setModelModal((prev) => (prev ? { ...prev, id: e.target.value } : null))
                  }
                />
                {modelModal.isNew && duplicateModelId ? (
                  <p className="llm-dialog-warn" role="alert">
                    {modelOverwriteArmed
                      ? t('再次点击「确认覆盖」将替换同 ID 的现有模型配置')
                      : t('模型 ID 已存在：{{id}}', { id: duplicateModelId })}
                  </p>
                ) : null}
              </div>

              <div className="llm-dialog-field">
                <label className="llm-dialog-label">{t('显示名称 (可选)')}</label>
                <input
                  type="text"
                  className="llm-field-input"
                  value={modelModal.name}
                  placeholder={modelModal.id || t('模型展示别名')}
                  onChange={(e) =>
                    setModelModal((prev) => (prev ? { ...prev, name: e.target.value } : null))
                  }
                />
              </div>

              <div className="llm-dialog-field">
                <div className="llm-dialog-label-row">
                  <label className="llm-dialog-label" htmlFor={modelContextInputId}>{t('上下文窗口')}</label>
                  <div className="llm-quick-ctx-group">
                    {[
                      { label: '64k', val: 65536 },
                      { label: '128k', val: 131072 },
                      { label: '256k', val: 262144 },
                      { label: '1M', val: 1000000 }
                    ].map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="llm-quick-ctx-btn"
                        onClick={() =>
                          setModelModal((prev) =>
                            prev ? { ...prev, contextWindow: item.val } : null
                          )
                        }
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  id={modelContextInputId}
                  type="number"
                  className="llm-field-input"
                  value={modelModal.contextWindow ?? modalInput?.contextWindow ?? ''}
                  placeholder={t('留空自动使用模型的上下文窗口')}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value, 10) : '';
                    setModelModal((prev) =>
                      prev ? { ...prev, contextWindow: val } : null
                    );
                  }}
                />
              </div>

              <div className="llm-dialog-accordion">
                <button
                  type="button"
                  className="llm-accordion-btn"
                  onClick={() =>
                    setModelModal((prev) =>
                      prev ? { ...prev, advancedOpen: !prev.advancedOpen } : null
                    )
                  }
                >
                  <span>{modelModal.advancedOpen ? '▾' : '▸'} {t('高级')}</span>
                </button>

                {modelModal.advancedOpen && (
                  <div className="llm-accordion-body">
                    <div className="llm-dialog-field">
                      <label className="llm-dialog-label">{t('最大输出 Token')}</label>
                      <input
                        type="number"
                        className="llm-field-input"
                        value={modelModal.maxTokens}
                        placeholder={t('例如 131072 或 8192')}
                        onChange={(e) => {
                          const val = e.target.value ? parseInt(e.target.value, 10) : '';
                          setModelModal((prev) =>
                            prev ? { ...prev, maxTokens: val } : null
                          );
                        }}
                      />
                    </div>

                    <div className="llm-dialog-checkbox-group">
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={modelModal.reasoning ?? false}
                          onChange={(e) =>
                            setModelModal((prev) =>
                              prev ? { ...prev, reasoning: e.target.checked } : null
                            )
                          }
                        />
                        <span>{t('深度思考模型 (Reasoning)')}</span>
                      </label>

                      <div className="llm-dialog-label-row">
                        <label className="settings-check">
                          <input
                            type="checkbox"
                            checked={modalInput?.multimodal ?? true}
                            onChange={(e) =>
                              setModelModal((prev) =>
                                prev ? { ...prev, multimodal: e.target.checked, multimodalExplicit: true } : null
                              )
                            }
                          />
                          <span>{t('支持图片输入（多模态）')}</span>
                        </label>
                        {modalInput?.imageOverride !== undefined && (
                          <button type="button" className="llm-quick-ctx-btn"
                            onClick={() => setModelModal(prev => prev ? { ...prev, multimodal: undefined, multimodalExplicit: undefined } : null)}>
                            {t('恢复默认')}
                          </button>
                        )}
                      </div>
                      <AttachmentPolicyFields value={modelModal.attachments}
                        onChange={attachments => setModelModal(prev => prev ? { ...prev, attachments } : null)} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="llm-dialog-footer">
              <button
                type="button"
                className="btn"
                onClick={() => setModelModal(null)}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!modelModal.id.trim()}
                onClick={handleSaveModelModal}
              >
                {modelModal.isNew && duplicateModelId && modelOverwriteArmed
                  ? t('确认覆盖')
                  : t('保存')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </SettingsContent>
  );
}
