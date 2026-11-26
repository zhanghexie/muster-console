/**
 * 悬停预览 + 点击固定菜单状态机：延迟展开、划过取消、离开收起、
 * 点击升级固定、固定态离开不关、再点同一目标切换。
 */
import { act, renderHook } from '@testing-library/react';
import {
  HOVER_PIN_LEAVE_MS,
  HOVER_PIN_OPEN_MS,
  useHoverPinMenu
} from '../../src/renderer/src/hooks/useHoverPinMenu';

function setup(canHover = true) {
  return renderHook(() =>
    useHoverPinMenu<{ id: string }>((a, b) => a.id === b.id, () => canHover)
  );
}

describe('useHoverPinMenu', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('悬停未满延迟不展开，到点才开 hover', () => {
    const { result } = setup();
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    expect(result.current.open).toBe(false);
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS - 1); });
    expect(result.current.open).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.open).toBe(true);
    expect(result.current.hold).toBe('hover');
    expect(result.current.data?.id).toBe('a');
  });

  it('快速划过会清掉展开定时器', () => {
    const { result } = setup();
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    act(() => result.current.onTriggerLeave());
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS + HOVER_PIN_LEAVE_MS); });
    expect(result.current.open).toBe(false);
  });

  it('悬停展开后离开，宽限期到才收起', () => {
    const { result } = setup();
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS); });
    act(() => result.current.onTriggerLeave());
    act(() => { vi.advanceTimersByTime(HOVER_PIN_LEAVE_MS - 1); });
    expect(result.current.open).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.open).toBe(false);
  });

  it('离开后进入菜单本体会取消收起', () => {
    const { result } = setup();
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS); });
    act(() => result.current.onTriggerLeave());
    act(() => result.current.onSurfaceEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PIN_LEAVE_MS + 20); });
    expect(result.current.open).toBe(true);
    expect(result.current.hold).toBe('hover');
  });

  it('点击打开为固定态，离开不关，再点同一目标关闭', () => {
    const { result } = setup();
    act(() => result.current.onTriggerClick({ id: 'a' }));
    expect(result.current.hold).toBe('fixed');
    act(() => result.current.onTriggerLeave());
    act(() => result.current.onSurfaceLeave());
    act(() => { vi.advanceTimersByTime(HOVER_PIN_LEAVE_MS + HOVER_PIN_OPEN_MS); });
    expect(result.current.open).toBe(true);
    act(() => result.current.onTriggerClick({ id: 'a' }));
    expect(result.current.open).toBe(false);
  });

  it('悬停预览时点击升级为固定，离开不再关', () => {
    const { result } = setup();
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS); });
    act(() => result.current.onTriggerClick({ id: 'a' }));
    expect(result.current.hold).toBe('fixed');
    act(() => result.current.onTriggerLeave());
    act(() => { vi.advanceTimersByTime(HOVER_PIN_LEAVE_MS + 20); });
    expect(result.current.open).toBe(true);
  });

  it('无 hover 环境不排期展开，点击仍可用', () => {
    const { result } = setup(false);
    act(() => result.current.onTriggerEnter({ id: 'a' }));
    act(() => { vi.advanceTimersByTime(HOVER_PIN_OPEN_MS + 20); });
    expect(result.current.open).toBe(false);
    act(() => result.current.onTriggerClick({ id: 'a' }));
    expect(result.current.hold).toBe('fixed');
  });
});
