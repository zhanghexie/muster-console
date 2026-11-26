import { describe, expect, it } from 'vitest';
import { uiWidgetAppearance } from '../../src/renderer/src/chatSurface/uiWidgetAppearance';

describe('widget surface appearance', () => {
  it.each([
    ['dark', '#121214', '#242428', '#f0f0f2'],
    ['light', '#ffffff', '#f7f7f5', '#2f2e2b']
  ])('maps both document backgrounds to the %s chat canvas, including the body bg-card alias', (_mode, canvas, raised, ink) => {
    const card = document.createElement('div');
    card.className = 'ma-ui-card is-inline';
    card.style.setProperty('--surface-raised', raised);
    card.style.setProperty('--surface-canvas', canvas);
    card.style.setProperty('--canvas-fg-primary', ink);
    const inline = uiWidgetAppearance(card).cssVars;
    expect(inline['--bg-canvas']).toBe(canvas);
    expect(inline['--bg-card']).toBe(canvas);
    expect(inline['--bg-card']).not.toBe(raised);
    expect(inline['--ink']).toBe(ink);
    card.className = 'standalone-browser';
    expect(uiWidgetAppearance(card).cssVars['--bg-canvas']).toBe(canvas);
    card.className = 'ma-ui-card is-inline is-collapsed';
    expect(uiWidgetAppearance(card).cssVars['--bg-canvas']).toBe(canvas);
    expect(uiWidgetAppearance(card).cssVars['--bg-card']).toBe(canvas);
  });
});
