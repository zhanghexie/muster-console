export type VisibleActionJson = null | boolean | number | string | VisibleActionJson[] | { [key: string]: VisibleActionJson };

/** Validate the outbox's lossless JSON contract and return a detached snapshot. */
export function boundedVisibleActionResult(value: unknown): VisibleActionJson {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0, stringUnits = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 100000 || item.depth > 128) throw new Error('Invalid visible action result');
    const node = item.value;
    if (node === null || typeof node === 'boolean') continue;
    if (typeof node === 'string') { stringUnits += node.length; if (stringUnits > 65536) throw new Error('Invalid visible action result'); continue; }
    if (typeof node === 'number' && Number.isFinite(node) && !Object.is(node, -0)) continue;
    if (typeof node !== 'object' || seen.has(node)) throw new Error('Invalid visible action result');
    seen.add(node);
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Invalid visible action result');
    const keys = Reflect.ownKeys(node), descriptors = Object.getOwnPropertyDescriptors(node);
    if (array && (keys.length !== node.length + 1 || !keys.includes('length'))) throw new Error('Invalid visible action result');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= node.length)) throw new Error('Invalid visible action result');
      stringUnits += key.length;
      if (stringUnits > 65536) throw new Error('Invalid visible action result');
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid visible action result');
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  const encoded = JSON.stringify({ outcome: 'known', value });
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65536) throw new Error('Invalid visible action result');
  return (JSON.parse(encoded) as { value: VisibleActionJson }).value;
}
