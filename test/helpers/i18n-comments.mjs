import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

/** Daily gate checks renderer source; explicit audit also inspects host/protocol code. */
export function shouldScanRawChinese(relativePath, audit = false) {
  const normalized = relativePath.replace(/\\/g, '/');
  return audit || normalized.startsWith('src/renderer/src/');
}

// Each file passes through several masks. Reuse only its unchanged syntax tree;
// retaining a single entry bounds memory and invalidates it as soon as input changes.
let lastParsed;
function parseSource(file, source) {
  if (lastParsed?.file === file && lastParsed.source === source) return lastParsed.tree;
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  lastParsed = { file, source, tree };
  return tree;
}

/** Detect real identifier references, not matching words in comments or strings. */
export function findIdentifierReferences(source, names, file = 'source.ts') {
  const wanted = new Set(names.filter(name => source.includes(name)));
  if (!wanted.size) return [];
  const found = new Set(), parsed = parseSource(file, source);
  const visit = node => {
    if (ts.isIdentifier(node) && wanted.has(node.text)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...found];
}

/** Blank comments without moving locations or touching comment-like text in literals. */
export function stripCommentsPreservingLines(source, file = 'source.ts') {
  const parsed = parseSource(file, source);
  const protectedRanges = [];
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isRegularExpressionLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      protectedRanges.push([node.getStart(parsed), node.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  protectedRanges.sort((a, b) => a[0] - b[0]);
  let result = '', i = 0, index = 0;
  while (i < source.length) {
    const range = protectedRanges[index];
    if (range && i >= range[0]) {
      if (i < range[1]) { result += source.slice(i, range[1]); i = range[1]; }
      index++;
      continue;
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      const next = end < 0 ? source.length : end;
      result += source.slice(i, next).replace(/[^\r\n]/g, ' '); i = next;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const next = end < 0 ? source.length : end + 2;
      result += source.slice(i, next).replace(/[^\r\n]/g, ' '); i = next;
    } else {
      result += source[i++];
    }
  }
  return result;
}

/** Mask only actual t(...) calls, including conditional and multiline arguments. */
export function maskTranslatedCallsPreservingLines(source, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original);
  const ranges = [];
  const visit = node => {
    if (ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 't') ||
         (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't'))) {
      ranges.push([node.getStart(parsed), node.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) {
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  }
  return result;
}

/** Mask only explicitly listed data keys, leaving unrelated strings on the same line visible. */
export function maskKnownLiteralsPreservingLines(source, keys, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original);
  const known = new Set(keys), ranges = [];
  const visit = node => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && known.has(node.text)) {
      ranges.push([node.getStart(parsed), node.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Mask verified label keys only at a named translating call or data comparison. */
export function maskVerifiedLabelReferencesPreservingLines(source, original, { keys, callName, comparison }, file = 'source.ts') {
  const parsed = parseSource(file, original), known = new Set(keys), ranges = [];
  const visit = node => {
    if (ts.isStringLiteral(node) && known.has(node.text)) {
      const parent = node.parent;
      const call = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === callName && parent.arguments[0] === node;
      const compare = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        parent.right === node && parent.left.getText(parsed) === comparison;
      if (call || compare) ranges.push([node.getStart(parsed), node.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Mask verified template envelopes only; interpolated expressions remain checked. */
export function maskVerifiedTemplatesPreservingLines(source, templates, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original), known = new Set(templates.map(parts => JSON.stringify(parts))), ranges = [];
  const visit = node => {
    if (ts.isTemplateExpression(node)) {
      const literals = [node.head, ...node.templateSpans.map(span => span.literal)];
      if (known.has(JSON.stringify(literals.map(literal => literal.text))))
        for (const literal of literals) ranges.push([literal.getStart(parsed), literal.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Blank CSS comments inside static `css` templates, preserving quoted content. */
export function maskCssCommentsPreservingLines(source, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original), ranges = [];
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'css' && ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
      const start = node.initializer.getStart(parsed) + 1, end = node.initializer.end - 1;
      let quote = '';
      for (let i = start; i < end; i++) {
        const char = original[i];
        if (quote) {
          if (char === '\\') i++;
          else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '/' && original[i + 1] === '*') {
          const close = original.indexOf('*/', i + 2);
          const stop = close < 0 || close >= end ? end : close + 2;
          ranges.push([i, stop]); i = stop - 1;
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Mask literal values only inside named, separately verified display-data initializers. */
export function maskDisplayDataPreservingLines(source, original, { variables = [], properties = [] }, file = 'source.ts') {
  const parsed = parseSource(file, original), ranges = [];
  const literals = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      ranges.push([node.getStart(parsed), node.end]);
      return;
    }
    ts.forEachChild(node, literals);
  };
  const visit = node => {
    const variable = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && variables.includes(node.name.text);
    const property = ts.isPropertyAssignment(node) && properties.includes(node.name.getText(parsed));
    if ((variable || property) && node.initializer) { literals(node.initializer); return; }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Mask string literals only in explicitly named model-protocol functions. */
export function maskProtocolFunctionsPreservingLines(source, original, names, file = 'source.ts') {
  const parsed = parseSource(file, original), ranges = [];
  const literals = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      ranges.push([node.getStart(parsed), node.end]); return;
    }
    ts.forEachChild(node, literals);
  };
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text) && node.body) { literals(node.body); return; }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Regular expressions are machine-matching rules, not visible text. */
export function maskRegexLiteralsPreservingLines(source, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original);
  const ranges = [];
  const visit = node => {
    if (ts.isRegularExpressionLiteral(node)) { ranges.push([node.getStart(parsed), node.end]); return; }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Console diagnostics may span lines; mask their arguments without hiding siblings. */
export function maskConsoleCallsPreservingLines(source, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original), ranges = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console' &&
        ['log', 'info', 'debug', 'warn', 'error', 'trace'].includes(node.expression.name.text)) {
      ranges.push([node.getStart(parsed), node.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  let result = source;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** In a named model-tool function, mask only tool descriptions and thrown diagnostics. */
export function maskModelDiagnosticsPreservingLines(source, { className, methodName, functionName }, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original), ranges = [];
  const inside = node => {
    if (ts.isThrowStatement(node) && (ts.isNewExpression(node.expression) || ts.isCallExpression(node.expression)) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Error' && node.expression.arguments?.[0]) {
      ranges.push([node.expression.arguments[0].getStart(parsed), node.expression.arguments[0].end]);
      return;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'description') {
      ranges.push([node.initializer.getStart(parsed), node.initializer.end]);
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'inputErrors' &&
        node.expression.name.text === 'push' && node.arguments[0]) {
      ranges.push([node.arguments[0].getStart(parsed), node.arguments[0].end]);
      return;
    }
    ts.forEachChild(node, inside);
  };
  const find = node => {
    if (functionName && ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) { inside(node.body); return; }
    if (className && ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) if (ts.isMethodDeclaration(member) && member.name.getText(parsed) === methodName && member.body) inside(member.body);
      return;
    }
    ts.forEachChild(node, find);
  };
  find(parsed);
  let result = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  return result;
}

/** Scan unmasked literal content using original syntax, including multiline templates. */
export function scanRawChineseLines(source, allow = () => false, file = 'source.ts', original = source) {
  const parsed = parseSource(file, original);
  const lines = source.split('\n'), found = new Set();
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(parsed), firstLine = parsed.getLineAndCharacterOfPosition(start).line;
      source.slice(start, node.end).split('\n').forEach((part, offset) => {
        const index = firstLine + offset, code = lines[index]?.replace(/\r$/, '') ?? '';
        if (/[\u4e00-\u9fff]/.test(part) && !allow(code)) found.add(index);
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...found].sort((a, b) => a - b).map(index => ({ line: index + 1, text: lines[index].trim() }));
}
