import { userDataStorage } from '../../../runtimeKernel/storageRootResolver';
/**
 * Claude（GUI）设置页状态探测：可执行文件 + 配置目录 + 鉴权形态（不 spawn 引擎）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../../context';
import {
  inferClaudeGuiAuth,
  resolveClaudeConfigDir,
  type ClaudeGuiStatus
} from '../../../../shared/claudeGui';
import { resolveClaudeExecutable } from './claudeSdk';

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function probeClaudeGuiStatus(
  ctx: AppContext,
  userDataDir: string
): Promise<ClaudeGuiStatus> {
  const isolate = ctx.config.get().claude?.isolateConfig === true;
  const configDir = resolveClaudeConfigDir({
    isolate,
    isolatedConfigDir: isolate ? userDataStorage(userDataDir).resolve('app', 'claude-gui-home') : undefined,
    userDataDir,
    homedir: os.homedir(),
    envConfigDir: process.env.CLAUDE_CONFIG_DIR,
    join: path.join
  });
  const exeInfo = await resolveClaudeExecutable();
  const settings = readJson(path.join(configDir, 'settings.json'));
  const hasCredentials = fs.existsSync(path.join(configDir, '.credentials.json'));
  const { auth, model } = inferClaudeGuiAuth(settings, hasCredentials);
  return {
    packaged: exeInfo.packaged,
    executable: exeInfo.executable ?? null,
    canLaunch: exeInfo.ok,
    isolateConfig: isolate,
    configDir,
    auth,
    model
  };
}
