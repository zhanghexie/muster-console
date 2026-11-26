import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
/** Dedicated Pi SDK worker. Business tools and policy remain in the parent. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { ModeController } from '../../../agent/providers/modeExtension';
import { setSkillsManagementService } from '../../../capabilityManagement/runtimeSkills';
import type { SkillsManagementService } from '../../../capabilityManagement/skills';
import type { GuiDriverConnectInput, GuiDriverStreamEvent, GuiRuntimeConnection, GuiSendImage } from '../../types';
import { loadPiSdk } from './piSdk';
import { PiWorkerEngine } from './workerEngine';
import { createPiWorkerToolExecutor, PiWorkerDesktopDelivery } from './childDesktopDelivery';
import { PiWorkerCaptureImages } from './captureImages';
import type { VisibleAcknowledgementOutcome } from '../../../desktop/visibleActionCoordinator';
import { PI_WORKER_IMAGE_CHUNK_CHARS, PI_WORKER_MAX_IMAGE_CHARS, PI_WORKER_MAX_MESSAGE_BYTES, PI_WORKER_MAX_PENDING, type PiMemorySnapshot, type PiWorkerCreate, type PiWorkerModeState, type PiWorkerRequest, type PiWorkerResponse } from './workerProtocol';

if (!process.send) throw new Error('Pi worker requires a parent IPC channel');

const generation = new AsyncLocalStorage<number>();
const eventGeneration = new WeakMap<GuiDriverStreamEvent, number>();
const hostPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
let nextHostId = 1;
let connection: GuiRuntimeConnection | undefined;
let modeController: ModeController | undefined;
let memory: PiMemorySnapshot | undefined;
let thinking: ReturnType<NonNullable<GuiDriverConnectInput['getThinkingLevel']>> = null;
let closing = false;
let creating = false;
let identityChallenged = false;
let activeGeneration: number | undefined;
let imageBatch: { generation: number; chars: number; images: Map<number, { mimeType: string; name?: string; parts: string[]; expected: number }> } | undefined;
let latestSkillSnapshot: { managed: boolean; paths: string[]; globalPaths: string[] } = { managed: false, paths: [], globalPaths: [] };
let skillPolicyId: string | undefined;
let outboundBytes = 0;
let sending = false;
const outbound: Array<{ value: PiWorkerResponse; bytes: number }> = [];

function fatal(message: string): never {
  process.stderr.write(`Pi worker: ${message}\n`);
  process.exit(1);
}

function drain(): void {
  if (sending || !outbound.length || !process.connected || !process.send) return;
  const next = outbound.shift()!;
  outboundBytes -= next.bytes;
  sending = true;
  process.send(next.value, error => {
    sending = false;
    if (error) fatal(`IPC send failed: ${error.message}`);
    drain();
  });
}

function post(value: PiWorkerResponse): void {
  if (!process.connected) throw new Error('Pi worker parent IPC is closed');
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > PI_WORKER_MAX_MESSAGE_BYTES || outboundBytes + bytes > PI_WORKER_MAX_MESSAGE_BYTES * 2 || outbound.length >= 128)
    fatal('IPC output limit exceeded');
  outbound.push({ value, bytes });
  outboundBytes += bytes;
  drain();
}

function callHost(method: string, args?: unknown, signal?: AbortSignal, sourceGeneration?: number): Promise<unknown> {
  if (closing || signal?.aborted) return Promise.reject(new Error('Pi host callback cancelled'));
  if (hostPending.size >= PI_WORKER_MAX_PENDING) return Promise.reject(new Error('Too many Pi host callbacks'));
  const id = nextHostId++;
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const pending = hostPending.get(id);
      if (!pending) return;
      hostPending.delete(id);
      pending.cleanup();
      try { post({ type: 'host-cancel', id }); } catch { /* parent already closed */ }
      reject(new Error('Pi host callback cancelled'));
    };
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    hostPending.set(id, { resolve, reject, cleanup });
    signal?.addEventListener('abort', abort, { once: true });
    try { post({ type: 'host-call', id, generation: sourceGeneration ?? generation.getStore(), method, args }); }
    catch (error) { hostPending.delete(id); cleanup(); reject(error as Error); }
  });
}

const desktopDelivery = new PiWorkerDesktopDelivery(() => activeGeneration, () => !closing && !!process.connected,
  async (receipt, signal): Promise<VisibleAcknowledgementOutcome> => {
    const result = await callHost('desktop.deliveryAck', receipt, signal, receipt.generation) as { outcome?: unknown } | undefined;
    return result?.outcome === 'acknowledged' ? { outcome: 'acknowledged' } : { outcome: 'unknown', reason: 'current-changed' };
  }, receipt => { void callHost('desktop.deliveryAbandon', receipt, undefined, receipt.generation).catch(() => {}); });
const captureImages = new PiWorkerCaptureImages(() => activeGeneration, () => !closing && !!process.connected);

function cancelHostCalls(reason: string): void {
  for (const [id, pending] of hostPending) {
    hostPending.delete(id);
    pending.cleanup();
    try { post({ type: 'host-cancel', id }); } catch { /* parent already closed */ }
    pending.reject(new Error(reason));
  }
}

function updateMode(state: PiWorkerModeState): void {
  if (!modeController) return;
  modeController.mode = state.mode;
  modeController.executing = state.executing;
  modeController.planSteps = state.planSteps.map(step => ({ ...step }));
  modeController.applyTools?.();
}

async function create(input: PiWorkerCreate): Promise<unknown> {
  if (connection || creating) throw new Error('Pi worker already has a connection');
  creating = true;
  const cwd = input.dto.cwd;
  const agentDir = userDataStorage(input.userDataDir).resolve('app', 'muster-core');
  const pi = await loadPiSdk();
  modeController = new ModeController(input.modeState.mode);
  modeController.executing = input.modeState.executing;
  modeController.planSteps = input.modeState.planSteps.map(step => ({ ...step }));
  modeController.onPlanExtracted = value => post({ type: 'plan', generation: generation.getStore(), kind: 'extracted', value });
  modeController.onPlanUpdated = value => post({ type: 'plan', generation: generation.getStore(), kind: 'updated', value });
  modeController.onPlanCompleted = () => post({ type: 'plan', generation: generation.getStore(), kind: 'completed' });

  // The skill service lives in the main process. Admission is a closed allowlist
  // prepared there from all candidates and rechecked after each resource reload.
  const remoteService = {
    additionalSkillPaths: (projects: string[]) => projects.length ? latestSkillSnapshot.paths : latestSkillSnapshot.globalPaths,
    prepareRuntimeSkillFilter: async () => {
      const loaded = pi.loadSkills({ cwd, agentDir, skillPaths: latestSkillSnapshot.paths, includeDefaults: false });
      const candidates = [...loaded.skills];
      for (const diagnostic of loaded.diagnostics) {
        if (diagnostic.type === 'collision' && diagnostic.collision?.resourceType === 'skill') {
          candidates.push(...pi.loadSkills({ cwd, agentDir, skillPaths: [diagnostic.collision.loserPath], includeDefaults: false }).skills);
        }
      }
      const unique = [...new Map(candidates.map(skill => [skill.filePath, { filePath: skill.filePath, name: skill.name }])).values()];
      const result = await callHost('skills.filter', { candidates: unique }) as { allowed: string[]; policyId: string };
      if (!result || !Array.isArray(result.allowed) || typeof result.policyId !== 'string') throw new Error('Invalid skill policy response');
      skillPolicyId = result.policyId;
      const allowed = new Set(result.allowed);
      // runtimeSkills maps worktree skill paths back to their trusted source
      // identity before invoking a prepared filter. Admit only corresponding
      // source paths already authorized for this exact snapshot as well.
      for (const file of result.allowed) {
        for (const mapping of input.dto.workspaceContext?.mappings ?? []) {
          const relative = path.relative(mapping.worktreePath, file);
          if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
            allowed.add(path.join(mapping.sourcePath, relative));
        }
      }
      return <T extends { filePath: string }>(skills: T[]): T[] => skills.filter(skill => allowed.has(skill.filePath));
    }
  };
  const refreshSkills = async (): Promise<void> => {
    const snapshot = await callHost('skills.snapshot') as typeof latestSkillSnapshot;
    if (!snapshot || typeof snapshot.managed !== 'boolean' || !Array.isArray(snapshot.paths) || !Array.isArray(snapshot.globalPaths))
      throw new Error('Invalid skill directory snapshot');
    latestSkillSnapshot = snapshot;
    skillPolicyId = undefined;
    setSkillsManagementService(snapshot.managed ? remoteService as unknown as SkillsManagementService : undefined);
  };
  const verifySkills = async (): Promise<void> => {
    if (!latestSkillSnapshot.managed) return;
    if (!skillPolicyId) throw new Error('Managed skill policy was not prepared');
    await callHost('skills.verify', { policyId: skillPolicyId });
  };
  await refreshSkills();

  const hostTools: GuiDriverConnectInput['hostTools'] = input.tools.map(tool => ({
    ...tool,
    execute: createPiWorkerToolExecutor(tool.id, desktopDelivery, () => generation.getStore(),
      (args, signal) => callHost('tool', args, signal), captureImages)
  }));
  const driverInput: GuiDriverConnectInput = {
    ...input.dto,
    modeController,
    hostTools,
    requestApproval: request => callHost('approval', request) as ReturnType<GuiDriverConnectInput['requestApproval']>,
    ...(input.supportsQuestions ? { requestUserQuestion: request => callHost('question', request) as ReturnType<NonNullable<GuiDriverConnectInput['requestUserQuestion']>> } : {}),
    getPolicyState: (() => callHost('policy')) as unknown as GuiDriverConnectInput['getPolicyState'],
    getThinkingLevel: () => thinking,
    log: (level, message) => { void callHost('log', { level, message }).catch(() => {}); }
  };

  const engine = new PiWorkerEngine({
    userDataDir: input.userDataDir,
    resolved: { provider: { id: input.providerId }, model: { id: input.modelId } },
    providerDefaultOutput: input.providerDefaultOutput,
    shellEnv: input.shellEnv,
    memorySnapshot: () => memory,
    refreshSkills,
    verifySkills,
    attachDeliveryAgent: (agent, settings) => { desktopDelivery.attach(agent); captureImages.attach(agent, settings); },
    toolExtraContent: (name, id, signal, text) => captureImages.content(name, id, signal, text),
    onToolStart: event => captureImages.observeToolStart(event),
    markEvent: event => { const current = generation.getStore(); if (current !== undefined) eventGeneration.set(event, current); },
    captureStart: event => callHost('review.start', event).then(() => {}),
    captureEnd: event => callHost('review.end', event).then(() => {}),
    recordModelCall: value => { void callHost('usage', value).catch(() => {}); }
  });
  connection = await engine.connect(driverInput);
  creating = false;
  const current = connection;
  let lastUsageUpdate = 0;
  void (async () => {
    try {
      for await (const event of current.events) {
        const eventGen = eventGeneration.get(event);
        if (eventGen === undefined && activeGeneration !== undefined && event.type !== 'resume-token')
          throw new Error(`Pi event ${event.type} has no turn generation`);
        const includeUsage = event.type === 'turn-complete' || event.type === 'error' ||
          (event.type === 'compaction' && event.phase === 'end') || Date.now() - lastUsageUpdate >= 1000;
        if (includeUsage) lastUsageUpdate = Date.now();
        post({ type: 'event', generation: eventGen, event,
          ...(includeUsage ? { contextUsage: current.getContextUsage?.() ?? null } : {}) });
        if ((event.type === 'turn-complete' || event.type === 'error') && eventGen === activeGeneration) activeGeneration = undefined;
      }
    } catch (error) {
      if (!closing) fatal(`Event stream failed: ${(error as Error).message}`);
    }
  })();
  return { engineCapture: connection.engineCapture };
}

async function dispatch(message: PiWorkerRequest): Promise<void> {
  if (message.type === 'identity-challenge') {
    if (identityChallenged || creating || connection || closing || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce))
      throw new Error('Pi worker identity challenge is invalid or late');
    identityChallenged = true;
    post({ type: 'identity-response', nonce: message.nonce });
    return;
  }
  if (message.type === 'host-result') {
    const pending = hostPending.get(message.id);
    if (!pending) return;
    hostPending.delete(message.id);
    pending.cleanup();
    if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error || 'Pi host callback failed'));
    return;
  }
  if (message.type === 'host-cancel') {
    const pending = hostPending.get(message.id);
    if (!pending) return;
    hostPending.delete(message.id);
    pending.cleanup();
    pending.reject(new Error('Pi host callback cancelled'));
    return;
  }
  if (message.type === 'mode') { updateMode(message.state); return; }
  let result: unknown;
  try {
    if (message.operation === 'create') result = await create(message.create);
    else {
      const current = connection;
      if (!current || closing) throw new Error('Pi connection unavailable');
      if (message.operation === 'image') {
        if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index > 4095 ||
            !Number.isSafeInteger(message.part) || !Number.isSafeInteger(message.parts) || message.parts < 1 ||
            message.part < 0 || message.part >= message.parts || typeof message.data !== 'string' || message.data.length > PI_WORKER_IMAGE_CHUNK_CHARS ||
            typeof message.mimeType !== 'string') throw new Error('Pi image chunk is invalid');
        if (!imageBatch || imageBatch.generation !== message.generation)
          imageBatch = { generation: message.generation, chars: 0, images: new Map() };
        let image = imageBatch.images.get(message.index);
        if (!image) {
          if (message.part !== 0) throw new Error('Pi image chunk is out of order');
          image = { mimeType: message.mimeType, name: message.name, parts: [], expected: message.parts };
          imageBatch.images.set(message.index, image);
        }
        if (image.parts.length !== message.part || image.expected !== message.parts || image.mimeType !== message.mimeType)
          throw new Error('Pi image chunk does not match its batch');
        imageBatch.chars += message.data.length;
        if (imageBatch.chars > PI_WORKER_MAX_IMAGE_CHARS) throw new Error('Pi image batch exceeds attachment limit');
        image.parts.push(message.data);
      } else if (message.operation === 'send') {
        desktopDelivery.invalidate();
        captureImages.invalidate();
        activeGeneration = message.generation;
        memory = message.memory;
        thinking = message.thinking ?? null;
        let images: GuiSendImage[] | undefined;
        if (message.imageCount) {
          if (!imageBatch || imageBatch.generation !== message.generation || imageBatch.images.size !== message.imageCount)
            throw new Error('Pi image batch is incomplete');
          images = Array.from({ length: message.imageCount }, (_, index) => {
            const image = imageBatch!.images.get(index);
            if (!image || image.parts.length !== image.expected) throw new Error('Pi image chunks are missing');
            return { data: image.parts.join(''), mimeType: image.mimeType, ...(image.name ? { name: image.name } : {}) };
          });
        }
        imageBatch = undefined;
        await generation.run(message.generation, () => current.send(message.text, images, message.parameters, {
          forkIdentity: message.forkIdentity, literalText: message.literalText
        }));
      } else if (message.operation === 'fork') {
        if (!current.nativeFork) throw new Error('内置引擎不支持原生分叉');
        result = await current.nativeFork(message.point);
      } else if (message.operation === 'receive') {
        memory = message.memory;
        result = await generation.run(message.generation, () => current.receiveMessage?.(message.message) ?? Promise.resolve({ status: 'unsupported' }));
      } else if (message.operation === 'redirect') {
        memory = message.memory;
        result = generation.run(message.generation, () => current.redirect?.(message.text) ?? false);
      } else if (message.operation === 'compact') {
        if (!current.compact) throw new Error('Pi compaction is unavailable');
        const compact = await current.compact(message.text);
        result = { ...compact, __contextUsage: current.getContextUsage?.() ?? null };
      }
      else if (message.operation === 'abort') { imageBatch = undefined; desktopDelivery.invalidate(); captureImages.invalidate(); cancelHostCalls('Pi turn aborted'); await current.abort(); activeGeneration = undefined; }
      else if (message.operation === 'close') { imageBatch = undefined; closing = true; desktopDelivery.close(); captureImages.close(); cancelHostCalls('Pi connection closed'); await current.close(); }
    }
    post({ type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    post({ type: 'response', id: message.id, ok: false, error: (error as Error)?.message ?? String(error) });
  }
}

process.on('message', value => {
  if (!value || typeof value !== 'object') return fatal('Invalid IPC message');
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > PI_WORKER_MAX_MESSAGE_BYTES) return fatal('IPC input limit exceeded');
    void dispatch(value as PiWorkerRequest).catch(error => fatal((error as Error).message));
  } catch (error) { fatal((error as Error).message); }
});
process.once('disconnect', () => {
  closing = true;
  desktopDelivery.close();
  captureImages.close();
  cancelHostCalls('Pi parent disconnected');
  const timer = setTimeout(() => process.exit(1), 2000);
  void Promise.resolve(connection?.close()).catch(() => {}).finally(() => { clearTimeout(timer); process.exit(0); });
});
post({ type: 'ready' });
