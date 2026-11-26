import { ErrorTip } from './ErrorTip';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '../../../shared/types';
import { useUiStore, useWorkspaceStore } from '../store';
import { useSessionNotes } from '../chatSurface/useSessionNotes';
import { TerminalView, type TerminalScanRequest } from './TerminalView';
import { ComposerEditable, type ComposerEditableHandle } from './ComposerEditable';
import { useComposerDraft } from './agentComposer/useComposerDraft';
import { useComposerImages } from './agentComposer/useComposerImages';
import { useComposerInsertions } from './agentComposer/useComposerInsertions';
import { useComposerSlashMenu } from './agentComposer/useComposerSlashMenu';
import { useComposerCommands } from './agentComposer/useComposerCommands';
import { useComposerSubmit } from './agentComposer/useComposerSubmit';
import { useComposerMenus } from './agentComposer/useComposerMenus';
import { useQuickInputPhrases } from './agentComposer/useQuickInputPhrases';
import type { MenuKind } from './agentComposer/composerHelpers';
import { ComposerTriggerMenu } from './agentComposer/ComposerTriggerMenu';
import { ComposerQuickInputPanel } from './agentComposer/ComposerQuickInputPanel';
import { ComposerAttachBar, ComposerCommandChip } from './agentComposer/ComposerAttachBar';
import { ComposerToolbarLeft } from './agentComposer/ComposerToolbarLeft';
import { removeQuickPhrase } from '../../../shared/composerTools';
import { composerFileReference, composerSkillReference } from '../../../shared/noteAnnotations';
import type { ChatImageAttachment } from '../../../shared/types';
import { setLastFocusedDraftBucket } from './agentComposer/focusBucket';
import { ComposerSendButtons } from './agentComposer/ComposerSendButtons';
import { ComposerReplySuggestions } from './agentComposer/ComposerReplySuggestions';
import { useReplySuggestions } from './agentComposer/useReplySuggestions';
import { IconExpand, IconLocate, IconShrink } from './icons';
import { NoteEditor } from './NoteEditor';
import { MOTION, usePresence, usePresenceValue } from './motion';
import { useCliComposerPlacement } from './useCliComposerPlacement';
import { FloatingCapsuleDragHandle } from './FloatingCapsuleDragHandle';
import { useCliTerminalHold } from './useCliTerminalHold';
import { SessionReminders } from './SessionReminders';
import { useComposerModelMention } from './agentComposer/useComposerModelMention';
import { WorkerTargetDialog } from './workerRouting/WorkerTargetDialog';
import { workerRoutingScopeForSession } from './workerRouting/workerRoutingScope';
import { isWebGateway } from '../webGatewayEnvironment';

interface Props {
  session: SessionMeta;
  visible: boolean;
  style?: React.CSSProperties;
  skillTarget?: string;
}

const COLLAPSE_KEY = 'muster.cli-composer-collapsed:';
const TERMINAL_NOTE = 'cli-terminal-selection';

/** 图标槽保持挂载，状态切换时由同一个槽从放大状态快速回弹。 */
function ComposerToggleGlyph({ open, charging }: { open: boolean; charging: boolean }): React.JSX.Element {
  return <span className={`cli-composer-state-icon${charging ? ' is-charging' : ''}`} data-state={open ? 'shrink' : 'expand'}>
    {open ? <IconShrink /> : <IconExpand className="cli-composer-expand-icon" />}
  </span>;
}

/** CLI 保持完整终端尺寸；工作台输入区由可拖动贴边胶囊展开。 */
export function CliSessionView({ session, visible, style, skillTarget }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip, requestOpenWorkspaceFile } = useUiStore();
  const { workspaces } = useWorkspaceStore();
  const viewRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<ComposerEditableHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popupHostRef = useRef<HTMLDivElement>(null);
  const reminderPopupHostRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scanRequestRef = useRef<TerminalScanRequest | null>(null);
  const captureDepthRef = useRef(0);
  const draftKey = `cli-session:${session.id}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY + session.id) === '0'; } catch { return false; }
  });
  const openRef = useRef(open);
  openRef.current = open;
  const activeTerminalNote = useRef(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const [scanActive, setScanActive] = useState(false);
  const [error, setError] = useState('');
  const notes = useSessionNotes({ sessionId: session.id, draftKey, persistDraftNotes: true,
    getMessageRole: () => undefined, viewRef, flashTip, requestOpenWorkspaceFile });
  const draft = useComposerDraft({ draftBucket: draftKey, editableRef, onValueChange: text => {
    setDraftEmpty(text.length === 0);
    notes.onValueChange(text);
    modelMention.onDraftChange(text);
  } });

  const setComposerOpen = useCallback((next: boolean): void => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpen(next);
    try { localStorage.setItem(COLLAPSE_KEY + session.id, next ? '0' : '1'); } catch { /* keep this view's state */ }
  }, [session.id]);
  const attachmentError = useCallback((message: string): void => {
    setError(message);
    setComposerOpen(true);
  }, [setComposerOpen]);
  const imgs = useComposerImages(t, draftKey, attachmentError, true);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [query, setQuery] = useState('');
  const [triggerStart, setTriggerStart] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const menus = useComposerMenus(undefined);
  const qip = useQuickInputPhrases({ value: draft.value, applyValue: draft.applyValue, setMenu, editableRef });
  const scope = session.runtime && session.launchKind !== 'shell'
    ? workerRoutingScopeForSession(workspaces.find(workspace => workspace.id === session.workspaceId), session) : undefined;
  const modelMention = useComposerModelMention({ scope: isWebGateway() ? undefined : scope, bucket: draftKey, editableRef, active: visible && open });
  const slash = useComposerSlashMenu({ workspaceId: session.workspaceId ?? null, menu, setMenu, query, setQuery,
    triggerStart, setTriggerStart, activeIdx, setActiveIdx, surfaceKind: 'gui-session', skillTarget: skillTarget ?? `runtime:${session.runtime ?? 'unknown'}`,
    cliInput: true, sessionId: session.id, editableRef, onOpenHarness: modelMention.available ? modelMention.open : undefined });
  const cmds = useComposerCommands({ menu, setMenu, slashItems: slash.slashItems, atItems: slash.atItems, activeIdx,
    replaceTrigger: slash.replaceTrigger, openHarness: () => slash.openHarness('trigger'),
    applyValue: draft.applyValue, enterCmdMode: qip.enterCmdMode,
    toggleModelMenu: menus.toggleModelMenu, onClear: async () => {},
    skillSelection: item => item.skillFilePath ? { type: 'skill', name: item.id.slice('skill:'.length),
      title: item.skillFilePath, serializedText: composerSkillReference(item.id.slice('skill:'.length), item.skillFilePath) } : null,
    fileSelection: file => {
      const path = file.absolutePath;
      if (!path) return null;
      return { type: 'file', path, label: `@${file.displayPath ?? file.path}`, serializedText: composerFileReference(path) };
    }
  });
  const openForInsert = useCallback(() => setComposerOpen(true), [setComposerOpen]);
  const inserts = useComposerInsertions({ allowImages: true, requireTarget: true, onTargetedInsert: openForInsert, draftBucket: draftKey,
    valueRef: draft.valueRef, applyValue: draft.applyValue, setValue: draft.setValue, setHasText: draft.setHasText,
    onValueChangeRef: draft.onValueChangeRef, cmdMode: qip.cmdMode, refreshMenuFromCaret: slash.refreshMenuFromCaret,
    editableRef, addImageFiles: imgs.addImageFiles, setImages: imgs.setImages, insertAtCaret: slash.insertAtCaret,
    setShowPlusMenu: menus.setShowPlusMenu, formatPathReferences: paths => paths.map(composerFileReference).join(' ') + ' ' });
  useEffect(() => {
    if (open && visible) return;
    setMenu(null);
    menus.setShowPlusMenu(false);
    if (qip.cmdMode) qip.exitCmdMode();
  }, [open, visible, qip.cmdMode, menus.setShowPlusMenu]);
  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      if (!openRef.current || !viewRef.current?.isConnected) return;
      const noteInput = viewRef.current.querySelector<HTMLTextAreaElement>('.cli-terminal-note .msg-note-bubble-input');
      if (activeTerminalNote.current && noteInput) noteInput.focus();
      else editableRef.current?.focus();
    });
  };
  const hold = useCliTerminalHold({ open, openRef, visible, onCommit: setComposerOpen, onOpenRelease: focusComposer,
    onError: error => flashTip(t('长按切换失败：{{error}}', { error: String(error) })) });
  const holdActive = hold.visual != null;
  const displayOpen = hold.visual && hold.visual.phase !== 'committed' ? !hold.visual.sourceOpen : open;
  const panelPresence = usePresence(displayOpen);
  const capsulePresence = usePresence(!displayOpen, MOTION.menuMs);
  const onPositionPersistenceError = useCallback(() => flashTip(t('胶囊位置无法保存，重新打开后可能恢复默认')), [flashTip, t]);
  const onSizePersistenceError = useCallback(() => flashTip(t('输入框大小无法保存，重新打开后可能恢复默认')), [flashTip, t]);
  const placement = useCliComposerPlacement({ sessionId: session.id, visible, open: displayOpen, viewRef, capsuleRef, dialogRef,
    onPersistenceError: onPositionPersistenceError, resizable: true, onResizePersistenceError: onSizePersistenceError });
  const toggle = (): void => {
    const next = !openRef.current;
    setComposerOpen(next);
    if (next) focusComposer();
  };
  const closeWithFocus = useCallback((): void => {
    setComposerOpen(false);
    requestAnimationFrame(() => { if (!openRef.current && viewRef.current?.isConnected) toggleRef.current?.focus(); });
  }, [setComposerOpen]);
  const onScanControl = useCallback((request: TerminalScanRequest | null): void => { scanRequestRef.current = request; }, []);
  const prepareScanCapture = useCallback((): (() => void) => {
    const view = viewRef.current;
    if (!view) return () => {};
    captureDepthRef.current += 1;
    view.classList.add('is-scan-capturing');
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      captureDepthRef.current = Math.max(0, captureDepthRef.current - 1);
      if (!captureDepthRef.current) view.classList.remove('is-scan-capturing');
    };
  }, []);
  const requestScan = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const request = scanRequestRef.current;
    if (!request) { flashTip(t('终端未就绪')); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    request({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    if (openRef.current) focusComposer();
  };
  const annotate = useCallback((selected: string): void => {
    setComposerOpen(true);
    setLastFocusedDraftBucket(draftKey);
    if (activeTerminalNote.current) {
      flashTip(t('请先保存或取消当前批注'));
      return;
    }
    setQuote(selected);
  }, [draftKey, flashTip, setComposerOpen, t]);
  const editingNote = notes.notes.find(n => n.id === notes.openNoteId && n.messageId === TERMINAL_NOTE);
  const noteValue = quote != null ? { quote, id: '', note: '' }
    : editingNote ? { quote: editingNote.quote, id: editingNote.id, note: editingNote.note } : null;
  activeTerminalNote.current = noteValue != null;
  const { presence: notePresence, value: noteSnapshot } = usePresenceValue(noteValue, MOTION.menuMs);
  const closeNote = useCallback((): void => { setQuote(null); notes.onOpenNote(null); }, [notes.onOpenNote]);
  const onScanEscape = useCallback((): boolean => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || !viewRef.current?.contains(target)) return false;
    if (target.closest('.cli-terminal-note')) { closeNote(); return true; }
    if (target.closest('.cli-composer-dialog')) { closeWithFocus(); return true; }
    return false;
  }, [closeNote, closeWithFocus]);

  const sendToCli = async (text: string, attachments?: ChatImageAttachment[]): Promise<boolean> => {
    setError('');
    if (!await modelMention.validate(text)) return false;
    try {
      const expanded = notes.expandForSend(text);
      const result = attachments?.length ? await window.api.pty.submitComposer(session.id, expanded, attachments)
        : await window.api.pty.submitComposer(session.id, expanded);
      if (!result.ok) {
        setError(result.error || t('发送失败'));
        setComposerOpen(true);
        return false;
      }
      if (result.warning) { setError(result.warning); setComposerOpen(true); }
      return true;
    } catch (err) {
      setError(String(err));
      setComposerOpen(true);
      return false;
    }
  };
  const send = useComposerSubmit({ cmdMode: qip.cmdMode, qipFiltered: qip.qipFiltered, qipActive: qip.qipActive,
    setQipActive: qip.setQipActive, insertPhrase: qip.insertPhrase, exitCmdMode: qip.exitCmdMode,
    valueRef: draft.valueRef, busy: false, clearing: imgs.loading || cmds.clearing, images: imgs.images, setImages: imgs.setImages,
    menu, setMenu, itemCount: slash.itemCount, activeIdx, setActiveIdx, applyValue: draft.applyValue,
    applyItem: cmds.applyItem, openHarness: () => slash.openHarness('draft'), runClear: cmds.runClear, runCompact: cmds.runCompact, toggleModelMenu: menus.toggleModelMenu,
    enterCmdMode: qip.enterCmdMode, onSend: sendToCli, tosend: [], addTosend: () => {},
    nativeSlashCommands: true, preserveWhitespace: true });
  const [selection, setSelection] = useState<{ messageId: string; index: number } | null>(null);
  const replyState = useReplySuggestions(draftKey, session.cliSuggestedReplies, snapshot => window.api.suggestions.clear({
    kind: 'cli', targetId: session.id, messageId: snapshot.messageId, replies: snapshot.replies
  }), message => { setError(message); setComposerOpen(true); });
  const visibleReplies = draftEmpty && !send.submitting && !imgs.images.length && !imgs.loading && !qip.cmdMode
    ? replyState.visible : null;
  const { presence: replyPresence, value: replySnapshot } = usePresenceValue(visibleReplies);
  const { presence: triggerPresence, value: triggerSnapshot } = usePresenceValue(menu, MOTION.menuMs);
  const replyIndex = replySnapshot && selection?.messageId === replySnapshot.messageId
    ? Math.min(selection.index, replySnapshot.replies.length - 1) : 0;
  const ghost = visibleReplies?.replies[replyIndex];

  return <div ref={viewRef} className={`cli-session-view xfade xfade-instant${visible ? ' is-shown' : ''}${holdActive ? ' is-holding-terminal' : ''}`}
    data-hold-phase={hold.visual?.phase} data-hold-step={hold.visual?.chargeStep} style={style}
    onFocusCapture={() => setLastFocusedDraftBucket(draftKey)}>
    <div className="cli-terminal-surface">
      <TerminalView sessionId={session.id} workspaceId={session.workspaceId} visible={visible} cwd={session.cwd}
        onAnnotateSelection={annotate} onBlankPointerDown={hold.onBlankPointerDown}
        onScanControl={onScanControl} onScanStateChange={setScanActive} onScanEscape={onScanEscape}
        prepareScanCapture={prepareScanCapture}/>
    </div>
    <div ref={dialogRef} className="cli-composer-dialog mp-panel" style={placement.dialogStyle}
      data-mp-stage={displayOpen ? panelPresence.stage : 'out'} role="dialog" aria-label={t('输入框')}
      data-morph-active={displayOpen || panelPresence.mounted ? 'true' : 'false'}
      aria-hidden={!displayOpen || holdActive} {...(!displayOpen || holdActive ? { inert: '' } : {})}>
        <div className="cli-composer-charge-surface cli-composer-panel-charge">
          {(['left', 'right'] as const).map(edge => {
            const label = edge === 'left' ? t('拖动左侧边缘调整宽度（左右方向键微调）') : t('拖动右侧边缘调整宽度（左右方向键微调）');
            return <button key={edge} type="button" className={`cli-composer-resize is-${edge}`} aria-label={label} title={label}
              onPointerDown={event => placement.onResizePointerDown(event, edge)}
              onPointerMove={placement.onResizePointerMove} onPointerUp={placement.onResizePointerUp}
              onPointerCancel={placement.onResizePointerCancel} onLostPointerCapture={placement.onResizeLostPointerCapture}
              onKeyDown={event => placement.onResizeKeyDown(event, edge)}/>;
          })}
          <div className="agent-composer cli-composer" ref={qip.composerRef} onDragOver={inserts.onDragOver} onDrop={inserts.onDrop}>
            <div className="chat-input-row"><div className="chat-input-shell">
              <div className="composer-actions-header">
                {replyPresence.mounted && replySnapshot ? <div className={`acc${replyPresence.stage === 'in' ? ' is-open' : ''}`}
                  aria-hidden={replyPresence.stage === 'out'} {...(replyPresence.stage === 'out' ? { inert: '' } : {})}>
                  <div className="acc-body"><ComposerReplySuggestions suggestions={replySnapshot} selectedIndex={replyIndex}
                    clearing={replyState.clearing} onSelect={index => {
                      setSelection({ messageId: replySnapshot.messageId, index }); editableRef.current?.focus();
                    }} onClear={() => { editableRef.current?.focus(); setError(''); void replyState.clear(replySnapshot); }}/></div>
                </div> : null}
                <ComposerCommandChip cmdMode={qip.cmdMode} onExitCmdMode={() => qip.exitCmdMode()}/>
              </div>
              <ComposerAttachBar allowImages images={imgs.images} onRemoveImage={imgs.removeImage}
                fileInputRef={fileInputRef} onPickFiles={imgs.addImageFiles}/>
              <div className="composer-ta-wrap">
                <ComposerEditable ref={editableRef} value={draft.value} noteTokens={notes.tokens} disabled={send.submitting}
                  placeholder={qip.cmdMode ? t('输入即搜索，↑↓ 选择，Enter 插入') : t('输入内容，Enter 发送到 CLI')}
                  onChange={inserts.onEditorChange} onCaretMove={inserts.onEditorCaretMove}
                  onFocus={() => setLastFocusedDraftBucket(draftKey)}
                  onPasteFiles={imgs.addImageFiles} onPasteNativeFiles={imgs.pasteNativeFiles}
                  onNoteTokenClick={notes.onTokenClick} onNoteTokenDelete={notes.onTokenDelete}
                  onModelTokenClick={modelMention.open}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing) return;
                    send.onKeyDown(event);
                    if (event.defaultPrevented) return;
                    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
                      event.preventDefault(); event.stopPropagation(); closeWithFocus(); return;
                    }
                    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey ||
                        draft.valueRef.current !== '' || send.submitting || !visibleReplies) return;
                    if (event.shiftKey) {
                      if (visibleReplies.replies.length < 2) return;
                      event.preventDefault();
                      if (!event.repeat) setSelection(previous => {
                        const index = previous?.messageId === visibleReplies.messageId
                          ? Math.min(previous.index, visibleReplies.replies.length - 1) : 0;
                        return { messageId: visibleReplies.messageId, index: (index + 1) % visibleReplies.replies.length };
                      });
                    } else if (!event.repeat && ghost) {
                      event.preventDefault(); editableRef.current?.insertText(ghost);
                    }
                  }}/>
                {ghost ? <div className="composer-ghost-suggestion" aria-hidden="true">{ghost}</div> : null}
              </div>
              {modelMention.error ? <ErrorTip message={modelMention.error} /> : null}
              <div className="agent-composer-toolbar">
                <div className="agent-composer-tb-left">
                  <ComposerToolbarLeft plusMenu allowImages showPlusMenu={menus.showPlusMenu}
                    setShowPlusMenu={menus.setShowPlusMenu} plusMenuPresence={menus.plusMenuPresence}
                    plusMenuRef={menus.plusMenuRef} plusPopupRef={menus.plusPopupRef} plusPopupHost={popupHostRef.current}
                    insertTriggerChar={inserts.insertTriggerChar} fileInputRef={fileInputRef}
                    mode="default" modeLabel={() => ''} showModeMenu={menus.showModeMenu} setShowModeMenu={menus.setShowModeMenu}
                    modeMenuPresence={menus.modeMenuPresence} modeMenuRef={menus.modeMenuRef}
                    presetRoster={menus.presetRoster} presetName=""/>
                  <SessionReminders kind="session" id={session.id} visible={visible && displayOpen && !holdActive}
                    popupHostRef={reminderPopupHostRef}/>
                  {imgs.loading ? <span role="status">{t('正在读取附件…')}</span> : null}
                  {imgs.images.length ? <span className="cli-composer-attachment-hint" title={t('附件将以文件路径提供给 CLI，请确保它有读取权限')}>{t('附件以路径发送')}</span> : null}
                  {error ? <ErrorTip message={error} /> : null}
                </div>
                <div className="cli-composer-actions">
                  <button type="button" className="cli-composer-close" aria-pressed={scanActive}
                    title={scanActive ? t('关闭识屏') : t('识屏')} aria-label={scanActive ? t('关闭识屏') : t('识屏')}
                    onClick={requestScan}><IconLocate /></button>
                  <button type="button" className="cli-composer-close" title={t('收起输入框（Esc）')}
                    aria-label={t('收起输入框')} onClick={closeWithFocus}>
                    <ComposerToggleGlyph open={open} charging={hold.visual?.phase === 'charging'}/></button>
                  <FloatingCapsuleDragHandle label={t('拖动输入框')} handlers={placement}/>
                  <ComposerSendButtons busy={false} submitting={send.submitting} inputLocked={send.submitting || imgs.loading}
                    hasText={draft.hasText} imagesCount={imgs.images.length} onSubmit={() => void send.submit()}/>
                </div>
              </div>
            </div></div>
          </div>
        </div>
    </div>
    <div ref={capsuleRef} className={`cli-composer-capsule${placement.dragging ? ' is-dragging' : ''}`} style={placement.capsuleStyle}>
      <div className="cli-composer-charge-surface cli-composer-capsule-charge">
      <div className="cli-composer-capsule-shell mp-pop"
        data-mp-stage={displayOpen ? 'out' : capsulePresence.stage}
        data-morph-active={displayOpen || panelPresence.mounted ? 'true' : 'false'} aria-hidden={displayOpen || holdActive}
        {...(displayOpen || holdActive ? { inert: '' } : {})}>
        <button ref={toggleRef} type="button" className={`cli-composer-toggle${!open && !holdActive && replyState.visible?.replies.length ? ' has-suggestions' : ''}`}
          aria-expanded={open} title={t('展开输入框')} aria-label={t('展开输入框')} onClick={toggle}>
          <ComposerToggleGlyph open={open} charging={hold.visual?.phase === 'charging'}/>
        </button>
        <button type="button" className="cli-composer-scan" aria-pressed={scanActive}
          title={scanActive ? t('关闭识屏') : t('识屏')} aria-label={scanActive ? t('关闭识屏') : t('识屏')}
          onClick={requestScan}><IconLocate /></button>
        <FloatingCapsuleDragHandle label={t('拖动输入框')} handlers={placement}/>
      </div>
      </div>
    </div>
    <div ref={reminderPopupHostRef} className={`cli-composer-popover cli-reminder-popover${placement.reminderPopupBelow ? ' is-below' : ''}`} style={placement.reminderPopupStyle}
      aria-hidden={!displayOpen || holdActive || !visible} {...(!displayOpen || holdActive || !visible ? { inert: '' } : {})}/>
    <div ref={popupHostRef} className={`cli-composer-popover${placement.popupBelow ? ' is-below' : ''}`} style={placement.popupStyle}
      aria-hidden={!displayOpen || holdActive || !visible} {...(!displayOpen || holdActive || !visible ? { inert: '' } : {})}>
      {triggerPresence.mounted && triggerSnapshot ? <ComposerTriggerMenu menu={triggerSnapshot} slashItems={slash.slashItems}
        atItems={slash.atItems} activeIdx={activeIdx} menuRef={slash.menuRef} workspaceId={session.workspaceId ?? null}
        onHover={setActiveIdx} onApply={index => void cmds.applyItem(index)} presence={triggerPresence}/> : null}
      <ComposerQuickInputPanel presence={qip.qipPresence} qipRef={qip.qipRef} qipEdit={qip.qipEdit}
        setQipEdit={qip.setQipEdit} qipFiltered={qip.qipFiltered} phrasesCount={qip.phrases.length}
        qipActive={qip.qipActive} setActive={qip.setQipActive} qipKeyRef={qip.qipKeyRef} qipValueRef={qip.qipValueRef}
        onKeyDown={qip.onQipKeyDown} onInsert={qip.insertPhrase} onSave={qip.savePhrase}
        onDelete={id => qip.setPhrases(previous => removeQuickPhrase(previous, id))}/>
    </div>
    <WorkerTargetDialog mention request={modelMention.request} onClose={modelMention.close} onSelect={modelMention.apply} />
    {notePresence.mounted && noteSnapshot ? <div className="msg-note-bubble mp-pop cli-terminal-note" {...notePresence.spread}
      data-mp-stage={displayOpen ? notePresence.stage : 'out'} aria-hidden={!displayOpen || holdActive || notePresence.stage === 'out'}
      {...(!displayOpen || holdActive || notePresence.stage === 'out' ? { inert: '' } : {})}>
      <NoteEditor key={noteSnapshot.id || noteSnapshot.quote} initial={noteSnapshot.note} edit={!!noteSnapshot.id}
        source={<span>{noteSnapshot.quote}</span>} onCancel={closeNote}
        onSave={value => { if (noteSnapshot.id) notes.onNoteUpdate(noteSnapshot.id, value); else notes.addTerminalNote?.(noteSnapshot.quote, value); closeNote(); }}
        onDelete={noteSnapshot.id ? () => { notes.onNoteDelete(noteSnapshot.id); closeNote(); } : undefined}/>
    </div> : null}
  </div>;
}
