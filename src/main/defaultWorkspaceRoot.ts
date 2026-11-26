import os from 'node:os';
import path from 'node:path';

/**
 * 推荐工作区根：用户主目录下的应用自有目录（三平台统一目录名，分隔符交给 path.join）。
 * 首启不再自动登记工作区、也不预建目录；只有用户在新建面板「一键填入」并提交时才落盘。
 * 单独成模块：路径纯计算不该把 ConfigManager（依赖 electron / i18n / 一堆服务）拖进
 * WorkspaceService 的加载链，纯 Node 逻辑回归也能安全 import。
 */
export const DEFAULT_WORKSPACE_FOLDER = 'Muster';

/** 新建面板「一键填入」的推荐名称：工作区数据，不是界面文案，不进 i18n 词条。 */
export const RECOMMENDED_WORKSPACE_NAME = 'muster 默认工作区';

export function defaultWorkspaceRoot(homeDir?: string): string {
  if (homeDir === undefined && process.argv.some(arg => arg === '--demo-build' || arg === '--demo-run') && process.env.MUSTER_DEMO_PROJECTS) {
    return process.env.MUSTER_DEMO_PROJECTS;
  }
  return path.join(homeDir ?? os.homedir(), DEFAULT_WORKSPACE_FOLDER);
}
