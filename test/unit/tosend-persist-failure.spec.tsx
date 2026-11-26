/**
 * send-queue F-02：手动确认清单 localStorage 写失败（配额满/隐私模式）不得静默——
 * notifyComposerError 一次性提示「清单未能保存」（连续失败不刷屏；写恢复后可再提示）。
 * 红绿：stash src/renderer/src/components/agentComposer/useTosendQueue.ts 后断言红。
 * 运行: npx vitest run test/unit/tosend-persist-failure.spec.tsx
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useTosendQueue } from '../../src/renderer/src/components/agentComposer/useTosendQueue';
import { currentApiMock } from './helpers/api-mock';

type HookProps = Parameters<typeof useTosendQueue>[0];
let hookApi: ReturnType<typeof useTosendQueue> | null = null;
function HookHarness(props: HookProps): null {
  hookApi = useTosendQueue(props);
  return null;
}

function mountHook(): void {
  const props: HookProps = {
    draftBucket: 'f02-ws',
    editableRef: { current: null },
    onSend: vi.fn(async () => true)
  };
  render(<HookHarness {...props} />);
}

function quotaFail(on: boolean): void {
  if (on) {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
  } else {
    vi.mocked(Storage.prototype.setItem).mockRestore();
  }
}

describe('手动清单写失败一次性提示（send-queue F-02）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    hookApi = null;
    currentApiMock();
  });
  // 用例失败提前退出时也复原 Storage spy，防跨用例污染
  afterEach(() => vi.restoreAllMocks());

  it('配额满：清单写失败 → notify.toast 一次性提示；连续失败不刷屏；恢复写后再失败可再提示', async () => {
    quotaFail(true);
    mountHook();
    const toast = currentApiMock().mockOf('notify.toast');
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].text).toContain('清单未能保存');
    // 连续失败：再加两条，仍只有一次提示
    await act(async () => { hookApi!.addTosend('第二条'); });
    await act(async () => { hookApi!.addTosend('第三条'); });
    await new Promise(r => setTimeout(r, 30));
    expect(toast).toHaveBeenCalledTimes(1);
    // 恢复可写 → 标志重置
    quotaFail(false);
    await act(async () => { hookApi!.addTosend('恢复写入'); });
    expect(localStorage.getItem('muster.tosend.v1:f02-ws')).toBeTruthy();
    // 再度失败 → 允许再次提示
    quotaFail(true);
    await act(async () => { hookApi!.addTosend('又失败了'); });
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    quotaFail(false);
  });

  it('写成功：不弹任何提示', async () => {
    mountHook();
    await act(async () => { hookApi!.addTosend('正常条目'); });
    await new Promise(r => setTimeout(r, 30));
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(localStorage.getItem('muster.tosend.v1:f02-ws')).toContain('正常条目');
  });
});
