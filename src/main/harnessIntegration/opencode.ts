import fs from 'node:fs';
import path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { t } from '../../shared/i18n';
import { assertHarnessMcpPublicPath } from './publicPath';
import type { HarnessPathContext } from './resolve';
import type { InboundMcpEngineFile } from '../../shared/inboundMcp';

export type OpenCodeMcpLayout = 'flat' | 'nested';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const server = (value: unknown): boolean => object(value) && (value.type === 'local' || value.type === 'remote' || typeof value.enabled === 'boolean');

export function openCodeMcpLayout(mcp: unknown): OpenCodeMcpLayout | undefined {
  if (!object(mcp)) return undefined;
  const nested = (object(mcp.servers) && !server(mcp.servers)) || typeof mcp.timeout === 'number' || typeof mcp.disabled === 'boolean';
  const flat = Object.values(mcp).some(server);
  if (nested && flat) throw new Error(t('OpenCode 配置混用了两种 MCP 服务结构，请合并后重试'));
  if (nested) return 'nested';
  if (flat) return 'flat';
  return undefined;
}

export function readOpenCodeMcpLayout(filename: string): OpenCodeMcpLayout | undefined {
  assertHarnessMcpPublicPath(filename);
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })) return undefined;
  const physical = fs.realpathSync.native(filename);
  assertHarnessMcpPublicPath(physical);
  const stat = fs.statSync(physical);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(t('CLI 配置不是有效的普通文件，或超过 2 MiB'));
  const errors: ParseError[] = [];
  const value: unknown = parse(fs.readFileSync(physical, 'utf8').replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(t('CLI 配置无法解析；原文件已保留，请修复后重试'));
  return openCodeMcpLayout(object(value) ? value.mcp : undefined);
}

export function openCodeMcpFile(context: HarnessPathContext, defaultLayout: OpenCodeMcpLayout = 'nested'): Pick<InboundMcpEngineFile, 'path' | 'format' | 'serversKey' | 'entryStyle' | 'checkOpenCodeLayout'> {
  const paths = (context.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  const env = context.env ?? process.env;
  // Content/custom directory can override global values, so don't claim global setup is effective.
  if (env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR) throw new Error(t('OpenCode 使用自定义配置环境；请移除 OPENCODE_CONFIG_CONTENT/OPENCODE_CONFIG_DIR 后重试，或手动接入'));
  const root = context.configDir ?? env.XDG_CONFIG_HOME ?? paths.join(context.homeDir, '.config');
  if (!paths.isAbsolute(root)) throw new Error(t('OpenCode XDG_CONFIG_HOME 必须是绝对路径'));
  const custom = env.OPENCODE_CONFIG;
  if (custom && !paths.isAbsolute(custom)) throw new Error(t('OpenCode OPENCODE_CONFIG 必须是绝对路径'));
  const candidates = custom ? [custom] : ['opencode.jsonc', 'opencode.json'].map(name => paths.join(root, 'opencode', name));
  // Both are merged by the CLI. Refuse ambiguous double definitions instead of shadowing a user's server.
  candidates.forEach(assertHarnessMcpPublicPath);
  const existing = candidates.filter(file => fs.existsSync(file));
  if (existing.length > 1) throw new Error(t('OpenCode 同时存在 JSON 与 JSONC 配置；请合并为一个文件后重试，原文件已保留'));
  const filename = existing[0] ?? custom ?? paths.join(root, 'opencode', 'opencode.json');
  const layout = readOpenCodeMcpLayout(filename) ?? defaultLayout;
  return { path: filename, format: 'jsonc', serversKey: layout === 'nested' ? ['mcp', 'servers'] : ['mcp'],
    entryStyle: 'command-array', checkOpenCodeLayout: true };
}
