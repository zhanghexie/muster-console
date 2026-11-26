/**
 * 扩展侧栏 caps（modeOrder=[]，会话固定 standard 档）必须压过运行时权限选项：
 * ChatSurfaceView 的 permissionView 不得让 guiPermissionOptions 把模式 chip 复活
 * （此前 caps 传了空 modeOrder 也被 pi 的权限档覆盖，底栏仍出现"标准"菜单）。
 * 运行: npx vitest run test/unit/chat-surface-extension-mode.spec.tsx
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import { currentApiMock } from './helpers/api-mock';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const guiMessages: GuiChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '问' }], ts: 100 },
  { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '答' }], ts: 200 }
];

function makeExtensionSurface(): ChatSurface {
  const snap = {
    messages: guiMessages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null,
    compactions: []
  };
  return {
    sessionId: 'ext-1',
    caps: {
      surfaceKind: 'gui-session',
      draftKey: 'ext-1',
      images: false,
      manualCompact: true,
      plusMenu: true,
      presets: false,
      modeOrder: [],
      modeLabels: {},
      modeDescriptions: {},
      modeDisabled: {},
      modeLockOnBusy: false,
      localCommands: false
    },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: async () => true,
      stop: () => undefined,
      clear: async () => undefined,
      compact: async () => ({ ok: true }),
      retry: () => undefined,
      cancelQueued: () => undefined,
      // setMode 必须在场：没有它 onModeChange 为空、chip 本来就不渲染，测不到复活路径
      setMode: () => undefined
    }
  };
}

describe('扩展 caps 压过运行时权限选项', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('modeOrder=[] 时 pi 会话也不出模式 chip', async () => {
    const mock = currentApiMock();
    mock.override('sessions.list', async () => ({ sessions: [{ id: 'ext-1', name: 'Ext fixture', runtime: 'pi', type: 'terminal', cwd: 'E:/ext', createdAt: 0 }], activeId: 'ext-1' }));
    const { container } = render(
      <StoreProvider>
        <ChatSurfaceView surface={makeExtensionSurface()} workspaceId="ws-ext" />
      </StoreProvider>
    );
    // 等会话加载完成（avatarSession 命中 pi、permissionChoices 有值），chip 也不得出现
    await waitFor(() => expect(mock.mockOf('sessions.list')).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.agent-mode-chip')).toBeNull(), { timeout: 1500 });
  });
});
