import fs from 'node:fs';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { preflightAllRuntimes, preflightRuntime } from '../../runtime/preflight';
import { isConfirmed } from '../../../shared/confirmDialog';
import { collectEnvSecrets, redactSafetyText, safetySecrets } from '../../safety/redact';

export async function confirmRuntimeRegistration(ctx: AppContext, raw: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return null;
  const secrets = [...collectEnvSecrets(process.env), ...safetySecrets(ctx.config.get())];
  const checkReviewText = (detail: string): void => {
    if (detail.length > 8000) throw new Error('Runtime Manifest is too large to review');
    if (redactSafetyText(detail, secrets) !== detail) {
      throw new Error('Remove credentials and sensitive values from the Runtime Manifest before registering it');
    }
  };
  checkReviewText(JSON.stringify(raw) ?? '');
  const manifest = ctx.runtimes.prepareManifest(raw);
  const detail = JSON.stringify(manifest, null, 2);
  checkReviewText(detail);
  const title = manifest.terminal ? t('注册 Agent Runtime（终端仅启动）') : t('注册 Agent Runtime');
  const confirmation = await ctx.ui.confirm(title, detail, { dangerous: true, signal });
  if (signal?.aborted || !isConfirmed(confirmation)) return null;
  return ctx.runtimes.registerManifest(manifest);
}

export const runtimesHost = {
  'runtimes.list': (ctx: AppContext) => ({ runtimes: ctx.runtimes.list() }),

  'runtimes.register': async (ctx: AppContext, args: { manifest: unknown }, opts?: { signal?: AbortSignal }) => {
    const entry = await confirmRuntimeRegistration(ctx, args.manifest, opts?.signal);
    if (!entry) throw new Error(t('已取消'));
    return entry;
  },

  'runtimes.get': (ctx: AppContext, args: { id: string; }) => {
    const e = ctx.runtimes.get(args.id);
    if (!e) throw new Error(t('不存在: {{id}}', { id: args.id }));
    const scriptSource = e.surface === 'chat' || e.manifest ? '' : fs.readFileSync(ctx.runtimes.scriptPath(args.id), 'utf8');
    return { ...e, scriptSource };
  },

  'runtimes.update': (
    ctx: AppContext,
    args: {
      id: string;
      label?: string;
      enabled?: boolean;
      extraArgs?: string[];
      scriptSource?: string;
    }
  ) => {
    const { id, ...patch } = args;
    return ctx.runtimes.update(id, patch);
  },

  'runtimes.remove': (ctx: AppContext, args: { id: string; }) => ctx.runtimes.remove(args.id),

  'runtimes.restoreBuiltins': (ctx: AppContext, args?: { ids?: string[]; }) =>
    ctx.runtimes.restoreBuiltins(args?.ids),

  /** 可用性预检（只读）：id 省略=全量；创建前闸门与设置页徽标共用同一实现 */
  'runtimes.preflight': async (ctx: AppContext, args?: { id?: string; }) => {
    const id = typeof args?.id === 'string' ? args.id.trim() : '';
    if (id) {
      if (!ctx.runtimes.get(id)) throw new Error(t('不存在: {{id}}', { id }));
      return { results: [await preflightRuntime(ctx, id)] };
    }
    return { results: await preflightAllRuntimes(ctx) };
  }
};
