import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { ResolvedAppearance } from '../../../shared/resolvedAppearance';

/**
 * CodeMirror 公共排版。颜色角色与其他宿主内容面相同；实际深浅 facet 和
 * concrete palette 由 workbenchAppearanceTheme 在独立 compartment 中实时更新。
 */
export const workbenchEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: 'var(--font-control)',
      backgroundColor: 'var(--surface-canvas)',
      color: 'var(--fg-primary)'
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.45'
    },
    '.cm-content': {
      caretColor: 'var(--fg-primary)',
      paddingBottom: '24px'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--fg-primary)'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--interaction-selected)'
    },
    '.cm-activeLine': {
      /* 选中行：叠白（design.md §8） */
      backgroundColor: 'var(--interaction-hover)'
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-canvas)',
      color: 'var(--fg-muted)',
      border: 'none',
      borderRight: '1px solid var(--border-subtle)',
      /* 行号/折叠标记恒等宽（prose 模式的比例字体不进 gutter，数字列宽稳定不跳） */
      fontFamily: 'var(--font-mono)'
    },
    /* 行号右对齐：个位数永远贴着代码，位数增长向左扩（编辑器惯例） */
    '.cm-lineNumbers .cm-gutterElement': {
      textAlign: 'right',
      paddingRight: '4px'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--interaction-hover)',
      color: 'var(--fg-primary)'
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--surface-raised)',
      border: '1px solid var(--border-subtle)',
      color: 'var(--raised-fg-secondary)'
    },
    '.cm-tooltip': {
      /* 浮层：L3 + shadow-pop + radius-card（design.md §7） */
      backgroundColor: 'var(--surface-overlay)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-card)',
      boxShadow: 'var(--shadow-pop)',
      color: 'var(--overlay-fg-primary)'
    }
  }
);

/** Reconfigure this extension in place; document, undo, cursor and scroll survive palette changes. */
export function workbenchAppearanceTheme(appearance: ResolvedAppearance): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    '&': { backgroundColor: appearance.cm.background, color: appearance.cm.foreground },
    '.cm-content': { caretColor: appearance.cm.cursor },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: appearance.cm.cursor },
    '.cm-gutters': { backgroundColor: appearance.cm.background, color: appearance.cm.gutter },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: appearance.cm.selection }
  }, { dark: appearance.cm.dark });
}

/**
 * 语法色：薄荷冷色系，与 base.css 的 --syn-* 一一对应
 * （design.md §1.4，内容色，永不进壳层）：
 *   fg #c9d1d9 = --syn-fg      muted #8b949e = --syn-muted
 *   blue #8ac6ff = --syn-blue  cyan #a5d8ff = --syn-cyan
 *   red #f88b9a = --syn-red    purple #c3b1ff = --syn-purple
 *   orange #ffb37d = --syn-orange
 */
const workbenchHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--syn-muted)', fontStyle: 'italic' },
  { tag: t.lineComment, color: 'var(--syn-muted)', fontStyle: 'italic' },
  { tag: t.blockComment, color: 'var(--syn-muted)', fontStyle: 'italic' },
  { tag: t.docComment, color: 'var(--syn-muted)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--syn-muted)' },
  { tag: t.keyword, color: 'var(--syn-red)' },
  { tag: t.controlKeyword, color: 'var(--syn-red)' },
  { tag: t.operatorKeyword, color: 'var(--syn-red)' },
  { tag: t.moduleKeyword, color: 'var(--syn-red)' },
  { tag: t.definitionKeyword, color: 'var(--syn-red)' },
  { tag: t.string, color: 'var(--syn-cyan)' },
  { tag: t.special(t.string), color: 'var(--syn-cyan)' },
  { tag: t.character, color: 'var(--syn-cyan)' },
  { tag: t.number, color: 'var(--syn-blue)' },
  { tag: t.bool, color: 'var(--syn-blue)' },
  { tag: t.null, color: 'var(--syn-blue)' },
  { tag: t.escape, color: 'var(--syn-blue)' },
  { tag: t.regexp, color: 'var(--syn-red)' },
  { tag: t.variableName, color: 'var(--syn-fg)' },
  { tag: t.definition(t.variableName), color: 'var(--syn-fg)' },
  { tag: t.function(t.variableName), color: 'var(--syn-purple)' },
  { tag: t.propertyName, color: 'var(--syn-blue)' },
  { tag: t.definition(t.propertyName), color: 'var(--syn-blue)' },
  { tag: t.className, color: 'var(--syn-orange)' },
  { tag: t.typeName, color: 'var(--syn-orange)' },
  { tag: t.namespace, color: 'var(--syn-orange)' },
  { tag: t.macroName, color: 'var(--syn-purple)' },
  { tag: t.labelName, color: 'var(--syn-orange)' },
  { tag: t.attributeName, color: 'var(--syn-blue)' },
  { tag: t.attributeValue, color: 'var(--syn-cyan)' },
  { tag: t.heading, color: 'var(--syn-blue)', fontWeight: '500' },
  { tag: t.heading1, color: 'var(--syn-blue)', fontWeight: '500' },
  { tag: t.heading2, color: 'var(--syn-blue)', fontWeight: '500' },
  { tag: t.url, color: 'var(--syn-cyan)' },
  { tag: t.link, color: 'var(--syn-cyan)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '500' },
  /* 行内代码/代码块在 Markdown 文档感模式（is-prose 比例字体）下仍保持等宽 */
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.operator, color: 'var(--syn-red)' },
  { tag: t.punctuation, color: 'var(--syn-fg)' },
  { tag: t.bracket, color: 'var(--syn-fg)' },
  { tag: t.angleBracket, color: 'var(--syn-fg)' },
  { tag: t.squareBracket, color: 'var(--syn-fg)' },
  { tag: t.paren, color: 'var(--syn-fg)' },
  { tag: t.invalid, color: 'var(--syn-red)' }
]);

export const workbenchSyntaxHighlighting = syntaxHighlighting(workbenchHighlight);
