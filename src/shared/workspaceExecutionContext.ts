/** A captured directory set, independent of the active workspace and the default cwd. */
export interface ExecutionDirectory {
  path: string;
  /** Captured realpath; a retargeted Junction must not reuse this permission. */
  physicalPath: string;
}

export interface WorkspaceExecutionContext {
  workspaceId: string;
  workspaceName: string;
  rootsRevision: number;
  sourceRootId: string;
  cwd: string;
  /** Native execution in a registered task checkout, independent of the persisted source cwd. */
  worktreeExecution?: {
    cwd: ExecutionDirectory;
    checkout: ExecutionDirectory;
    gitDir: string;
    branch: string;
  };
  controlRoot: string;
  controlPhysicalPath: string;
  roots: ReadonlyArray<{ rootId: string; label?: string; path: string; error?: string }>;
  readableDirectories: readonly ExecutionDirectory[];
  /** Session-owned handover snapshot, readable by the host and supplied to native adapters. */
  handoverDirectory?: ExecutionDirectory;
  writableDirectories: readonly ExecutionDirectory[];
  /** Source checkouts mapped to a task tree are reference-only for host file tools. */
  referenceDirectories?: readonly ExecutionDirectory[];
  mappingRevision?: number;
  mappings: ReadonlyArray<{ rootId: string; sourcePath: string; worktreePath: string }>;
}

/** Dynamic facts only. Rule and protocol documents remain paths, loaded on demand. */
export function renderWorkspaceExecutionContext(context: WorkspaceExecutionContext, directoryNote: string, authority: 'host-policy' | 'assignment' = 'host-policy'): string {
  return [
    '## Workspace Directory Scope (connection snapshot)',
    JSON.stringify({
      workspaceId: context.workspaceId,
      name: context.workspaceName,
      rootsRevision: context.rootsRevision,
      sourceRootId: context.sourceRootId,
      cwd: context.cwd,
      controlRoot: context.controlRoot,
      sourceFolders: context.roots,
      readableDirectories: context.readableDirectories.map(dir => dir.path),
      writableDirectories: context.writableDirectories.map(dir => dir.path),
      referenceDirectories: context.referenceDirectories?.map(dir => dir.path),
      mappingRevision: context.mappingRevision,
      isolationMappings: context.mappings
    }, null, 2),
    `Relative paths resolve against cwd; use absolute paths for cross-root files. The readable/writable lists denote ${authority === 'assignment' ? 'the task scope assigned by the host, which does not intercept native CLI file tools' : 'the host file-policy scope'}; the engine\'s actual access follows the note below. Offline source roots are not in the accessible set. Source checkouts in isolation mappings are reference-only — edits, tests, and Git should use absolute paths in the task worktree (git -C); cwd stays as listed. To isolate a newly added repo, plan and register the task tree with sessions.isolate instead of hand-creating unregistered trees; later connections read the new mapping, and the current connection\'s permissions may not hot-update. The management root holds host data; protocols and project rules are read on demand by file path.`,
    directoryNote
  ].join('\n');
}

/** Render the Worker-facing scope without repeating shared read/write paths. */
export function renderWorkerDirectoryScope(
  context: WorkspaceExecutionContext,
  directoryNote: string,
  surface: 'gui' | 'cli' = 'gui'
): string {
  const readable = new Set(context.readableDirectories.map(dir => dir.path));
  const writable = new Set(context.writableDirectories.map(dir => dir.path));
  const readWrite = [...writable].filter(dir => readable.has(dir));
  const readOnly = [...readable].filter(dir => !writable.has(dir));
  const writeOnly = [...writable].filter(dir => !readable.has(dir));
  const rootsByPath = new Map(context.roots.map(root => [root.path, root.rootId]));
  const scopePath = (folder: string) => {
    if (folder === context.cwd) return 'cwd';
    const root = rootsByPath.get(folder);
    return root ? `root ${root}` : JSON.stringify(folder);
  };
  const paths = (items: readonly string[]) => items.map(scopePath).join(', ');
  const [firstRoot] = context.roots;
  const singleRoot = surface === 'gui' && firstRoot && context.roots.length === 1 && !context.mappings.length &&
    firstRoot.rootId === context.sourceRootId && firstRoot.path === context.cwd && !firstRoot.error &&
    writable.size === 1 && writable.has(context.cwd) && readable.has(context.cwd) ? firstRoot : undefined;
  const workspace = `Workspace ${context.workspaceName} (${context.workspaceId}).`;
  const cwd = `cwd: ${JSON.stringify(context.cwd)}`;
  const cwdIsManagementRoot = context.controlRoot === context.cwd;
  return [
    '## Workspace Directory Scope (connection snapshot)',
    singleRoot
      ? `${workspace} Source root ${singleRoot.rootId}${singleRoot.label ? ` (${singleRoot.label})` : ''} (rev ${context.rootsRevision}), ${cwd} (read/write${cwdIsManagementRoot ? ', management root' : ''}).`
      : `${workspace} ${cwd}${cwdIsManagementRoot ? ' (management root)' : ''}.`,
    ...(!cwdIsManagementRoot ? [`Management root: ${scopePath(context.controlRoot)}.`] : []),
    ...(singleRoot ? [] : [
      `Source folders (${context.sourceRootId} current, rev ${context.rootsRevision}):`,
      ...context.roots.map(root => `- ${root.rootId}${root.label ? ` (${root.label})` : ''}: ${root.path === context.cwd ? 'cwd' : JSON.stringify(root.path)}${root.error ? ` [unavailable: ${root.error}]` : ''}`),
      `Read/write directories: ${paths(readWrite) || 'none'}.`
    ]),
    ...(readOnly.length ? [`Additional read-only directories: ${paths(readOnly)}.`] : []),
    ...(writeOnly.length ? [`Write-only directories: ${paths(writeOnly)}.`] : []),
    ...(context.mappings.length ? [
      'Isolation mappings (source is reference-only, work in the task worktree):',
      ...context.mappings.map(mapping => `- ${scopePath(mapping.sourcePath)} → ${scopePath(mapping.worktreePath)}`)
    ] : []),
    'Resolve relative paths against cwd. Use absolute paths across roots.',
    ...(surface === 'cli' ? ['The assigned scope does not intercept native CLI file tools.'] : []),
    ...(directoryNote ? [directoryNote] : [])
  ].join('\n');
}
