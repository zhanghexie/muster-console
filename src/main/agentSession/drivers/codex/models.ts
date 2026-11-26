/** SDK 无枚举接口，使用同一本机 CLI 的只读 app-server RPC；不启动推理回合。 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexModelItems, configuredCodexModels, type CodexModelListResult } from '../../../../shared/codexModels';
import { ModelCatalogRefreshOrder } from '../../modelCatalogRefreshOrder';
import { ModelCatalogCache } from '../../modelCatalogCache';
import { t } from '../../../../shared/i18n';
import { resolveCodexExecutable } from './executable';
import { scrubCodexSpawnEnv } from './env';

export function queryCodexModels(executable: string, cwd: string, opts: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number; argsPrefix?: string[]; signal?: AbortSignal;
} = {}): Promise<CodexModelListResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: t('Codex 模型目录读取已取消') });
  return new Promise((resolve) => {
    const child = spawn(executable, [...(opts.argsPrefix ?? []), 'app-server'], {
      cwd, env: scrubCodexSpawnEnv(opts.env ?? process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let byteCount = 0;
    let config: Record<string, any> = {};
    const rows: unknown[] = [];
    const cursors = new Set<string>();
    let requestId = 3;
    const finish = (result: CodexModelListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(result);
    };
    const fail = (error: string): void => finish({ ok: false, error });
    const cancel = (): void => fail(t('Codex 模型目录读取已取消'));
    const timer = setTimeout(() => fail(t('Codex 模型目录读取超时，请重试')), opts.timeoutMs ?? 8000);
    opts.signal?.addEventListener('abort', cancel, { once: true });
    if (opts.signal?.aborted) { cancel(); return; }
    const send = (id: number, method: string, params: Record<string, unknown>): void => {
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    };
    const complete = (error?: string): void => {
      const items = codexModelItems(rows);
      const configured = configuredCodexModels(config);
      const source = items.length ? 'app-server' : 'config';
      for (const id of configured) if (!items.some((item) => item.id === id)) items.push({ id, displayName: id });
      if (!items.length) return fail(error || t('Codex 未返回模型目录，请检查 CLI 登录与配置'));
      const defaultRow = rows.find((row: any) => row?.isDefault === true && row?.hidden !== true) as any;
      const configuredDefault = typeof config.model === 'string' ? config.model.trim() : '';
      const defaultModelId = configuredDefault || defaultRow?.model || defaultRow?.id || (source === 'app-server' ? items[0].id : '');
      finish({ ok: true, items, defaultModelId, source,
        ...(typeof config.model_reasoning_effort === 'string' ? { defaultParameters: { reasoning: config.model_reasoning_effort } } : {}),
        ...(source === 'config' ? { warning: t('Codex 模型枚举失败，当前仅显示本机配置中的模型：{{error}}', { error: error || t('目录为空') }) } : {}) });
    };
    child.stdout.on('data', (data) => {
      byteCount += data.length;
      if (byteCount > 2 * 1024 * 1024) fail(t('Codex 模型目录响应过大'));
    });
    child.stderr.resume();
    child.on('error', (e) => fail(e.message));
    child.stdin.on('error', (e) => fail(e.message));
    child.on('close', (code) => { if (!settled) fail(t('Codex 模型目录进程提前退出（{{code}}）', { code: String(code) })); });
    lines.on('line', (line) => {
      if (settled) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return fail(t('Codex 模型目录返回无效 JSON')); }
      if (message.id === 1) {
        if (message.error) return fail(String(message.error.message));
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        send(2, 'config/read', { includeLayers: false });
      } else if (message.id === 2) {
        config = message.result?.config ?? {};
        send(requestId, 'model/list', { includeHidden: false, limit: 100 });
      } else if (message.id === requestId) {
        if (message.error) return rows.length ? fail(String(message.error.message)) : complete(String(message.error.message));
        if (!Array.isArray(message.result?.data)) {
          const error = t('Codex 未返回模型目录，请检查 CLI 登录与配置');
          return rows.length ? fail(error) : complete(error);
        }
        rows.push(...message.result.data);
        const cursor = message.result.nextCursor;
        if (typeof cursor === 'string' && cursor) {
          if (cursors.has(cursor) || cursors.size >= 20) return fail(t('Codex 模型目录分页异常'));
          cursors.add(cursor);
          send(++requestId, 'model/list', { cursor, includeHidden: false, limit: 100 });
        } else complete();
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'muster-model-catalog', version: '1' }, capabilities: { experimentalApi: true } });
  });
}

const cached = new ModelCatalogCache<Extract<CodexModelListResult, { ok: true }>>('codex');
const pending = new Map<string, { promise: Promise<CodexModelListResult>; signal?: AbortSignal }>();
const refreshOrder = new ModelCatalogRefreshOrder();
const codexCatalogKey = (cwd: string, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) => JSON.stringify([cwd, home]);
export function codexModelCatalogRevision(cwd: string): number { return cached.revision(codexCatalogKey(cwd)); }
export async function listCodexModels(cwd: string, refresh = false, signal?: AbortSignal): Promise<CodexModelListResult> {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const catalogKey = codexCatalogKey(cwd, home);
  if (!refresh) return structuredClone(cached.get(catalogKey) ?? { ok: false, error: t('尚未读取模型目录，请手动刷新') });
  if (signal?.aborted) return { ok: false, error: t('Codex 模型目录读取已取消') };
  const exe = await resolveCodexExecutable();
  if (signal?.aborted) return { ok: false, error: t('Codex 模型目录读取已取消') };
  if (!exe.ok || !exe.executable) return { ok: false, error: t('未找到本机 Codex 安装。Codex（GUI）依赖你自己的 Codex CLI（订阅/API 鉴权）') };
  const stamp = (file: string): number => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  const key = JSON.stringify([exe.executable, cwd, home, stamp(path.join(home, 'auth.json')), stamp(path.join(home, 'config.toml')), stamp(path.join(cwd, '.codex', 'config.toml'))]);
  const inflight = pending.get(key);
  if (inflight && !inflight.signal?.aborted) return inflight.promise;
  const isCurrentRefresh = refreshOrder.begin(catalogKey);
  const run = queryCodexModels(exe.executable, cwd, { signal }).then((result) => {
    if (signal?.aborted) return { ok: false as const, error: t('Codex 模型目录读取已取消') };
    if (!result.ok) return result;
    if (!isCurrentRefresh()) return { ok: false as const, error: t('模型目录已被较新的刷新替代，请重新读取') };
    if (result.source === 'config' && cached.get(catalogKey)?.source === 'app-server') {
      return { ok: false as const, error: t('本次只读到了 Codex 本机配置，已保留上次成功的目录。') };
    }
    cached.set(catalogKey, result);
    return result;
  }).finally(() => { if (pending.get(key)?.promise === run) pending.delete(key); });
  pending.set(key, { promise: run, signal });
  return run;
}
