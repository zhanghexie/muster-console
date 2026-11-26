import { afterEach, describe, expect, it, vi } from 'vitest';
import { settlePanelVisibility } from '../../src/renderer/src/panelVisibility';

describe('workspace page visibility confirmation', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
  it('waits for a late-starting transition and two visible stable frames', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const page = document.createElement('div'); page.className = 'terminal-page'; document.body.append(page);
    let left = -900, running = false;
    vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => ({ left, right: left + 900, top: 0, bottom: 600, width: 900, height: 600, x: left, y: 0, toJSON: () => ({}) }));
    Object.defineProperty(page, 'getAnimations', { value: () => running ? [{ playState: 'running' }] : [] });
    let settled = false;
    const pending = settlePanelVisibility('.terminal-page').then(() => { settled = true; });
    const frame = async () => { frames.shift()!(0); await Promise.resolve(); };
    await frame(); expect(settled).toBe(false);
    left = 0; running = true;
    await frame(); expect(settled).toBe(false);
    running = false;
    await frame(); expect(settled).toBe(false);
    await frame(); await pending;
    expect(settled).toBe(true);
  });
  it('stops waiting when the request or user intent changes', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const page = document.createElement('div'); page.className = 'terminal-page'; document.body.append(page);
    let current = true;
    const pending = settlePanelVisibility('.terminal-page', () => current);
    current = false; frames.shift()!(0);
    await expect(pending).rejects.toThrow(/selection changed/);
  });
});
