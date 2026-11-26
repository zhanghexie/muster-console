/**
 * ④ 调度对话浮窗面板高度上限：不与顶栏（.chrome-bar 36px）重合。
 * 回归：此前上限为视口高 − 24（顶缘只留 12px），拖大/持久大尺寸面板顶缘伸进
 * 顶栏区域，且 .main-view overflow-y:hidden 直接裁掉超出部分（用户看到被顶栏遮挡）。
 * 取舍：不抬 z-index（遮挡根源是祖先裁剪，且顶栏承载拖拽区/全局入口不该被盖），
 * 改为硬限制高度。见 src/renderer/src/panels/agentFloatGeom.ts。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHROME_BAR_H, maxPanelHeight } from '../../src/renderer/src/panels/agentFloatGeom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('agent-float 面板高度上限', () => {
  it('上限 = 视口 − 底锚 4 − 顶栏 36 − 顶隙 8，面板顶缘永不侵入顶栏', () => {
    expect(maxPanelHeight(860)).toBe(860 - 4 - 36 - 8);
    expect(maxPanelHeight(400)).toBe(400 - 48);
    for (const vh of [600, 720, 860, 1080, 1440]) {
      const panelTop = 4 + maxPanelHeight(vh);
      expect(panelTop).toBeGreaterThanOrEqual(CHROME_BAR_H + 8);
    }
  });

  it('CSS 默认上限同步同一几何（100vh − 48px），不回退旧的 24/56px 口径', () => {
    const css = readFileSync(path.join(root, 'src/renderer/src/styles/float.css'), 'utf8');
    const block = css.slice(css.indexOf('.agent-float.is-expanded .agent-float-panel {'));
    const maxHeight = /max-height:\s*([^;]+);/.exec(block)?.[1] ?? '';
    expect(maxHeight).toMatch(/calc\(100vh - 48px\)/);
    expect(block).not.toMatch(/calc\(100vh - 24px\)/);
    expect(block).not.toMatch(/calc\(100vh - 56px\)/);
  });

  it('拖拽与持久尺寸上限走 maxPanelHeight()（防两处口径漂移）', () => {
    const ts = readFileSync(path.join(root, 'src/renderer/src/panels/AgentFloat.tsx'), 'utf8');
    expect(ts).toContain('maxPanelHeight(window.innerHeight)');
    expect(ts).not.toContain('rect.bottom - 12;');
  });
});
