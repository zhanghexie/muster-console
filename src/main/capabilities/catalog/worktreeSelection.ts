/** Public selection contains source coordinates only; task paths and Git guards are host-owned. */
export const worktreeSelectionProperty = {
  type: 'array', minItems: 1,
  description: 'Isolated repos: rootId + relativePath from source root (empty = root repo). Others stay shared; cwd is unchanged. Append via sessions.isolate.',
  items: { type: 'object', required: ['rootId', 'relativePath', 'repoSet'], additionalProperties: false,
    properties: { rootId: { type: 'string' }, relativePath: { type: 'string' },
      repoSet: { type: 'array', items: { type: 'string' }, description: 'Nested paths relative to root repo; [] = root only. List members and required ancestors; undiscovered repos are excluded.' } } }
};
