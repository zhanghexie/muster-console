import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProtectedEvaluateScript,
  formatSemanticTargetError,
  parseCoordinatePair,
  performSemanticDrag,
  performSemanticElementAction,
  performSemanticPageKey,
  performSemanticScroll,
  semanticElementAction
} from '../../src/main/browser/semanticActions';
import type { Locator } from 'playwright-core';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function foreground() {
  const field = mount<HTMLInputElement>('input');
  field.value = 'human draft'; field.focus();
  return field;
}

describe('background semantic DOM actions', () => {
  it('clicks an HTML control synthetically without pointer, keyboard or focus dispatch', () => {
    const human = foreground(), checkbox = mount<HTMLInputElement>('input'); checkbox.type = 'checkbox';
    const seen: Event[] = [];
    for (const type of ['click', 'pointerdown', 'mousedown', 'keydown', 'focus']) checkbox.addEventListener(type, event => seen.push(event));
    const focus = vi.spyOn(checkbox, 'focus');
    expect(performSemanticElementAction(checkbox, { action: 'click' })).toEqual({ ok: true });
    expect(checkbox.checked).toBe(true);
    expect(seen.map(event => event.type)).toEqual(['click']);
    expect(seen[0].isTrusted).toBe(false);
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(human); expect(human.value).toBe('human draft');
  });

  it.each(['input', 'textarea'])('fills a %s with its native setter and synthetic edit notifications, without focus', tag => {
    const human = foreground(), field = mount<HTMLInputElement | HTMLTextAreaElement>(tag);
    const prototype = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const native = Object.getOwnPropertyDescriptor(prototype, 'value')!;
    const instanceSetter = vi.fn(function (this: HTMLInputElement, value: string) { native.set!.call(this, value); });
    // A controlled input's instance value tracker must not swallow notification.
    Object.defineProperty(field, 'value', { get() { return native.get!.call(this); }, set: instanceSetter });
    const seen: Array<{ type: string; value: string; trusted: boolean; data?: string | null }> = [];
    for (const type of ['beforeinput', 'input', 'change']) field.addEventListener(type, event => {
      seen.push({ type: event.type, value: field.value, trusted: event.isTrusted, ...(event instanceof InputEvent ? { data: event.data } : {}) });
    });
    const focus = vi.spyOn(field, 'focus');
    expect(performSemanticElementAction(field, { action: 'fill', text: '后台文字' })).toEqual({ ok: true });
    expect(field.value).toBe('后台文字'); expect(instanceSetter).not.toHaveBeenCalled();
    expect(seen).toEqual([{ type: 'beforeinput', value: '', trusted: false, data: '后台文字' },
      { type: 'input', value: '后台文字', trusted: false, data: '后台文字' }, { type: 'change', value: '后台文字', trusted: false }]);
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(human);
  });

  it('fills contenteditable as plain text without changing the focused element or invoking execCommand', () => {
    const human = foreground(), editor = mount<HTMLDivElement>('div'); editor.setAttribute('contenteditable', 'true');
    editor.innerHTML = '<strong>old formatting</strong>';
    const seen: Event[] = [];
    editor.addEventListener('beforeinput', event => seen.push(event)); editor.addEventListener('input', event => seen.push(event));
    expect(performSemanticElementAction(editor, { action: 'fill', text: '<b>plain</b>' })).toEqual({ ok: true });
    expect(editor.textContent).toBe('<b>plain</b>'); expect(editor.childElementCount).toBe(0);
    expect(seen.map(event => event.type)).toEqual(['beforeinput', 'input']); expect(seen.every(event => !event.isTrusted)).toBe(true);
    expect(document.activeElement).toBe(human);
  });

  it('reports cancelled or rejected editor semantics without any native fallback', () => {
    const human = foreground(), editor = mount<HTMLDivElement>('div'); editor.setAttribute('contenteditable', 'true'); editor.textContent = 'keep';
    editor.addEventListener('beforeinput', event => event.preventDefault(), { once: true });
    expect(performSemanticElementAction(editor, { action: 'fill', text: 'replace' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
    expect(editor.textContent).toBe('keep');
    editor.addEventListener('input', () => { editor.textContent = 'editor model rejected'; });
    expect(performSemanticElementAction(editor, { action: 'fill', text: 'replace' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
    expect(document.activeElement).toBe(human);
  });

  it('selects by value or visible label with synthetic input/change, without opening the native menu', () => {
    const human = foreground(), select = mount<HTMLSelectElement>('select');
    select.innerHTML = '<option value="a">Alpha</option><option value="b">Beta</option><optgroup disabled><option value="c">Closed</option></optgroup>';
    const events: Event[] = []; select.addEventListener('input', event => events.push(event)); select.addEventListener('change', event => events.push(event));
    expect(performSemanticElementAction(select, { action: 'select', value: 'Beta' })).toEqual({ ok: true }); expect(select.value).toBe('b');
    expect(performSemanticElementAction(select, { action: 'select', value: 'a' })).toEqual({ ok: true }); expect(select.value).toBe('a');
    expect(events.map(event => event.type)).toEqual(['input', 'change', 'input', 'change']); expect(events.every(event => !event.isTrusted)).toBe(true);
    expect(performSemanticElementAction(select, { action: 'select', value: 'c' })).toMatchObject({ ok: false, code: 'semantic_action_failed' });
    expect(select.value).toBe('a'); expect(document.activeElement).toBe(human);
  });

  it('uses the target iframe realm and leaves both frame and foreground focus unchanged', () => {
    const human = foreground(), iframe = mount<HTMLIFrameElement>('iframe'), doc = iframe.contentDocument!;
    const input = doc.createElement('input'); doc.body.append(input);
    expect(input instanceof HTMLInputElement).toBe(false);
    expect(performSemanticElementAction(input, { action: 'fill', text: 'own frame' })).toEqual({ ok: true });
    expect(input.value).toBe('own frame'); expect(doc.activeElement).toBe(doc.body); expect(document.activeElement).toBe(human);
  });

  it('rejects canvas, SVG, file/value-less inputs, readonly and disabled controls explicitly', () => {
    const canvas = mount('canvas'); expect(performSemanticElementAction(canvas, { action: 'click' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); document.body.append(svg);
    expect(performSemanticElementAction(svg, { action: 'click' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
    for (const type of ['file', 'checkbox', 'button', 'range', 'hidden']) {
      const input = mount<HTMLInputElement>('input'); input.type = type;
      expect(performSemanticElementAction(input, { action: 'fill', text: 'bad' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
      if (type === 'file') {
        const click = vi.fn(); input.onclick = click;
        expect(performSemanticElementAction(input, { action: 'click' })).toMatchObject({ ok: false, code: 'capability_unsupported' });
        expect(click).not.toHaveBeenCalled();
      }
    }
    const readonly = mount<HTMLInputElement>('input'); readonly.readOnly = true;
    expect(performSemanticElementAction(readonly, { action: 'fill', text: 'bad' })).toMatchObject({ ok: false, code: 'semantic_action_failed' });
    const disabled = mount<HTMLButtonElement>('button'); disabled.disabled = true; const clicked = vi.fn(); disabled.onclick = clicked;
    expect(performSemanticElementAction(disabled, { action: 'click' })).toMatchObject({ ok: false, code: 'semantic_action_failed' }); expect(clicked).not.toHaveBeenCalled();
  });

  it('turns an in-page unsupported result into a stable capability error', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ok: false, code: 'capability_unsupported', error: 'trusted input required' });
    await expect(semanticElementAction({ evaluate } as unknown as Locator, { action: 'click' }, 8000)).rejects.toMatchObject({ code: 'capability_unsupported', message: expect.stringContaining('trusted input required') });
    expect(evaluate).toHaveBeenCalledWith(performSemanticElementAction, { action: 'click' }, { timeout: 8000 });
  });

  it('scrolls only the root DOM scroller instantly without a wheel event', () => {
    const scroller = document.documentElement, scrollBy = vi.fn(), wheel = vi.fn();
    const originalScroller = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
    const originalScrollBy = Object.getOwnPropertyDescriptor(scroller, 'scrollBy');
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: scroller });
    Object.defineProperty(scroller, 'scrollBy', { configurable: true, value: scrollBy }); document.addEventListener('wheel', wheel);
    try { performSemanticScroll(-600); expect(scrollBy).toHaveBeenCalledWith({ top: -600, left: 0, behavior: 'instant' }); expect(wheel).not.toHaveBeenCalled(); }
    finally {
      document.removeEventListener('wheel', wheel);
      if (originalScroller) Object.defineProperty(document, 'scrollingElement', originalScroller);
      else delete (document as unknown as { scrollingElement?: Element }).scrollingElement;
      if (originalScrollBy) Object.defineProperty(scroller, 'scrollBy', originalScrollBy);
      else delete (scroller as unknown as { scrollBy?: unknown }).scrollBy;
    }
  });

  it('dispatches hover and pressKey synthetically without changing foreground focus', () => {
    const human = foreground();
    const btn = mount<HTMLButtonElement>('button');
    const events: string[] = [];
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'keydown', 'keypress', 'keyup', 'click']) {
      btn.addEventListener(type, (e) => events.push(`${e.type}:${e.isTrusted}`));
    }
    expect(performSemanticElementAction(btn, { action: 'hover' })).toEqual({ ok: true });
    expect(performSemanticElementAction(btn, { action: 'pressKey', key: 'Enter' })).toEqual({ ok: true });
    expect(events).toContain('mouseover:false');
    expect(events).toContain('keydown:false');
    expect(events).toContain('click:false');
    expect(document.activeElement).toBe(human);
  });

  it('parses decimal coordinates and always releases pointerdown in performSemanticDrag finally block', () => {
    expect(parseCoordinatePair('330.5, 220.25')).toEqual({ x: 330.5, y: 220.25 });
    expect(parseCoordinatePair('#selector')).toBeNull();
    expect(() => parseCoordinatePair('1e999, 2')).toThrow(/有限数字/);

    const box = mount<HTMLDivElement>('div');
    box.id = 'drag-source';
    const seen: Array<{ type: string; buttons?: number }> = [];
    let down = false;
    const origDispatch = box.dispatchEvent.bind(box);
    box.dispatchEvent = (e: Event): boolean => {
      const me = e as MouseEvent;
      seen.push({ type: e.type, buttons: me.buttons });
      if (e.type === 'pointerdown') down = true;
      if (e.type === 'pointerup') down = false;
      if (e.type === 'dragover') {
        throw new Error('dragover interrupted');
      }
      return origDispatch(e);
    };
    const origFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => box;
    try {
      expect(() =>
        performSemanticDrag({ fromPoint: { x: 12.5, y: 24.75 }, toPoint: { x: 120.25, y: 240.5 } })
      ).toThrow('dragover interrupted');
      expect(down).toBe(false);
      expect(seen.some((x) => x.type === 'pointerup' && x.buttons === 0)).toBe(true);
    } finally {
      document.elementFromPoint = origFromPoint;
    }
  });

  it('formats stale frame-prefixed and main-frame refs with actionable snapshot hints', () => {
    expect(formatSemanticTargetError('f4e59', new Error('Timeout 8000ms exceeded')).message).toMatch(
      /元素引用 ref "f4e59" 已失效.*iframe.*browser\.snapshot/
    );
    expect(formatSemanticTargetError('e59', new Error('Timeout 8000ms exceeded')).message).toMatch(
      /元素引用 ref "e59" 已失效.*browser\.snapshot/
    );
  });

  it('executes performSemanticPageKey when serialized via Function.prototype.toString without outer scope references', () => {
    const input = mount<HTMLInputElement>('input');
    input.focus();
    const events: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(type, (e) => events.push(`${e.type}:${(e as KeyboardEvent).key}:${e.isTrusted}`));
    }
    // Simulate Playwright page.evaluate(performSemanticPageKey, 'Enter') where outer module helpers do not exist
    const isolatedPageKey = new Function(`"use strict"; return (${performSemanticPageKey.toString()});`)() as typeof performSemanticPageKey;
    expect(isolatedPageKey('Enter')).toEqual({ ok: true });
    expect(events).toEqual(['keydown:Enter:false', 'keypress:Enter:false', 'keyup:Enter:false']);
  });

  it('delivers drag events to elements inside an iframe for both iframe-locator drag and coordinate-over-iframe drag', () => {
    const iframe = mount<HTMLIFrameElement>('iframe');
    iframe.getBoundingClientRect = () => ({ left: 100, top: 80, width: 400, height: 300, right: 500, bottom: 380, x: 100, y: 80, toJSON: () => ({}) });
    const subDoc = iframe.contentDocument!;
    const subSource = subDoc.createElement('div');
    subSource.id = 'iframe-src';
    subSource.getBoundingClientRect = () => ({ left: 20, top: 30, width: 40, height: 20, right: 60, bottom: 50, x: 20, y: 30, toJSON: () => ({}) });
    const subTarget = subDoc.createElement('div');
    subTarget.id = 'iframe-dst';
    subTarget.getBoundingClientRect = () => ({ left: 150, top: 30, width: 40, height: 20, right: 190, bottom: 50, x: 150, y: 30, toJSON: () => ({}) });
    subDoc.body.append(subSource, subTarget);

    const iframeEvents: string[] = [];
    const srcEvents: string[] = [];
    const dstEvents: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'dragstart', 'pointermove', 'pointerup', 'dragend', 'dragenter', 'dragover', 'drop']) {
      iframe.addEventListener(type, (e) => { if (e.target === iframe) iframeEvents.push(type); });
      subSource.addEventListener(type, () => srcEvents.push(type));
      subTarget.addEventListener(type, () => dstEvents.push(type));
    }

    // 1. Locator-based drag inside iframe (e.g. f3e13 -> f3e14)
    const isolatedElementAction = new Function(`"use strict"; return (${performSemanticElementAction.toString()});`)() as typeof performSemanticElementAction;
    expect(isolatedElementAction(subTarget, { action: 'markDragTarget', token: 'tok-1' })).toEqual({ ok: true });
    expect(isolatedElementAction(subSource, { action: 'drag', dx: 130, dy: 0, targetToken: 'tok-1' })).toMatchObject({
      ok: true,
      targetHit: true
    });
    expect(srcEvents).toEqual(['pointerdown', 'mousedown', 'dragstart', 'pointermove', 'pointermove', 'pointerup', 'dragend']);
    expect(dstEvents).toEqual(['dragenter', 'dragover', 'drop']);
    expect(iframeEvents).toEqual([]);

    // 2. Coordinate-based drag over an iframe drills into iframe.contentDocument.elementFromPoint
    srcEvents.length = 0;
    dstEvents.length = 0;
    const origOuterFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => iframe;
    subDoc.elementFromPoint = (x: number, y: number) => (x < 100 && y >= 0 ? subSource : subTarget);
    try {
      const isolatedDrag = new Function(`"use strict"; return (${performSemanticDrag.toString()});`)() as typeof performSemanticDrag;
      expect(isolatedDrag({ fromPoint: { x: 140, y: 120 }, toPoint: { x: 270, y: 120 } })).toMatchObject({
        ok: true,
        targetHit: true
      });
      expect(srcEvents).toContain('dragstart');
      expect(srcEvents).toContain('pointerup');
      expect(dstEvents).toEqual(['dragenter', 'dragover', 'drop']);
      expect(iframeEvents).toEqual([]);
    } finally {
      document.elementFromPoint = origOuterFromPoint;
    }
  });

  it('preserves DataTransfer payload across sibling iframes and step-by-step dropTarget fallback', () => {
    const iframeA = mount<HTMLIFrameElement>('iframe');
    const iframeB = mount<HTMLIFrameElement>('iframe');
    const docA = iframeA.contentDocument!;
    const docB = iframeB.contentDocument!;
    const card = docA.createElement('div');
    card.getBoundingClientRect = () => ({ left: 10, top: 10, width: 50, height: 30, right: 60, bottom: 40, x: 10, y: 10, toJSON: () => ({}) });
    docA.body.append(card);

    const dropzone = docB.createElement('div');
    dropzone.getBoundingClientRect = () => ({ left: 20, top: 20, width: 80, height: 60, right: 100, bottom: 80, x: 20, y: 20, toJSON: () => ({}) });
    docB.body.append(dropzone);

    card.addEventListener('dragstart', (e) => {
      const dt = (e as DragEvent).dataTransfer;
      dt?.setData('text/plain', 'card-42');
    });
    const receivedDrops: string[] = [];
    dropzone.addEventListener('drop', (e) => {
      const dt = (e as DragEvent).dataTransfer;
      receivedDrops.push(dt?.getData('text/plain') ?? '');
    });

    const isolatedElementAction = new Function(`"use strict"; return (${performSemanticElementAction.toString()});`)() as typeof performSemanticElementAction;

    // Case A: Same-origin sibling iframes (resolved directly via top document traversal)
    expect(isolatedElementAction(dropzone, { action: 'markDragTarget', token: 'sib-1' })).toEqual({ ok: true });
    const sameOriginRes = isolatedElementAction(card, { action: 'drag', dx: 200, dy: 0, targetToken: 'sib-1' });
    expect(sameOriginRes).toMatchObject({ ok: true, targetHit: true });
    expect(receivedDrops).toEqual(['card-42']);

    // Case B: Step-by-step dropTarget fallback (e.g. when frames cannot traverse parent)
    const unlinkedDragRes = isolatedElementAction(card, { action: 'drag', dx: 200, dy: 0, targetToken: 'missing-tok' });
    expect(unlinkedDragRes).toMatchObject({ ok: true, targetHit: false, dragData: expect.objectContaining({ 'text/plain': 'card-42' }) });
    if (unlinkedDragRes.ok) {
      expect(isolatedElementAction(dropzone, { action: 'dropTarget', token: 'missing-tok', dragData: unlinkedDragRes.dragData })).toMatchObject({
        ok: true,
        targetHit: true
      });
    }
    expect(receivedDrops).toEqual(['card-42', 'card-42']);
  });

  it('prevents same-origin iframe focus/blur from stealing foreground focus during sync and async evaluate', async () => {
    const human = foreground();
    const iframe = mount<HTMLIFrameElement>('iframe');
    const iframeInput = iframe.contentDocument!.createElement('input');
    iframeInput.id = 'iframe-input';
    iframe.contentDocument!.body.append(iframeInput);

    const script = buildProtectedEvaluateScript(`(async () => {
      const existing = document.querySelector('iframe').contentDocument.getElementById('iframe-input');
      existing.focus();
      await new Promise(r => setTimeout(r, 10));
      existing.focus();
      const dyn = document.createElement('iframe');
      document.body.append(dyn);
      const dynInput = dyn.contentDocument.createElement('input');
      dyn.contentDocument.body.append(dynInput);
      dynInput.focus();
      return document.activeElement?.value ?? '';
    })()`);

    const out = await (0, eval)(script);
    expect(out).toBe('human draft');
    expect(document.activeElement).toBe(human);
    expect(iframe.contentDocument!.activeElement).not.toBe(iframeInput);
  });

  it('suppresses focus in delayed callbacks (setTimeout / nested timer / fire-and-forget Promise) after evaluate returns', async () => {
    const human = foreground();
    const other = mount<HTMLInputElement>('input');
    other.id = 'other-input';
    const iframe = mount<HTMLIFrameElement>('iframe');
    const iframeInput = iframe.contentDocument!.createElement('input');
    iframeInput.id = 'iframe-delayed-input';
    iframe.contentDocument!.body.append(iframeInput);

    const script = buildProtectedEvaluateScript(`(() => {
      const other = document.getElementById('other-input');
      const sub = document.querySelector('iframe').contentDocument.getElementById('iframe-delayed-input');
      setTimeout(() => {
        other.focus();
        sub.focus();
        setTimeout(() => { other.focus(); sub.focus(); }, 10);
      }, 10);
      Promise.resolve().then(() => {
        other.focus();
        sub.focus();
      });
      (async () => {
        await new Promise(r => setTimeout(r, 12));
        other.focus();
        sub.focus();
      })();
      return 'scheduled';
    })()`);

    const out = await (0, eval)(script);
    expect(out).toBe('scheduled');
    expect(document.activeElement).toBe(human);
    await new Promise((r) => setTimeout(r, 35));
    expect(document.activeElement).toBe(human);
    expect(iframe.contentDocument!.activeElement).not.toBe(iframeInput);

    // Outside evaluate and its scheduled callbacks, normal focus still works
    other.focus();
    expect(document.activeElement).toBe(other);
  });

  it.each(['resolve', 'reject'] as const)('restores shared focus guards when an older callback outlives a newer evaluate (%s)', async (outcome) => {
    // Isolate the page realm: the broken implementation leaves global prototypes patched.
    type PageWindow = Window & typeof globalThis & { reviewGates: Record<string, unknown> };
    type PageDom = { window: PageWindow };
    const environment = (globalThis as unknown as { jsdom: PageDom }).jsdom;
    const PageDOM = environment.constructor as new (html: string, options: { runScripts: string }) => PageDom;
    const dom = new PageDOM('<input id="human"><input id="other"><iframe></iframe>', { runScripts: 'outside-only' });
    const page = dom.window;
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(yes => { resolve = yes; });
      return { promise, resolve };
    };
    const callbackStarted = deferred(), callbackGate = deferred(), callbackDone = deferred();
    const evaluationStarted = deferred(), evaluationGate = deferred();
    const frame = page.document.querySelector('iframe')!.contentWindow as PageWindow;
    const originals = [page, frame].map(w => ({
      focus: w.HTMLElement.prototype.focus, blur: w.HTMLElement.prototype.blur,
      then: w.Promise.prototype.then, timer: w.setTimeout, append: w.Node.prototype.appendChild
    }));
    page.reviewGates = {
      callbackStarted: callbackStarted.resolve, callbackGate: callbackGate.promise, callbackDone: callbackDone.resolve,
      evaluationStarted: evaluationStarted.resolve, evaluationGate: evaluationGate.promise
    };
    const run = (expression: string): Promise<unknown> => page.eval(buildProtectedEvaluateScript(expression));
    try {
      (page.document.querySelector('#human') as HTMLInputElement).focus();
      expect(await run(`setTimeout(async () => {
        reviewGates.callbackStarted();
        try {
          await reviewGates.callbackGate;
          document.querySelector('#other').focus();
        } finally { reviewGates.callbackDone(); }
      }, 0); 'scheduled'`)).toBe('scheduled');
      const newer = run(`(async () => {
        reviewGates.evaluationStarted();
        await reviewGates.evaluationGate;
        ${outcome === 'reject' ? 'throw new Error("expected rejection");' : 'return "newer-done";'}
      })()`);
      // Attach rejection handling before releasing either asynchronous operation.
      const newerResult = newer.then(value => ({ value }), error => ({ error: String(error) }));
      await evaluationStarted.promise;
      await callbackStarted.promise;
      evaluationGate.resolve();
      const result = await newerResult;
      expect(result).toEqual(outcome === 'reject' ? { error: 'Error: expected rejection' } : { value: 'newer-done' });
      callbackGate.resolve();
      await callbackDone.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(page.document.activeElement?.id).toBe('human');
      [page, frame].forEach((w, i) => {
        expect(w.HTMLElement.prototype.focus).toBe(originals[i].focus);
        expect(w.HTMLElement.prototype.blur).toBe(originals[i].blur);
        expect(w.Promise.prototype.then).toBe(originals[i].then);
        expect(w.setTimeout).toBe(originals[i].timer);
        expect(w.Node.prototype.appendChild).toBe(originals[i].append);
      });
      (page.document.querySelector('#other') as HTMLInputElement).focus();
      expect(page.document.activeElement?.id).toBe('other');
    } finally {
      callbackGate.resolve();
      evaluationGate.resolve();
      page.close();
    }
  });

  it('clears tracked DataTransfer cache when clearData is called on native or fallback DataTransfer', () => {
    const origDT = (window as unknown as { DataTransfer?: unknown }).DataTransfer;
    class FakeNativeDataTransfer {
      private map = new Map<string, string>();
      types: string[] = [];
      setData(fmt: string, val: string): void {
        const k = fmt.toLowerCase() === 'text' ? 'text/plain' : fmt.toLowerCase();
        this.map.set(k, String(val));
        if (!this.types.includes(k)) this.types.push(k);
      }
      getData(fmt: string): string {
        const k = fmt.toLowerCase() === 'text' ? 'text/plain' : fmt.toLowerCase();
        return this.map.get(k) ?? '';
      }
      clearData(fmt?: string): void {
        if (fmt === undefined) {
          this.map.clear();
          this.types.length = 0;
        } else {
          const k = fmt.toLowerCase() === 'text' ? 'text/plain' : fmt.toLowerCase();
          this.map.delete(k);
          this.types = this.types.filter((t) => t !== k);
        }
      }
    }
    (window as unknown as { DataTransfer?: unknown }).DataTransfer = FakeNativeDataTransfer;
    try {
      const src = mount<HTMLDivElement>('div');
      src.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
      const dst = mount<HTMLDivElement>('div');
      dst.getBoundingClientRect = () => ({ left: 100, top: 10, width: 40, height: 20, right: 140, bottom: 30, x: 100, y: 10, toJSON: () => ({}) });

      src.addEventListener('dragstart', (e) => {
        const dt = (e as DragEvent).dataTransfer!;
        dt.setData('text/plain', 'stale-card');
        dt.clearData('text/plain');
      });
      const drops: string[] = [];
      dst.addEventListener('drop', (e) => {
        drops.push((e as DragEvent).dataTransfer?.getData('text/plain') ?? 'missing');
      });

      const isolatedElementAction = new Function(`"use strict"; return (${performSemanticElementAction.toString()});`)() as typeof performSemanticElementAction;
      expect(isolatedElementAction(dst, { action: 'markDragTarget', token: 'clr-1' })).toEqual({ ok: true });
      const res = isolatedElementAction(src, { action: 'drag', dx: 90, dy: 0, targetToken: 'clr-1' });
      expect(res).toMatchObject({ ok: true, targetHit: true, dragData: {} });
      expect(drops).toEqual(['']);
    } finally {
      (window as unknown as { DataTransfer?: unknown }).DataTransfer = origDT;
    }
  });
});
