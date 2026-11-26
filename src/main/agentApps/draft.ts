/** Copy-on-write drafts for the plain JSON-shaped app state used by the storage worker. */
const DRAFT = Symbol('agent-app-draft');
type Plain = Record<PropertyKey, unknown> | unknown[];
type DraftState = { base: Plain; copy?: Plain; parent?: DraftState; key?: PropertyKey; assigned: boolean; children: Map<PropertyKey, DraftState>; proxy: Plain };
const draftable = (value: unknown): value is Plain => !!value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
const source = (state: DraftState): Plain => state.copy ?? state.base;
function setCopy(copy: Plain, property: PropertyKey, value: unknown): void {
  const descriptor = Reflect.getOwnPropertyDescriptor(copy, property);
  if (descriptor && !('value' in descriptor)) Object.defineProperty(copy, property, { value, enumerable: descriptor.enumerable, configurable: true, writable: true });
  else Reflect.set(copy, property, value);
}

function markChanged(state: DraftState): void {
  if (state.copy) return;
  state.copy = Array.isArray(state.base) ? state.base.slice() : Object.create(Object.getPrototypeOf(state.base), Object.getOwnPropertyDescriptors(state.base)) as Plain;
  if (!state.parent || state.key === undefined) return;
  const parentValue = Reflect.get(source(state.parent), state.key);
  if (parentValue !== state.base && parentValue !== state.proxy) return;
  markChanged(state.parent);
  setCopy(state.parent.copy!, state.key, state.proxy);
}
function createDraft(base: Plain, parent?: DraftState, key?: PropertyKey): DraftState {
  const state: DraftState = { base, parent, key, assigned: !!parent && key !== undefined && Reflect.get(parent.base, key) !== base, children: new Map(), proxy: base };
  state.proxy = new Proxy(base, {
    get(_target, property, receiver) {
      if (property === DRAFT) return state;
      const value = Reflect.get(source(state), property, receiver);
      if (!draftable(value) || Reflect.get(value, DRAFT)) return value;
      let child = state.children.get(property);
      if (!child || child.base !== value) { child = createDraft(value, state, property); state.children.set(property, child); }
      return child.proxy;
    },
    set(_target, property, value) {
      if (Object.is(Reflect.get(source(state), property), value)) return true;
      markChanged(state); setCopy(state.copy!, property, value); state.children.delete(property); return true;
    },
    deleteProperty(_target, property) {
      if (!Reflect.has(source(state), property)) return true;
      markChanged(state); Reflect.deleteProperty(state.copy!, property); state.children.delete(property); return true;
    },
    has(_target, property) { return Reflect.has(source(state), property); },
    ownKeys() { return Reflect.ownKeys(source(state)); },
    getOwnPropertyDescriptor(_target, property) { return Reflect.getOwnPropertyDescriptor(source(state), property); }
  });
  return state;
}
function finishAssigned(value: unknown): unknown {
  if (!draftable(value)) return value;
  const state = Reflect.get(value, DRAFT) as DraftState | undefined;
  if (state) return finish(state);
  if (Array.isArray(value)) return value.map(finishAssigned);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finishAssigned(item)]));
}
function finish(state: DraftState): Plain {
  if (!state.copy) return state.assigned ? finishAssigned(state.base) as Plain : state.base;
  for (const property of Reflect.ownKeys(state.copy)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(state.copy, property), previous = Reflect.getOwnPropertyDescriptor(state.base, property);
    if (descriptor && !('value' in descriptor) && previous && !('value' in previous) && descriptor.get === previous.get && descriptor.set === previous.set) continue;
    const value = Reflect.get(state.copy, property);
    if (state.assigned || value !== Reflect.get(state.base, property) || draftable(value) && Reflect.get(value, DRAFT)) Reflect.set(state.copy, property, finishAssigned(value));
  }
  return state.copy;
}
export function produceAppDraft<T extends object, R>(base: T, update: (draft: T) => R): { next: T; result: R } {
  if (!draftable(base)) throw new Error('App draft needs a plain object');
  const state = createDraft(base);
  const result = update(state.proxy as T);
  return { next: finish(state) as T, result: finishAssigned(result) as R };
}
