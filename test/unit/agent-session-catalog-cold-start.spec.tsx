import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { listClaudeModels } from '../../src/main/agentSession/drivers/claude/models';
import { configureModelCatalogStorage } from '../../src/main/agentSession/modelCatalogCache';
import type { ChatSurface, SessionHarnessModelExpected } from '../../src/shared/chatSurface';
import type { HarnessPickerRequest, HarnessPickerResult } from '../../src/shared/harnessPicker';
import { currentApiMock } from './helpers/api-mock';
import { overrideGuiHistory } from './helpers/gui-history-range';

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  supportedModels: vi.fn(async () => [{ value: 'fixture-sonnet', displayName: 'Fixture Sonnet', supportedEffortLevels: ['high'] }])
}));

vi.mock('../../src/main/agentSession/drivers/claude/claudeSdk', () => ({
  resolveUserClaudeExecutable: () => null,
  resolveClaudeExecutable: async () => ({ ok: true }),
  loadClaudeSdk: async () => ({
    query: ({ options }: { options: { spawnClaudeCodeProcess: (request: { command: string }) => unknown } }) => {
      options.spawnClaudeCodeProcess({ command: 'fixture-claude' });
      return { supportedModels: native.supportedModels, close: () => undefined };
    }
  })
}));

vi.mock('../../src/main/agentSession/process/controlledChild', () => ({
  createControlledChild: () => {
    native.spawn();
    return { child: { stderr: { resume: () => undefined } }, ready: Promise.resolve(), reclaim: async () => undefined };
  }
}));

it('restores the persisted Claude catalog after a cold history response without starting discovery', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-catalog-cold-'));
  const source = path.join(fixture, 'source');
  const worktree = path.join(fixture, 'worktree');
  const profile = path.join(fixture, 'profile');
  const home = vi.spyOn(os, 'homedir').mockReturnValue(fixture);
  const override = { providerId: 'claude', modelId: 'fixture-sonnet' };
  const discovery = { cwd: source, userDataDir: profile, isolateConfig: true };
  let view: ReturnType<typeof render> | undefined;
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(worktree);
    configureModelCatalogStorage(profile);
    expect(await listClaudeModels({ ...discovery, refresh: true })).toMatchObject({ ok: true });
    expect(native.spawn).toHaveBeenCalledTimes(1);
    configureModelCatalogStorage(profile);
    expect(await listClaudeModels({ ...discovery, cwd: worktree, refresh: false })).toMatchObject({ ok: false });

    const api = currentApiMock();
    overrideGuiHistory(api, async () => ({ mode: 'auto', busy: false, modelOverride: override,
      messages: [{ id: 'old', role: 'user', parts: [{ kind: 'text', text: 'Existing history' }], ts: 1 }] }));
    api.override('agentSession.getHarnessModelSelections', async () => ({}));
    let resolveIdentity!: (value: { ok: true; expected: SessionHarnessModelExpected }) => void;
    const identity = new Promise<{ ok: true; expected: SessionHarnessModelExpected }>(resolve => { resolveIdentity = resolve; });
    api.override('agentSession.getSessionHarnessModelState', () => identity);
    api.override('agentSession.listSessionHarnessModels', async (request: { expected: SessionHarnessModelExpected; refresh?: boolean }) => {
      const cwd = request.expected.catalogCwd ?? request.expected.cwd;
      const result = await listClaudeModels({ ...discovery, cwd, refresh: request.refresh });
      return { ...result, runtimeId: 'claude' };
    });
    api.override('agentSession.readHarnessPickerCatalog', async (request: HarnessPickerRequest): Promise<HarnessPickerResult> => {
      expect(request).toMatchObject({ sessionId: 'cold-claude', refresh: false });
      const result = await listClaudeModels({ ...discovery, refresh: request.refresh });
      if (!result.ok) return result;
      const selected = result.items.find(item => item.id === request.model?.modelId);
      return { ok: true, catalog: {
        harness: { harnessId: 'claude-code', runtimeId: 'claude', surface: 'gui' },
        source: { workspaceId: 'ws', rootId: 'root', rootsRevision: 0, cwd: source },
        state: 'ready', defaultModel: null, selectedModel: override, selectedParameters: {}, sessionStamp: 'session-stamp',
        canRefresh: true, canSetModel: true,
        models: result.items.map(item => ({ providerId: 'claude', modelId: item.id, label: item.name })),
        parameterState: selected ? 'ready' : 'not-requested', parameters: selected ? [{
          descriptor: { id: 'reasoning', label: 'Effort', apply: 'reconnect', supportsDefault: true,
            options: selected.effortLevels.map(value => ({ value, label: value })) },
          override: null, effectiveValue: null, source: 'engine'
        }] : []
      } };
    });

    const surface: { current: ChatSurface | null } = { current: null };
    function Harness() {
      surface.current = useAgentSessionSurface({ sessionId: 'cold-claude', runtimeId: 'claude', visible: true });
      return <ChatSurfaceView surface={surface.current} workspaceId="ws" findEnabled={false} />;
    }
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    await act(async () => { view = render(<StoreProvider><Harness /></StoreProvider>); });
    await waitFor(() => expect(surface.current?.getSnapshot().messages).toHaveLength(1));
    await act(async () => {
      resolveIdentity({ ok: true, expected: { runtimeId: 'claude', cwd: worktree, catalogCwd: source,
        workspaceFingerprint: 'workspace', engineFingerprint: 'engine', modelOverride: override } });
    });

    await waitFor(() => expect(surface.current?.getSnapshot().status?.harnessModelCatalog).toMatchObject({
      state: 'ready', items: [{ id: 'fixture-sonnet', name: 'Fixture Sonnet' }]
    }));
    const reads = api.mockOf('agentSession.listSessionHarnessModels');
    expect(reads).toHaveBeenCalledWith(expect.objectContaining({ refresh: false,
      expected: expect.objectContaining({ cwd: worktree, catalogCwd: source }) }));
    expect(reads).not.toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));

    const trigger = document.querySelector<HTMLButtonElement>('.agent-composer-model-trigger');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    await screen.findByRole('option', { name: 'Fixture Sonnet' });
    await screen.findByText('high');
    expect(api.mockOf('agentSession.readHarnessPickerCatalog')).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'cold-claude', refresh: false, model: override
    }));
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(native.supportedModels).toHaveBeenCalledTimes(1);
  } finally {
    view?.unmount();
    vi.unstubAllGlobals();
    home.mockRestore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
