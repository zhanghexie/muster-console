import type { Locator } from 'playwright-core';

// Only the operations used by the serialized callback are described here. Do not
// import lib.dom into the main process: it changes unrelated Node timer/globals.
interface SemanticDocument {
  defaultView: unknown;
  scrollingElement?: SemanticElement | null;
  activeElement?: SemanticElement | null;
  body?: SemanticHTMLElement | null;
  querySelector?(sel: string): SemanticElement | null;
  querySelectorAll?(sel: string): ArrayLike<SemanticElement>;
  elementFromPoint?(x: number, y: number): SemanticElement | null;
}
interface SemanticElement {
  ownerDocument: SemanticDocument;
  isConnected: boolean;
  localName: string;
  id?: string;
  clientLeft?: number;
  clientTop?: number;
  shadowRoot?: { elementFromPoint(x: number, y: number): SemanticElement | null } | null;
  contentDocument?: SemanticDocument | null;
  contentWindow?: unknown;
  matches(selector: string): boolean;
  closest(selector: string): SemanticElement | null;
  getAttribute(name: string): string | null;
  dispatchEvent(event: object): boolean;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
}
interface SemanticForm extends SemanticHTMLElement {
  requestSubmit?: () => void;
  submit?: () => void;
}
interface SemanticHTMLElement extends SemanticElement {
  isContentEditable: boolean;
  textContent: string | null;
  click(): void;
  clientHeight: number;
  scrollHeight: number;
  scrollBy(options: { top: number; behavior: 'instant' }): void;
}
interface SemanticTextControl extends SemanticHTMLElement {
  value: string;
  readOnly: boolean;
  form?: SemanticForm | null;
}
interface SemanticInput extends SemanticTextControl { type: string }
interface SemanticOption {
  value: string; label: string; index: number; disabled: boolean;
  parentElement: SemanticElement | null;
}
interface SemanticSelect extends SemanticHTMLElement { options: ArrayLike<SemanticOption>; selectedIndex: number }
interface SemanticOptGroup extends SemanticHTMLElement { disabled: boolean }
interface SemanticDataTransfer {
  setData(format: string, data: string): void;
  getData(format: string): string;
  clearData?(format?: string): void;
  types?: ReadonlyArray<string> | string[];
}
interface RealmConstructor<T> { new (...args: never[]): T; prototype: T }
interface SemanticRealm {
  parent?: unknown;
  top?: unknown;
  document?: SemanticDocument;
  HTMLElement: RealmConstructor<SemanticHTMLElement>;
  HTMLInputElement: RealmConstructor<SemanticInput>;
  HTMLTextAreaElement: RealmConstructor<SemanticTextControl>;
  HTMLSelectElement: RealmConstructor<SemanticSelect>;
  HTMLOptGroupElement: RealmConstructor<SemanticOptGroup>;
  Event: new (type: string, options?: object) => object;
  InputEvent: new (type: string, options?: object) => object;
  KeyboardEvent?: new (type: string, options?: object) => object;
  MouseEvent?: new (type: string, options?: object) => object;
  PointerEvent?: new (type: string, options?: object) => object;
  DragEvent?: new (type: string, options?: object) => object;
  DataTransfer?: new () => SemanticDataTransfer;
  getComputedStyle(element: SemanticElement): { overflowY: string };
  __maDragTargets?: Record<string, SemanticElement>;
}

export type SemanticElementAction =
  | { action: 'click' }
  | { action: 'hover' }
  | { action: 'scroll'; delta: number }
  | { action: 'pressKey'; key: string }
  | { action: 'fill'; text: string }
  | { action: 'select'; value: string }
  | { action: 'markDragTarget'; token: string }
  | { action: 'dropTarget'; token?: string; dragData?: Record<string, string> }
  | { action: 'drag'; dx: number; dy: number; targetToken?: string };

export type SemanticActionSuccess = {
  ok: true;
  targetHit?: boolean;
  dragData?: Record<string, string>;
};

export type SemanticActionResult =
  | SemanticActionSuccess
  | { ok: false; code: 'capability_unsupported' | 'semantic_action_failed'; error: string };

export class BrowserCapabilityUnsupportedError extends Error {
  readonly code = 'capability_unsupported';
  constructor(action: string, reason: string) {
    super(`capability_unsupported: browser.${action}: ${reason}`);
    this.name = 'BrowserCapabilityUnsupportedError';
  }
}

const COORD_TOKEN_RE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const COORD_PAIR_RE = new RegExp(`^\\s*(${COORD_TOKEN_RE})\\s*,\\s*(${COORD_TOKEN_RE})\\s*$`);

/**
 * 解析 "x,y" 坐标对（支持小数与科学计数法，如 "330.5, 220.25"）。
 * 非坐标格式返回 null（调用方按 ref/CSS 选择器处理）；坐标格式但数值越界（Infinity/NaN）抛错。
 */
export function parseCoordinatePair(raw: unknown): { x: number; y: number } | null {
  const s = String(raw ?? '').trim();
  const m = COORD_PAIR_RE.exec(s);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`坐标必须是有限数字：${s}`);
  }
  return { x, y };
}

/**
 * 将快照 ref（e12 / f4e59）的定位超时或帧丢失错误转换为明确可识别提示，
 * 让 Agent 能直接区分「ref 已失效需重新 snapshot」与「页面无该 CSS 选择器」。
 */
export function formatSemanticTargetError(target: string | undefined, err: unknown): Error {
  if (err instanceof BrowserCapabilityUnsupportedError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const ref = String(target ?? '').trim();
  if (/^(?:f\d+)?e\d+$/.test(ref) && !msg.startsWith('semantic_action_failed:')) {
    const isFrameRef = /^f\d+e\d+$/.test(ref);
    const prefix = isFrameRef
      ? `元素引用 ref "${ref}" 已失效（iframe 或页面帧已重建，帧前缀可能已变更为新序号或主帧 eN），请重新调用 browser.snapshot 获取最新 ref`
      : `元素引用 ref "${ref}" 已失效或不在当前页面（DOM 已更新），请重新调用 browser.snapshot 获取最新 ref`;
    return new Error(`${prefix}（${msg}）`);
  }
  return err instanceof Error ? err : new Error(msg);
}

/** This entire function runs in the element's own frame. Keep it self-contained.
 * The agent's CDP proxy forces userGesture:false for every Runtime evaluation.
 * No focus, selection, native pointer/key event, clipboard or native fallback.
 * Events are synthetic: editors that require trusted input need manual operation. */
export function performSemanticElementAction(element: SemanticElement, request: SemanticElementAction): SemanticActionResult {
  const unsupported = (error: string): SemanticActionResult => ({ ok: false, code: 'capability_unsupported', error });
  const failed = (error: string): SemanticActionResult => ({ ok: false, code: 'semantic_action_failed', error });
  const win = element.ownerDocument.defaultView;
  if (!win || !element.isConnected) return failed('目标元素已脱离页面，请重新取快照');
  // The owner window matters for elements resolved in an iframe.
  const realm = win as SemanticRealm;
  if (!(element instanceof realm.HTMLElement)) return unsupported('只支持 HTML 元素的 DOM 语义动作');
  if (request.action === 'scroll') {
    const { overflowY } = realm.getComputedStyle(element);
    if (element.scrollHeight <= element.clientHeight ||
        (element !== element.ownerDocument.scrollingElement && !['auto', 'scroll', 'hidden'].includes(overflowY))) {
      return failed('目标元素没有可滚动的垂直内容');
    }
    element.scrollBy({ top: request.delta, behavior: 'instant' });
    return { ok: true };
  }
  if (element.localName === 'canvas') return unsupported('canvas 需要坐标或可信指针输入，请手动操作');
  if (element.matches(':disabled')) return failed('目标元素已禁用');

  const createTrackedDataTransfer = (
    targetRealm: SemanticRealm,
    initialData?: Record<string, string>
  ): { dt: SemanticDataTransfer; store: Record<string, string> } => {
    const store: Record<string, string> = {};
    let clearedAll = false;
    const clearedFormats = new Set<string>();
    const normalizeFormat = (fmt: string): string => {
      const f = String(fmt ?? '').toLowerCase();
      return f === 'text' ? 'text/plain' : f === 'url' ? 'text/uri-list' : f;
    };
    const clearStore = (format?: string): void => {
      if (format === undefined) {
        clearedAll = true;
        for (const k of Object.keys(store)) delete store[k];
      } else {
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        clearedFormats.add(normKey);
        delete store[rawKey];
        delete store[normKey];
        for (const k of Object.keys(store)) {
          if (normalizeFormat(k) === normKey) delete store[k];
        }
      }
    };
    let dt: SemanticDataTransfer;
    if (typeof targetRealm.DataTransfer === 'function') {
      dt = new targetRealm.DataTransfer();
      const origSet = typeof dt.setData === 'function' ? dt.setData.bind(dt) : null;
      const origGet = typeof dt.getData === 'function' ? dt.getData.bind(dt) : null;
      const origClear = typeof dt.clearData === 'function' ? dt.clearData.bind(dt) : null;
      dt.setData = (format: string, data: string): void => {
        const val = String(data ?? '');
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        clearedFormats.delete(normKey);
        store[rawKey] = val;
        store[normKey] = val;
        try { origSet?.(format, val); } catch { /* ignore */ }
      };
      dt.getData = (format: string): string => {
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        if (Object.prototype.hasOwnProperty.call(store, rawKey)) return store[rawKey];
        if (Object.prototype.hasOwnProperty.call(store, normKey)) return store[normKey];
        if (clearedAll || clearedFormats.has(normKey)) return '';
        try {
          const nativeVal = origGet ? origGet(format) : '';
          if (nativeVal) return nativeVal;
        } catch { /* ignore */ }
        return '';
      };
      dt.clearData = (format?: string): void => {
        clearStore(format);
        try {
          if (format === undefined) origClear?.();
          else origClear?.(format);
        } catch { /* ignore */ }
      };
    } else {
      const types: string[] = [];
      dt = {
        types,
        setData(format: string, data: string): void {
          const val = String(data ?? '');
          const norm = normalizeFormat(format);
          clearedFormats.delete(norm);
          store[String(format)] = val;
          store[norm] = val;
          if (!types.includes(norm)) types.push(norm);
        },
        getData(format: string): string {
          return store[String(format)] ?? store[normalizeFormat(format)] ?? '';
        },
        clearData(format?: string): void {
          clearStore(format);
          if (format === undefined) {
            types.length = 0;
          } else {
            const norm = normalizeFormat(format);
            const idx = types.indexOf(norm);
            if (idx >= 0) types.splice(idx, 1);
          }
        }
      };
    }
    if (initialData) {
      for (const [k, v] of Object.entries(initialData)) {
        dt.setData(k, v);
      }
    }
    return { dt, store };
  };

  const makeDragEvent = (
    targetRealm: SemanticRealm,
    type: string,
    clientX: number,
    clientY: number,
    dt: SemanticDataTransfer
  ): object => {
    const Ctor = targetRealm.DragEvent ?? targetRealm.MouseEvent ?? targetRealm.Event;
    const ev = new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      dataTransfer: dt
    }) as { dataTransfer?: SemanticDataTransfer };
    if (ev.dataTransfer !== dt) {
      try {
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
      } catch {
        /* ignore if non-configurable */
      }
    }
    return ev;
  };

  if (request.action === 'click') {
    if (element instanceof realm.HTMLInputElement && element.type === 'file') {
      return unsupported('后台不支持文件选择，请在前台手动选择文件');
    }
    realm.HTMLElement.prototype.click.call(element);
    return { ok: true };
  }

  if (request.action === 'hover') {
    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const MouseEv = realm.MouseEvent ?? realm.Event;
    const PointerEv = realm.PointerEvent ?? MouseEv;
    element.dispatchEvent(new PointerEv('pointerover', { bubbles: true, cancelable: true, composed: true, clientX, clientY }));
    element.dispatchEvent(new PointerEv('pointerenter', { bubbles: false, cancelable: false, clientX, clientY }));
    element.dispatchEvent(new MouseEv('mouseover', { bubbles: true, cancelable: true, composed: true, clientX, clientY }));
    element.dispatchEvent(new MouseEv('mouseenter', { bubbles: false, cancelable: false, clientX, clientY }));
    element.dispatchEvent(new MouseEv('mousemove', { bubbles: true, cancelable: true, composed: true, clientX, clientY }));
    return { ok: true };
  }

  if (request.action === 'markDragTarget') {
    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    if (rect.width <= 0 || rect.height <= 0) {
      return failed('拖拽目标不可见或无包围盒');
    }
    if (!realm.__maDragTargets) realm.__maDragTargets = {};
    realm.__maDragTargets[request.token] = element;
    return { ok: true };
  }

  if (request.action === 'dropTarget') {
    if (request.token && realm.__maDragTargets) {
      delete realm.__maDragTargets[request.token];
    }
    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const { dt } = createTrackedDataTransfer(realm, request.dragData);
    element.dispatchEvent(makeDragEvent(realm, 'dragenter', clientX, clientY, dt));
    element.dispatchEvent(makeDragEvent(realm, 'dragover', clientX, clientY, dt));
    element.dispatchEvent(makeDragEvent(realm, 'drop', clientX, clientY, dt));
    return { ok: true, targetHit: true };
  }

  if (request.action === 'drag') {
    const rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    if (rect.width <= 0 || rect.height <= 0) {
      return failed('拖拽源不可见或无包围盒');
    }
    const fromX = rect.left + rect.width / 2;
    const fromY = rect.top + rect.height / 2;
    let toX = fromX + (Number(request.dx) || 0);
    let toY = fromY + (Number(request.dy) || 0);

    let toEl: SemanticElement | null = null;
    let toRealm: SemanticRealm = realm;
    let targetHit = false;

    const getTopSameOriginDoc = (startDoc: SemanticDocument): SemanticDocument => {
      let curDoc: SemanticDocument = startDoc;
      let curWin = startDoc.defaultView as SemanticRealm | null | undefined;
      for (let depth = 0; depth < 16 && curWin; depth++) {
        try {
          const parentWin = curWin.parent as SemanticRealm | null | undefined;
          if (!parentWin || parentWin === curWin || !parentWin.document) break;
          curDoc = parentWin.document;
          curWin = parentWin;
        } catch {
          break;
        }
      }
      return curDoc;
    };

    const findMarkedInDoc = (doc: SemanticDocument | null | undefined, token: string): { el: SemanticElement; win: SemanticRealm } | null => {
      if (!doc || !doc.defaultView) return null;
      const w = doc.defaultView as SemanticRealm;
      if (w.__maDragTargets && w.__maDragTargets[token]) {
        const found = w.__maDragTargets[token];
        delete w.__maDragTargets[token];
        if (found && found.isConnected) return { el: found, win: w };
      }
      if (typeof doc.querySelectorAll === 'function') {
        const frames = doc.querySelectorAll('iframe, frame');
        for (let i = 0; i < frames.length; i++) {
          try {
            const sub = findMarkedInDoc(frames[i].contentDocument, token);
            if (sub) return sub;
          } catch {
            /* cross-origin frame */
          }
        }
      }
      return null;
    };

    if (request.targetToken) {
      const rootDoc = getTopSameOriginDoc(element.ownerDocument);
      const marked = findMarkedInDoc(rootDoc, request.targetToken) ?? findMarkedInDoc(element.ownerDocument, request.targetToken);
      if (marked) {
        toEl = marked.el;
        toRealm = marked.win;
        targetHit = true;
        if (typeof toEl.getBoundingClientRect === 'function') {
          const tr = toEl.getBoundingClientRect();
          toX = tr.left + tr.width / 2;
          toY = tr.top + tr.height / 2;
        }
      }
    }

    if (!toEl && !request.targetToken) {
      let curDoc: SemanticDocument | null | undefined = element.ownerDocument;
      let cx = toX;
      let cy = toY;
      while (curDoc && typeof curDoc.elementFromPoint === 'function') {
        const hit: SemanticElement | null = curDoc.elementFromPoint(cx, cy) ?? curDoc.body ?? null;
        if (!hit) break;
        if (hit.localName === 'iframe' || hit.localName === 'frame') {
          try {
            const subDoc: SemanticDocument | null | undefined = hit.contentDocument;
            if (subDoc && typeof subDoc.elementFromPoint === 'function') {
              const fr = typeof hit.getBoundingClientRect === 'function'
                ? hit.getBoundingClientRect()
                : { left: 0, top: 0 };
              cx = cx - fr.left - (hit.clientLeft ?? 0);
              cy = cy - fr.top - (hit.clientTop ?? 0);
              curDoc = subDoc;
              if (subDoc.defaultView) toRealm = subDoc.defaultView as SemanticRealm;
              continue;
            }
          } catch {
            /* cross-origin iframe */
          }
        }
        toEl = hit;
        toX = cx;
        toY = cy;
        targetHit = true;
        break;
      }
    }

    const MouseEv = realm.MouseEvent ?? realm.Event;
    const PointerEv = realm.PointerEvent ?? MouseEv;
    const { dt: dataTransfer, store: dragData } = createTrackedDataTransfer(realm);

    let pointerDownSent = false;
    let lastX = fromX;
    let lastY = fromY;
    try {
      element.dispatchEvent(new PointerEv('pointerdown', {
        bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
        button: 0, buttons: 1, clientX: fromX, clientY: fromY
      }));
      pointerDownSent = true;
      element.dispatchEvent(new MouseEv('mousedown', {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: fromX, clientY: fromY
      }));
      element.dispatchEvent(makeDragEvent(realm, 'dragstart', fromX, fromY, dataTransfer));
      if (Array.isArray(dataTransfer.types)) {
        for (const t of dataTransfer.types) {
          try {
            const v = dataTransfer.getData(t);
            if (v && !(t in dragData)) dragData[t] = v;
          } catch { /* ignore */ }
        }
      }

      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      for (const [mx, my] of [[midX, midY], [toX, toY]] as const) {
        lastX = mx;
        lastY = my;
        element.dispatchEvent(new PointerEv('pointermove', {
          bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
          button: 0, buttons: 1, clientX: mx, clientY: my
        }));
        element.dispatchEvent(new MouseEv('mousemove', {
          bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: mx, clientY: my
        }));
      }

      if (toEl) {
        toEl.dispatchEvent(makeDragEvent(toRealm, 'dragenter', toX, toY, dataTransfer));
        toEl.dispatchEvent(makeDragEvent(toRealm, 'dragover', toX, toY, dataTransfer));
        toEl.dispatchEvent(makeDragEvent(toRealm, 'drop', toX, toY, dataTransfer));
      }
      return { ok: true, targetHit, dragData };
    } finally {
      if (pointerDownSent) {
        try {
          element.dispatchEvent(new PointerEv('pointerup', {
            bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
            button: 0, buttons: 0, clientX: lastX, clientY: lastY
          }));
          element.dispatchEvent(new MouseEv('mouseup', {
            bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, clientX: lastX, clientY: lastY
          }));
          element.dispatchEvent(makeDragEvent(realm, 'dragend', lastX, lastY, dataTransfer));
        } catch {
          /* ignore release error */
        }
      }
    }
  }

  if (request.action === 'pressKey') {
    const rawKey = String(request.key ?? '').trim();
    if (!rawKey) return failed('key 不能为空');
    const parts = rawKey.split('+').filter(Boolean);
    let ctrlKey = false, shiftKey = false, altKey = false, metaKey = false;
    const mainKey = parts[parts.length - 1] ?? rawKey;
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i].toLowerCase();
      if (mod === 'control' || mod === 'ctrl') ctrlKey = true;
      else if (mod === 'shift') shiftKey = true;
      else if (mod === 'alt' || mod === 'option') altKey = true;
      else if (mod === 'meta' || mod === 'cmd' || mod === 'command') metaKey = true;
    }
    const code = mainKey.length === 1
      ? (/^[a-z]$/i.test(mainKey) ? `Key${mainKey.toUpperCase()}` : /^[0-9]$/.test(mainKey) ? `Digit${mainKey}` : mainKey)
      : mainKey;
    const KeyEv = realm.KeyboardEvent ?? realm.Event;
    const init = { key: mainKey, code, ctrlKey, shiftKey, altKey, metaKey, bubbles: true, cancelable: true, composed: true };
    const downProceeded = element.dispatchEvent(new KeyEv('keydown', init));
    if (mainKey.length === 1 || mainKey === 'Enter') {
      element.dispatchEvent(new KeyEv('keypress', init));
    }
    element.dispatchEvent(new KeyEv('keyup', init));
    if (downProceeded && !ctrlKey && !altKey && !metaKey && mainKey === 'Enter') {
      if (element instanceof realm.HTMLInputElement && element.form) {
        if (typeof element.form.requestSubmit === 'function') element.form.requestSubmit();
        else element.form.dispatchEvent(new realm.Event('submit', { bubbles: true, cancelable: true }));
      } else if (element.localName === 'button' || element.localName === 'a') {
        realm.HTMLElement.prototype.click.call(element);
      }
    }
    return { ok: true };
  }

  if (request.action === 'select') {
    if (!(element instanceof realm.HTMLSelectElement)) return unsupported('selectOption 的目标必须是原生 <select>');
    const option = Array.from(element.options).find(candidate => candidate.value === request.value)
      ?? Array.from(element.options).find(candidate => candidate.label === request.value);
    if (!option) return failed('未找到匹配 value 或文本的 option');
    if (option.disabled || (option.parentElement instanceof realm.HTMLOptGroupElement && option.parentElement.disabled)) {
      return failed('目标 option 已禁用');
    }
    // selectedIndex selects one concrete option even when values are duplicated.
    const setter = Object.getOwnPropertyDescriptor(realm.HTMLSelectElement.prototype, 'selectedIndex')?.set;
    if (!setter) return unsupported('页面不提供原生 select 赋值能力');
    setter.call(element, option.index);
    element.dispatchEvent(new realm.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new realm.Event('change', { bubbles: true }));
    return { ok: true };
  }

  const input = element instanceof realm.HTMLInputElement ? element : null;
  const textarea = element instanceof realm.HTMLTextAreaElement ? element : null;
  const textControl = input ?? textarea;
  const editable = element.isContentEditable || element.getAttribute('contenteditable') === 'true'
    || element.getAttribute('contenteditable') === '' || element.getAttribute('contenteditable') === 'plaintext-only';
  if (!input && !textarea && !editable) return unsupported('fill 只支持文本 input、textarea 或 contenteditable');
  if (input && !['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(input.type)) {
    return unsupported(`fill 不支持 input[type=${input.type}]`);
  }
  if (textControl?.readOnly) return failed('目标输入框为只读');
  const text = request.text;
  const eventOptions = { bubbles: true, composed: true, inputType: 'insertText', data: text };
  if (!element.dispatchEvent(new realm.InputEvent('beforeinput', { ...eventOptions, cancelable: true }))) {
    return unsupported('编辑器拒绝了合成 beforeinput，请手动操作；不会退回原生输入');
  }
  if (!element.isConnected) return failed('beforeinput 后目标元素已被替换，请重新取快照');
  if (textControl) {
    const prototype = input ? realm.HTMLInputElement.prototype : realm.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return unsupported('页面不提供原生文本赋值能力');
    // Native prototype setter also notifies controlled inputs via the input event
    // without invoking an instance's React value tracker setter.
    setter.call(textControl, text);
    if (textControl.value !== text) return failed('输入类型未接受该文本（例如日期或数字格式无效）');
  } else {
    // Whole-content replacement deliberately does not claim rich-text formatting,
    // cursor/selection, IME, or editor-specific model compatibility.
    element.textContent = text;
  }
  element.dispatchEvent(new realm.InputEvent('input', eventOptions));
  if (textControl) element.dispatchEvent(new realm.Event('change', { bubbles: true }));
  if ((textControl ? textControl.value : element.textContent) !== text) {
    return unsupported('编辑器未保留语义填充值，请手动操作；不会退回原生输入');
  }
  return { ok: true };
}

export async function semanticElementAction(
  locator: Locator,
  request: SemanticElementAction,
  timeout: number,
  targetHint?: string
): Promise<SemanticActionSuccess> {
  let timer: NodeJS.Timeout | undefined;
  let result: SemanticActionResult;
  try {
    result = await Promise.race([
      locator.evaluate(performSemanticElementAction, request, { timeout }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout ${timeout}ms exceeded during semantic ${request.action}`)),
          timeout + 250
        );
        timer.unref?.();
      })
    ]);
  } catch (err) {
    throw formatSemanticTargetError(targetHint, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result.ok) return result;
  if (result.code === 'capability_unsupported') throw new BrowserCapabilityUnsupportedError(request.action, result.error);
  throw new Error(`semantic_action_failed: ${result.error}`);
}

/**
 * 页面内语义按键（无显式元素定位器时作用于 document.activeElement 或 document.body）：
 * 此函数经 page.evaluate 序列化到浏览器上下文执行，必须完全自包含，不得引用任何模块级外部标识符！
 */
export function performSemanticPageKey(key: string): SemanticActionResult {
  const g = globalThis as unknown as {
    document?: { activeElement?: SemanticElement | null; body?: SemanticHTMLElement | null };
  };
  let target = (g.document?.activeElement && g.document.activeElement.localName !== 'body'
    ? g.document.activeElement
    : g.document?.body) as SemanticElement | null | undefined;
  // 若当前激活元素是同源 iframe，则下钻到 iframe 内部的 activeElement 或 body
  while (target && (target.localName === 'iframe' || target.localName === 'frame')) {
    try {
      const subDoc: SemanticDocument | null | undefined = target.contentDocument;
      const inner = (subDoc?.activeElement && subDoc.activeElement.localName !== 'body'
        ? subDoc.activeElement
        : subDoc?.body) as SemanticElement | null | undefined;
      if (!inner || inner === target) break;
      target = inner;
    } catch {
      break;
    }
  }
  if (!target || !target.isConnected || !target.ownerDocument?.defaultView) {
    return { ok: false, code: 'semantic_action_failed', error: '页面尚未就绪，无可用按键目标' };
  }
  const realm = target.ownerDocument.defaultView as SemanticRealm;
  if (!(target instanceof realm.HTMLElement)) {
    return { ok: false, code: 'capability_unsupported', error: '只支持 HTML 元素的 DOM 语义动作' };
  }
  if (target.matches(':disabled')) {
    return { ok: false, code: 'semantic_action_failed', error: '目标元素已禁用' };
  }
  const rawKey = String(key ?? '').trim();
  if (!rawKey) return { ok: false, code: 'semantic_action_failed', error: 'key 不能为空' };
  const parts = rawKey.split('+').filter(Boolean);
  let ctrlKey = false, shiftKey = false, altKey = false, metaKey = false;
  const mainKey = parts[parts.length - 1] ?? rawKey;
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === 'control' || mod === 'ctrl') ctrlKey = true;
    else if (mod === 'shift') shiftKey = true;
    else if (mod === 'alt' || mod === 'option') altKey = true;
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command') metaKey = true;
  }
  const code = mainKey.length === 1
    ? (/^[a-z]$/i.test(mainKey) ? `Key${mainKey.toUpperCase()}` : /^[0-9]$/.test(mainKey) ? `Digit${mainKey}` : mainKey)
    : mainKey;
  const KeyEv = realm.KeyboardEvent ?? realm.Event;
  const init = { key: mainKey, code, ctrlKey, shiftKey, altKey, metaKey, bubbles: true, cancelable: true, composed: true };
  const downProceeded = target.dispatchEvent(new KeyEv('keydown', init));
  if (mainKey.length === 1 || mainKey === 'Enter') {
    target.dispatchEvent(new KeyEv('keypress', init));
  }
  target.dispatchEvent(new KeyEv('keyup', init));
  if (downProceeded && !ctrlKey && !altKey && !metaKey && mainKey === 'Enter') {
    if (target instanceof realm.HTMLInputElement && target.form) {
      if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit();
      else target.form.dispatchEvent(new realm.Event('submit', { bubbles: true, cancelable: true }));
    } else if (target.localName === 'button' || target.localName === 'a') {
      realm.HTMLElement.prototype.click.call(target);
    }
  }
  return { ok: true };
}

export interface SemanticDragRequest {
  fromPoint?: { x: number; y: number } | null;
  toPoint?: { x: number; y: number } | null;
  fromSelector?: string | null;
  toSelector?: string | null;
  targetToken?: string | null;
}

/**
 * 页面内语义拖拽（支持元素选择器、小数坐标与同源 iframe 穿透，保证异常时也在 finally 释放指针按下态）。
 * 此函数经 page.evaluate 序列化执行，必须完全自包含！
 */
export function performSemanticDrag(req: SemanticDragRequest): SemanticActionResult {
  const g = globalThis as unknown as SemanticRealm & {
    document?: SemanticDocument;
  };
  const doc = g.document;
  if (!doc) return { ok: false, code: 'semantic_action_failed', error: '页面文档未就绪' };

  const createTrackedDataTransfer = (
    targetRealm: SemanticRealm
  ): { dt: SemanticDataTransfer; store: Record<string, string> } => {
    const store: Record<string, string> = {};
    let clearedAll = false;
    const clearedFormats = new Set<string>();
    const normalizeFormat = (fmt: string): string => {
      const f = String(fmt ?? '').toLowerCase();
      return f === 'text' ? 'text/plain' : f === 'url' ? 'text/uri-list' : f;
    };
    const clearStore = (format?: string): void => {
      if (format === undefined) {
        clearedAll = true;
        for (const k of Object.keys(store)) delete store[k];
      } else {
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        clearedFormats.add(normKey);
        delete store[rawKey];
        delete store[normKey];
        for (const k of Object.keys(store)) {
          if (normalizeFormat(k) === normKey) delete store[k];
        }
      }
    };
    let dt: SemanticDataTransfer;
    if (typeof targetRealm.DataTransfer === 'function') {
      dt = new targetRealm.DataTransfer();
      const origSet = typeof dt.setData === 'function' ? dt.setData.bind(dt) : null;
      const origGet = typeof dt.getData === 'function' ? dt.getData.bind(dt) : null;
      const origClear = typeof dt.clearData === 'function' ? dt.clearData.bind(dt) : null;
      dt.setData = (format: string, data: string): void => {
        const val = String(data ?? '');
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        clearedFormats.delete(normKey);
        store[rawKey] = val;
        store[normKey] = val;
        try { origSet?.(format, val); } catch { /* ignore */ }
      };
      dt.getData = (format: string): string => {
        const rawKey = String(format);
        const normKey = normalizeFormat(rawKey);
        if (Object.prototype.hasOwnProperty.call(store, rawKey)) return store[rawKey];
        if (Object.prototype.hasOwnProperty.call(store, normKey)) return store[normKey];
        if (clearedAll || clearedFormats.has(normKey)) return '';
        try {
          const nativeVal = origGet ? origGet(format) : '';
          if (nativeVal) return nativeVal;
        } catch { /* ignore */ }
        return '';
      };
      dt.clearData = (format?: string): void => {
        clearStore(format);
        try {
          if (format === undefined) origClear?.();
          else origClear?.(format);
        } catch { /* ignore */ }
      };
    } else {
      const types: string[] = [];
      dt = {
        types,
        setData(format: string, data: string): void {
          const val = String(data ?? '');
          const norm = normalizeFormat(format);
          clearedFormats.delete(norm);
          store[String(format)] = val;
          store[norm] = val;
          if (!types.includes(norm)) types.push(norm);
        },
        getData(format: string): string {
          return store[String(format)] ?? store[normalizeFormat(format)] ?? '';
        },
        clearData(format?: string): void {
          clearStore(format);
          if (format === undefined) {
            types.length = 0;
          } else {
            const norm = normalizeFormat(format);
            const idx = types.indexOf(norm);
            if (idx >= 0) types.splice(idx, 1);
          }
        }
      };
    }
    return { dt, store };
  };

  const makeDragEvent = (
    targetRealm: SemanticRealm,
    type: string,
    clientX: number,
    clientY: number,
    dt: SemanticDataTransfer
  ): object => {
    const Ctor = targetRealm.DragEvent ?? targetRealm.MouseEvent ?? targetRealm.Event ?? g.Event;
    const ev = new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      dataTransfer: dt
    }) as { dataTransfer?: SemanticDataTransfer };
    if (ev.dataTransfer !== dt) {
      try {
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
      } catch {
        /* ignore */
      }
    }
    return ev;
  };

  const findMarkedInDoc = (rootDoc: SemanticDocument | null | undefined, token: string): { el: SemanticElement; x: number; y: number; realm: SemanticRealm } | null => {
    if (!rootDoc || !rootDoc.defaultView) return null;
    const w = rootDoc.defaultView as SemanticRealm;
    if (w.__maDragTargets && w.__maDragTargets[token]) {
      const found = w.__maDragTargets[token];
      delete w.__maDragTargets[token];
      if (found && found.isConnected) {
        const r = typeof found.getBoundingClientRect === 'function'
          ? found.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 };
        return { el: found, x: r.left + r.width / 2, y: r.top + r.height / 2, realm: w };
      }
    }
    if (typeof rootDoc.querySelectorAll === 'function') {
      const frames = rootDoc.querySelectorAll('iframe, frame');
      for (let i = 0; i < frames.length; i++) {
        try {
          const sub = findMarkedInDoc(frames[i].contentDocument, token);
          if (sub) return sub;
        } catch {
          /* cross-origin frame */
        }
      }
    }
    return null;
  };

  const resolveEndpoint = (
    point?: { x: number; y: number } | null,
    selector?: string | null,
    token?: string | null
  ): { el: SemanticElement; x: number; y: number; realm: SemanticRealm; hit: boolean } | { error: string } => {
    if (token) {
      const marked = findMarkedInDoc(doc, token);
      if (marked) return { ...marked, hit: true };
    }
    if (point) {
      let curDoc: SemanticDocument | null | undefined = doc;
      let cx = point.x;
      let cy = point.y;
      let curRealm: SemanticRealm = g;
      let hit: SemanticElement | null = null;
      while (curDoc && typeof curDoc.elementFromPoint === 'function') {
        const candidate: SemanticElement | null = curDoc.elementFromPoint(cx, cy) ?? curDoc.body ?? null;
        if (!candidate) break;
        if (candidate.localName === 'iframe' || candidate.localName === 'frame') {
          try {
            const subDoc: SemanticDocument | null | undefined = candidate.contentDocument;
            if (subDoc && typeof subDoc.elementFromPoint === 'function') {
              const fr = typeof candidate.getBoundingClientRect === 'function'
                ? candidate.getBoundingClientRect()
                : { left: 0, top: 0 };
              cx = cx - fr.left - (candidate.clientLeft ?? 0);
              cy = cy - fr.top - (candidate.clientTop ?? 0);
              curDoc = subDoc;
              if (subDoc.defaultView) curRealm = subDoc.defaultView as SemanticRealm;
              continue;
            }
          } catch {
            /* cross-origin iframe */
          }
        }
        hit = candidate;
        break;
      }
      if (!hit) return { error: `坐标 (${point.x}, ${point.y}) 未命中任何元素` };
      const hitIframeContainer = hit.localName === 'iframe' || hit.localName === 'frame';
      return { el: hit, x: cx, y: cy, realm: curRealm, hit: !token && !hitIframeContainer };
    }
    if (selector) {
      let el: SemanticElement | null = null;
      try {
        el = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null;
      } catch {
        return { error: `无效的选择器：${selector}` };
      }
      if (!el || typeof el.getBoundingClientRect !== 'function') {
        return { error: '拖拽源不可见或无包围盒' };
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        return { error: '拖拽源不可见或无包围盒' };
      }
      const realm = (el.ownerDocument?.defaultView as SemanticRealm | undefined) ?? g;
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2, realm, hit: true };
    }
    return { error: '缺少拖拽端点' };
  };

  const from = resolveEndpoint(req.fromPoint, req.fromSelector, null);
  if ('error' in from) return { ok: false, code: 'semantic_action_failed', error: from.error };
  const to = resolveEndpoint(req.toPoint, req.toSelector, req.targetToken);
  if ('error' in to) return { ok: false, code: 'semantic_action_failed', error: to.error };

  const MouseEv = from.realm.MouseEvent ?? from.realm.Event ?? g.Event;
  const PointerEv = from.realm.PointerEvent ?? MouseEv;
  const { dt: dataTransfer, store: dragData } = createTrackedDataTransfer(from.realm);

  let pointerDownSent = false;
  let lastX = from.x;
  let lastY = from.y;
  try {
    from.el.dispatchEvent(new PointerEv('pointerdown', {
      bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
      button: 0, buttons: 1, clientX: from.x, clientY: from.y
    }));
    pointerDownSent = true;
    from.el.dispatchEvent(new MouseEv('mousedown', {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: from.x, clientY: from.y
    }));
    from.el.dispatchEvent(makeDragEvent(from.realm, 'dragstart', from.x, from.y, dataTransfer));
    if (Array.isArray(dataTransfer.types)) {
      for (const t of dataTransfer.types) {
        try {
          const v = dataTransfer.getData(t);
          if (v && !(t in dragData)) dragData[t] = v;
        } catch { /* ignore */ }
      }
    }

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    for (const [cx, cy] of [[midX, midY], [to.x, to.y]] as const) {
      lastX = cx;
      lastY = cy;
      from.el.dispatchEvent(new PointerEv('pointermove', {
        bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
        button: 0, buttons: 1, clientX: cx, clientY: cy
      }));
      from.el.dispatchEvent(new MouseEv('mousemove', {
        bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: cx, clientY: cy
      }));
    }

    if (to.hit) {
      to.el.dispatchEvent(makeDragEvent(to.realm, 'dragenter', to.x, to.y, dataTransfer));
      to.el.dispatchEvent(makeDragEvent(to.realm, 'dragover', to.x, to.y, dataTransfer));
      to.el.dispatchEvent(makeDragEvent(to.realm, 'drop', to.x, to.y, dataTransfer));
    }
    return { ok: true, targetHit: to.hit, dragData };
  } finally {
    if (pointerDownSent) {
      try {
        from.el.dispatchEvent(new PointerEv('pointerup', {
          bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true,
          button: 0, buttons: 0, clientX: lastX, clientY: lastY
        }));
        from.el.dispatchEvent(new MouseEv('mouseup', {
          bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, clientX: lastX, clientY: lastY
        }));
        from.el.dispatchEvent(makeDragEvent(from.realm, 'dragend', lastX, lastY, dataTransfer));
      } catch {
        /* 释放阶段异常不再掩盖主流程 */
      }
    }
  }
}

/** Hit-test the viewport and send button events without granting user activation. */
export function performSemanticCoordinateClick(point: { x: number; y: number }): SemanticActionResult {
  const viewport = globalThis as unknown as SemanticRealm & { document: SemanticDocument };
  let x = point.x, y = point.y;
  let element = viewport.document.elementFromPoint?.(x, y);
  while (element) {
    const shadowHit = element.shadowRoot?.elementFromPoint(x, y);
    if (shadowHit && shadowHit !== element) {
      element = shadowHit;
      continue;
    }
    if (element.localName !== 'iframe' && element.localName !== 'frame') break;
    const frameDocument = element.contentDocument, bounds = element.getBoundingClientRect?.();
    if (!frameDocument || !bounds) {
      return { ok: false, code: 'capability_unsupported', error: '坐标命中跨源 iframe，请使用该帧的快照 ref' };
    }
    x -= bounds.left + (element.clientLeft ?? 0);
    y -= bounds.top + (element.clientTop ?? 0);
    element = frameDocument.elementFromPoint?.(x, y);
  }
  const realm = element?.ownerDocument.defaultView as SemanticRealm | undefined;
  if (!element || !realm || !element.isConnected) {
    return { ok: false, code: 'semantic_action_failed', error: '坐标未命中网页元素，请使用视口内的 CSS 像素坐标' };
  }
  if (element.closest(':disabled')) {
    return { ok: false, code: 'semantic_action_failed', error: '目标元素已禁用' };
  }
  if (element instanceof realm.HTMLInputElement && element.type === 'file') {
    return { ok: false, code: 'capability_unsupported', error: '请使用受控上传工具或在原生网页中手动选择文件' };
  }
  const Mouse = realm.MouseEvent ?? realm.Event, Pointer = realm.PointerEvent ?? Mouse;
  const position = { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, button: 0, detail: 1 };
  const pointer = { ...position, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const mouseEvents = element.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
  if (mouseEvents) element.dispatchEvent(new Mouse('mousedown', { ...position, buttons: 1 }));
  element.dispatchEvent(new Pointer('pointerup', { ...pointer, buttons: 0 }));
  if (mouseEvents) element.dispatchEvent(new Mouse('mouseup', { ...position, buttons: 0 }));
  if (!element.isConnected) {
    return { ok: false, code: 'semantic_action_failed', error: '目标元素在点击期间脱离页面' };
  }
  element.dispatchEvent(new Pointer('click', { ...pointer, buttons: 0 }));
  return { ok: true };
}

/** Fixed main-frame scroll, evaluated through the same non-user-gesture proxy. */
export function performSemanticScroll(delta: number): void {
  const scroller = (globalThis as unknown as { document: {
    scrollingElement: { scrollBy(options: { top: number; left: number; behavior: string }): void } | null;
  } }).document.scrollingElement;
  if (!scroller) throw new Error('semantic_action_failed: 页面没有可滚动的根节点');
  // Avoid CSS smooth scrolling extending a queued action after it has returned.
  scroller.scrollBy({ top: delta, left: 0, behavior: 'instant' });
}

/**
 * 构造受焦点保护的 evaluate 包装脚本：
 * - 覆盖主 frame 与所有可达同源子 frame（含已有 iframe、动态插入的 iframe、通过 contentWindow/contentDocument 访问的 iframe）
 * - 跨 async/await 以及表达式内注册的延迟回调（setTimeout / setInterval / requestAnimationFrame / requestIdleCallback / queueMicrotask / Promise.then）
 *   全程按进入/退出深度自动开启与还原 window/HTMLElement/SVGElement/Element/MathMLElement 的 focus/blur 屏蔽
 * - 同一文档的调用与延迟回调共享控制器，避免交错执行时把另一调用的补丁当作原方法还原
 */
export function buildProtectedEvaluateScript(expr: string): string {
  return `((__maExpr) => {
    const guardKey = Symbol.for('muster.browser.evaluateFocusGuard.v1');
    const existingGuard = window[guardKey];
    if (existingGuard) return existingGuard.run(__maExpr);
    const noop = function() {};
    const rawPromise = typeof Promise !== 'undefined' ? Promise : null;
    const rawThen = rawPromise && rawPromise.prototype ? rawPromise.prototype.then : null;
    let activeDepth = 0;
    let runningEvaluations = 0;
    const patchedWins = [];
    const restorers = [];
    const hasWin = (w) => patchedWins.indexOf(w) >= 0;
    const addWin = (w) => { if (!hasWin(w)) patchedWins.push(w); };

    const patchMethod = (obj, prop, fn) => {
      if (!obj) return;
      try {
        const hadOwn = Object.prototype.hasOwnProperty.call(obj, prop);
        const desc = Object.getOwnPropertyDescriptor(obj, prop);
        const prev = obj[prop];
        if (prev === fn) return;
        obj[prop] = fn;
        restorers.push(() => {
          try {
            if (hadOwn && desc) Object.defineProperty(obj, prop, desc);
            else if (hadOwn) obj[prop] = prev;
            else {
              delete obj[prop];
              if (obj[prop] === fn) obj[prop] = prev;
            }
          } catch {
            try { obj[prop] = prev; } catch {}
          }
        });
      } catch {}
    };

    const patchFrameGetter = (proto, prop) => {
      if (!proto) return;
      try {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: !!desc.enumerable,
          get: function() {
            const val = desc.get.call(this);
            try {
              if (activeDepth > 0) {
                if (prop === 'contentWindow' && val) patchWin(val);
                else if (prop === 'contentDocument' && val && val.defaultView) patchWin(val.defaultView);
              }
            } catch {}
            return val;
          }
        });
        restorers.push(() => {
          try { Object.defineProperty(proto, prop, desc); } catch {}
        });
      } catch {}
    };

    const wrapCallback = (cb) => {
      if (typeof cb === 'string') {
        const code = cb;
        cb = function() { return (0, eval)(code); };
      }
      if (typeof cb !== 'function') return cb;
      if (cb.__maFocusWrapped) return cb;
      const wrapped = function() {
        enterGuard();
        let asyncPending = false;
        try {
          const r = cb.apply(this, arguments);
          if (r && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
            asyncPending = true;
            if (rawThen) {
              const p = rawThen.call(r, exitGuard, exitGuard);
              try { p.__maInternalPromise = true; } catch {}
            } else {
              r.then(exitGuard, exitGuard);
            }
          }
          return r;
        } finally {
          if (!asyncPending) {
            if (runningEvaluations > 0 || !rawPromise || !rawThen) {
              exitGuard();
            } else {
              const p = rawThen.call(rawPromise.resolve(), exitGuard, exitGuard);
              try { p.__maInternalPromise = true; } catch {}
            }
          }
        }
      };
      try { wrapped.__maFocusWrapped = true; } catch {}
      return wrapped;
    };

    const patchScheduler = (w, name) => {
      if (!w || typeof w[name] !== 'function') return;
      const orig = w[name];
      if (orig.__maSchedulerPatched) return;
      const replacement = function(cb) {
        const args = Array.prototype.slice.call(arguments);
        if (activeDepth > 0 && args.length > 0) {
          args[0] = wrapCallback(cb);
        }
        return orig.apply(this, args);
      };
      try { replacement.__maSchedulerPatched = true; } catch {}
      patchMethod(w, name, replacement);
    };

    const patchPromiseThen = (w) => {
      const P = w && w.Promise;
      if (!P || !P.prototype || typeof P.prototype.then !== 'function') return;
      const origThen = P.prototype.then;
      if (origThen.__maThenPatched) return;
      const replacement = function(onFulfilled, onRejected) {
        if (this && (this.__maOuterPromise || this.__maInternalPromise)) {
          return origThen.call(this, onFulfilled, onRejected);
        }
        const f = activeDepth > 0 && typeof onFulfilled === 'function' ? wrapCallback(onFulfilled) : onFulfilled;
        const r = activeDepth > 0 && typeof onRejected === 'function' ? wrapCallback(onRejected) : onRejected;
        return origThen.call(this, f, r);
      };
      try { replacement.__maThenPatched = true; } catch {}
      patchMethod(P.prototype, 'then', replacement);
    };

    const patchWin = (w) => {
      if (!w || (typeof w !== 'object' && typeof w !== 'function') || hasWin(w)) return;
      addWin(w);
      patchMethod(w, 'focus', noop);
      patchMethod(w, 'blur', noop);
      for (const name of ['HTMLElement', 'SVGElement', 'Element', 'MathMLElement']) {
        const ctor = w[name];
        if (ctor && ctor.prototype) {
          patchMethod(ctor.prototype, 'focus', noop);
          patchMethod(ctor.prototype, 'blur', noop);
        }
      }
      for (const fName of ['HTMLIFrameElement', 'HTMLFrameElement']) {
        const fCtor = w[fName];
        if (fCtor && fCtor.prototype) {
          patchFrameGetter(fCtor.prototype, 'contentWindow');
          patchFrameGetter(fCtor.prototype, 'contentDocument');
        }
      }
      for (const sName of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask', 'setImmediate']) {
        patchScheduler(w, sName);
      }
      patchPromiseThen(w);
      if (w.Node && w.Node.prototype) {
        for (const mName of ['appendChild', 'insertBefore', 'replaceChild']) {
          const orig = w.Node.prototype[mName];
          if (typeof orig === 'function') {
            patchMethod(w.Node.prototype, mName, function() {
              const res = orig.apply(this, arguments);
              try { if (activeDepth > 0) scanDoc(w.document); } catch {}
              return res;
            });
          }
        }
      }
      if (w.Element && w.Element.prototype) {
        for (const mName of ['append', 'prepend', 'replaceChildren', 'insertAdjacentElement', 'insertAdjacentHTML']) {
          const orig = w.Element.prototype[mName];
          if (typeof orig === 'function') {
            patchMethod(w.Element.prototype, mName, function() {
              const res = orig.apply(this, arguments);
              try { if (activeDepth > 0) scanDoc(w.document); } catch {}
              return res;
            });
          }
        }
      }
      try { scanDoc(w.document); } catch {}
      try {
        if (w.frames && typeof w.frames.length === 'number') {
          for (let i = 0; i < w.frames.length; i++) {
            try { patchWin(w.frames[i]); } catch {}
          }
        }
      } catch {}
    };

    const scanDoc = (doc) => {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      const frames = doc.querySelectorAll('iframe, frame');
      for (let i = 0; i < frames.length; i++) {
        try {
          const f = frames[i];
          if (f.contentWindow) patchWin(f.contentWindow);
          if (f.contentDocument && f.contentDocument.defaultView) patchWin(f.contentDocument.defaultView);
        } catch {}
      }
    };

    const installPatches = () => {
      patchWin(window);
      if (typeof globalThis !== 'undefined' && globalThis !== window) {
        patchWin(globalThis);
      }
    };

    const uninstallPatches = () => {
      for (let i = restorers.length - 1; i >= 0; i--) {
        try { restorers[i](); } catch {}
      }
      restorers.length = 0;
      patchedWins.length = 0;
    };

    const enterGuard = () => {
      activeDepth++;
      if (activeDepth === 1) {
        installPatches();
      } else {
        try { scanDoc(window.document); } catch {}
      }
    };

    const exitGuard = () => {
      if (activeDepth <= 0) return;
      activeDepth--;
      if (activeDepth === 0) {
        uninstallPatches();
      }
    };

    const run = async (expression) => {
      runningEvaluations++;
      enterGuard();
      try {
        const out = await (0, eval)(expression);
        if (out === undefined) return null;
        if (out === null || typeof out === 'string' || typeof out === 'number' || typeof out === 'boolean') return out;
        try { return JSON.parse(JSON.stringify(out)); } catch { return String(out); }
      } finally {
        runningEvaluations--;
        exitGuard();
      }
    };
    const guard = {
      run(expression) {
        const outer = run(expression);
        try { outer.__maOuterPromise = true; } catch {}
        return outer;
      }
    };
    // Keep the controller for this document even while inactive: old scheduled
    // callbacks must re-enter the same state used by subsequent evaluations.
    Object.defineProperty(window, guardKey, { value: guard, configurable: true });
    return guard.run(__maExpr);
  })(${JSON.stringify(expr)})`;
}
