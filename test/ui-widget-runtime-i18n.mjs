/** Runtime-owned labels/errors are translated without mutating author content or diagnostics. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const ts = createRequire(import.meta.url)('typescript');
const names = ['bridge', 'expressions', 'components', 'data-components', 'advanced-components'];
const sources = new Map(names.map(name => [name, fs.readFileSync(`src/main/uiRuntime/${name}.js`, 'utf8')]));
let onAppearance;
const dom = new JSDOM(`<!doctype html><html><head><script>${sources.get('bridge')}</script></head><body></body></html>`, {
  url: 'https://fixture.invalid/widget', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(window) {
    window.TextEncoder = TextEncoder;
    window.__maUiHost = { read: async () => ({ state: { modelContent: {}, privateContent: {}, revision: 0 } }),
      onAppearance: callback => { onAppearance = callback; }, onState() {}, receipt: async () => {} };
  }
});
try {
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  await dom.window.maUi.whenReady();
  onAppearance({ locale: 'en' });
  const api = dom.window.maUi;
  const bridge = ts.createSourceFile('bridge.js', sources.get('bridge'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let dictionary;
  function dictionaryNode(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(bridge) === 'english') dictionary = node.initializer;
    ts.forEachChild(node, dictionaryNode);
  }
  dictionaryNode(bridge);
  assert.ok(dictionary && ts.isObjectLiteralExpression(dictionary));
  const keys = new Set();
  for (const prop of dictionary.properties) {
    assert.ok(ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name) && ts.isStringLiteral(prop.initializer));
    const key = prop.name.text, value = prop.initializer.text;
    assert.ok(!keys.has(key), `duplicate runtime translation: ${key}`); keys.add(key);
    const args = text => [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(args(value), args(key), `runtime placeholders differ: ${key}`);
  }
  // Exact, counted protocol/default sources: new bare display strings must be
  // wired to a translation instead of passing merely because a key exists.
  const allowedUnbound = {
    'bridge|displayHint|可用函数：': 2, 'bridge|fail|内容渲染失败': 1, 'bridge||行 ': 1,
    'expressions|error|检查此位置的运算符、括号和参数': 1,
    'components|showDiagnostic|（第 ': 1, 'components|showDiagnostic| 字符）': 1,
    'components|showDiagnostic|\n建议：': 1, 'components|build|继续': 1,
    'data-components|refresh|已完成': 1, 'data-components|refresh|进行中': 1,
    'data-components|refresh|待开始': 1, 'data-components|refresh|受阻': 1,
  };
  function sample(node) {
    if (ts.isParenthesizedExpression(node)) return sample(node.expression);
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return sample(node.left) + sample(node.right);
    return '42';
  }
  function verify(runtimeSources) {
    const unbound = new Map(Object.entries(allowedUnbound));
    for (const name of names) {
    const file = `${name}.js`, tree = ts.createSourceFile(file, runtimeSources.get(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function check(node) {
      if (name === 'bridge' && ts.isVariableDeclaration(node) && node.name.getText(tree) === 'english') return;
      if (ts.isStringLiteral(node) && /[\u3400-\u9fff]/.test(node.text)) {
        let parent = node.parent, translated = false, scope = '';
        while (parent && !ts.isSourceFile(parent)) {
          if (!scope && (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent))) scope = parent.name?.getText(tree) ?? '';
          if (ts.isCallExpression(parent)) {
            const fn = parent.expression.getText(tree);
            const index = fn === 'api.bindAttr' ? 2 : fn === 'api.bindText' ? 1 : ['api.text', 'api.ownedError', 'ownedError'].includes(fn) ? 0 : fn === 'error' && name === 'expressions' ? 0 : -1;
            const argument = parent.arguments[index];
            if (argument && node.pos >= argument.pos && node.end <= argument.end) {
              if (['api.text', 'api.bindText', 'api.bindAttr'].includes(fn)) assert.ok(keys.has(node.text), `missing runtime label ${file}: ${node.text}`);
              translated = true; break;
            }
            if (fn === 'error' && name === 'expressions' && parent.arguments[3] && node.pos >= parent.arguments[3].pos && node.end <= parent.arguments[3].end) { translated = true; break; }
          }
          parent = parent.parent;
        }
        if (!translated) {
          const id = `${name}|${scope}|${node.text}`, remaining = unbound.get(id) ?? 0;
          assert.ok(remaining > 0, `unreviewed widget runtime text ${file}: ${node.text}`);
          unbound.set(id, remaining - 1);
        }
      }
      if (ts.isCallExpression(node)) {
        const fn = node.expression.getText(tree);
        const errorCall = fn === 'api.ownedError' || name === 'bridge' && fn === 'ownedError' || name === 'expressions' && fn === 'error';
        if (errorCall && node.arguments[0]) {
          const message = sample(node.arguments[0]);
          if (/[\u3400-\u9fff]/.test(message)) assert.notEqual(api.displayError(api.ownedError(message)), message, `untranslated runtime diagnostic ${file}: ${message}`);
        }
        if (name === 'expressions' && fn === 'error' && node.arguments[3]) {
          const hint = sample(node.arguments[3]);
          if (/[\u3400-\u9fff]/.test(hint)) assert.notEqual(api.displayHint(hint), hint, `untranslated runtime hint: ${hint}`);
        }
      }
      ts.forEachChild(node, check);
    }
      check(tree);
    }
    assert.ok([...unbound.values()].every(count => count === 0), 'reviewed protocol/default sites changed; recheck their display boundary');
  }
  verify(sources);
  const withBareText = new Map(sources);
  withBareText.set('components', sources.get('components') + "\nconst accidentalRawLabel = '继续';\n");
  assert.throws(() => verify(withBareText), /unreviewed widget runtime text/, 'an existing dictionary key cannot hide a new untranslated label');
  assert.equal(api.displayHint('可用函数：sum, len'), 'Available functions: sum, len');
  assert.equal(api.displayHint('请改写为 sum(value, ...)，不支持 .sum() 方法写法'), 'Use sum(value, ...) instead of .sum()');
  assert.equal(api.displayError(new dom.window.Error('除数不能为零')), '除数不能为零');
  console.log('ui widget runtime i18n: labels, owned diagnostics, placeholders and provenance passed');
} finally { dom.window.close(); }
