import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { injectExtensionPanelChrome, injectPanelRelay, PANEL_CLEAR_SELECTION_EVENT, PANEL_ESCAPE_EVENT, PANEL_FOCUS_EVENT, PANEL_SELECTION_EVENT } from '../../src/shared/panelRelay';

function guest(getSelection?: () => unknown) {
  const documentListeners = new Map<string, (event: any) => void>();
  const windowListeners = new Map<string, (event: any) => void>();
  const postMessage = vi.fn();
  const parent = { postMessage };
  const html = injectPanelRelay('<html><head></head><body></body></html>');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    document: {
      addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, listener),
      ...(getSelection ? { getSelection } : {})
    },
    window: { addEventListener: (type: string, listener: (event: any) => void) => windowListeners.set(type, listener) },
    parent
  });
  return { documentListeners, windowListeners, postMessage, parent };
}

describe('sandbox panel event relay', () => {
  it('relays Escape from the iframe while leaving other keys alone', () => {
    const fixture = guest();
    fixture.documentListeners.get('keydown')!({ key: 'Enter' });
    expect(fixture.postMessage).not.toHaveBeenCalled();
    fixture.documentListeners.get('keydown')!({ key: 'Escape' });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ __ma: true, type: PANEL_ESCAPE_EVENT }, '*');
  });
  it('reports repeated clicks and keyboard focus without depending on parent-window blur', () => {
    const fixture = guest();
    fixture.documentListeners.get('pointerdown')!({});
    fixture.documentListeners.get('pointerdown')!({});
    fixture.documentListeners.get('focusin')!({});
    fixture.windowListeners.get('focus')!({});
    expect(fixture.postMessage).toHaveBeenCalledTimes(4);
    for (const [message, origin] of fixture.postMessage.mock.calls) {
      expect(message).toEqual({ __ma: true, type: PANEL_FOCUS_EVENT });
      expect(origin).toBe('*');
    }
  });

  it('preserves the middle-click relay and ignores ordinary/default-prevented clicks', () => {
    const fixture = guest();
    const mouse = fixture.documentListeners.get('mousedown')!;
    const preventDefault = vi.fn();
    mouse({ button: 0, defaultPrevented: false, preventDefault });
    mouse({ button: 1, defaultPrevented: true, preventDefault });
    expect(fixture.postMessage).not.toHaveBeenCalled();
    mouse({ button: 1, defaultPrevented: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(fixture.postMessage).toHaveBeenLastCalledWith({ __ma: true, type: 'middleClick' }, '*');
  });

  it('reports guest text selections with pointer coordinates for the host selection menu', () => {
    const fixture = guest(() => ({ toString: () => '面板里的划词内容' }));
    const mouseUp = fixture.documentListeners.get('mouseup')!;
    mouseUp({ button: 2, clientX: 0, clientY: 0 });
    expect(fixture.postMessage).not.toHaveBeenCalled();
    mouseUp({ button: 0, clientX: 12, clientY: 34 });
    expect(fixture.postMessage).toHaveBeenLastCalledWith(
      { __ma: true, type: PANEL_SELECTION_EVENT, text: '面板里的划词内容', x: 12, y: 34 },
      '*'
    );
    // 空选区也上报（宿主据此收起菜单）
    const empty = guest(() => ({ toString: () => '' }));
    empty.documentListeners.get('mouseup')!({ button: 0, clientX: 1, clientY: 2 });
    expect(empty.postMessage).toHaveBeenLastCalledWith(
      { __ma: true, type: PANEL_SELECTION_EVENT, text: '', x: 1, y: 2 },
      '*'
    );
  });

  it('clears the guest selection when the host asks to', () => {
    const removeAllRanges = vi.fn();
    const fixture = guest(() => ({ toString: () => 'x', removeAllRanges }));
    const onMessage = fixture.windowListeners.get('message')!;
    onMessage({ source: { alien: true }, data: { __ma: true, type: PANEL_CLEAR_SELECTION_EVENT } });
    expect(removeAllRanges).not.toHaveBeenCalled();
    onMessage({ source: fixture.parent, data: { __ma: true, type: PANEL_CLEAR_SELECTION_EVENT } });
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });
});


it('removes extension canvas outlines without changing other focus styles or HTML previews', () => {
  const source = '<html><head></head><body><canvas tabindex="0"></canvas><button>OK</button></body></html>';
  expect(injectExtensionPanelChrome(source)).toContain('canvas:focus { outline: none !important; }');
  expect(injectPanelRelay(source)).not.toContain('data-ma-canvas-focus');
});
