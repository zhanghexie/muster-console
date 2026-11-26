import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/** 启动开关辅助：appendSwitch 必须在 app ready 前，而 ConfigManager 尚未构造——容错同步直读 config.json */
import { app } from 'electron';
import fs from 'node:fs';

export type BrowserCdpBootState =
  | { kind: 'disabled'; port: 0 }
  | { kind: 'enabled'; port: number }
  | { kind: 'error'; port: 0; reason: 'invalid-port' | 'startup-failed'; detail?: string };

let bootState: BrowserCdpBootState = { kind: 'disabled', port: 0 };

/** CDP 桥是否随进程启动开启（browser.cdpEnabled !== false；读不到配置默认开） */
export function readBrowserCdpEnabledAtBoot(): boolean {
  try {
    const raw = fs.readFileSync(userDataStorage(app.getPath('userData')).file('config'), 'utf8');
    return JSON.parse(raw)?.browser?.cdpEnabled !== false;
  } catch {
    return true;
  }
}

/** Port 0 asks Chromium to bind an available local port atomically. */
export function selectBrowserCdpBootState(
  explicitPort: string | undefined,
  enabled: boolean
): BrowserCdpBootState {
  const raw = explicitPort?.trim();
  if (raw) {
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { kind: 'error', port: 0, reason: 'invalid-port' };
    }
    return { kind: 'enabled', port };
  }
  if (!enabled) return { kind: 'disabled', port: 0 };
  return { kind: 'enabled', port: 0 };
}

/** Must run after userData setup and before Electron is ready. */
export function configureBrowserCdpAtBoot(): void {
  try {
    bootState = selectBrowserCdpBootState(process.env.MUSTER_DEVTOOLS_PORT, readBrowserCdpEnabledAtBoot());
    if (bootState.kind === 'enabled') {
      const explicitAutomation = ['enable-automation', 'headless', 'remote-debugging-pipe']
        .some((name) => app.commandLine.hasSwitch(name)) || app.commandLine.getSwitchValue('enable-blink-features')
        .split(',').some((feature) => /^AutomationControlled(?:[<:]|$)/.test(feature.trim()));
      if (bootState.port === 0 && !explicitAutomation) {
        // Chromium treats port 0 as automation. Keep the existing browser behavior
        // while letting Chromium itself select and bind an unused local port.
        const existing = app.commandLine.getSwitchValue('disable-blink-features');
        const features = existing.split(',').map((value) => value.trim()).filter(Boolean);
        if (!features.includes('AutomationControlled')) features.push('AutomationControlled');
        app.commandLine.appendSwitch('disable-blink-features', features.join(','));
      }
      app.commandLine.appendSwitch('remote-debugging-port', String(bootState.port));
    } else if (bootState.kind === 'error') {
      console.error(`[browser] CDP boot configuration error: ${bootState.reason}`);
    }
  } catch (error) {
    bootState = { kind: 'error', port: 0, reason: 'startup-failed', detail: error instanceof Error ? error.message : String(error) };
    console.error(`[browser] CDP boot failed: ${bootState.detail}`);
  }
}

export function getBrowserCdpBootState(): BrowserCdpBootState {
  return bootState;
}
