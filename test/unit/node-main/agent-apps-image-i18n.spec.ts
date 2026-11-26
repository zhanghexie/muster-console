import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import { applyLocaleSetting } from '../../../src/shared/i18n';

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: mocks.showOpenDialog } }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, fn: (...args: any[]) => any) => mocks.handlers.set(channel, fn) }));
import { registerAgentAppsIpc } from '../../../src/main/ipc/agentApps';

describe('phone image IPC localization', () => {
  afterEach(() => { applyLocaleSetting('zh-CN'); mocks.handlers.clear(); vi.clearAllMocks(); });
  it('localizes the native picker and validation while keeping ownership checks', async () => {
    applyLocaleSetting('en');
    const window = { webContents: { id: 42 } };
    const importImage = vi.fn(async () => ({ id: 'asset' }));
    registerAgentAppsIpc({ getWindow: () => window, agentApps: { importImage } } as unknown as AppContext);
    const pick = mocks.handlers.get('agentApps:pickImage')!;
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['chosen.png'] });
    await expect(pick({ sender: { id: 42 } }, 'ws', 'app')).resolves.toEqual({ canceled: false, asset: { id: 'asset' } });
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({ title: 'Choose image', filters: [expect.objectContaining({ name: 'Image' })] }));
    await expect(pick({ sender: { id: 99 } }, 'ws', 'app')).rejects.toThrow('Images can only be selected from the local workbench window.');
    expect(() => mocks.handlers.get('agentApps:dropImage')!({ sender: { id: 42 } }, 'ws', 'app', '')).toThrow('Could not read the dropped local image.');
    expect(importImage).toHaveBeenCalledOnce();
  });
});
