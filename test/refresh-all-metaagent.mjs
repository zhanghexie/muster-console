/**
 * Refresh .muster for all workspaces in App config.
 * Run: node test/refresh-all-metaagent.mjs
 *
 * X7-F04（reliability/X7-启动与更新链）：fixture 依赖清单由手工复制改为
 * createSharedCompiler 的 import 图自动收集（同 X2-F03 解法；该 helper 自带
 * i18next/ws shim 与纯类型 import 剥离）——源码新增相对 import（如
 * shared/memoryFormat）不再让本脚本 ERR_MODULE_NOT_FOUND 且无人察觉。
 * 注意：本脚本刷新**真实工作区**（读 APPDATA 下的真 config），属运维工具而非
 * 纯测试；test/run.mjs 不把它纳入默认集合。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const cfgPath = path.join(process.env.APPDATA || '', 'metaagent-workbench', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config not found:', cfgPath);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-refresh-'));
const compile = createSharedCompiler(repoRoot, tmp);
const scaffoldOut = compile('main/metaAgent/scaffold.ts');

const { ensureMetaAgentScaffold } = await import(pathToFileURL(scaffoldOut).href);

for (const w of workspaces) {
  const root = w.path;
  const name = w.name || root;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.log(`SKIP ${name}: missing ${root}`);
    continue;
  }
  const before = fs.existsSync(path.join(root, '.muster'));
  const r = ensureMetaAgentScaffold(root);
  const hostOk = !['HOST.md', 'HOST-EXT.md'].some(name => fs.existsSync(path.join(root, '.muster', name)));
  const legacyGone = !fs.existsSync(path.join(root, '.muster', 'skills', 'metaagent-host'));
  console.log(
    `OK ${name}: created=${r.created} hadBefore=${before} HOST=${hostOk} legacyCleared=${legacyGone}`
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('done');
