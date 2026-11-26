import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'app-log-directory-'));
try {
  const ts = createRequire(import.meta.url)('typescript');
  const source = ts.createSourceFile('index.ts', fs.readFileSync('src/main/index.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handle' && node.arguments[0]?.text === 'app:log-dir') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }; visit(source); assert.ok(callback, 'real log-directory IPC registration exists');
  const compile = createSharedCompiler(process.cwd(), folder);
  const { userDataStorage } = await import(pathToFileURL(compile('main/runtimeKernel/storageRootResolver.ts')));
  const storage = userDataStorage(path.join(folder, 'injected-instance-root'));
  const code = ts.transpileModule(`exports.callback = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const result = Function('exports', 'productStorageResolver', `${code}\nreturn exports.callback();`)({}, () => storage);
  assert.equal(result, path.join(folder, 'injected-instance-root', 'logs'));
  console.log('app log-directory IPC resolves the actual injected product log root');
} finally {
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  fs.rmSync(folder, { recursive: true, force: true });
}
