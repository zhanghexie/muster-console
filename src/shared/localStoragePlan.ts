import type { LocalStorageDependency, LocalStorageItem } from './localStorage';

/** Same plan in the renderer and main. Only prerequisites directly made unused by this selection are suggested. */
export function planLocalStorageCleanup(
  items: readonly LocalStorageItem[],
  dependencies: readonly LocalStorageDependency[],
  selected: readonly string[]
) {
  const byId = new Map(items.map(item => [item.id, item]));
  const dependents = new Map<string, string[]>();
  for (const { dependentId, prerequisiteId } of dependencies) {
    if (!byId.has(dependentId) || !byId.has(prerequisiteId)) continue;
    const list = dependents.get(prerequisiteId);
    if (list) list.push(dependentId);
    else dependents.set(prerequisiteId, [dependentId]);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];
  let cycle = false;
  // Iterative traversal also handles old session trees with very deep nesting.
  for (const root of selected) {
    const stack = [{ id: root, exit: false }];
    while (stack.length) {
      const { id, exit } = stack.pop()!;
      if (exit) {
        visiting.delete(id);
        visited.add(id);
        ordered.push(id);
      } else if (visiting.has(id)) {
        cycle = true;
      } else if (!visited.has(id)) {
        visiting.add(id);
        stack.push({ id, exit: true });
        for (const dependent of dependents.get(id) ?? []) stack.push({ id: dependent, exit: false });
      }
    }
  }

  const explicit = new Set(selected);
  const recommended: string[] = [];
  for (const [id, users] of dependents) {
    if (!visited.has(id) && byId.get(id)?.action && users.every(user => visited.has(user))) recommended.push(id);
  }
  return {
    ordered,
    required: ordered.filter(id => !explicit.has(id)),
    blocked: ordered.filter(id => !byId.get(id)?.action),
    recommended,
    dependents,
    cycle
  };
}
