import type { Page } from '@playwright/test';

export const hasExtensionTestCenter = process.env.MUSTER_EXTENSION_CENTER_E2E === '1';

export async function installCenterExtension(win: Page, extensionId: string): Promise<void> {
  await win.evaluate(async id => {
    const config = await window.api.config.get();
    const workspaceId = config.activeWorkspaceId;
    if (!workspaceId) throw new Error('An active fixture workspace is required');
    const result = await window.api.extensionCenter.install(`muster/${id}`);
    if (!result.installed) throw new Error(result.error ?? `Center did not install ${id}`);
    await window.api.extensions.setEnabledAll({ workspaceId, extensionId: id, enabled: true });
  }, extensionId);
}
