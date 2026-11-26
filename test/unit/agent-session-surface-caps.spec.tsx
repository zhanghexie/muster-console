import { describe, expect, it } from 'vitest';
import { capsFor } from '../../src/renderer/src/chatSurface/agentSessionSurface';

/** 扩展 Agent 侧栏的 Composer 简化：模式选择与权限档位不出现（会话固定 standard 档）。 */
describe('agentSessionSurface caps variant', () => {
  it('keeps the full caps for regular GUI sessions', () => {
    const caps = capsFor('s1', 'pi');
    expect(caps.presets).toBe(true);
    expect((caps.modeOrder ?? []).length).toBeGreaterThan(0);
    expect(Object.keys(caps.modeLabels ?? {}).length).toBeGreaterThan(0);
  });

  it('drops mode presets and permission levels for the extension sidebar variant', () => {
    const caps = capsFor('s2', 'pi', 'extension');
    expect(caps.presets).toBe(false);
    expect(caps.modeOrder).toEqual([]);
    expect(caps.modeLabels).toEqual({});
    expect(caps.modeDescriptions).toEqual({});
    expect(caps.modeLockOnBusy).toBe(false);
    // 保留扩展侧栏仍需要的能力：附件菜单、后台任务、分叉、批注、手动压缩。
    expect(caps.plusMenu).toBe(true);
    expect(caps.bgTasks).toBe(true);
    expect(caps.fork).toBe(true);
    expect(caps.notes).toBe(true);
    expect(caps.manualCompact).toBe(true);
  });
});
