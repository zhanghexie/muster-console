/**
 * CLI 入站 MCP 配置：自动路径严格检查所有权、结构与外部漂移；保留旧显式写入函数供兼容调用。
 */
import fs from 'node:fs';
import os from 'node:os';
import { parse as parseJsonc, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { harnessMcpEntry, harnessMcpLaunch, matchesHarnessMcpEntry } from '../harnessIntegration/mcpEntry';
import type { AgentRuntimeEntry } from '../../shared/types';
import { builtinHarnessEntries } from '../harnessIntegration/seed';
import { assertHarnessMcpPublicPath, harnessMcpTargets } from '../harnessIntegration/mcp';
import { openCodeMcpLayout } from '../harnessIntegration/opencode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t } from '../../shared/i18n';
import {
  inboundMcpFingerprint,
  inboundMcpLaunchFromEntry,
  sameInboundMcpLaunch,
  WORKER_INBOUND_MCP_SERVER,
  upsertInboundMcpServerJson,
  type InboundMcpEngineFile,
  type InboundMcpLaunch,
  type InboundMcpSetupStatus,
  type InboundMcpReview
} from '../../shared/inboundMcp';

/** Legacy convenience entry; production passes the live trusted runtime registry. */
export function defaultInboundMcpEngineFiles(home = os.homedir(), entries: AgentRuntimeEntry[] = builtinHarnessEntries()): InboundMcpEngineFile[] {
  // This legacy JSON-only API cannot encode dialect-specific entries. Production uses harnessMcpTargets.
  return harnessMcpTargets(entries.filter(entry => entry.integrations?.mcp?.strategy !== 'config-file' || !entry.integrations.mcp.dialect), { homeDir: home }).files.filter(file => file.format === 'json');
}

function readJsonObject(file: string): { exists: boolean; value: unknown; corrupted?: boolean } {
  if (!fs.existsSync(file)) return { exists: false, value: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { exists: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { exists: true, value: {}, corrupted: true };
  }
}

export function previewInboundMcpInstall(
  launch: InboundMcpLaunch,
  files: InboundMcpEngineFile[] = defaultInboundMcpEngineFiles()
): InboundMcpReview {
  return {
    fingerprint: inboundMcpFingerprint(launch),
    command: launch.command,
    args: launch.args,
    files: files.map((f) => ({
      id: f.id,
      label: f.label,
      path: f.path,
      action: fs.existsSync(f.path) ? 'update' : 'create'
    }))
  };
}

export function writeInboundMcpEngineConfigs(
  launch: InboundMcpLaunch,
  files: InboundMcpEngineFile[] = defaultInboundMcpEngineFiles()
): InboundMcpReview {
  const preview = previewInboundMcpInstall(launch, files);
  // 先全量预扫描损坏文件、再统一落盘：边解析边写的话，排在损坏文件之后的引擎
  // 已经写完才发现要中止，各引擎配置进入半写状态（trust 指纹也没落）。
  for (const f of files) {
    const { corrupted } = readJsonObject(f.path);
    if (corrupted) {
      // 引擎配置里通常还有大量用户态内容；解析失败硬写会把「保键合并」变成「整文件清空」
      throw new Error(
        `无法解析 ${f.path}（JSON 格式错误）。为避免覆盖已有配置，本次入站 MCP 安装中止；请先修复该文件后重试。`
      );
    }
  }
  for (const f of files) {
    const { value } = readJsonObject(f.path);
    const next = upsertInboundMcpServerJson(value, launch);
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    const tmp = `${f.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, f.path);
  }
  return preview;
}


export interface InboundMcpSetupOptions {
  /** Required explicit targets keep tests and sandbox callers out of the real home. */
  files: InboundMcpEngineFile[];
  ownershipFile: string;
  /** Legacy user-confirmed launch identity, used only for an exact, narrow migration. */
  legacyTrustedFingerprint?: string;
}
interface FileSnapshot { format?: InboundMcpEngineFile['format']; path: string; physical: string; raw?: string; mode: number; identity?: string }
interface SetupLedger { version: 1; engines: Record<string, InboundMcpLaunch[]> }
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_OWNED_LAUNCHES = 32;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function missingPhysicalPath(file: string): string {
  const children: string[] = []; let ancestor = path.resolve(file);
  while (true) {
    try { return path.join(fs.realpathSync.native(ancestor), ...children); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      const parent = path.dirname(ancestor); if (parent === ancestor) throw error;
      children.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}
function readSnapshot(file: string): FileSnapshot {
  assertHarnessMcpPublicPath(file);
  let link: fs.Stats;
  try { link = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, physical: missingPhysicalPath(file), mode: 0o600 };
    throw error;
  }
  // Follow an intentional file link without replacing the user's link itself.
  // A dangling link or unreadable target is an error, never an empty config.
  const physical = fs.realpathSync.native(file);
  assertHarnessMcpPublicPath(physical);
  const stat = link.isSymbolicLink() ? fs.statSync(physical) : link;
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(t('CLI 配置不是有效的普通文件，或超过 2 MiB'));
  return { path: file, physical, raw: fs.readFileSync(physical, 'utf8'), mode: stat.mode & 0o777,
    identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
}
function parseObject(snapshot: FileSnapshot): Record<string, unknown> {
  if (snapshot.raw === undefined) return {};
  let value: unknown;
  try {
    const raw = snapshot.raw.replace(/^\uFEFF/, '');
    if (snapshot.format === 'jsonc') { const errors: ParseError[] = []; value = parseJsonc(raw, errors, { allowTrailingComma: true }); if (errors.length) throw new Error('Invalid JSONC'); }
    else value = snapshot.format === 'toml' ? parseToml(raw) : snapshot.format === 'yaml' ? yamlDocument(raw).toJS({ maxAliasCount: 100 }) : JSON.parse(raw);
  }
  catch { throw new Error(t('CLI 配置无法解析；原文件已保留，请修复后重试')); }
  if (!object(value)) throw new Error(t('CLI 配置顶层必须是对象；原文件已保留'));
  return value;
}
function yamlDocument(raw: string) {
  const document = parseDocument(raw);
  if (document.errors.length) throw new Error('Invalid YAML configuration; original file was preserved');
  return document;
}
function configSnapshot(file: InboundMcpEngineFile): { snapshot: FileSnapshot; value: Record<string, unknown>; entry: unknown; present: boolean } {
  assertHarnessMcpPublicPath(file.path);
  const snapshot = { ...readSnapshot(file.path), format: file.format };
  const value = parseObject(snapshot);
  if (file.requiresMcpEnabled && (value.features !== undefined && !object(value.features) || object(value.features) && value.features.mcp !== undefined && value.features.mcp !== true)) {
    throw new Error('ZCode features.mcp is explicitly disabled or invalid; enable MCP in ZCode and retry');
  }
  if (file.checkOpenCodeLayout) {
    const layout = openCodeMcpLayout(value.mcp);
    const selected = file.serversKey?.length === 2 ? 'nested' : 'flat';
    if (layout && layout !== selected) throw new Error(t('OpenCode MCP 配置结构已变化，请重试'));
  }
  let servers: Record<string, unknown> | undefined = value;
  for (const key of file.serversKey ?? ['mcpServers']) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid harness MCP server key');
    const next: unknown = servers?.[key];
    if (next !== undefined && !object(next)) throw new Error(t('MCP 服务映射必须是对象；原文件已保留'));
    servers = next as Record<string, unknown> | undefined;
  }
  return { snapshot, value, entry: servers?.[WORKER_INBOUND_MCP_SERVER], present: !!servers && owns(servers, WORKER_INBOUND_MCP_SERVER) };
}
function withHarnessServer(value: Record<string, unknown>, file: InboundMcpEngineFile, launch: InboundMcpLaunch): Record<string, unknown> {
  const next = structuredClone(value); let current = next;
  for (const [key, defaultValue] of Object.entries(file.rootDefaults ?? {})) if (!owns(next, key)) next[key] = structuredClone(defaultValue);
  if (file.requiresMcpEnabled) next.features = { ...(object(next.features) ? next.features : {}), mcp: true };
  for (const key of file.serversKey ?? ['mcpServers']) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid harness MCP server key');
    if (!object(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[WORKER_INBOUND_MCP_SERVER] = harnessMcpEntry(launch, file);
  return next;
}
function writeSnapshot(snapshot: FileSnapshot, value: unknown, file?: InboundMcpEngineFile): void {
  const jsoncPath = [...(file?.serversKey ?? ['mcpServers']), WORKER_INBOUND_MCP_SERVER];
  const jsoncValue = jsoncPath.reduce<unknown>((current, key) => (current as Record<string, unknown>)?.[key], value);
  let raw: string;
  if (snapshot.format === 'yaml' && file) {
    const document = yamlDocument(snapshot.raw ?? '{}\n');
    document.setIn(jsoncPath, jsoncValue);
    raw = document.toString();
  } else if (snapshot.format === 'jsonc' && file) {
    raw = applyEdits(snapshot.raw ?? '{}\n', modify(snapshot.raw ?? '{}\n', jsoncPath, jsoncValue, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    if (file.requiresMcpEnabled) raw = applyEdits(raw, modify(raw, ['features', 'mcp'], true, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  } else raw = snapshot.format === 'toml' ? stringifyToml(value as Record<string, unknown>) : `${JSON.stringify(value, null, 2)}\n`;
  if (snapshot.raw === raw) return;
  assertHarnessMcpPublicPath(snapshot.physical);
  fs.mkdirSync(path.dirname(snapshot.physical), { recursive: true, mode: 0o700 });
  const temp = `${snapshot.physical}.${randomUUID()}.tmp`;
  let owned = false;
  try {
    const descriptor = fs.openSync(temp, 'wx', snapshot.mode);
    owned = true;
    try { fs.writeFileSync(descriptor, raw, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    const current = readSnapshot(snapshot.path);
    if (current.physical !== snapshot.physical || current.raw !== snapshot.raw || current.identity !== snapshot.identity) {
      throw new Error(t('CLI 配置被外部修改；未覆盖，请重试'));
    }
    fs.renameSync(temp, snapshot.physical); owned = false;
    if (fs.readFileSync(snapshot.physical, 'utf8') !== raw) throw new Error(t('CLI 配置写入后发生变化，请检查文件后重试'));
  } finally {
    if (owned) { try { fs.unlinkSync(temp); } catch { /* Preserve the original failure. */ } }
  }
}
function readLedger(file: string): { snapshot: FileSnapshot; ledger: SetupLedger } {
  const snapshot = readSnapshot(file);
  if (snapshot.raw === undefined) return { snapshot, ledger: { version: 1, engines: {} } };
  const value = parseObject(snapshot);
  if (value.version !== 1 || !object(value.engines)) throw new Error(t('入站 MCP 托管记录损坏；原文件已保留'));
  const engines: Record<string, InboundMcpLaunch[]> = {};
  for (const [id, entries] of Object.entries(value.engines)) {
    if (!Array.isArray(entries) || entries.length > MAX_OWNED_LAUNCHES) throw new Error(t('入站 MCP 托管记录损坏；原文件已保留'));
    const launches = entries.map(inboundMcpLaunchFromEntry);
    if (launches.some(launch => !launch)) throw new Error(t('入站 MCP 托管记录损坏；原文件已保留'));
    Object.defineProperty(engines, id, { value: launches, enumerable: true, configurable: true, writable: true });
  }
  return { snapshot, ledger: { version: 1, engines } };
}
function legacyTrusted(launch: InboundMcpLaunch, fingerprint?: string): boolean {
  // Old TOFU stored command/args, not env. Only its original one-script shape and
  // Electron's fixed run-as-node flag are eligible; arbitrary env/cwd/type is not.
  return !!fingerprint && launch.args.length === 1 && !/[\r\n]/.test(launch.command)
    && !/[\r\n]/.test(launch.args[0]) && inboundMcpFingerprint(launch) === fingerprint
    && Object.entries(launch.env ?? {}).every(([key, value]) => key === 'ELECTRON_RUN_AS_NODE' && value === '1');
}
function recognized(entry: unknown, launch: InboundMcpLaunch, previous: InboundMcpLaunch[], legacy?: string, file?: InboundMcpEngineFile): InboundMcpLaunch | null {
  if (file) for (const candidate of [launch, ...previous]) if (matchesHarnessMcpEntry(entry, candidate, file)) return candidate;
  const parsed = harnessMcpLaunch(entry, file) ?? (file?.entryStyle ? inboundMcpLaunchFromEntry(entry) : null);
  return parsed && (sameInboundMcpLaunch(parsed, launch) || previous.some(item => sameInboundMcpLaunch(parsed, item)) || legacyTrusted(parsed, legacy)) ? parsed : null;
}
function message(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) return t('无法访问 CLI 配置（{{code}}）；请检查文件及目录权限后重试', { code });
  return error instanceof Error ? error.message : t('CLI 自动配置失败，请重试');
}
function result(engines: InboundMcpSetupStatus['engines']): InboundMcpSetupStatus {
  const failures = engines.filter(engine => engine.state === 'error');
  return { ok: !failures.length, engines, ...(failures.length ? { error: failures.map(engine => `${engine.label}: ${engine.error}`).join('\n') } : {}) };
}
export function failedInboundMcpSetup(files: InboundMcpEngineFile[], error: string): InboundMcpSetupStatus {
  return result(files.map(file => ({ ...file, state: 'error', error })));
}

/** Reads actual configuration and ownership facts. Never writes or starts a process. */
export function readInboundMcpSetupStatus(launch: InboundMcpLaunch | null, options: InboundMcpSetupOptions): InboundMcpSetupStatus {
  if (!launch) return failedInboundMcpSetup(options.files, t('入站 MCP 脚本未找到（请先构建）'));
  let ledger: SetupLedger;
  try { ledger = readLedger(options.ownershipFile).ledger; }
  catch (error) { return failedInboundMcpSetup(options.files, message(error)); }
  return result(options.files.map(file => {
    try {
      const current = configSnapshot(file);
      if (file.requiresMcpEnabled && (!object(current.value.features) || current.value.features.mcp !== true)) throw new Error('ZCode MCP feature has not been enabled; retry automatic configuration');
      if (!current.present) throw new Error(t('尚未配置宿主 MCP，请重试自动配置'));
      const known = recognized(current.entry, launch, ledger.engines[file.id] ?? [], options.legacyTrustedFingerprint, file);
      if (!known) throw new Error(t('同名 muster 服务不是已识别的宿主配置；原配置已保留'));
      if (!sameInboundMcpLaunch(known, launch)) throw new Error(t('宿主 MCP 安装路径已改变，请重试自动配置'));
      if (!matchesHarnessMcpEntry(current.entry, launch, file) || Object.keys(file.rootDefaults ?? {}).some(key => !owns(current.value, key))) throw new Error('Host MCP configuration format changed; retry automatic configuration');
      if (!(ledger.engines[file.id] ?? []).some(item => sameInboundMcpLaunch(item, launch))) throw new Error(t('宿主 MCP 配置已存在，但托管记录尚未保存，请重试自动配置'));
      return { ...file, state: 'configured' as const };
    } catch (error) { return { ...file, state: 'error' as const, error: message(error) }; }
  }));
}

/** Independently ensures each engine; known current entries are not rewritten. */
export function ensureInboundMcpSetup(launch: InboundMcpLaunch | null, options: InboundMcpSetupOptions): InboundMcpSetupStatus {
  if (!launch) return failedInboundMcpSetup(options.files, t('入站 MCP 脚本未找到（请先构建）'));
  let stored: ReturnType<typeof readLedger>;
  try { stored = readLedger(options.ownershipFile); }
  catch (error) { return failedInboundMcpSetup(options.files, message(error)); }
  return result(options.files.map(file => {
    try {
      const current = configSnapshot(file);
      const previous = stored.ledger.engines[file.id] ?? [];
      const known = current.present ? recognized(current.entry, launch, previous, options.legacyTrustedFingerprint, file) : null;
      if (current.present && !known) throw new Error(t('同名 muster 服务不是已识别的宿主配置；原配置已保留'));
      const history = [...previous];
      for (const candidate of [known, launch]) if (candidate && !history.some(item => sameInboundMcpLaunch(item, candidate))) history.push(candidate);
      if (history.length !== previous.length) {
        const ledger: SetupLedger = { version: 1, engines: { ...stored.ledger.engines, [file.id]: history.slice(-MAX_OWNED_LAUNCHES) } };
        // Commit trusted identities first, retaining every failed engine's old identity.
        // A later config write failure therefore cannot prevent a safe retry/upgrade.
        writeSnapshot(stored.snapshot, ledger);
        stored = readLedger(options.ownershipFile);
      }
      if (!known || !sameInboundMcpLaunch(known, launch) || !matchesHarnessMcpEntry(current.entry, launch, file) || Object.keys(file.rootDefaults ?? {}).some(key => !owns(current.value, key)) || file.requiresMcpEnabled && (!object(current.value.features) || current.value.features.mcp !== true)) writeSnapshot(current.snapshot, withHarnessServer(current.value, file, launch), file);
      return { ...file, state: 'configured' as const };
    } catch (error) { return { ...file, state: 'error' as const, error: message(error) }; }
  }));
}
