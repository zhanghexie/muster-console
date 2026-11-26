/**
 * 左栏会话名：无论是否有胶囊，都是「名字 · CLI」。
 * 运行: node test/session-list-name.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'sessionListName.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-list-name-'));
  const outFile = path.join(tmp, 'sessionListName.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const { sessionCliLabel, formatSessionListName } = await import(pathToFileURL(outFile).href);

const runtimes = [{ id: 'grok', label: 'Grok' }, { id: 'cursor-cli', label: 'Cursor CLI' }];

assert.equal(sessionCliLabel({ type: 'scheduled' }, runtimes), '');
assert.equal(
  sessionCliLabel({ type: 'terminal', launchKind: 'agent', runtime: 'grok' }, runtimes),
  'Grok'
);
assert.equal(
  sessionCliLabel(
    { type: 'terminal', launchKind: 'shell', shellProfileId: 'powershell' },
    runtimes
  ),
  'powershell'
);
assert.equal(
  sessionCliLabel({ type: 'terminal', launchKind: 'agent', runtime: 'missing' }, runtimes),
  'missing'
);

assert.equal(formatSessionListName('工作面板 6', 'Grok'), '工作面板 6 · Grok');
assert.equal(formatSessionListName('划词', 'Grok'), '划词 · Grok');
assert.equal(formatSessionListName('划词', ''), '划词');
assert.equal(formatSessionListName('划词', null), '划词');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('session-list-name ok');
