import fs from 'node:fs';
import path from 'node:path';
import type { Credential, CredentialStore, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { loadPiSdk, type PiModule } from '../../agentSession/drivers/pi/piSdk';
import { inferModelSyncDefaults, normalizePiBaseUrl } from '../../agent/piConfigSync';
import { assertKnowledgeDirectory } from '../layout';
import { redactCredentialShapes } from '../redact';
import { MEMORY_CURATOR_SYSTEM_PROMPT } from './prompt';
import { MEMORY_CURATOR_TOOL_NAMES } from './tools';
import type { CuratorPiOptions, CuratorSessionFactory } from './types';
import {curatorRequestError,parseCuratorResponse,type CuratorResponseMetadata} from './retry';
import {CuratorBudgetError,curatorContextBudget,curatorRequestLimit} from './budget';

const CURATOR_FETCH_APIS = new Set([
  'openai-completions', 'openai-responses', 'openai-codex-responses', 'azure-openai-responses',
  'anthropic-messages', 'mistral-conversations', 'pi-messages'
]);
const RETRY_RESPONSE_HEADERS = [
  'retry-after', 'resetat', 'reset-at', 'x-reset-at', 'x-ratelimit-reset-at', 'x-quota-reset-at',
  'ratelimit-reset', 'x-ratelimit-reset', 'x-rate-limit-reset', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'
];

/** Observe HTTP failures before provider clients turn them into lossy error messages. */
export function curatorResponseOptions(api: string, options: SimpleStreamOptions | undefined,
  observe: (metadata: CuratorResponseMetadata | undefined) => void): SimpleStreamOptions {
  const next: SimpleStreamOptions = {
    ...options,
    async onResponse(response, model) {
      observe(response.status < 200 || response.status >= 300 ? parseCuratorResponse(response) : undefined);
      await options?.onResponse?.(response, model);
    }
  };
  // Google explicitly rejects custom fetch; unknown adapters must retain their own transport.
  if (CURATOR_FETCH_APIS.has(api)) {
    const requestFetch = options?.fetch ?? globalThis.fetch;
    next.fetch = async (...args) => {
      const response = await requestFetch(...args);
      if (response.status < 200 || response.status >= 300) {
        const headers: Record<string, string> = {};
        for (const name of RETRY_RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        observe(parseCuratorResponse({ status: response.status, headers }));
      } else observe(undefined);
      // Return the exact response. Its body and request signal belong to the provider adapter.
      return response;
    };
  }
  return next;
}

/** Deliberately implements ResourceLoader instead of configuring discovery and hoping it stays empty. */
export function createCuratorResourceLoader(pi: Pick<PiModule, 'createExtensionRuntime'>): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: pi.createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => MEMORY_CURATOR_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources(paths) {
      if (Object.values(paths).some(value => value?.length)) throw new Error('专用记忆会话禁止加载额外资源');
    },
    async reload() { /* No disk, packages, AGENTS, skills, templates or extensions are discovered. */ }
  };
}

function credentialsFor(providerId: string, key: string): CredentialStore {
  const values = new Map<string, Credential>([[providerId, { type: 'api_key', key }]]);
  return {
    async read(id) { return values.get(id); },
    async list() { return [...values].map(([id, value]) => ({ providerId: id, type: value.type })); },
    async modify(id, fn) { const next = await fn(values.get(id)); if (next) values.set(id, next); return values.get(id); },
    async delete(id) { values.delete(id); }
  };
}

export function createMemoryCuratorPiFactory(options: CuratorPiOptions): CuratorSessionFactory {
  return async input => {
    const pi = await loadPiSdk();
    const config = options.config(), selected = options.targetModel?.();
    const providerId = selected?.providerId || config.llm?.activeProviderId;
    const provider = config.llm?.providers.find(p => p.id === providerId && p.enabled !== false);
    const modelId = selected?.modelId || config.llm?.activeModelId;
    const configuredModel = provider?.models.find(m => m.id === modelId);
    if (!provider || !configuredModel || !provider.apiKey.trim() || !provider.baseUrl.trim()) throw new Error('记忆会话缺少可用模型或凭据，请在模型设置中配置');
    assertKnowledgeDirectory(input.root, input.directory);
    const sessionDirectory = path.join(input.directory, 'sessions');
    const agentDirectory = options.agentDirectory ?? path.join(input.directory, 'pi-home');
    assertKnowledgeDirectory(input.root, agentDirectory);
    assertKnowledgeDirectory(input.root, sessionDirectory);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.mkdirSync(agentDirectory, { recursive: true });
    if (input.sessionFile) {
      const relative = path.relative(sessionDirectory, path.resolve(input.sessionFile));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(input.sessionFile)
        || !fs.lstatSync(input.sessionFile).isFile() || fs.lstatSync(input.sessionFile).isSymbolicLink()) throw new Error('记忆会话转录路径无效或已丢失');
    }
    const modelRuntime = await pi.ModelRuntime.create({
      credentials: credentialsFor(provider.id, provider.apiKey), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false
    });
    const api = provider.api ?? 'openai-completions';
    const baseUrl = api === 'openai-completions' || api === 'openai-responses'
      ? normalizePiBaseUrl(provider.baseUrl) : provider.baseUrl.trim().replace(/\/+$/, '');
    const defaults = inferModelSyncDefaults(configuredModel.id, configuredModel);
    const budget=curatorContextBudget(configuredModel),requestLimit=curatorRequestLimit(input.maxModelRequests);
    modelRuntime.registerProvider(provider.id, {
      name: provider.name, baseUrl, api, authHeader: true,
      models: [{ id: configuredModel.id, name: configuredModel.name || configuredModel.id, ...defaults,
        contextWindow:budget.contextWindow,maxTokens:budget.outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(api === 'openai-completions' ? { compat: {
          ...(provider.thinking?.thinkingFormat ? { thinkingFormat: provider.thinking.thinkingFormat } : {}),
          ...(provider.thinking?.reasoningEffortField === false ? { supportsReasoningEffort: false } : {})
        } } : {}) }]
    });
    const model = modelRuntime.getModel(provider.id, configuredModel.id);
    if (!model) throw new Error('记忆会话模型注册失败');
    let requests = 0, runError: Error | undefined, active = false,responseFailure:CuratorResponseMetadata|undefined,budgetFailure:CuratorBudgetError|undefined;
    const stream = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = ((...args: Parameters<typeof stream>) => {
      if (!active) throw new Error('记忆会话当前没有宿主任务');
      if(requests>=requestLimit){budgetFailure=new CuratorBudgetError('requests');throw budgetFailure;}
      try{input.beforeModelRequest?.();}catch(error){if(error instanceof CuratorBudgetError)budgetFailure=error;throw error;}
      // Conservative character bound covers restored history and tool schemas, including content
      // that never appeared in the public transcript. Rotation happens through the host queue.
      if (JSON.stringify(args[1]).length > budget.inputCharacters){budgetFailure=new CuratorBudgetError('context');throw budgetFailure;}
      requests++; input.onEvent({ type: 'model-start' });
      responseFailure=undefined;
      return stream(args[0],args[1],curatorResponseOptions(args[0].api,args[2],metadata=>{responseFailure=metadata;}));
    }) as typeof modelRuntime.streamSimple;
    const names = input.tools.map(t => t.name).sort();
    if (names.join('|') !== [...MEMORY_CURATOR_TOOL_NAMES].sort().join('|')) throw new Error('记忆会话工具白名单不匹配');
    const customTools = input.tools.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.parameters as ToolDefinition['parameters'],
      async execute(_id: string, args: Record<string, unknown>, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const result = await tool.execute(args, signal);
        return { content: [{ type: 'text' as const, text: redactCredentialShapes(JSON.stringify(result) ?? 'null').text }], details: {} };
      }
    })) as ToolDefinition[];
    const manager = input.sessionFile ? pi.SessionManager.open(input.sessionFile, sessionDirectory, input.root)
      : pi.SessionManager.create(input.root, sessionDirectory);
    const file = manager.getSessionFile();
    // The SDK normally delays creating the file until its first assistant response. Reopen our
    // durable header through its public API so its flush state agrees with the existing file.
    if (file && !fs.existsSync(file)) {
      fs.writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      manager.setSessionFile(file);
    }
    const { session } = await pi.createAgentSession({
      cwd: input.root, agentDir: agentDirectory, modelRuntime, model, thinkingLevel: 'off',
      scopedModels: [{ model, thinkingLevel: 'off' }], sessionManager: manager,
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
        hideThinkingBlock: true, enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false,
        packages: [], extensions: [], skills: [], prompts: [], defaultTools: [], images: { blockImages: true }
      }),
      resourceLoader: createCuratorResourceLoader(pi), noTools: 'builtin', tools: names,
      excludeTools: ['read','write','edit','bash','powershell','grep','find','ls'], customTools
    });
    if (session.getActiveToolNames().sort().join('|') !== names.join('|')) { session.dispose(); throw new Error('记忆会话实际工具集越界'); }
    const unsubscribe = session.subscribe(event => {
      if (!active) return;
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        input.onEvent({ type: 'text-delta', text: event.assistantMessageEvent.delta });
      } else if (event.type === 'tool_execution_start') {
        input.onEvent({ type: 'tool-start', id: event.toolCallId, name: event.toolName, input: event.args as Record<string, unknown> });
      } else if (event.type === 'tool_execution_end') {
        const result = event.result as { content?: Array<{ type: string; text?: string }> };
        input.onEvent({ type: 'tool-result', id: event.toolCallId, output: redactCredentialShapes((result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')).text, isError: event.isError });
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted' || event.message.stopReason === 'length') runError = curatorRequestError(new Error(event.message.errorMessage || '记忆模型请求未完成或输出截断'),responseFailure);
        input.onEvent({ type: 'usage', inputTokens: event.message.usage.input, outputTokens: event.message.usage.output });
      }
    });
    return {
      id: manager.getSessionId(), file: manager.getSessionFile(),
      model: { providerId: provider.id, modelId: configuredModel.id, name: configuredModel.name || configuredModel.id },
      async run(job, signal) {
        if (active) throw new Error('记忆会话只允许串行执行');
        signal.throwIfAborted(); requests = 0; runError = undefined;responseFailure=undefined;budgetFailure=undefined; active = true;
        const abort = () => { void session.abort(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (job.kind === 'user') await session.sendUserMessage(job.text, { expandPromptTemplates: false });
          else await session.sendCustomMessage({ customType: job.kind==='repair'?'memory-receipt-repair':'memory-candidate', content: job.text, display: false, details: { purpose: 'memory' } }, { triggerTurn: true });
          signal.throwIfAborted();if(budgetFailure)throw budgetFailure;if (runError) throw runError;
        } catch(error){if(budgetFailure)throw budgetFailure;if(error instanceof CuratorBudgetError)throw error;throw curatorRequestError(error,responseFailure);
        } finally { active = false; signal.removeEventListener('abort', abort); }
      },
      async abort() { await session.abort(); },
      dispose() { unsubscribe(); session.dispose(); }
    };
  };
}
