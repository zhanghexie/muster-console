import { randomUUID } from 'node:crypto';
import { DesktopSemanticRefs, type SemanticSurfaceIdentity } from './semanticRefs';
import type { CuaConnection, CuaSetValueDelivery } from './cuaTransport';

type Node = { token: string };
type DriverResult = { isError?: boolean; structuredContent?: unknown; content?: unknown };
type DriverWindowState = { pid?: unknown; window_id?: unknown; snapshot_id?: unknown; elements?: unknown; truncated?: unknown;
  elements_complete?: unknown; capture_id?: unknown; screenshot_width?: unknown; screenshot_height?: unknown;
  screenshot_frame_valid?: unknown; screenshot_error?: unknown };
export type CuaWindowImage = { png: Buffer; width: number; height: number };
export type CuaWindowPoint = { x: number; y: number; button?: 'left' | 'middle' | 'right'; count: 1 | 2 };

export class CuaWindowCaptureError extends Error {
  constructor(readonly code: 'window_capture_unavailable' | 'invalid_driver_response', message: string) { super(message); }
}
type DriverElement = { element_token?: unknown; role?: unknown; label?: unknown; value?: unknown; enabled?: unknown; selected?: unknown;
  depth?: unknown; actions?: unknown; is_password?: unknown; is_secure?: unknown };
type ProjectedElement = { ref?: string; role?: string; label?: string; valueRedacted?: boolean; labelRedacted?: boolean;
  enabled?: boolean; selected?: boolean; depth?: number; actions: string[] };
type ProjectedSnapshot = { snapshotId: string; expiresAt: number; elements: ProjectedElement[]; truncated: boolean; complete: boolean;
  operable: boolean; treeAvailable: boolean };
const PAGE_LIMIT_CHARS = 8000;

function inputLike(item: DriverElement): boolean {
  const role = typeof item.role === 'string' ? item.role.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const actions = Array.isArray(item.actions) ? item.actions.filter((value): value is string => typeof value === 'string') : [];
  return item.is_password === true || item.is_secure === true ||
    /^(?:ax)?(?:securetext(?:field|area)?|textfield|textarea|searchfield|edit|editabletext|entry|passwordtext|password|text)$/.test(role) ||
    actions.some(action => /^(setvalue|typetext|inserttext|text)$/.test(action.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

/** Keep input values private when the driver cannot prove label provenance. */
function projectElements(elements: DriverElement[], refs?: readonly string[]): ProjectedElement[] {
  const sensitiveValues = elements.filter(inputLike).map(item => typeof item.value === 'string' ? item.value : '')
    .flatMap(value => value && value.trim() !== value ? [value, value.trim()] : value ? [value] : []).filter(Boolean);
  const oversizedSensitiveValue = sensitiveValues.some(value => value.length > 4096);
  const safe = (value: unknown, max: number, ownValue?: unknown): string | undefined => {
    if (typeof value !== 'string' || oversizedSensitiveValue) return undefined;
    const visible = value.slice(0, max);
    const secrets = typeof ownValue === 'string' && ownValue ? [...sensitiveValues, ownValue, ownValue.trim()] : sensitiveValues;
    // Check the part that can actually be returned, including when it is a
    // truncated prefix of a value. Oversized input values degrade all labels.
    if (visible && secrets.some(secret => secret && (visible.includes(secret) || secret.includes(visible)))) return undefined;
    return visible;
  };
  return elements.map((item, index) => {
    // An input label without a value has unknown provenance: it may itself be
    // the driver's value fallback, so do not guess that it is safe to expose.
    const label = inputLike(item) && (typeof item.value !== 'string' || !item.value) ? undefined : safe(item.label, 256, item.value);
    const actions = Array.isArray(item.actions) ? item.actions.filter((value): value is string => typeof value === 'string').slice(0, 8)
      .map(value => safe(value, 64)).filter((value): value is string => value !== undefined) : [];
    return { ...(refs ? { ref: refs[index] } : {}), role: safe(item.role, 64), label,
      ...(typeof item.value === 'string' && item.value ? { valueRedacted: true } : {}),
      ...(typeof item.label === 'string' && label === undefined ? { labelRedacted: true } : {}),
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      selected: typeof item.selected === 'boolean' ? item.selected : undefined,
      depth: typeof item.depth === 'number' && Number.isSafeInteger(item.depth) ? item.depth : undefined, actions };
  });
}

export class CuaUncertainActionError extends Error {
  constructor(readonly outcome: ReturnType<typeof projectCuaActionResult>) {
    super('Cua action outcome is unknown or partial; observe before another action');
    this.name = 'CuaUncertainActionError';
  }
}

/** Expose an effect, not the driver's native window identifiers or arbitrary payload. */
export function projectCuaActionResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Cua action response; outcome is unknown');
  const response = result as DriverResult;
  if (response.isError !== undefined && typeof response.isError !== 'boolean') throw new Error('Invalid Cua action response; outcome is unknown');
  const structured = response.structuredContent && typeof response.structuredContent === 'object' && !Array.isArray(response.structuredContent)
    ? response.structuredContent as { effect?: unknown; code?: unknown } : {};
  const effects = ['confirmed', 'unverifiable', 'refused', 'not_applied', 'suspected_noop', 'partial', 'unknown'] as const;
  type Effect = typeof effects[number];
  const observed = effects.find(effect => effect === structured.effect);
  const effect: Effect = observed && !(response.isError && observed === 'confirmed') ? observed : response.isError ? 'unknown' : 'unverifiable';
  const code = typeof structured.code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(structured.code) ? structured.code : undefined;
  return { ok: response.isError !== true && !['refused', 'not_applied', 'suspected_noop', 'partial', 'unknown'].includes(effect),
    delivery: 'unknown' as const, effect, verification: 'not_performed' as const, ...(code ? { code } : {}) };
}

/** One trusted target and driver session; neither native handles nor driver tokens escape to the model. */
export class CuaSemanticSession {
  private readonly refs = new DesktopSemanticRefs<Node>();
  private readonly session = randomUUID();
  private identity: SemanticSurfaceIdentity | undefined;
  private snapshot: ProjectedSnapshot | undefined;
  private capture?: { id: string; width: number; height: number };
  private active = true;
  private revision = 0;
  private observing = false;
  private acting = false;
  constructor(private readonly driver: CuaConnection, private readonly surfaceId: string,
    private readonly generation: string, private readonly pid: number, private readonly windowId: number,
    private readonly targetIsCurrent: () => boolean,
    private readonly setValueDelivery: CuaSetValueDelivery) {
    if (!surfaceId || !generation || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0 || typeof targetIsCurrent !== 'function' ||
        !['mode-parameter', 'background-only', 'unavailable'].includes(setValueDelivery)) {
      throw new Error('Invalid Cua semantic target');
    }
  }

  async observe(signal?: AbortSignal, withImage = false): Promise<ReturnType<CuaSemanticSession['page']> & { image?: CuaWindowImage }> {
    this.assertActive();
    if (this.acting) throw new Error('Cua semantic action still in progress');
    if (this.observing) throw new Error('Cua semantic observation already in progress');
    this.observing = true;
    try {
      // A failed or overlapping observation must never leave old references usable.
      const revision = ++this.revision;
      this.identity = undefined;
      this.snapshot = undefined;
      this.capture = undefined;
      this.refs.revokeSurface(this.surfaceId);
      const response = await this.driver.call('get_window_state', { pid: this.pid, window_id: this.windowId,
        include_accessibility_tree: true, include_screenshot: withImage, tree_format: 'elements', max_elements: 500,
        ...(withImage ? { max_image_dimension: 1280 } : {}), session: this.session }, signal) as DriverResult;
      this.assertActive(); signal?.throwIfAborted();
      if (revision !== this.revision) throw new Error('Cua semantic observation was superseded');
      if (!response?.structuredContent || typeof response.structuredContent !== 'object') throw new Error('Cua semantic observation failed');
      const content = response.structuredContent as DriverWindowState;
      if (withImage && (content.screenshot_error || content.screenshot_frame_valid === false)) throw this.unavailableImage();
      if (response.isError) throw new Error('Cua semantic observation failed');
      const treeAvailable = Array.isArray(content.elements);
      if (content.pid !== this.pid || content.window_id !== this.windowId ||
          (content.snapshot_id != null && (typeof content.snapshot_id !== 'string' || !/^s[0-9a-f]{8}$/.test(content.snapshot_id))) ||
          (!treeAvailable && (!withImage || content.elements !== undefined))) throw new Error('Invalid Cua semantic observation');
      const elements = treeAvailable ? content.elements as DriverElement[] : [];
      if (elements.length > 500) throw new Error('Invalid Cua semantic observation');
      if (elements.some(item => !item || typeof item !== 'object' ||
          (item.is_password != null && typeof item.is_password !== 'boolean') || (item.is_secure != null && typeof item.is_secure !== 'boolean') ||
          (item.element_token != null &&
          (typeof item.element_token !== 'string' || !/^s[0-9a-f]{8}:[0-9]+$/.test(item.element_token) ||
            (typeof content.snapshot_id === 'string' && !item.element_token.startsWith(`${content.snapshot_id}:`)))))) throw new Error('Invalid Cua semantic element');
      const operable = treeAvailable && typeof content.snapshot_id === 'string' && elements.every(item => typeof item.element_token === 'string');
      const image = withImage ? this.readImage(response, content) : undefined;
      const identity = operable ? { surfaceId: this.surfaceId, surfaceGeneration: this.generation, semanticRevision: content.snapshot_id as string } : undefined;
      const refs = identity ? this.refs.create(identity, elements.map(item => ({ token: item.element_token as string })), 60_000) : undefined;
      this.identity = identity;
      const snapshot = { snapshotId: refs?.snapshotId ?? randomUUID(), expiresAt: refs?.expiresAt ?? Date.now() + 60_000 };
      this.snapshot = { snapshotId: snapshot.snapshotId, expiresAt: snapshot.expiresAt, operable, treeAvailable,
        truncated: content.truncated === true, complete: content.elements_complete === true,
        elements: projectElements(elements, refs?.refs) };
      const page = this.page(snapshot.snapshotId, 0);
      return image ? { ...page, image } : page;
    } finally { this.observing = false; }
  }

  private readImage(response: DriverResult, content: DriverWindowState): CuaWindowImage {
    const parts = Array.isArray(response.content) ? response.content.filter(part => part?.type === 'image') : [];
    const { capture_id: id, screenshot_width: width, screenshot_height: height } = content;
    if (!parts.length || typeof id !== 'string' || !id.trim()) throw this.unavailableImage();
    const part = parts[0];
    if (parts.length !== 1 || part.mimeType !== 'image/png' || typeof part.data !== 'string' || part.data.length > 28_000_000 ||
        id.length > 256 || typeof width !== 'number' || !Number.isSafeInteger(width) || typeof height !== 'number' || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width * height > 40_000_000) {
      throw new CuaWindowCaptureError('invalid_driver_response', 'Cua returned an invalid window screenshot.');
    }
    const png = Buffer.from(part.data, 'base64');
    if (png.length < 45 || png.length > 20 * 1024 * 1024 || png.readBigUInt64BE() !== 0x89504e470d0a1a0an ||
        png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new CuaWindowCaptureError('invalid_driver_response', 'Cua window screenshot dimensions do not match its action frame.');
    }
    this.capture = { id, width, height };
    return { png, width, height };
  }

  private unavailableImage(): CuaWindowCaptureError {
    return new CuaWindowCaptureError('window_capture_unavailable',
      'The driver could not bind a screenshot to this window. Try a visible window or request its semantic tree. On Wayland, check compositor or portal support.');
  }

  validatePoint(snapshotId: string, point: CuaWindowPoint): void {
    this.assertActive();
    const frame = this.capture, snapshot = this.snapshot;
    if (!frame || !snapshot || snapshot.snapshotId !== snapshotId || snapshot.expiresAt <= Date.now() ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height) {
      throw new Error('The window screenshot or point is unavailable. Look at the window again.');
    }
  }

  async clickPoint(snapshotId: string, point: CuaWindowPoint, signal?: AbortSignal) {
    this.validatePoint(snapshotId, point);
    const captureId = this.capture!.id;
    return this.execute('click', { x: point.x, y: point.y, capture_id: captureId, count: point.count,
      ...(point.button ? { button: point.button } : {}), delivery_mode: 'foreground' }, signal);
  }

  /** Pages are bounded for the host's tool-result limit and share one snapshot. */
  page(snapshotId: string, offset: number) {
    this.assertActive();
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.snapshotId !== snapshotId || snapshot.expiresAt <= Date.now()) throw new Error('Stale Cua semantic observation');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.elements.length) throw new Error('Invalid Cua semantic page offset');
    const elements: ProjectedElement[] = [];
    let size = 0;
    for (const element of snapshot.elements.slice(offset)) {
      const itemSize = JSON.stringify(element).length + 1;
      if (size + itemSize > PAGE_LIMIT_CHARS) break;
      size += itemSize;
      elements.push(this.setValueDelivery === 'unavailable' ? { ...element,
        actions: element.actions.filter(action => !/^set[_\s-]?value$/i.test(action)) } : element);
    }
    const nextOffset = offset + elements.length < snapshot.elements.length ? offset + elements.length : null;
    if (nextOffset === offset) throw new Error('Cua semantic element exceeds page limit');
    return { snapshotId, expiresAt: snapshot.expiresAt, elements, total: snapshot.elements.length, nextOffset, operable: snapshot.operable,
      treeAvailable: snapshot.treeAvailable,
      limitations: ['semantic_values_redacted', 'input_label_provenance_unverified', ...(!snapshot.treeAvailable ? ['semantic_tree_unavailable'] : []),
        ...(!snapshot.operable ? ['semantic_refs_unavailable'] : []),
        ...(this.setValueDelivery === 'unavailable' ? ['semantic_set_value_unavailable'] : [])],
      truncated: snapshot.truncated, complete: snapshot.treeAvailable && snapshot.complete && !snapshot.truncated && nextOffset === null };
  }

  async act(snapshotId: string, ref: string, action: 'click' | 'set_value', value?: string, signal?: AbortSignal,
    delivery: 'background' | 'foreground' = 'background') {
    this.assertActive();
    if (this.observing || this.acting) throw new Error('Cua semantic operation already in progress');
    if (!this.identity) throw new Error('Observe the window again');
    if (action !== 'click' && action !== 'set_value') throw new Error('Unsupported semantic action');
    if (delivery !== 'background' && delivery !== 'foreground') throw new Error('Invalid semantic delivery mode');
    if (action === 'set_value' && (typeof value !== 'string' || value.length > 4096)) throw new Error('Invalid semantic value');
    if (action === 'set_value' && this.setValueDelivery === 'unavailable') throw new Error('Semantic set_value is not supported by this driver');
    if (action === 'set_value' && this.setValueDelivery === 'background-only' && delivery !== 'background') {
      throw new Error('Foreground semantic set_value is not supported by this driver');
    }
    const node = this.refs.resolve(snapshotId, ref, this.identity);
    return this.execute(action, { element_token: node.token,
      ...(action !== 'set_value' || this.setValueDelivery === 'mode-parameter' ? { delivery_mode: delivery } : {}),
      ...(action === 'set_value' ? { value } : {}) }, signal);
  }

  private async execute(action: 'click' | 'set_value', args: Record<string, unknown>, signal?: AbortSignal) {
    if (this.observing || this.acting) throw new Error('Cua semantic operation already in progress');
    // Consume the observation before dispatch: an uncertain write must never reuse it.
    this.revision++;
    this.identity = undefined;
    this.snapshot = undefined;
    this.capture = undefined;
    this.refs.revokeSurface(this.surfaceId);
    this.acting = true;
    try {
      this.assertActive();
      const result = await this.driver.call(action, { ...args, pid: this.pid, window_id: this.windowId, session: this.session }, signal);
      this.assertActive(); signal?.throwIfAborted();
      const outcome = projectCuaActionResult(result);
      if (!outcome.ok && outcome.effect !== 'refused' && outcome.effect !== 'not_applied') throw new CuaUncertainActionError(outcome);
      return outcome;
    } finally { this.acting = false; }
  }

  close(): void { this.active = false; this.revision++; this.identity = undefined; this.snapshot = undefined; this.capture = undefined; this.refs.revokeSurface(this.surfaceId); }
  private assertActive(): void {
    if (!this.active) throw new Error('Cua semantic session is closed');
    let current = false;
    try { current = this.targetIsCurrent(); } catch { /* a failed identity check is stale */ }
    if (!current) { this.identity = undefined; this.snapshot = undefined; this.capture = undefined; this.refs.revokeSurface(this.surfaceId); throw new Error('Cua semantic target changed; observe again'); }
  }
}
