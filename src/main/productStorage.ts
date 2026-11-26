import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { extensionTrialRoot } from './extensions/extensionTrialEnvironment';
import { PRODUCT_NAME, PRODUCT_STORAGE_DIR } from '../shared/productIdentity';
import { StorageRootResolver } from './runtimeKernel/storageRootResolver';

/**
 * 配置 Muster 的正式 userData 根目录。
 *
 * 普通开发模式由 devSandbox 接管并重定向到仓库内 .dev-sandbox/userData。
 * 只有安装版和显式 no-sandbox 开发模式走这个产品专属目录，避免读取旧应用数据。
 */
export function configureProductUserDataPath(): void {
  app.setName(PRODUCT_NAME);
  const trial = extensionTrialRoot();
  if (trial) {
    const appData = path.join(trial, 'appData');
    fs.mkdirSync(appData, { recursive: true });
    app.setPath('appData', appData);
    return;
  }
  if (app.isPackaged || process.env.MUSTER_NO_SANDBOX === '1') {
    // Packaged smoke launches must isolate their profile from a developer's
    // already-running installation. This override is deliberately gated by
    // the smoke marker and is never accepted by normal packaged launches.
    const smokeUserData = process.env.MUSTER_PACKAGED_SMOKE === '1'
      ? process.env.MUSTER_PACKAGED_USER_DATA?.trim()
      : undefined;
    if (smokeUserData) {
      app.setPath('userData', path.resolve(smokeUserData));
    } else {
      app.setPath('userData', productStorageResolver().productRoot());
    }
  }
}

/** 当前进程的存储根解析器：业务子目录一律按 scope + purpose 派生。 */
export function productStorageResolver(): StorageRootResolver {
  return new StorageRootResolver({
    userDataPath: app.getPath('userData'),
    appDataPath: app.getPath('appData')
  });
}

export function productUserDataPath(appDataPath = app.getPath('appData')): string {
  return path.join(appDataPath, PRODUCT_STORAGE_DIR);
}
