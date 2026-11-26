import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

/** Exercise the real get/project/peek contract without starting an app or reading user data. */
export function sessionProjectionFixture(rows) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/sessions.ts'), 'utf8');
  const tree = ts.createSourceFile('sessions.ts', source, ts.ScriptTarget.Latest, true);
  const klass = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionsService');
  const methods = ['get', 'project', 'peek'].map(name => {
    const method = klass.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(tree) === name);
    assert.ok(method, `SessionsService.${name} exists`);
    return method.getText(tree);
  });
  const compiled = ts.transpileModule(`class Projection { ${methods.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const Projection = new Function(`${compiled}\nreturn Projection;`)();
  return Object.assign(new Projection(), { sessions: rows, isChatRuntime: () => true });
}
