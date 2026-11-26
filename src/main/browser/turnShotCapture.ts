import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * 回合结束浏览器截图采集（任务 D）：消费 TurnTabLedger 里本会话本回合实际用过的
 * tab，对仍存活的 tab 各抓一帧 PNG，按既有 browser-shot 证据形状归集（先落
 * browser-captures 原图，收集器复制进证据目录；evidence.browserShots 默认关）。
 *
 * 硬边界：本函数只允许 fire-and-forget 调用（`void captureTurnShots(...)`，
 * 不 await）——任何失败在内部吞掉，绝不影响回合收口；只截台账记录集合，
 * 不截全局 active tab；截图不回灌模型、不新增审批。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppContext } from '../context';
import { pruneBrowserCaptures } from '../persistenceSweeps';
import { shouldCapture, turnTabLedger } from './turnShots';

/** 与显式 browser.screenshot 的 capturesDir 同目录约定（agentTools.ts） */
function turnShotFile(): string {
  return path.join(
    userDataStorage(app.getPath('userData')).resolve('app', 'browser-captures'),
    `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
}

/**
 * 归属记录：browser.* 工具执行**成功**时记目标 tab（失败不记——没动到的页面不截）。
 * tabId 取 args.tabId；browser.open 无入参 tab，从结果 `{ id }` 取新建标签。
 * 绝不抛错：归属记录失败只少一张证据，不影响工具返回。
 */
export function recordBrowserToolUse(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: { ok: boolean } | null | undefined,
  fullResult?: unknown
): void {
  try {
    if (!result?.ok || !toolName.startsWith('browser.')) return;
    const argTabId = typeof args.tabId === 'string' ? args.tabId.trim() : '';
    const tabId =
      argTabId ||
      (toolName === 'browser.open' ? openResultTabId(fullResult ?? (result as { result?: unknown }).result) : '');
    if (tabId) turnTabLedger.recordToolUse(sessionId, tabId, Date.now());
  } catch {
    // 归属记录绝不影响工具调用本身
  }
}

function openResultTabId(result: unknown): string {
  const id = (result as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * 取走并采集：GUI 在 finishTurn 调（turnId=收口回合 assistant 消息 id），
 * CLI 在活动信号 idle（terminal 会话）调（无 turnId）。
 */
export async function captureTurnShots(
  ctx: AppContext,
  sessionId: string,
  turnId?: string
): Promise<void> {
  try {
    const usage = turnTabLedger.collectTurnTabs(sessionId);
    if (!usage || usage.tabIds.length === 0) return;
    const browser = ctx.browser;
    const evidence = ctx.evidence;
    if (!browser || !evidence) return;
    const enabled = ctx.config.get().evidence?.browserShots === true;
    for (const tabId of usage.tabIds) {
      try {
        if (!shouldCapture({ enabled, tabAlive: browser.tabLive(tabId) })) continue;
        const shot = await browser.captureTurnShot(tabId);
        if (!shot || !shot.png.length) continue;
        const file = turnShotFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, shot.png);
        // X3-F05：截图只增不减 → 写路径按 keep-newest 回收（terminal pruneCaptureDir 同范式）
        pruneBrowserCaptures(path.dirname(file));
        evidence.recordBrowserShot(sessionId, file, { ...(turnId ? { turnId } : {}), url: shot.url });
      } catch {
        // 单个 tab 失败（已关/抓帧异常/磁盘满）：静默跳过，继续下一个
      }
    }
  } catch {
    // 采集整体绝不外抛：回合收口路径不受影响
  }
}
