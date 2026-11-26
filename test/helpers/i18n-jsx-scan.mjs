import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
const humanAttrs = new Set(['aria-label', 'aria-description', 'ariaLabel', 'title', 'placeholder', 'alt', 'label']);

/** Extract literal JSX text and human-facing attributes, preserving exact source locations. */
export function scanJsxChinese(source, file = 'source.tsx') {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const add = (node, text, kind) => {
    const value = text.trim().replace(/\s+/g, ' ');
    if (!/[\u4e00-\u9fff]/.test(value)) return;
    const index = node.getStart(parsed);
    found.push({ line: parsed.getLineAndCharacterOfPosition(index).line + 1, text: value, kind });
  };
  const literalBranches = (node, kind) => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node)) return literalBranches(node.expression, kind);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return add(node, node.text, kind);
    if (ts.isConditionalExpression(node)) {
      literalBranches(node.whenTrue, kind);
      literalBranches(node.whenFalse, kind);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      literalBranches(node.left, kind);
      literalBranches(node.right, kind);
    }
  };
  const visit = node => {
    if (ts.isJsxText(node)) add(node, node.text, 'text');
    if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) literalBranches(node.expression, 'text');
    if (ts.isJsxAttribute(node) && humanAttrs.has(node.name.getText(parsed)) && node.initializer) {
      literalBranches(ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer, 'attribute');
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}
