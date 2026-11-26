/**
 * 重新生成本仓库 AGENTS.md/CLAUDE.md 的记忆托管块（不访问私有记忆数据）。
 * 修改 shared/memoryFormat 的渲染文案后运行，
 * 保证仓库内种子与渲染单源一致（否则应用下次 ensure 才会把改动写回工作区，造成提交后工作区又脏）。
 * 幂等：scaffold 自带归属标记 + 零 diff 语义。
 * 运行: node scripts/regen-memory-seeds.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from '../test/helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-seeds-'));
const compile = createSharedCompiler(root, tmp);

const scaffold = await import('file:///' + compile('main/metaAgent/scaffold.ts').replace(/\\/g, '/'));
scaffold.upsertMemoryAgentDocs(root);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[regen-memory-seeds] memory contract seeds regenerated for', root);
