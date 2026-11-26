import { leadingComposerSkill } from '../../../shared/composerSkills';
import React, { useEffect, useImperativeHandle, useRef } from 'react';
import {
  noteTokenDomMatches,
  tokenizeComposerText,
  type NoteTokenRef
} from '../../../shared/composerTokens';
import { dataTransferHasPaths } from '../../../shared/fileDropPaths';
import { isWebGateway } from '../webGatewayEnvironment';
import { workerModelMentions } from '../../../shared/workerModelMention';
import { serializeComposerDom as serialize, composerOffsetOfPosition as offsetOfPosition, resolveComposerPosition as resolvePosition } from './composerDomText';
import { composerLineFormats, composerNewlineEdit } from './composerMarkdown';
import { formatComposerMarkdown, readComposerSelection, restoreComposerSelection, replaceComposerSourceRange, type ComposerSelection } from './composerMarkdownDom';

/**
 * contenteditable 输入核（替代 textarea+镜像层）：token（批注/文件/技能）是
 * contenteditable=false 的原子 span——backspace 整删、光标自动跳过、真 hover/真按钮。
 *
 * 同步回路：emittedRef 记上次序列化产物；value prop ≠ emitted 才重建 DOM（外部写入），
 * 用户输入走 input → 序列化 → onChange，value 回流后与 emitted 相等不再重建，光标不跳。
 * caret offset 度量 / 序列化 / caret 解析共用同一套 walk 规则：文本节点计其文本、
 * [data-token] 计 data-token 且不下钻（× 按钮文本不计）、br 与原生行块计换行。
 * 不用 Range.toString()（会吞 × 破坏一致性）。
 *
 * 发送契约不变：序列化产物仍是「批注N / @path / /skill:name」纯文本
 * （设计与取舍见 docs/plans/implemented/composer-contenteditable-plan.md）。
 */

/** token 节点规格：file=@path、skill=/skill:name（批注 token 由文本回灌经 tokenizer 生成） */
export interface FileTokenSpec {
  type: 'file';
  path: string;
  label?: string;
  serializedText?: string;
}

export interface SkillTokenSpec {
  type: 'skill';
  name: string;
  serializedText?: string;
  title?: string;
}

export type InsertTokenSpec = FileTokenSpec | SkillTokenSpec | {
  type: 'model';
  label: string;
  serializedText: string;
  appendSpace?: boolean;
};

/** token 的序列化文本（与旧纯文本契约逐字符一致） */
export function tokenText(spec: InsertTokenSpec): string {
  if (spec.type === 'model') return spec.serializedText;
  return spec.serializedText ?? (spec.type === 'file' ? `@${spec.path}` : `/skill:${spec.name}`);
}

export interface ComposerEditableHandle {
  focus(): void;
  getText(): string;
  getCaret(): number;
  setCaret(offset: number): void;
  /** 外部写入整段文本（不经 value prop；按键不回写 state 后 applyValue 仍能清空/替换） */
  setText(text: string): void;
  /** 光标处插纯文本（保留输入核的撤销历史） */
  insertText(text: string): void;
  /** 光标处插原子 token，后补一个空格（保持 `@path ` 契约形态） */
  insertToken(spec: InsertTokenSpec): void;
  /** 删除序列化文本的 [start,end) 并原地放 replacement（文本或 token），光标落其后 */
  replaceRange(start: number, end: number, replacement: string | InsertTokenSpec): void;
}

export type ComposerEditReplay = 'composition' | 'history';

interface Props {
  value: string;
  extensionSkillNames?: readonly string[];
  noteTokens?: ReadonlyArray<NoteTokenRef & { title?: string; label?: string }>;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  enterNewline?: boolean;
  onChange: (text: string, caret: number, replay?: ComposerEditReplay) => void;
  /** 光标移动（点击/方向键）：触发词菜单刷新 */
  onCaretMove?: (text: string, caret: number) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  /** 粘贴里的图片文件（纯文本粘贴不走这里，直接插入） */
  onPasteFiles?: (files: File[]) => void;
  onPasteNativeFiles?: (requireFiles?: boolean) => void;
  /** 批注药丸点击（跳回批注处） */
  onNoteTokenClick?: (id: string) => void;
  /** 批注药丸 × 快删（连批注记录一起摘） */
  onNoteTokenDelete?: (id: string) => void;
  onModelTokenClick?: (start: number, serializedText: string) => void;
}

// ── DOM walk 基元（纯函数）：offset 度量 / 序列化 / caret 解析共用 ──

function isTokenEl(node: Node): boolean {
  return node instanceof HTMLElement && node.hasAttribute('data-token');
}

function tokenSerialized(el: HTMLElement): string {
  return el.getAttribute('data-token') ?? '';
}

export const ComposerEditable = React.forwardRef<ComposerEditableHandle, Props>(
  function ComposerEditable(props, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const emittedRef = useRef<string | null>(null);
    const composingRef = useRef(false);
    const propsRef = useRef(props);
    propsRef.current = props;
    const noteTokensRef = useRef(props.noteTokens);
    noteTokensRef.current = props.noteTokens;
    // DOM formatting invalidates Chromium's native undo nodes. Keep source + atomic nodes
    // together in one bounded history, including the selection before each edit/IME commit.
    type Snapshot = { text: string; html: string; selection: ComposerSelection };
    const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[]; current?: Snapshot; before?: Snapshot; kind: string; lastKind: string; time: number }>({ past: [], future: [], kind: '', lastKind: '', time: 0 });

    function snapshot(): Snapshot {
      const root = rootRef.current!;
      return { text: serialize(root), html: root.innerHTML, selection: readComposerSelection(root) };
    }

    function beforeEdit(kind: string): void {
      historyRef.current.before = snapshot();
      historyRef.current.kind = kind;
    }

    function undo(redo = false): void {
      const root = rootRef.current;
      if (!root || composingRef.current) return;
      const history = historyRef.current;
      const from = redo ? history.future : history.past;
      const target = from.pop();
      if (!target) return;
      (redo ? history.past : history.future).push(snapshot());
      root.innerHTML = target.html;
      restoreComposerSelection(root, target.selection);
      history.current = target;
      history.before = undefined;
      history.lastKind = '';
      emit(false);
    }

    // ── caret 基元 ──

    function caretToOffset(): number {
      const root = rootRef.current;
      if (!root) return 0;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).startContainer)) {
        return serialize(root).length;
      }
      const r = sel.getRangeAt(0);
      return offsetOfPosition(root, r.startContainer, r.startOffset);
    }

    function applyCaret(offset: number): void {
      const root = rootRef.current;
      if (!root) return;
      const sel = window.getSelection();
      if (!sel) return;
      // 只在选区本就在 root 内（或 root 持焦）时动选区，别抢用户在别处的划词
      const inside =
        document.activeElement === root ||
        (sel.rangeCount > 0 && sel.anchorNode != null && root.contains(sel.anchorNode));
      if (!inside) return;
      const pos = resolvePosition(root, offset);
      const r = document.createRange();
      try {
        r.setStart(pos.node, pos.offset);
      } catch {
        return;
      }
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    function syncEmptyFlag(text: string): void {
      const root = rootRef.current;
      if (root) root.dataset.empty = text.length ? 'false' : 'true';
    }

    function syncNoteLabels(): void {
      for (const el of rootRef.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? []) {
        const spec = noteTokensRef.current?.find(n => n.id === el.dataset.noteId);
        if (!spec) continue;
        const label = el.querySelector('.composer-token-label');
        if (label) label.textContent = spec.label ?? spec.token;
        el.title = spec.title ?? spec.token;
      }
    }

    /** DOM 现状 → onChange（input 事件与命令式插入的统一出口） */
    function emit(recordHistory = true): void {
      const root = rootRef.current;
      if (!root) return;
      const text = serialize(root);
      if (!composingRef.current && text.length === 0 && root.childNodes.length > 0) {
        root.textContent = ''; // 清空后清残骸（<br> 等），placeholder 由 data-empty 驱动
      }
      if (!composingRef.current) {
        const history = historyRef.current;
        const previous = history.current;
        if (recordHistory && previous && text !== previous.text) {
          const before = history.before?.text === previous.text ? history.before : previous;
          const now = Date.now();
          const merge = history.kind === 'insertText' && history.lastKind === 'insertText' &&
            now - history.time < 750 && before.selection.anchor === before.selection.focus &&
            before.selection.focus === previous.selection.focus && text.split('\n').length === previous.text.split('\n').length;
          if (!merge) history.past.push(before);
          // Limit both count and DOM payload size for large pasted drafts.
          while (history.past.length > 100 || (history.past.length > 1 && history.past.reduce((n, s) => n + s.html.length, 0) > 1_000_000)) history.past.shift();
          history.future = [];
          history.lastKind = history.kind;
          history.time = now;
        }
        syncModelTokens(root, text);
        formatComposerMarkdown(root);
        syncNoteLabels();
        history.current = snapshot();
        history.before = undefined;
        history.kind = '';
      }
      syncEmptyFlag(text);
      emittedRef.current = text;
      // 用与序列化同源的偏移报告光标，格式化后的滚动仍跟随正文末尾。
      const caret = caretToOffset();
      if (composingRef.current) propsRef.current.onChange?.(text, caret, 'composition');
      else if (!recordHistory) propsRef.current.onChange?.(text, caret, 'history');
      else propsRef.current.onChange?.(text, caret);
      if (caret >= text.length) root.scrollTop = root.scrollHeight;
    }

    /** 命令式改动后兜底：DOM 与 emitted 漂移才补发（execCommand 自带 input 时不重发） */
    function ensureEmit(): void {
      const root = rootRef.current;
      if (!root) return;
      if (serialize(root) !== emittedRef.current) emit();
    }

    /** 在当前选区/光标处插文本；优先浏览器编辑命令，失败手动 DOM。 */
    function insertTextRaw(text: string): void {
      const root = rootRef.current;
      if (!root || !text) return;
      if (!historyRef.current.before) beforeEdit('insertFromPaste');
      if (document.activeElement !== root) {
        const at = Math.min(caretToOffset(), serialize(root).length);
        const p1 = resolvePosition(root, at);
        const node = document.createTextNode(text);
        const r = document.createRange();
        r.setStart(p1.node, p1.offset);
        r.collapse(true);
        r.insertNode(node);
        ensureEmit();
        return;
      }
      if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
        ensureEmit();
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      ensureEmit();
    }

    function buildTokenNode(cls: string, token: string, title: string, noteId?: string, label = token): HTMLElement {
      const el = document.createElement('span');
      el.className = `composer-token ${cls}`;
      el.setAttribute('data-token', token);
      el.setAttribute('contenteditable', 'false');
      el.title = title;
      if (noteId) {
        el.setAttribute('data-note-id', noteId);
        el.setAttribute('data-note-entry', '');
      }
      const labelEl = document.createElement('span');
      labelEl.className = 'composer-token-label';
      labelEl.textContent = label;
      if (cls === 'is-model') {
        labelEl.tabIndex = 0;
        labelEl.setAttribute('role', 'button');
      }
      el.appendChild(labelEl);
      const x = document.createElement('span');
      x.className = 'composer-token-x';
      x.setAttribute('aria-hidden', 'true');
      x.textContent = '×';
      el.appendChild(x);
      return el;
    }

    function syncModelTokens(root: HTMLDivElement, text: string): void {
      const mentions = workerModelMentions(text);
      if (!mentions.length) return;
      const existing = new Set(Array.from(root.querySelectorAll<HTMLElement>('.composer-token.is-model'),
        el => offsetOfPosition(root, el.parentNode!, Array.prototype.indexOf.call(el.parentNode!.childNodes, el))));
      if (mentions.every(item => existing.has(item.start))) return;
      const selection = readComposerSelection(root);
      for (const { start, end, mention } of mentions.reverse()) {
        if (existing.has(start)) continue;
        const from = resolvePosition(root, start), to = resolvePosition(root, end);
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        range.deleteContents();
        range.insertNode(buildTokenNode('is-model', text.slice(start, end), mention.label, undefined, mention.label));
      }
      restoreComposerSelection(root, selection);
    }

    /** 从纯文本重建整棵 DOM（外部写入：草稿/清空/快捷短语…） */
    function rebuild(text: string): void {
      const root = rootRef.current;
      if (!root) return;
      const prevCaret = caretToOffset();
      root.textContent = '';
      const tokens = noteTokensRef.current ?? [];
      const skill = leadingComposerSkill(text, propsRef.current.extensionSkillNames);
      if (skill) root.appendChild(buildTokenNode('is-skill', skill.token, skill.path ?? skill.token, undefined, `/skill:${skill.name}`));
      for (const seg of tokenizeComposerText(text.slice(skill?.token.length ?? 0), tokens)) {
        if (seg.kind === 'text') {
          root.appendChild(document.createTextNode(seg.text));
        } else {
          const spec = tokens.find((n) => n.id === seg.id);
          root.appendChild(buildTokenNode('is-note', seg.token, spec?.title ?? seg.token, seg.id, spec?.label));
        }
      }
      syncModelTokens(root, text);
      emittedRef.current = text;
      syncEmptyFlag(text);
      applyCaret(Math.min(prevCaret, text.length));
      formatComposerMarkdown(root);
      const history = historyRef.current;
      history.past = []; history.future = []; history.before = undefined; history.lastKind = '';
      history.current = snapshot();
    }

    /** 在选区 Range 处放 [token, 空格]，光标落空格后。
     *  不走 execCommand insertHTML：Chromium 会把光标留在 token 内部，补的空格会插进 token 里 */
    function placeTokenAtRange(r: Range, spec: InsertTokenSpec): void {
      beforeEdit('insertToken');
      const title = spec.type === 'file' ? spec.path : spec.type === 'model' ? spec.label : spec.title ?? `/skill:${spec.name}`;
      const node = buildTokenNode(`is-${spec.type}`, tokenText(spec), title, undefined,
        spec.type === 'file' ? spec.label ?? `@${spec.path}` : spec.type === 'model' ? spec.label : `/skill:${spec.name}`);
      r.deleteContents();
      r.insertNode(node);
      const space = document.createTextNode(' ');
      r.setStartAfter(node);
      r.collapse(true);
      if (spec.type !== 'model' || spec.appendSpace !== false) {
        r.insertNode(space);
        r.setStartAfter(space);
        r.collapse(true);
      }
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    function replaceSourceRange(start: number, end: number, text: string): void {
      const root = rootRef.current!;
      replaceComposerSourceRange(root, start, end, text);
      ensureEmit();
    }

    function insertNewline(): void {
      const root = rootRef.current!;
      const selection = readComposerSelection(root);
      beforeEdit('insertLineBreak');
      const edit = composerNewlineEdit(serialize(root), Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus));
      replaceSourceRange(edit.start, edit.end, edit.text);
    }

    function onEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
      const modelToken = (e.target as HTMLElement).closest<HTMLElement>('.composer-token.is-model');
      if (modelToken && !propsRef.current.disabled) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openModelToken(modelToken);
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          beforeEdit('deleteToken');
          const offset = modelTokenOffset(modelToken);
          modelToken.remove();
          rootRef.current?.focus();
          applyCaret(offset);
          emit();
          return;
        }
      }
      propsRef.current.onKeyDown?.(e);
      if (e.defaultPrevented || propsRef.current.disabled) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault(); undo(e.shiftKey || e.key.toLowerCase() === 'y'); return;
      }
      if (e.key === 'Enter' && (e.shiftKey || propsRef.current.enterNewline)) { e.preventDefault(); insertNewline(); return; }
      if (e.key === 'Home' && !e.altKey) {
        const root = rootRef.current!;
        const text = serialize(root), selection = readComposerSelection(root);
        const start = e.ctrlKey || e.metaKey ? 0 : text.lastIndexOf('\n', selection.focus - 1) + 1;
        const format = composerLineFormats(text)[text.slice(0, start).split('\n').length - 1];
        if (format) {
          e.preventDefault();
          const focus = start + format.prefix.length;
          restoreComposerSelection(root, { anchor: e.shiftKey ? selection.anchor : focus, focus });
        }
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const root = rootRef.current!;
        const text = serialize(root), selection = readComposerSelection(root);
        if (selection.anchor !== selection.focus) return;
        const start = text.lastIndexOf('\n', selection.focus - 1) + 1;
        const format = composerLineFormats(text)[text.slice(0, start).split('\n').length - 1];
        if (format && selection.focus === start + format.prefix.length) {
          e.preventDefault(); beforeEdit('deleteContentBackward'); replaceSourceRange(start, selection.focus, '');
        }
      }
    }

    function modelTokenOffset(el: HTMLElement): number {
      return offsetOfPosition(rootRef.current!, el.parentNode!, Array.prototype.indexOf.call(el.parentNode!.childNodes, el));
    }

    function openModelToken(el: HTMLElement): void {
      propsRef.current.onModelTokenClick?.(modelTokenOffset(el), tokenSerialized(el));
    }

    // ── 对外 handle（只经 refs 取状态，挂载后引用恒定） ──

    useImperativeHandle(
      ref,
      (): ComposerEditableHandle => ({
        focus: () => {
          const root = rootRef.current;
          if (!root) return;
          root.focus();
          const sel = window.getSelection();
          const hasCaret =
            sel && sel.rangeCount > 0 && sel.anchorNode != null && root.contains(sel.anchorNode);
          if (!hasCaret) applyCaret(serialize(root).length);
        },
        getText: () => serialize(rootRef.current),
        getCaret: () => caretToOffset(),
        setCaret: (offset: number) => applyCaret(offset),
        setText: (text: string) => rebuild(text),
        insertText: (text: string) => {
          const root = rootRef.current;
          if (!root || !text) return;
          const at = caretToOffset();
          root.focus();
          // focus 可能把光标重置到开头：先记住 offset，聚焦后显式归位再插（与 insertToken 同防护）
          if (document.activeElement === root) applyCaret(at);
          insertTextRaw(text);
        },
        insertToken: (spec: InsertTokenSpec) => {
          const root = rootRef.current;
          if (!root) return;
          const at = caretToOffset();
          root.focus();
          // focus 可能把光标重置到开头：先记住 offset，聚焦后显式归位再插
          if (document.activeElement === root) applyCaret(at);
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            placeTokenAtRange(sel.getRangeAt(0), spec);
            ensureEmit();
          }
        },
        replaceRange: (start: number, end: number, replacement: string | InsertTokenSpec) => {
          const root = rootRef.current;
          if (!root) return;
          root.focus();
          if (replacement === '') {
            beforeEdit('deleteContentBackward');
            replaceSourceRange(start, end, '');
            return;
          }
          const sel = window.getSelection();
          if (!sel) return;
          const p1 = resolvePosition(root, start);
          const p2 = resolvePosition(root, end);
          const r = document.createRange();
          try {
            r.setStart(p1.node, p1.offset);
            r.setEnd(p2.node, p2.offset);
          } catch {
            return;
          }
          sel.removeAllRanges();
          sel.addRange(r);
          if (typeof replacement === 'string') {
            insertTextRaw(replacement);
          } else {
            placeTokenAtRange(r, replacement);
          }
          ensureEmit();
        }
      }),
      []
    );

    // ── 外部 value 同步（≠ emitted 才重建；合成期挂起，compositionend 后由 emit 收口） ──

    useEffect(() => {
      if (emittedRef.current === null || (props.value !== emittedRef.current && !composingRef.current)) {
        rebuild(props.value);
      }
    }, [props.value]);
    const extensionNamesKey = JSON.stringify(props.extensionSkillNames ?? []);
    const lastNamesKey = useRef(extensionNamesKey);
    useEffect(() => {
      if (lastNamesKey.current !== extensionNamesKey && !composingRef.current && rootRef.current) rebuild(serialize(rootRef.current));
      lastNamesKey.current = extensionNamesKey;
    }, [extensionNamesKey]);

    // appendDraft 同步 setText 时 noteTokens 往往还是上一拍：最后一颗「批注N」落成纯文本，
    // 看起来像汇总条按钮却点不动。表到齐后再对账，不一致就按新表切药丸。
    useEffect(() => {
      if (emittedRef.current == null || composingRef.current) return;
      const root = rootRef.current;
      // 内容摘要变化时原地更新；不重建输入核、不移动光标，也不改序列化编号。
      syncNoteLabels();
      const live = root
        ? Array.from(root.querySelectorAll('[data-note-id]')).map(
            (el) => el.getAttribute('data-note-id') ?? ''
          )
        : [];
      if (noteTokenDomMatches(emittedRef.current, props.noteTokens ?? [], live)) return;
      rebuild(emittedRef.current);
    }, [props.noteTokens]);

    // ── 原生事件（React 对 beforeinput/composition 的合成支持不稳，走原生） ──

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;

      /** 删除波及 token（切进领地/边界子位）：扩为整颗删，吞掉部分删除 */
      const tokenDeleteGuard = (e: InputEvent): boolean => {
        if (typeof e.getTargetRanges !== 'function') return false;
        const victims = new Set<HTMLElement>();
        for (const sr of e.getTargetRanges()) {
          const probe = (container: Node, off: number): void => {
            if (container.nodeType === Node.ELEMENT_NODE) {
              const kid = (container as HTMLElement).childNodes[off];
              if (kid && isTokenEl(kid)) victims.add(kid as HTMLElement);
            }
            let n: Node | null = container;
            while (n && n !== root) {
              if (isTokenEl(n)) {
                victims.add(n as HTMLElement);
                break;
              }
              n = n.parentNode;
            }
          };
          probe(sr.startContainer, sr.startOffset);
          probe(sr.endContainer, sr.endOffset);
        }
        if (victims.size === 0) return false;
        e.preventDefault();
        victims.forEach((el) => el.remove());
        emit();
        return true;
      };

      const onInput = (): void => {
        emit();
      };
      const onBeforeInput = (e: Event): void => {
        const ie = e as InputEvent;
        if (composingRef.current) return;
        if (ie.inputType === 'historyUndo' || ie.inputType === 'historyRedo') {
          e.preventDefault(); undo(ie.inputType === 'historyRedo'); return;
        }
        if (!historyRef.current.before) beforeEdit(ie.inputType);
        if (ie.inputType === 'insertParagraph') {
          // Enter 全在 keydown 接管（发送/菜单）；阻止默认段落插入。
          e.preventDefault();
          return;
        }
        if (ie.inputType === 'insertLineBreak') {
          e.preventDefault();
          insertNewline();
          return;
        }
        if (ie.inputType === 'deleteContentBackward' || ie.inputType === 'deleteContentForward') {
          const domSelection = window.getSelection();
          if (domSelection && !domSelection.isCollapsed && domSelection.anchorNode && domSelection.focusNode &&
              root.contains(domSelection.anchorNode) && root.contains(domSelection.focusNode) && root.querySelector('[data-prefix]')) {
            const text = serialize(root), selected = readComposerSelection(root), first = resolvePosition(root, 0);
            const firstVisible = offsetOfPosition(root, first.node, first.offset);
            // A virtual Markdown prefix cannot be selected by Chromium. Treat a
            // selection of all visible content as selection of the whole source.
            if (Math.min(selected.anchor, selected.focus) <= firstVisible && Math.max(selected.anchor, selected.focus) >= text.length) {
              e.preventDefault();
              replaceSourceRange(0, text.length, '');
              return;
            }
          }
          if (tokenDeleteGuard(ie)) return;
        }
        // 原生文字/删除放行，input 事件跟进 emit；历史命令由输入核接管。
      };
      const onCompositionStart = (): void => {
        beforeEdit('composition');
        composingRef.current = true;
      };
      const onCompositionEnd = (): void => {
        composingRef.current = false;
        emit();
      };
      const onPaste = (e: ClipboardEvent): void => {
        e.preventDefault(); // 净化：外部 HTML 永不进 DOM
        const dt = e.clipboardData;
        if (!dt) return;
        const files: File[] = [];
        for (const item of Array.from(dt.items ?? [])) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length > 0 && propsRef.current.onPasteFiles) {
          propsRef.current.onPasteFiles(files);
          return;
        }
        const types = Array.from(dt.types ?? []).map(type => type.toLowerCase());
        const nativeFileType = types.some(type => ['files', 'public.file-url', 'nsfilenamespboardtype', 'cf_hdrop', 'filenamew'].includes(type));
        const uriList = types.includes('text/uri-list') ? dt.getData('text/uri-list') : '';
        const gnomeList = types.includes('x-special/gnome-copied-files') ? dt.getData('x-special/gnome-copied-files') : '';
        if (!isWebGateway() && propsRef.current.onPasteNativeFiles &&
            (nativeFileType || /(?:^|[\r\n])file:/i.test(uriList) || /(?:^|[\r\n])file:/i.test(gnomeList))) {
          propsRef.current.onPasteNativeFiles(true);
          return;
        }
        const text = dt.getData('text/plain');
        if (text) { beforeEdit('insertFromPaste'); insertTextRaw(text.replace(/\r\n?/g, '\n')); }
        else propsRef.current.onPasteNativeFiles?.();
      };
      const onCopy = (e: ClipboardEvent): void => {
        const sel = window.getSelection();
        if (!sel?.anchorNode || !sel.focusNode || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
        const selection = readComposerSelection(root);
        if (selection.anchor === selection.focus || !e.clipboardData) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', serialize(root).slice(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)));
        if (e.type === 'cut') {
          beforeEdit('deleteByCut');
          replaceSourceRange(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus), '');
        }
      };
      const onDrop = (e: DragEvent): void => {
        const dt = e.dataTransfer;
        if (!dt) return;
        if (dt.files && dt.files.length > 0) return; // 文件/路径拖放交给容器 onDrop
        if (dataTransferHasPaths(dt)) return; // 同上（文本形态的路径拖放）
        e.preventDefault();
        const text = dt.getData('text/plain');
        if (!text) return;
        let at = serialize(root).length;
        const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (pos && root.contains(pos.startContainer)) {
          at = offsetOfPosition(root, pos.startContainer, pos.startOffset);
        }
        applyCaret(at);
        insertTextRaw(text);
      };
      const reportCaret = (): void => {
        if (!composingRef.current) propsRef.current.onCaretMove?.(serialize(root), caretToOffset());
      };
      const onMouseDown = (e: MouseEvent): void => {
        const target = e.target as HTMLElement | null;
        const tokenEl = target?.closest?.('[data-token]') as HTMLElement | null;
        if (!tokenEl || !root.contains(tokenEl) || propsRef.current.disabled) return;
        e.preventDefault(); // 别抽走焦点（同旧镜像药丸）
        if (target!.closest('.composer-token-x')) {
          const noteId = tokenEl.getAttribute('data-note-id');
          if (noteId) {
            propsRef.current.onNoteTokenDelete?.(noteId);
          } else {
            beforeEdit('deleteToken');
            tokenEl.remove();
            emit();
          }
          return;
        }
        if (tokenEl.classList.contains('is-model')) {
          openModelToken(tokenEl);
          return;
        }
        const noteId =
          tokenEl.getAttribute('data-note-id') ??
          propsRef.current.noteTokens?.find((n) => n.token === tokenSerialized(tokenEl))?.id;
        if (noteId) propsRef.current.onNoteTokenClick?.(noteId);
      };

      root.addEventListener('input', onInput);
      root.addEventListener('beforeinput', onBeforeInput);
      root.addEventListener('compositionstart', onCompositionStart);
      root.addEventListener('compositionend', onCompositionEnd);
      root.addEventListener('paste', onPaste);
      root.addEventListener('copy', onCopy);
      root.addEventListener('cut', onCopy);
      root.addEventListener('drop', onDrop);
      root.addEventListener('keyup', reportCaret);
      root.addEventListener('click', reportCaret);
      root.addEventListener('mousedown', onMouseDown);
      return () => {
        root.removeEventListener('input', onInput);
        root.removeEventListener('beforeinput', onBeforeInput);
        root.removeEventListener('compositionstart', onCompositionStart);
        root.removeEventListener('compositionend', onCompositionEnd);
        root.removeEventListener('paste', onPaste);
        root.removeEventListener('copy', onCopy);
        root.removeEventListener('cut', onCopy);
        root.removeEventListener('drop', onDrop);
        root.removeEventListener('keyup', reportCaret);
        root.removeEventListener('click', reportCaret);
        root.removeEventListener('mousedown', onMouseDown);
      };
    }, []);

    return (
      <div
        ref={rootRef}
        className={`composer-editable${props.disabled ? ' is-disabled' : ''}`}
        contentEditable={!props.disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={props.ariaLabel}
        aria-placeholder={props.placeholder}
        aria-disabled={props.disabled || undefined}
        data-placeholder={props.placeholder}
        data-empty="true"
        onKeyDown={onEditorKeyDown}
        onFocus={() => propsRef.current.onFocus?.()}
      />
    );
  }
);
