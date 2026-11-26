/**
 * 行内公式货币误报守卫（guardInlineMathCurrency）。
 * 规则：单 `$` 配对内容首尾是空白 → 转义开定界符（Pandoc 行内公式规则）；
 * `$$` 连跑、代码围栏/行内代码、已转义 `\$` 原样跳过。
 * 运行: node test/markdown-math-guard.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-math-guard-'));
/** 转译并落盘一个 shared 模块（守卫依赖 cjkMarkdownEmphasis，需一起装载；
 *  转译产物保持无扩展名导入，ESM 直载需补 .mjs） */
function transpileShared(name) {
  const entry = path.join(root, 'src/shared', `${name}.ts`);
  const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: entry
  });
  const out = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(out, outputText.replace(/(from\s+')\.\/([A-Za-z0-9_.-]+)(')/g, "$1./$2.mjs$3"));
  return out;
}
transpileShared('cjkMarkdownEmphasis');
const { guardInlineMathCurrency: guard } = await import(pathToFileURL(transpileShared('markdownMathGuard')).href);

// 货币：闭定界符前是空格 → 开 $ 转义，其余原样（渲染回字面 $5/$10）
assert.equal(guard('价格是 $5 和总价 $10 合计'), '价格是 \\$5 和总价 $10 合计');

// 真公式不受影响（首尾无空白）
assert.equal(guard('$x^2$'), '$x^2$');
assert.equal(guard('场强中文$x_{ij}$继续'), '场强中文$x_{ij}$继续');
assert.equal(guard('$a$ 与 $b$ 都保留'), '$a$ 与 $b$ 都保留');

// 内容首空白同样转义（Pandoc 规则的另一侧）
assert.equal(guard('a $ b$'), 'a \\$ b$');

// `$$` 连跑（块级/行内显示公式，含换行体）整跑跳过
assert.equal(guard('$$E=mc^2$$'), '$$E=mc^2$$');
assert.equal(guard('$$\n\\int_0^1 f(x)\\,dx\n$$'), '$$\n\\int_0^1 f(x)\\,dx\n$$');

// 代码围栏与行内代码内的 $ 原样
assert.equal(guard('```\n$a b $\n```'), '```\n$a b $\n```');
assert.equal(guard('见 `$a $` 字面量'), '见 `$a $` 字面量');

// 已转义的 \$ 不二次处理；其后单 $ 无配对也原样
assert.equal(guard('\\$5 和 $10'), '\\$5 和 $10');

// 无 $ / 空文本直通
assert.equal(guard('普通正文'), '普通正文');
assert.equal(guard(''), '');

// 已知边界（记录行为，不做守卫）：CJK 无空格贴排的货币仍判为公式内容
assert.equal(guard('$5和$10'), '$5和$10');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('markdown-math-guard: 全部断言通过');
