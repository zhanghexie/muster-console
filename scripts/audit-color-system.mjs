import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

// Read source only. Never load app configuration or import app modules.
const start = performance.now();
const budgetMs = 10_000;
const root = process.cwd();
const require = createRequire(import.meta.url);
const ts = require('typescript');
const slash = value => value.replaceAll('\\', '/');
const relative = value => slash(path.relative(root, value));
const day = process.argv.find(arg => arg.startsWith('--date='))?.slice(7)
  || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid --date; expected YYYY-MM-DD');
const jsonOut = path.resolve(root, `docs/audits/evidence/color-system-inventory-${day}.json`);
const markdownOut = path.resolve(root, `docs/audits/color-system-inventory-${day}.md`);
for (const output of [jsonOut, markdownOut]) {
  if (!output.startsWith(path.resolve(root, 'docs/audits') + path.sep)) throw new Error('Output escaped audit directory');
}
const guard = () => { if (performance.now() - start > budgetMs) throw new Error('Static scan exceeded 10 seconds; no report written'); };
function walk(dir) {
  guard();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}
const scopeRoots = ['src/renderer', 'src/mobile'].map(value => ({ path: value, exists: fs.existsSync(path.join(root, value)) }));
const files = scopeRoots.filter(scope => scope.exists).flatMap(scope => walk(path.join(root, scope.path))).sort();
const cssFiles = files.filter(file => file.endsWith('.css'));
const tsxFiles = files.filter(file => file.endsWith('.tsx'));
const sourceFiles = files.filter(file => /\.(?:ts|tsx)$/.test(file));
const reads = new Map();
const read = file => { if (!reads.has(file)) reads.set(file, fs.readFileSync(file, 'utf8')); return reads.get(file); };
const isColorProperty = property => /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|stop-color|flood-color|lighting-color|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|scrollbar-color|opacity)$/.test(property);
const isColorToken = value => /(?:^--(?:bg|ink|text|syn|red|green|blue|yellow|purple|accent|ws-accent|on-accent|canvas|paper|surface|hairline|border|scrim|hover|selected|selection|shadow|scroll-thumb|glass|input-surface|input-border|focus-border|composer-chip|composer-fade|workspace|material-rim|rail-surface|rail-solid|material-grain|glow))/.test(value);
const kebab = value => value.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
function analyze(value) {
  const withoutUrls = value.replace(/url\([^)]*\)/gi, '');
  const literalColors = [...withoutUrls.matchAll(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b|\b(?:rgba?|hsla?|oklab|oklch|lab|lch|color)\s*\(|\b(?:transparent|currentColor|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|cyan|magenta|lime|navy|teal|silver|maroon|olive)\b/gi)].map(match => match[0]);
  return {
    tokens: [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]),
    literalColors,
    hardcodedColors: literalColors.filter(color => !/^(?:transparent|currentColor)$/i.test(color)),
    derivedMixes: [...value.matchAll(/\bcolor-mix\s*\(/gi)].length,
    transparentKeyword: /\btransparent\b/i.test(value),
    currentColorKeyword: /\bcurrentColor\b/i.test(value)
  };
}
function lineAt(text, offset) { return text.slice(0, offset).split('\n').length; }
function declarations(file) {
  const text = read(file);
  const masked = text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n\r]/g, ' '));
  const found = [];
  let segment = 0, parens = 0, quote = '', escaped = false;
  function flush(end) {
    const chunk = masked.slice(segment, end);
    const match = /^\s*(--[\w-]+|[a-z][\w-]*)\s*:\s*([\s\S]*?)\s*$/i.exec(chunk);
    if (!match) return;
    const offset = segment + chunk.indexOf(match[1]);
    const property = match[1];
    const value = match[2];
    const result = analyze(value);
    const colorRelated = isColorProperty(property) || isColorToken(property)
      || result.literalColors.length > 0 || result.tokens.some(isColorToken);
    found.push({ line: lineAt(text, offset), property, value, colorRelated, ...result });
  }
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (parens === 0 && char === '{') segment = index + 1;
    else if (parens === 0 && (char === ';' || char === '}')) { flush(index); segment = index + 1; }
  }
  return found;
}
const imports = [], settingMounts = [], themeApiCalls = [], tsxInventory = [];
const settingComponents = new Set(['ThemePane', 'WorkspaceAccentSettings']);
for (const file of sourceFiles) {
  guard();
  const text = read(file), isTsx = file.endsWith('.tsx');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const colorEntries = [];
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('.css')) {
      const target = node.moduleSpecifier.text;
      imports.push({ file: relative(file), line: line(node), target,
        resolved: target.startsWith('.') ? relative(path.resolve(path.dirname(file), target)) : null,
        kind: target.startsWith('.') ? 'local-source' : 'third-party' });
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && settingComponents.has(node.tagName.getText(source))) {
      settingMounts.push({ file: relative(file), line: line(node), component: node.tagName.getText(source) });
    }
    if (ts.isCallExpression(node) && /(?:^|\.)themes\.(?:activate|save|create|remove|list|get)$/.test(node.expression.getText(source))) {
      themeApiCalls.push({ file: relative(file), line: line(node), operation: node.expression.getText(source) });
    }
    if (isTsx && ts.isPropertyAssignment(node)) {
      const property = kebab(node.name.getText(source).replace(/^['"]|['"]$/g, ''));
      const value = node.initializer.getText(source);
      const analysis = analyze(value);
      if (isColorProperty(property) || isColorToken(property) || analysis.literalColors.length || analysis.tokens.some(isColorToken)) {
        let parent = node.parent, inline = false;
        while (parent) {
          if (ts.isJsxAttribute(parent) && parent.name.getText(source) === 'style') { inline = true; break; }
          if (ts.isVariableDeclaration(parent) || ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) break;
          parent = parent.parent;
        }
        colorEntries.push({ line: line(node), property, value, kind: inline ? 'jsx-inline-style' : 'object-property-candidate', ...analysis });
      }
    }
    if (isTsx && ts.isJsxAttribute(node)) {
      const property = kebab(node.name.getText(source));
      if (isColorProperty(property) && property !== 'opacity') {
        const value = node.initializer?.getText(source) || '';
        colorEntries.push({ line: line(node), property, value, kind: 'jsx-color-attribute', ...analyze(value) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (isTsx) {
    tsxInventory.push({ file: relative(file), entries: colorEntries,
      inlineStyleEntries: colorEntries.filter(entry => entry.kind === 'jsx-inline-style').length,
      jsxColorAttributes: colorEntries.filter(entry => entry.kind === 'jsx-color-attribute').length,
      objectCandidates: colorEntries.filter(entry => entry.kind === 'object-property-candidate').length,
      literalColorEntries: colorEntries.filter(entry => entry.literalColors.length).length,
      hardcodedColorEntries: colorEntries.filter(entry => entry.hardcodedColors.length).length });
  }
}
const cssByFile = new Map(cssFiles.map(file => [relative(file), declarations(file)]));
const cssImports = [];
for (const file of cssFiles) {
  const text = read(file);
  const pattern = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    cssImports.push({ file: relative(file), line: lineAt(text, match.index), target: match[1],
      resolved: match[1].startsWith('.') ? relative(path.resolve(path.dirname(file), match[1])) : null });
  }
}
function closure(seeds) {
  const reached = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const imported of cssImports) if (reached.has(imported.file) && imported.resolved && !reached.has(imported.resolved)) {
      reached.add(imported.resolved); changed = true;
    }
  }
  return reached;
}
const mainStyles = 'src/renderer/src/styles.css';
const mainClosure = closure([mainStyles]);
const sourceImportedClosure = closure(imports.filter(imported => imported.resolved).map(imported => imported.resolved));
const globalProperties = {};
const cssInventory = [...cssByFile].map(([file, entries]) => {
  const properties = {};
  for (const entry of entries) {
    for (const table of [properties, globalProperties]) {
      table[entry.property] ||= { declarations: 0, colorDeclarations: 0, tokenEntries: 0, literalColorEntries: 0, hardcodedColorEntries: 0, tokenReferences: 0, literalColorOccurrences: 0, hardcodedColorOccurrences: 0 };
      const item = table[entry.property];
      item.declarations++; item.colorDeclarations += Number(entry.colorRelated);
      item.tokenEntries += Number(entry.colorRelated && entry.tokens.length > 0);
      item.literalColorEntries += Number(entry.colorRelated && entry.literalColors.length > 0);
      item.hardcodedColorEntries += Number(entry.colorRelated && entry.hardcodedColors.length > 0);
      item.tokenReferences += entry.colorRelated ? entry.tokens.length : 0;
      item.literalColorOccurrences += entry.colorRelated ? entry.literalColors.length : 0;
      item.hardcodedColorOccurrences += entry.colorRelated ? entry.hardcodedColors.length : 0;
    }
  }
  const related = entries.filter(entry => entry.colorRelated);
  return { file,
    importStatus: mainClosure.has(file) ? 'main-styles-import-chain' : sourceImportedClosure.has(file) ? 'direct-source-css-import' : 'no-static-import-found',
    declarationCount: entries.length, colorDeclarationCount: related.length,
    tokenEntries: related.filter(entry => entry.tokens.length).length,
    literalColorEntries: related.filter(entry => entry.literalColors.length).length,
    hardcodedColorEntries: related.filter(entry => entry.hardcodedColors.length).length,
    derivedMixEntries: related.filter(entry => entry.derivedMixes).length,
    transparentEntries: related.filter(entry => entry.transparentKeyword).length,
    properties, entries: related };
});
const sum = (array, key) => array.reduce((total, item) => total + item[key], 0);
const artifact = {
  schemaVersion: 1, date: day, generatedAt: new Date().toISOString(), budgetMs,
  evidenceKind: 'static-source-inventory-not-visual-acceptance', scopeRoots,
  method: {
    css: 'Comment-masked declaration lexer; property counters include all declarations; color entry classification includes color properties/tokens and literal syntax. No computed cascade or selector reachability evaluation.',
    tsx: 'TypeScript AST: JSX inline style object properties, JSX color attributes, and separate object-property candidates. Indirect style objects are candidates, not proven visible UI.',
    literalColors: 'Hex, rgb/hsl/oklab/oklch/lab/lch/color function starts and named colors. Includes transparent/currentColor, separately flagged. hardcodedColorEntries excludes those two keywords; neither literal nor hardcode candidate means every occurrence is invalid.',
    imports: 'Static CSS @import closure and TS/TSX ImportDeclaration; importing a component stylesheet does not prove its component renders in the current route.',
    settings: 'Exact ThemePane and WorkspaceAccentSettings JSX mounts, plus theme API call sites. Counts are source entry points, not separate product pages.'
  },
  totals: { cssFiles: cssInventory.length, tsxFiles: tsxInventory.length, sourceFilesUsedForImports: sourceFiles.length,
    inventoriedCssAndTsxFiles: cssInventory.length + tsxInventory.length,
    mainStylesChainCssFiles: cssInventory.filter(item => item.importStatus === 'main-styles-import-chain').length,
    directSourceImportedCssFiles: cssInventory.filter(item => item.importStatus === 'direct-source-css-import').length,
    cssWithoutStaticImport: cssInventory.filter(item => item.importStatus === 'no-static-import-found').length,
    cssDeclarations: sum(cssInventory, 'declarationCount'), colorDeclarations: sum(cssInventory, 'colorDeclarationCount'),
    cssTokenEntries: sum(cssInventory, 'tokenEntries'), cssLiteralColorEntries: sum(cssInventory, 'literalColorEntries'),
    cssHardcodedColorEntries: sum(cssInventory, 'hardcodedColorEntries'),
    tsxFilesWithInlineColorStyles: tsxInventory.filter(item => item.inlineStyleEntries).length,
    tsxInlineColorStyleEntries: sum(tsxInventory, 'inlineStyleEntries'),
    tsxFilesWithColorEvidence: tsxInventory.filter(item => item.entries.length).length,
    tsxColorAttributes: sum(tsxInventory, 'jsxColorAttributes'),
    tsxHardcodedColorEntries: sum(tsxInventory, 'hardcodedColorEntries'),
    themeSettingMountPoints: settingMounts.length,
    themeSettingsPageMounts: settingMounts.filter(item => item.component === 'ThemePane').length,
    workspaceAccentSettingsMounts: settingMounts.filter(item => item.component === 'WorkspaceAccentSettings').length },
  cssImports, sourceCssImports: imports, themeSettingMounts: settingMounts, themeApiCalls,
  cssPropertyTotals: globalProperties, cssFiles: cssInventory, tsxFiles: tsxInventory,
  omissions: ['No runtime stylesheet insertion or inline imperative .style/cssText evaluation.', 'No JS / HTML / third-party package styles included in CSS/TSX totals.', 'No final computed colors, contrast measurements, platform material activation or visual approval.', 'No business-data reachability / feature-flag inference for TSX candidates.']
};
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(escape).join(' | ')} |`)].join('\n');
const colorProperties = Object.entries(globalProperties).filter(([, value]) => value.colorDeclarations).sort(([a], [b]) => a.localeCompare(b));
const inlineFiles = tsxInventory.filter(item => item.entries.length);
const md = [
  `# 配色系统全量静态清单（${day}）`,
  '', '本清单读取 renderer 的全部 CSS/TSX 源文件，并用 TypeScript 源文件补充静态 CSS 导入关系。没有读取个人配置，没有运行测试，没有修改生产 UI。**登记覆盖不等于每个 UI 已做真实视觉验收**。',
  '', `可复现：\`node scripts/audit-color-system.mjs --date=${day}\`。扫描与解析共用 ${budgetMs / 1000} 秒预算，超时在写报告前失败。`,
  '', '## 范围与数量', '',
  table(['项', '数量'], [
    ['CSS 文件', artifact.totals.cssFiles], ['TSX 文件', artifact.totals.tsxFiles], ['CSS + TSX 总数', artifact.totals.inventoriedCssAndTsxFiles],
    ['导入检查所读 TS/TSX', artifact.totals.sourceFilesUsedForImports], ['styles.css 链中 CSS（含入口）', artifact.totals.mainStylesChainCssFiles],
    ['另有组件静态导入的 CSS', artifact.totals.directSourceImportedCssFiles], ['未找到静态导入的 CSS', artifact.totals.cssWithoutStaticImport],
    ['CSS 全部属性声明', artifact.totals.cssDeclarations], ['颜色相关声明', artifact.totals.colorDeclarations], ['含 token 的颜色声明', artifact.totals.cssTokenEntries],
    ['含颜色字面量的声明', artifact.totals.cssLiteralColorEntries], ['具体色值硬码候选声明（不含透明 / currentColor）', artifact.totals.cssHardcodedColorEntries], ['含 JSX 内联颜色样式的 TSX 文件', artifact.totals.tsxFilesWithInlineColorStyles],
    ['JSX 内联颜色样式条目', artifact.totals.tsxInlineColorStyleEntries], ['含颜色证据 / 候选的 TSX 文件', artifact.totals.tsxFilesWithColorEvidence]
  ]),
  '', '`src/mobile` 当前不存在；移动端位于 `src/renderer/src/mobile`，已包含在上述总数中。',
  '', '## 计数定义', '',
  '- token / 字面量条目按“属性声明”计数；同一声明可以同时包含 token 与字面量，因此两列不可相加当作总数。',
  '- 字面量包括 hex、颜色函数和命名色，也包括 transparent / currentColor；硬码候选单独排除后两者。它们是待按职责审查的静态证据，不能全部称为违规。JSON 保留具体值与类别。',
  '- CSS JSON 每个文件的 properties 记录所有属性的总声明、颜色声明、token 条目、字面量条目及出现次数；entries 保留每个颜色相关声明的行号和值。',
  '- TSX 用 AST 分开 JSX style、SVG / JSX 颜色属性与普通对象候选。变量引用、业务图色、示例文本等候选需人工辨别；本清单不推断当前界面是否挂载。',
  '', '## CSS 文件覆盖与入口状态', '',
  table(['文件', '入口状态', '声明', '颜色', 'token', '字面量', '硬码候选', 'mix'], cssInventory.map(item => [item.file, item.importStatus, item.declarationCount, item.colorDeclarationCount, item.tokenEntries, item.literalColorEntries, item.hardcodedColorEntries, item.derivedMixEntries])),
  '', '### 样式导入证据', '',
  table(['来源', '行', '目标', '类型'], [...imports.map(item => [item.file, item.line, item.target, item.kind]), ...cssImports.map(item => [item.file, item.line, item.target, '@import'])]),
  '', '## CSS 属性颜色 / token / 字面量统计', '',
  table(['属性', '全部声明', '颜色相关', 'token 条目', '字面量条目', '硬码候选', 'token 次数', '字面量次数'], colorProperties.map(([key, value]) => [key, value.declarations, value.colorDeclarations, value.tokenEntries, value.literalColorEntries, value.hardcodedColorEntries, value.tokenReferences, value.literalColorOccurrences])),
  '', '## TSX 颜色出现文件', '',
  table(['文件', 'JSX style', 'JSX 颜色属性', '对象候选', '含字面量条目', '首次证据行'], inlineFiles.map(item => [item.file, item.inlineStyleEntries, item.jsxColorAttributes, item.objectCandidates, item.literalColorEntries, item.entries[0].line])),
  '', '### JSX 内联颜色与硬码证据', '',
  table(['文件 / 行', '种类', '属性', '值'], inlineFiles.flatMap(item => item.entries.filter(entry => entry.kind === 'jsx-inline-style' || entry.literalColors.length).map(entry => [`${item.file}:${entry.line}`, entry.kind, entry.property, entry.value.slice(0, 230)]))),
  '', '## 主题设置入口', '',
  `静态挂载点 ${settingMounts.length} 个：外观主页面 ThemePane ${artifact.totals.themeSettingsPageMounts} 个，页面内部 WorkspaceAccentSettings ${artifact.totals.workspaceAccentSettingsMounts} 个。它们构成一条设置页面路径，**不是 ${settingMounts.length} 个独立设置页面**。`,
  '', table(['文件', '行', '组件'], settingMounts.map(item => [item.file, item.line, item.component])),
  '', '主题 API 调用另登记如下；分支中不同 scope 的调用点不等于独立入口。', '',
  table(['文件', '行', '调用'], themeApiCalls.map(item => [item.file, item.line, item.operation])),
  '', '## 证据与局限', '',
  `完整文件清单、逐文件逐属性计数、逐条文件 / 行 / 值见 [JSON 证据](evidence/color-system-inventory-${day}.json)。`,
  '', '未扫描 node_modules 的第三方样式，也未计算动态插入 CSS、imperative .style/cssText、运行时级联、对比度、平台材质状态或页面挂载可达性。main-styles-import-chain 只说明进入主样式链；direct-source-css-import 只说明静态导入组件样式；no-static-import-found 不能证明文件可安全删除。',
  '', '本报告的硬码与 token 数量只回答“在哪里需要 review”，不回答“这些 UI 已经统一、可读或好看”。', ''
].join('\n');
guard();
artifact.elapsedMsBeforeWrite = Math.round(performance.now() - start);
fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
fs.writeFileSync(jsonOut, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
fs.writeFileSync(markdownOut, md, 'utf8');
console.log(JSON.stringify({ outputs: [relative(jsonOut), relative(markdownOut)], elapsedMs: Math.round(performance.now() - start), totals: artifact.totals }));
