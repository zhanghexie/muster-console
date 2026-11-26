/** The product's native textareas must never expose a manual resize handle. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(root, 'src/renderer/src');
const basePath = path.join(renderer, 'styles/base.css');
const base = postcss.parse(fs.readFileSync(basePath, 'utf8'), { from: basePath });
let globalGuard = false;
base.walkRules(rule => {
  if (!postcss.list.comma(rule.selector).includes('textarea')) return;
  rule.walkDecls('resize', decl => { if (decl.value.trim() === 'none' && decl.important) globalGuard = true; });
});
assert.ok(globalGuard, 'base.css must prevent native textarea resizing even when old local styles set resize: vertical');

const violations = [];
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) scan(file);
    else if (item.isFile() && file.endsWith('.css')) {
      postcss.parse(fs.readFileSync(file, 'utf8'), { from: file }).walkDecls('resize', decl => {
        const selector = decl.parent?.selector ?? '';
        if (decl.important && decl.value.trim() !== 'none' && /textarea|input|editor|field/i.test(selector)) violations.push(`${path.relative(root, file)}: ${selector}`);
      });
    }
  }
}
scan(renderer);
assert.deepEqual(violations, [], 'input styles must not override the resize guard');
console.log('textarea-resize-policy: ok');
