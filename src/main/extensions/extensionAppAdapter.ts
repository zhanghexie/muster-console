import { app } from 'electron';
import type { AppContext } from '../context';
import { ExtensionAgentService } from './extensionAgentService';

export interface ExtensionAppHostAssets { userData: string }

/**
 * Attach the extension Agent service to the real application context. The
 * single package host owns discovery, review and installation; this adapter only
 * provides the sidebar Agent runtime and its domain/resource registries.
 */
export function createExtensionAppHost(ctx: AppContext, assets?: ExtensionAppHostAssets): {
  agent: ExtensionAgentService;
  extensionDomains: ExtensionAgentService['extensionDomains'];
  extensionResources: ExtensionAgentService['extensionResources'];
  userDataDirectory: string;
  dispose: () => Promise<void>;
} {
  const userData = assets?.userData ?? app.getPath('userData');
  const agent = new ExtensionAgentService(ctx, userData);
  return {
    agent,
    extensionDomains: agent.extensionDomains,
    extensionResources: agent.extensionResources,
    userDataDirectory: userData,
    dispose: () => agent.close()
  };
}
