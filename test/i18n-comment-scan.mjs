import assert from 'node:assert/strict';
import { findIdentifierReferences, maskConsoleCallsPreservingLines, maskCssCommentsPreservingLines, maskDisplayDataPreservingLines, maskKnownLiteralsPreservingLines, maskModelDiagnosticsPreservingLines, maskProtocolFunctionsPreservingLines, maskRegexLiteralsPreservingLines, maskTranslatedCallsPreservingLines, maskVerifiedLabelReferencesPreservingLines, maskVerifiedTemplatesPreservingLines, scanRawChineseLines, shouldScanRawChinese, stripCommentsPreservingLines } from './helpers/i18n-comments.mjs';

const scopeFixture = [
  ['src/renderer/src/Example.tsx', "const message = '界面中文';"],
  ['src/main/example.ts', "const prompt = '发给模型的中文';"]
];
const scanFixture = audit => scopeFixture.filter(([file]) => shouldScanRawChinese(file, audit))
  .flatMap(([file, text]) => scanRawChineseLines(text, () => false, file, text).map(hit => `${file}:${hit.line}`));
assert.deepEqual(scanFixture(false), ['src/renderer/src/Example.tsx:1'], 'daily scan still detects renderer strings');
assert.deepEqual(scanFixture(true), ['src/renderer/src/Example.tsx:1', 'src/main/example.ts:1'], 'explicit audit still inspects host code');

const source = [
  '/* comment one',
  '   comment two */',
  `const url = 'https://example.test/路径'; // trailing comment`,
  'const re = /https?:\\/\\//; // regex remains intact',
  'const text = `模板 // 内容 ${value} 完整`; /* more */',
  'const last = "最后一行";'
].join('\n');
const stripped = stripCommentsPreservingLines(source);
assert.equal(stripped.length, source.length);
assert.equal(stripped.split('\n').length, source.split('\n').length);
assert.match(stripped, /https:\/\/example\.test\/路径/);
assert.match(stripped, /模板 \/\/ 内容 \$\{value\} 完整/);
assert.ok(!stripped.includes('comment one') && !stripped.includes('trailing comment'));
assert.equal(stripped.split('\n')[5], 'const last = "最后一行";');
const translations = `const a = t(flag ? '已翻译' : '也已翻译'); const b = '仍未翻译';\nconst c = "t('并非调用')";`;
const masked = maskTranslatedCallsPreservingLines(translations);
assert.equal(masked.length, translations.length);
assert.ok(!masked.includes('已翻译') && masked.includes('仍未翻译'));
assert.ok(masked.includes("t('并非调用')"));
const dataKeys = "const translated = '已翻译的数据键'; const missed = '同一行的未翻译文案';\nconst detail = `已翻译的前缀：${error}`;";
const maskedData = maskKnownLiteralsPreservingLines(dataKeys, ['已翻译的数据键', '已翻译的前缀：']);
assert.equal(maskedData.length, dataKeys.length);
assert.ok(!maskedData.includes('已翻译的数据键') && !maskedData.includes('已翻译的前缀：'));
assert.ok(maskedData.includes('同一行的未翻译文案'));
const labelRefs = "fieldCaption('标题', true); section.label === '类型'; const missed = '标题'; other('类型');";
const maskedLabels = maskVerifiedLabelReferencesPreservingLines(labelRefs, labelRefs, { keys: ['标题', '类型'], callName: 'fieldCaption', comparison: 'section.label' });
assert.ok(!maskedLabels.includes("fieldCaption('标题'") && !maskedLabels.includes("section.label === '类型'"));
assert.ok(maskedLabels.includes("missed = '标题'") && maskedLabels.includes("other('类型')"), 'same keys outside verified contexts stay visible');
const structured = 'const shown = `已翻译 ${count} 条`; const missed = `已翻译 ${count} 处`; const sibling = `已翻译 ${"未翻译"} 条`;';
const maskedStructured = maskVerifiedTemplatesPreservingLines(structured, [['已翻译 ', ' 条']]);
assert.equal(maskedStructured.length, structured.length);
assert.ok(!maskedStructured.includes('已翻译 ${count} 条'));
assert.ok(maskedStructured.includes('已翻译 ${count} 处') && maskedStructured.includes('未翻译'));
const layeredOriginal = "const a = `先屏蔽${value}`; const b = '后屏蔽'; const c = '仍须检查';";
const firstLayer = maskKnownLiteralsPreservingLines(layeredOriginal, ['先屏蔽']);
const secondLayer = maskKnownLiteralsPreservingLines(firstLayer, ['后屏蔽'], 'source.ts', layeredOriginal);
assert.ok(!secondLayer.includes('先屏蔽') && !secondLayer.includes('后屏蔽'), 'later passes locate keys in the original syntax even after a template head is masked');
assert.ok(secondLayer.includes('仍须检查'), 'a raw sibling remains visible after multiple masking passes');
const displayData = "const labels = { a: '已校验标签' }; const sibling = '同一行仍需翻译';\nconst view = { initNotes: [`说明 ${path}`] }; const other = '另一处';";
const maskedDisplayData = maskDisplayDataPreservingLines(displayData, displayData, { variables: ['labels'], properties: ['initNotes'] });
assert.equal(maskedDisplayData.length, displayData.length);
assert.ok(!maskedDisplayData.includes('已校验标签') && !maskedDisplayData.includes('说明'));
assert.ok(maskedDisplayData.includes('同一行仍需翻译') && maskedDisplayData.includes('另一处'));
const protocolText = "function model() { return `发给模型 ${value}`; } function display() { return '仍须翻译'; }";
const maskedProtocol = maskProtocolFunctionsPreservingLines(protocolText, protocolText, ['model']);
assert.equal(maskedProtocol.length, protocolText.length);
assert.ok(!maskedProtocol.includes('发给模型') && maskedProtocol.includes('仍须翻译'));
assert.deepEqual(findIdentifierReferences("// DormantPipeline\nconst label = 'DormantPipeline';", ['DormantPipeline']), []);
assert.deepEqual(findIdentifierReferences("import { DormantPipeline } from './legacy';", ['DormantPipeline']), ['DormantPipeline']);
const regexAndText = "const rule = /更正|删除/g; const label = '仍需翻译';";
const maskedRegex = maskRegexLiteralsPreservingLines(regexAndText);
assert.equal(maskedRegex.length, regexAndText.length);
assert.ok(!maskedRegex.includes('更正') && maskedRegex.includes('仍需翻译'));
const diagnostics = "class Store { commit() { throw new Error('模型诊断'); } view() { throw new Error('界面错误'); } }";
const maskedDiagnostics = maskModelDiagnosticsPreservingLines(diagnostics, { className: 'Store', methodName: 'commit' });
assert.ok(!maskedDiagnostics.includes('模型诊断') && maskedDiagnostics.includes('界面错误'));
const tools = "function tools() { return { description: '给模型的说明', run() { throw new Error('给模型的错误'); }, title: '仍需检查' }; }";
const maskedTools = maskModelDiagnosticsPreservingLines(tools, { functionName: 'tools' });
assert.ok(!maskedTools.includes('给模型的说明') && !maskedTools.includes('给模型的错误') && maskedTools.includes('仍需检查'));
const consoleAndText = "console.warn(\n  '日志'\n); const label = '需要翻译';";
const maskedConsole = maskConsoleCallsPreservingLines(consoleAndText);
assert.ok(!maskedConsole.includes('日志') && maskedConsole.includes('需要翻译'));
const infoAndText = "console.info('诊断'); console.debug('调试'); console.trace('调用栈'); const visible = '界面';";
const maskedInfo = maskConsoleCallsPreservingLines(infoAndText);
assert.ok(!maskedInfo.includes('诊断') && !maskedInfo.includes('调试') && !maskedInfo.includes('调用栈') && maskedInfo.includes('界面'));
assert.deepEqual(scanRawChineseLines("const labels = [\n  '尚未翻译',\n];").map(item => item.line), [2]);
assert.deepEqual(scanRawChineseLines('const text = `first\n尚未翻译\nlast`;').map(item => item.line), [2], 'multiline template text without quotes on the line must be checked');
const multilineOriginal = "const value = `已翻译${input}\n仍未翻译`; const 中文变量 = 1; // 注释不算文案";
const multilineMasked = maskKnownLiteralsPreservingLines(stripCommentsPreservingLines(multilineOriginal), ['已翻译'], 'source.ts', multilineOriginal);
assert.deepEqual(scanRawChineseLines(multilineMasked, () => false, 'source.ts', multilineOriginal).map(item => item.line), [2], 'masking a template prefix must not hide a later raw line or report identifiers/comments');
const revisionA = "const a = t('先前键');";
const revisionB = "const a = '尚未翻译';";
maskTranslatedCallsPreservingLines(revisionA, 'same.ts');
const changedSource = maskTranslatedCallsPreservingLines(revisionB, 'same.ts');
assert.deepEqual(scanRawChineseLines(changedSource, () => false, 'same.ts', revisionB).map(item => item.line), [1], 'an edited file must not reuse an older syntax tree');
const cssSource = "const beam = { css: `a { /* CSS 注释 */ content: '/* 仍需翻译 */'; }`, label: '另一个文案' };";
const cssMasked = maskCssCommentsPreservingLines(cssSource, 'beam.ts', cssSource);
assert.ok(!cssMasked.includes('CSS 注释') && cssMasked.includes('仍需翻译') && cssMasked.includes('另一个文案'));
assert.equal(cssMasked.length, cssSource.length, 'embedded CSS comments preserve source positions');
console.log('i18n comment scan: source locations, strings, templates and regex preserved');
