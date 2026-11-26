import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ play: vi.fn(), pause: vi.fn(), destroy: vi.fn() }));
vi.mock('@rrweb/replay', () => ({
  Replayer: class {
    wrapper = document.createElement('div');
    iframe = { contentDocument: document.implementation.createHTMLDocument('replay') };
    on(event: string, handler: () => void) {
      if (event !== 'event-cast') return;
      const root = this.iframe.contentDocument.documentElement;
      root.dataset.theme = 'light'; root.dataset.appearanceRevision = '7';
      root.style.setProperty('--surface-frame', '#fff0cc'); root.style.setProperty('--frame-fg-primary', '#352600');
      handler();
    }
    getMetaData() { return { totalTime: 9000 }; }
    getCurrentTime() { return 4180; }
    play = calls.play;
    pause = calls.pause;
    destroy = calls.destroy;
  }
}));

it('按记录入点播放，空格从暂停位置继续，Home 回到入点', async () => {
  document.body.innerHTML = '<main id="scene"></main><p id="status"></p>';
  window.demoReplay = { next: async () => ({ done: true, speed: 2, from: 1, width: 900, height: 640, events: [
    { type: 4, timestamp: 1, data: {} }, { type: 2, timestamp: 2, data: {} }
  ] }), appearance: vi.fn() };
  try {
    await import('../../src/renderer/src/demo/play');
    await vi.waitFor(() => expect(calls.play).toHaveBeenCalledWith(1000));
    expect(window.demoReplay?.appearance).toHaveBeenCalledWith({ appearance: 'light', panel: '#fff0cc', ink: '#352600' });
    const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true }));
    key('Space'); expect(calls.pause).toHaveBeenCalledOnce();
    key('Space'); expect(calls.play).toHaveBeenLastCalledWith(4180);
    key('Home'); expect(calls.destroy).toHaveBeenCalledOnce(); expect(calls.play).toHaveBeenLastCalledWith(1000);
  } finally { delete window.demoReplay; }
});
