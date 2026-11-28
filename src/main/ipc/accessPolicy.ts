/** Transport restrictions enforced at the common dispatch boundary, including nested calls. */
const WEB_DENIED = new Set([
  'workspaces:pickDir', 'app:quit', 'app:pickWallpaper',
  'shell:openPath', 'fs:openBrowserPreview',
  'usage:summary', 'usage:llm-call'
]);
const WEB_DENIED_PREFIXES = ['browser:', 'desktopIndicator:', 'desktopSetup:', 'messaging:', 'mailPresentation:', 'extensionPublishing:'];

export function isWebIpcAllowed(channel: string, args: readonly unknown[]): boolean {
  const effective = channel === 'git:invokeScoped' && typeof args[1] === 'string' ? `git:${args[1]}` : channel;
  if (effective === 'workbench:panelPlacement' && (args[0] as { placement?: unknown } | undefined)?.placement === 'window') return false;
  return !WEB_DENIED.has(effective) && !WEB_DENIED_PREFIXES.some(prefix => effective.startsWith(prefix));
}
