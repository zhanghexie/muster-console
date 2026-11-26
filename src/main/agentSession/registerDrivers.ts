/**
 * driver 注册：AgentSessionHost 构造后立即调用（勿写成无引用副作用模块——
 * 注册丢了 runtime 会静默不可用）。构造轻量、SDK 在 connect 内动态加载。
 */
import type { AppContext } from '../context';
import type { AgentSessionHost } from './host';
import type { RuntimeHost } from '../runtime/host';
import type { GuiRuntimeDriver } from './types';
import { turnChanges } from '../turnChanges/runtime';
import { PiRuntimeDriver } from './drivers/pi/driver';
import { ClaudeRuntimeDriver } from './drivers/claude/driver';
import { AcpRuntimeDriver } from './drivers/acp/driver';
import { CodexRuntimeDriver } from './drivers/codex/driver';
import { ExternalPiRuntimeDriver } from './drivers/externalPi/driver';
import { ZCodeRuntimeDriver } from './drivers/zcode/driver';
import { MuseRuntimeDriver } from './drivers/muse/driver';

export function registerAgentSessionDrivers(
  ctx: AppContext,
  host: AgentSessionHost,
  opts: { userDataDir: string; runtimes?: RuntimeHost }
): void {
  const register = (driver: GuiRuntimeDriver): void => {
    host.registerDriver(driver);
  };
  register(new PiRuntimeDriver(ctx, opts));
  register(new ClaudeRuntimeDriver(ctx, {
    userDataDir: opts.userDataDir,
    getReviewTracker: sessionId => turnChanges().activeForOwner(`gui:${sessionId}`)
  }));
  register(new ExternalPiRuntimeDriver('pi-external', { getExecutable: () => ctx.config.get().externalPi?.['pi-external']?.executable }));
  register(new ExternalPiRuntimeDriver('omp', { getExecutable: () => ctx.config.get().externalPi?.omp?.executable }));
  register(new ZCodeRuntimeDriver({ getExecutable: () => ctx.config.get().externalHarness?.['zcode-gui']?.executable }));
  register(new MuseRuntimeDriver({ getExecutable: () => ctx.config.get().externalHarness?.['muse-gui']?.executable }));
  register(new AcpRuntimeDriver(ctx, opts));
  register(new CodexRuntimeDriver(ctx, opts));
}
