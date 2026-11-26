/**
 * 文件拖放路径格式化自测。
 * 运行: node test/file-drop-paths.mjs
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
const entry = path.join(root, 'src', 'shared', 'fileDropPaths.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-drop-'));
  const outFile = path.join(tmp, 'fileDropPaths.mjs');
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
const {
  quoteShellPath,
  formatTerminalDropText,
  formatAgentDropText,
  pathsFromFiles,
  dataTransferHasFiles,
  readPlainTextFromDataTransfer,
  pathsFromDataTransfer,
  dataTransferHasPaths,
  agentInsertFromDataTransfer,
  MUSTER_PATHS_MIME,
  looksLikeAbsPath
} = await import(pathToFileURL(outFile).href);

assert.equal(quoteShellPath('D:\\a\\b.txt'), 'D:\\a\\b.txt');
assert.equal(quoteShellPath('D:\\a b\\c.txt'), '"D:\\a b\\c.txt"');
assert.equal(quoteShellPath('D:\\a"b.txt'), '"D:\\a\\"b.txt"');

assert.equal(formatTerminalDropText(['D:\\a.txt']), 'D:\\a.txt');
assert.equal(
  formatTerminalDropText(['D:\\a.txt', 'D:\\b c.txt']),
  'D:\\a.txt "D:\\b c.txt"'
);
assert.equal(formatTerminalDropText([]), '');

assert.equal(formatAgentDropText(['D:\\a.txt']), '@D:\\a.txt ');
assert.equal(
  formatAgentDropText(['D:\\a.txt', 'D:\\b.txt']),
  '@D:\\a.txt @D:\\b.txt '
);
assert.equal(formatAgentDropText([]), '');

const fakeFiles = [{ name: 'x' }, { name: 'y' }, { name: 'bad' }];
assert.deepEqual(
  pathsFromFiles(fakeFiles, (f) => {
    if (f.name === 'bad') throw new Error('nope');
    if (f.name === 'x') return 'D:\\x';
    if (f.name === 'y') return '';
    return 'D:\\z';
  }),
  ['D:\\x']
);

assert.equal(dataTransferHasFiles(null), false);
assert.equal(dataTransferHasFiles({ types: ['text/plain'] }), false);
assert.equal(dataTransferHasFiles({ types: ['Files', 'text/plain'] }), true);

const dtText = {
  types: ['text/plain'],
  getData: (f) => (f === 'text/plain' ? '  hello\nworld  ' : '')
};
assert.equal(readPlainTextFromDataTransfer(dtText), 'hello\nworld');

const dtBlank = {
  types: ['text/plain'],
  getData: () => '   \n  '
};
assert.equal(readPlainTextFromDataTransfer(dtBlank), null);

const dtFiles = {
  types: ['Files', 'text/plain'],
  getData: () => 'should-ignore'
};
assert.equal(readPlainTextFromDataTransfer(dtFiles), null);

const dtLegacy = {
  types: ['Text'],
  getData: (f) => (f === 'Text' ? 'legacy' : '')
};
assert.equal(readPlainTextFromDataTransfer(dtLegacy), 'legacy');

assert.equal(looksLikeAbsPath('D:\\foo\\bar'), true);
assert.equal(looksLikeAbsPath('/tmp/a'), true);
assert.equal(looksLikeAbsPath('relative/path'), false);

const fakeDt = {
  types: [MUSTER_PATHS_MIME, 'text/plain'],
  getData: (type) =>
    type === MUSTER_PATHS_MIME
      ? JSON.stringify(['D:\\from-tree.txt'])
      : 'D:\\from-tree.txt',
  files: []
};
assert.equal(dataTransferHasPaths(fakeDt), true);
assert.deepEqual(
  pathsFromDataTransfer(fakeDt, () => ''),
  ['D:\\from-tree.txt']
);

assert.equal(
  agentInsertFromDataTransfer(fakeDt, () => ''),
  '@D:\\from-tree.txt '
);

const textOnlyDt = {
  types: ['text/plain'],
  getData: (type) => (type === 'text/plain' ? '  hello from terminal\n' : ''),
  files: []
};
assert.equal(dataTransferHasPaths(textOnlyDt), true);
assert.deepEqual(pathsFromDataTransfer(textOnlyDt, () => ''), []);
assert.equal(agentInsertFromDataTransfer(textOnlyDt, () => ''), '  hello from terminal\n');

const absTextDt = {
  types: ['text/plain'],
  getData: (type) => (type === 'text/plain' ? 'D:\\abs\\file.ts' : ''),
  files: []
};
assert.equal(agentInsertFromDataTransfer(absTextDt, () => ''), '@D:\\abs\\file.ts ');

const emptyTextDt = {
  types: ['text/plain'],
  getData: () => '   ',
  files: []
};
assert.equal(agentInsertFromDataTransfer(emptyTextDt, () => ''), '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('file-drop-paths: ok');
