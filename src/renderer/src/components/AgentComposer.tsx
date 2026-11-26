import { composerFileReference, composerSkillReference } from '../../../shared/noteAnnotations';
import { leadingComposerSkill } from '../../../shared/composerSkills';
import { ErrorTip } from './ErrorTip';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuiWorkerMode } from '../../../shared/types';
import type { Props } from './agentComposer/composerTypes';
import {
  MODE_META,
  NO_QUEUED_ITEMS,
  deriveContextUsage,
  type MenuKind
} from './agentComposer/composerHelpers';
import { removeQuickPhrase } from '../../../shared/composerTools';
import { setLastFocusedDraftBucket } from './agentComposer/focusBucket';
import { useComposerImages } from './agentComposer/useComposerImages';
import { notifyComposerError } from './agentComposer/composerNotice';
import { useTosendQueue } from './agentComposer/useTosendQueue';
import { useComposerDraft } from './agentComposer/useComposerDraft';
import { useQuickInputPhrases } from './agentComposer/useQuickInputPhrases';
import { useComposerMenus } from './agentComposer/useComposerMenus';
import { useComposerSlashMenu } from './agentComposer/useComposerSlashMenu';
import { useComposerCommands } from './agentComposer/useComposerCommands';
import { useComposerSubmit } from './agentComposer/useComposerSubmit';
import { useComposerModelMention } from './agentComposer/useComposerModelMention';
import { WorkerTargetDialog } from './workerRouting/WorkerTargetDialog';
import { hasWorkerModelMentions, serializeWorkerModelMentions, summarizeWorkerModelMentions } from '../../../shared/workerModelMention';
import { useComposerInsertions } from './agentComposer/useComposerInsertions';
import { ComposerEditable, type ComposerEditableHandle } from './ComposerEditable';
import { QueueSendPanel } from './QueueSendPanel';
import { BgTasksArea } from '../agentChat/BgTasksArea';
import { WorkflowArea } from '../agentChat/WorkflowArea';
import { ComposerFlyout } from './agentComposer/ComposerFlyout';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { ComposerTriggerMenu } from './agentComposer/ComposerTriggerMenu';
import { ComposerQuickInputPanel } from './agentComposer/ComposerQuickInputPanel';
import { ComposerAttachBar, ComposerCommandChip } from './agentComposer/ComposerAttachBar';
import { ComposerDraftCapsules } from './agentComposer/ComposerDraftCapsules';
import { ComposerToolbarLeft } from './agentComposer/ComposerToolbarLeft';
import { ComposerContextUsage } from './agentComposer/ComposerContextUsage';
import { ComposerModelCluster } from './agentComposer/ComposerModelCluster';
import { ComposerThinkingChip } from './agentComposer/ComposerThinkingChip';
import { ComposerSendButtons } from './agentComposer/ComposerSendButtons';
import { SteerFallbackDialog } from './agentComposer/SteerFallbackDialog';
import { ComposerReplySuggestions } from './agentComposer/ComposerReplySuggestions';
import { useReplySuggestions } from './agentComposer/useReplySuggestions';
import { MOTION, usePresenceValue } from './motion';

/**
 * AgentComposer 编排壳：状态钩子装配 + 余量 JSX（对外导出与行为契约不变）。
 * 实现体按输入框职责区块拆在同目录 agentComposer/：composerTypes/composerHelpers
 * （类型与纯函数）+ 8 个状态钩子 + 8 个纯展示组件；详见 docs/features/composer-rich-input.md。
 */
export { getLastFocusedDraftBucket } from './agentComposer/focusBucket';
export type { ComposerPreset, ComposerPresetItem } from './agentComposer/composerTypes';

function AgentComposerInner({
  workspaceId, creation,
  workerRoutingScope,
  reminders,
  requestRecordingShortcut,
  nativeSettings,
  permissionConfiguration,
  busy,
  disabled,
  interactionActive = true,
  replySuggestions,
  pendingQuestion,
  onClearReplySuggestions,
  bgTasks,
  pendingInsert,
  onPendingInsertConsumed,
  queuedItems,
  onCancelQueued,
  onSendNow,
  onSendNowFallback,
  onEditQueued,
  onReorderQueued,
  onSend,
  getQueuedImages,
  onValueChange,
  prepareManualDraft,
  restoreManualDraft,
  onSendResolved,
  onSendNowResolved,
  noteTokens,
  onNoteTokenClick,
  onNoteTokenDelete,
  onStop,
  onClear,
  onCompact,
  onRecordRequests,
  onLocalCommand,
  mode = 'default',
  modeOrder,
  modeChipLabels,
  modeDescriptions,
  modeDisabled,
  modeSwitchLocked = false,
  modeSwitchLockedTitle,
  onModeChange,
  preset,
  draftKey,
  allowImages = true,
  plusMenu = false,
  extensionTask,
  extensionSkillNames,
  surfaceKind,
  harnessId,
  skillTarget,
  engineSlashCommands,
  chatStatus
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const draftBucket = creation ? null : draftKey ?? workspaceId;
  const inputPendingQuestion = !!pendingQuestion;
  const [menu, setMenu] = useState<MenuKind>(null);
  const [query, setQuery] = useState('');
  const [triggerStart, setTriggerStart] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const fallbackResolver = useRef<((result: 'sent' | 'failed') => void) | null>(null);
  const requestFallback = (text: string): Promise<'sent' | 'failed'> => new Promise(resolve => {
    fallbackResolver.current = resolve;
    setFallbackText(text);
  });
  const settleFallback = (result: 'sent' | 'failed'): void => {
    const resolve = fallbackResolver.current;
    fallbackResolver.current = null;
    setFallbackText(null);
    resolve?.(result);
  };
  React.useEffect(() => () => {
    const resolve = fallbackResolver.current;
    fallbackResolver.current = null;
    resolve?.('failed');
  }, []);
  const editableRef = useRef<ComposerEditableHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 输入框上方 hint 条已移除（2026-10-20 用户定稿）：失败/被拒提示改走桌面通知
  const imgs = useComposerImages(t, draftBucket, notifyComposerError, false, creation?.initialAttachments);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const draft = useComposerDraft({ draftBucket, initialText: creation?.initialText, editableRef, onValueChange: text => {
    setDraftEmpty(text.length === 0);
    onValueChange?.(text);
    modelMention.onDraftChange(text);
  } });
  const reportAttachments = creation?.onAttachments;
  React.useEffect(() => { reportAttachments?.(imgs.images, imgs.loading); }, [imgs.images, imgs.loading, reportAttachments]);
  const skillScope = JSON.stringify([creation?.rootId, skillTarget, creation?.skillFileReference]);
  const previousSkillScope = useRef(skillScope);
  React.useEffect(() => {
    if (creation && previousSkillScope.current !== skillScope) {
      const text = draft.valueRef.current;
      const skill = leadingComposerSkill(text, extensionSkillNames);
      if (skill && (skill.path || skill.token.startsWith('/skill:'))) draft.applyValue(text.slice(skill.token.length).replace(/^ /, ''));
    }
    previousSkillScope.current = skillScope;
  }, [skillScope]);
  const modelMention = useComposerModelMention({ scope: workerRoutingScope, bucket: draftBucket, editableRef, active: interactionActive && !disabled });
  const validateSend = (send: Props['onSend']): Props['onSend'] => (text, images) =>
    hasWorkerModelMentions(text) ? modelMention.validate(text).then(valid => valid && send(text, images)) : send(text, images);
  const sendDraft = validateSend(onSend);
  const sendQueued = validateSend(onSendResolved ?? onSend);
  const sendNow = onSendNowResolved ?? onSendNow;
  const fillDraft = (
    text: string,
    images?: Array<{ id: string; data: string; mimeType: string; name?: string; size?: number; url?: string }>
  ): void => {
    const current = draft.valueRef.current;
    draft.applyValue(current && text ? `${current}\n${text}` : current || text || '');
    const nextImgs = (images ?? []).map((im) => ({
      ...im,
      id: im.id || `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      data: im.data,
      mimeType: im.mimeType,
      ...(im.name ? { name: im.name } : {}),
      ...(typeof im.size === 'number' ? { size: im.size } : {}),
      url: im.url || `data:${im.mimeType};base64,${im.data}`
    }));
    imgs.setImages(previous => [...previous, ...nextImgs.filter(image => !previous.some(old => old.id === image.id))]);
  };
  const queue = useTosendQueue({
    draftBucket, enabled: !creation,
    editableRef,
    onSendNow: sendNow ? text => hasWorkerModelMentions(text)
      ? modelMention.validate(text).then(valid => valid ? sendNow(text) : 'failed')
      : sendNow(text) : undefined,
    onSendNowFallback: onSendNowFallback ? requestFallback : undefined,
    onCancelQueued,
    onEditQueued,
    onReorderQueued,
    onSend: sendQueued,
    getQueuedImages,
    prepareManualDraft,
    restoreManualDraft,
    onFillDraft: fillDraft
  });
  const qip = useQuickInputPhrases({
    value: draft.value,
    applyValue: draft.applyValue,
    setMenu,
    editableRef
  });
  // Pi custom mode is a launch-time choice for GUI Worker sessions. The session
  // still keeps the persisted preset in its surface snapshot, but the live
  // composer must not offer a control that cannot be changed after launch.
  const composerPreset = surfaceKind === 'gui-session' ? undefined : preset;
  const separatePreset = surfaceKind === 'gui-session' && !!composerPreset;
  const menus = useComposerMenus(composerPreset, separatePreset);
  const previousModelMenuBucket = useRef(draftBucket);
  React.useLayoutEffect(() => {
    if (!interactionActive || previousModelMenuBucket.current !== draftBucket) menus.setShowModelMenu(false);
    previousModelMenuBucket.current = draftBucket;
  }, [interactionActive, draftBucket, menus.setShowModelMenu]);
  const slash = useComposerSlashMenu({
    workspaceId,
    menu,
    setMenu,
    query,
    setQuery,
    triggerStart,
    setTriggerStart,
    activeIdx,
    setActiveIdx,
    surfaceKind,
    skillTarget, rootId: creation?.rootId, cliInput: !!creation, extensionSkills: creation ? extensionSkillNames : undefined,
    engineSlashCommands,
    onCompact,
    requestRecordingAvailable: !!onRecordRequests,
    editableRef,
    onOpenHarness: modelMention.available ? modelMention.open : undefined
  });
  const cmds = useComposerCommands({
    menu,
    setMenu,
    slashItems: slash.slashItems,
    atItems: slash.atItems,
    activeIdx,
    replaceTrigger: slash.replaceTrigger,
    skillSelection: creation?.skillFileReference ? item => item.skillFilePath ? {
      type: 'skill', name: item.id.slice(6), title: item.skillFilePath,
      serializedText: composerSkillReference(item.id.slice(6), item.skillFilePath)
    } : null : undefined,
    fileSelection: creation?.cli ? file => file.absolutePath ? { type: 'file', path: file.absolutePath,
      label: '@' + (file.displayPath ?? file.path), serializedText: composerFileReference(file.absolutePath) } : null : undefined,
    openHarness: () => slash.openHarness('trigger'),
    applyValue: draft.applyValue,
    enterCmdMode: qip.enterCmdMode,
    toggleModelMenu: menus.toggleModelMenu,
    onClear,
    onCompact,
    onRecordRequests,
    onLocalCommand,
    onStop
  });
  const send = useComposerSubmit({
    cmdMode: qip.cmdMode,
    qipFiltered: qip.qipFiltered,
    qipActive: qip.qipActive,
    setQipActive: qip.setQipActive,
    insertPhrase: qip.insertPhrase,
    exitCmdMode: qip.exitCmdMode,
    valueRef: draft.valueRef,
    busy,
    disabled,
    clearing: cmds.clearing || imgs.loading, creation, nativeSlashCommands: !!creation,
    images: imgs.images,
    setImages: imgs.setImages,
    menu,
    setMenu,
    itemCount: slash.itemCount,
    activeIdx,
    setActiveIdx,
    applyValue: draft.applyValue,
    applyItem: cmds.applyItem,
    openHarness: () => slash.openHarness('draft'),
    runClear: cmds.runClear,
    runCompact: cmds.runCompact,
    toggleModelMenu: menus.toggleModelMenu,
    enterCmdMode: qip.enterCmdMode,
    onCompact,
    onRecordRequests,
    onSend: sendDraft,
    onStop,
    onLocalCommand,
    tosend: queue.tosend,
    addTosend: queue.addTosend,
    extensionTask,
    workflowCommands: surfaceKind === 'dispatch',
    pendingQuestion: inputPendingQuestion
  });
  const inserts = useComposerInsertions({
    allowImages,
    disabled,
    requireTarget: !!creation, formatPathReferences: creation?.cli ? paths => paths.map(composerFileReference).join(' ') + ' ' : undefined,
    pendingInsert,
    onPendingInsertConsumed,
    draftBucket,
    valueRef: draft.valueRef,
    applyValue: draft.applyValue,
    setValue: draft.setValue,
    setHasText: draft.setHasText,
    onValueChangeRef: draft.onValueChangeRef,
    cmdMode: qip.cmdMode,
    refreshMenuFromCaret: slash.refreshMenuFromCaret,
    editableRef,
    addImageFiles: imgs.addImageFiles,
    setImages: imgs.setImages,
    insertAtCaret: slash.insertAtCaret,
    setShowPlusMenu: menus.setShowPlusMenu
  });

  const inputLocked = !!disabled || cmds.clearing;
  const [replySelection, setReplySelection] = useState<{ messageId: string; index: number } | null>(null);
  const replyState = useReplySuggestions(draftBucket ?? '', replySuggestions, onClearReplySuggestions, notifyComposerError);
  const visibleReplies = draftEmpty && imgs.images.length === 0 && !imgs.loading && !cmds.clearing && !qip.cmdMode ? replyState.visible : null;
  const { presence: replyPresence, value: replySnapshot } = usePresenceValue(visibleReplies);
  const replyIndex = replySnapshot && replySelection?.messageId === replySnapshot.messageId
    ? Math.min(replySelection.index, replySnapshot.replies.length - 1) : 0;
  const ghostReply = visibleReplies?.replies[replyIndex];

  // 状态条数据面（ChatSurfaceView 装配；缺数据时无模型按钮）
  const statusModel = (chatStatus?.modelLabel ?? '').trim();
  const modeLabel = (m: GuiWorkerMode): string =>
    modeChipLabels?.[m] ? t(modeChipLabels[m]!) : MODE_META[m].label;
  const usage = chatStatus ? deriveContextUsage(chatStatus.usage, statusModel, t) : null;
  const statusTitle = chatStatus ? chatStatus.title ?? usage?.label : undefined;
  const rawUsage = chatStatus?.usage ?? null;
  const presetName = composerPreset
    ? (menus.presetRoster?.find((p) => p.id === composerPreset.id)?.name ?? composerPreset.id)
    : '';

  const anchorName = '--task-editor-' + React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const flyoutAnchor = creation ? { ref: qip.composerRef, name: anchorName } : undefined;
  const trigger = usePresenceValue(creation && interactionActive ? menu : null, MOTION.menuMs);
  const menuKind = creation ? trigger.value : menu;
  useDismissOnOutsideClick(!!creation && !!menu, [qip.composerRef, slash.menuRef], () => setMenu(null));
  const suggestions = <>
      {menuKind && (
        <ComposerTriggerMenu
          menu={menuKind} presence={creation ? trigger.presence : undefined}
          slashItems={slash.slashItems}
          atItems={slash.atItems}
          activeIdx={activeIdx}
          menuRef={slash.menuRef}
          workspaceId={workspaceId}
          onHover={setActiveIdx}
          onApply={(i) => void cmds.applyItem(i)}
        />
      )}
      <ComposerQuickInputPanel
        presence={qip.qipPresence}
        qipRef={qip.qipRef}
        qipEdit={qip.qipEdit}
        setQipEdit={qip.setQipEdit}
        qipFiltered={qip.qipFiltered}
        phrasesCount={qip.phrases.length}
        qipActive={qip.qipActive}
        setActive={qip.setQipActive}
        qipKeyRef={qip.qipKeyRef}
        qipValueRef={qip.qipValueRef}
        onKeyDown={qip.onQipKeyDown}
        onInsert={qip.insertPhrase}
        onSave={qip.savePhrase}
        onClose={creation ? () => qip.exitCmdMode() : undefined}
        onDelete={(id) => qip.setPhrases((prev) => removeQuickPhrase(prev, id))}
      />
  </>;

  return (
    <>
    <div className="agent-composer" ref={qip.composerRef}
      style={flyoutAnchor ? { anchorName } as React.CSSProperties : undefined} onDragOver={inserts.onDragOver} onDrop={inserts.onDrop}>
      {flyoutAnchor ? interactionActive && !modelMention.request && (trigger.presence.mounted || qip.qipPresence.mounted) &&
        <ComposerFlyout anchor={flyoutAnchor}>{suggestions}</ComposerFlyout> : suggestions}
      <div className="chat-input-row">
        <div className="chat-input-shell">
          {!creation && <QueueSendPanel
            renderHeader={capsule => <div className="composer-actions-header">
              {(replyPresence.mounted || visibleReplies) && replySnapshot ? (
                <div className={`acc${visibleReplies || replyPresence.stage === 'in' ? ' is-open' : ''}`}
                  style={visibleReplies ? { transition: 'none' } : undefined}
                  aria-hidden={replyPresence.stage === 'out' || !!disabled} {...(replyPresence.stage === 'out' || disabled ? { inert: '' } : {})}>
                  <div className="acc-body"><ComposerReplySuggestions suggestions={replySnapshot} selectedIndex={replyIndex}
                    clearing={replyState.clearing} onSelect={index => {
                      setReplySelection({ messageId: replySnapshot.messageId, index }); editableRef.current?.focus();
                    }} onClear={onClearReplySuggestions ? () => { editableRef.current?.focus(); void replyState.clear(replySnapshot); } : undefined}/></div>
                </div>
              ) : null}
              {capsule}
              <ComposerCommandChip cmdMode={qip.cmdMode} onExitCmdMode={() => qip.exitCmdMode()}/>
              {requestRecordingShortcut}
            </div>}
            autoItems={queuedItems ?? NO_QUEUED_ITEMS}
            busy={busy}
            manualItems={queue.tosend.map((i) => ({
              id: i.id,
              text: i.text,
              ...(i.images?.length
                ? {
                    imageCount: i.images.length,
                    imagePreviews: i.images.map((im) => ({
                      id: im.id,
                      url: `data:${im.mimeType};base64,${im.data}`,
                      ...(im.name ? { name: im.name } : {})
                    }))
                  }
                : {})
            }))}
            onSendNow={(item, lane) => void queue.handlePanelSendNow(item, lane)}
            onEditToDraft={queue.handlePanelEditToDraft}
            onDelete={queue.handlePanelDelete}
            onReorder={queue.handlePanelReorder}
            onMoveLane={queue.handlePanelMoveLane}
          />}

          <ComposerAttachBar
            allowImages={allowImages}
            images={imgs.images}
            onRemoveImage={imgs.removeImage}
            fileInputRef={fileInputRef}
            onPickFiles={imgs.addImageFiles}
          />
          <div className="composer-ta-wrap">
            <ComposerEditable
              ref={editableRef} ariaLabel={creation?.label} enterNewline={!!creation}
              value={draft.value}
              extensionSkillNames={extensionSkillNames}
              noteTokens={noteTokens}
              disabled={inputLocked}
              placeholder={
                qip.cmdMode === 'quickInput'
                  ? t('输入即搜索，↑↓ 选择，Enter 插入')
                  : creation ? creation.placeholder
                  : inputPendingQuestion && !imgs.images.length
                    ? t('输入选项作答，或发送新消息')
                  : busy
                    ? queue.tosend.length > 0
                      ? t('Agent 正在工作，Enter 加入手动确认发送…')
                      : t('Agent 正在工作，输入内容发送后将排队…')
                    : allowImages
                      ? t('对 Agent 说点什么（可粘贴/选择文件，/ 快捷指令，Enter 发送）')
                      : t('对 Agent 说点什么（/ 快捷指令，Enter 发送）')
              }
              onChange={inserts.onEditorChange}
              onCaretMove={inserts.onEditorCaretMove}
              onKeyDown={event => {
                send.onKeyDown(event);
                if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey ||
                    event.nativeEvent.isComposing || draft.valueRef.current !== '' || inputLocked || !visibleReplies) return;
                if (event.shiftKey) {
                  if (visibleReplies.replies.length < 2) return;
                  event.preventDefault();
                  if (!event.repeat) {
                    setReplySelection(previous => {
                      const index = previous?.messageId === visibleReplies.messageId
                        ? Math.min(previous.index, visibleReplies.replies.length - 1) : 0;
                      return { messageId: visibleReplies.messageId, index: (index + 1) % visibleReplies.replies.length };
                    });
                  }
                  return;
                }
                if (event.repeat || !ghostReply) return;
                event.preventDefault();
                editableRef.current?.insertText(ghostReply);
              }}
              onFocus={() => {
                if (draftBucket) setLastFocusedDraftBucket(draftBucket);
              }}
              onPasteFiles={allowImages ? imgs.addImageFiles : undefined}
              onPasteNativeFiles={allowImages ? imgs.pasteNativeFiles : undefined}
              onNoteTokenClick={onNoteTokenClick}
              onNoteTokenDelete={onNoteTokenDelete}
              onModelTokenClick={modelMention.open}
            />
            {ghostReply ? <div className="composer-ghost-suggestion" aria-hidden="true">{ghostReply}</div> : null}
          </div>
          {modelMention.error ? <ErrorTip message={modelMention.error} /> : null}
          <div className="agent-composer-toolbar">
            <div className="agent-composer-tb-left">
              <ComposerToolbarLeft
                flyoutAnchor={flyoutAnchor} plusMenu={plusMenu}
                allowImages={allowImages}
                showPlusMenu={menus.showPlusMenu}
                setShowPlusMenu={menus.setShowPlusMenu}
                plusMenuPresence={menus.plusMenuPresence}
                plusMenuRef={menus.plusMenuRef}
                plusPopupRef={menus.plusPopupRef}
                insertTriggerChar={inserts.insertTriggerChar}
                fileInputRef={fileInputRef}
                onModeChange={onModeChange}
                permissionConfiguration={permissionConfiguration}
                mode={mode}
                modeLabel={modeLabel}
                modeOrder={modeOrder}
                modeDescriptions={modeDescriptions}
                modeDisabled={modeDisabled}
                modeSwitchLocked={modeSwitchLocked}
                modeSwitchLockedTitle={modeSwitchLockedTitle}
                disabled={disabled}
                preset={composerPreset}
                separatePreset={separatePreset}
                presetRoster={menus.presetRoster}
                presetError={menus.presetError}
                presetName={presetName}
                showModeMenu={menus.showModeMenu}
                setShowModeMenu={menus.setShowModeMenu}
                modeMenuPresence={menus.modeMenuPresence}
                modeMenuRef={menus.modeMenuRef}
                modePopupRef={menus.modePopupRef}
                showPresetMenu={menus.showPresetMenu}
                setShowPresetMenu={menus.setShowPresetMenu}
                presetMenuPresence={menus.presetMenuPresence}
                presetMenuRef={menus.presetMenuRef}
              />
              {nativeSettings}
              {reminders}
              {bgTasks ? (
                <BgTasksArea sessionId={bgTasks.sessionId} cwd={bgTasks.cwd} workspaceId={bgTasks.workspaceId} />
              ) : null}
              {surfaceKind === 'dispatch' && workspaceId ? <WorkflowArea workspaceId={workspaceId} /> : null}
            </div>
            <div className="agent-composer-tb-right">
              {usage ? (
                <ComposerContextUsage
                  usage={usage}
                  statusTitle={statusTitle}
                  rawUsage={rawUsage}
                  showCtxMenu={menus.showCtxMenu}
                  setShowCtxMenu={menus.setShowCtxMenu}
                  ctxMenuPresence={menus.ctxMenuPresence}
                  ctxMenuRef={menus.ctxMenuRef}
                />
              ) : null}
              {statusModel || chatStatus?.modelParameters?.length || chatStatus?.thinking?.levels?.length || harnessId ? (
                <ComposerModelCluster
                  interactionActive={interactionActive}
                  statusModel={statusModel || (harnessId ? t('跟随引擎默认') : t('模型参数'))}
                  harnessId={harnessId}
                  statusTitle={statusTitle}
                  chatStatus={chatStatus}
                  showModelMenu={menus.showModelMenu}
                  setShowModelMenu={menus.setShowModelMenu}
                  toggleModelMenu={menus.toggleModelMenu}
                  modelMenuPresence={menus.modelMenuPresence}
                  modelMenuRef={menus.modelMenuRef}
                  modelPopupRef={menus.modelPopupRef}
                />
              ) : null}
              {/* 兼容尚未提供档位目录的旧宿主，已声明档位时统一收进模型菜单。 */}
              {chatStatus?.thinking && !chatStatus.thinking.levels ? <ComposerThinkingChip thinking={chatStatus.thinking} /> : null}
              {creation?.targetButton}
              {creation ? <button type="button" className="git-btn primary task-composer-submit"
                disabled={inputLocked || creation.submitDisabled || !!qip.cmdMode || imgs.loading || send.submitting || (!draft.hasText && !imgs.images.length && !creation.allowEmpty)}
                onClick={() => void send.submit()}>{creation.submitLabel}</button> : <div className="composer-send-actions" role="group" aria-label={t('发送操作')}>
                <ComposerDraftCapsules
                  hasText={draft.hasText}
                  hasImages={imgs.images.length > 0}
                  busy={busy}
                  queuedCount={queuedItems?.length ?? 0}
                  manualCount={queue.tosend.length}
                  disabled={inputLocked || !!qip.cmdMode || imgs.loading || send.submitting}
                  onToManual={() => {
                    const text = draft.valueRef.current.trim();
                    const pendingImgs = imgs.images.length > 0 ? [...imgs.images] : undefined;
                    if (qip.cmdMode || (!text && !pendingImgs)) return;
                    queue.addTosend(text, pendingImgs);
                    if (pendingImgs) imgs.setImages([]);
                    draft.applyValue('');
                    setMenu(null);
                  }}
                  onToQueue={() => {
                    const text = draft.valueRef.current.trim();
                    if (qip.cmdMode || (!text && imgs.images.length === 0)) return;
                    const pendingImgs = imgs.images.length > 0 ? [...imgs.images] : undefined;
                    void Promise.resolve(sendDraft(text, pendingImgs)).then((ok) => {
                      if (ok === false) return;
                      if (pendingImgs) {
                        const sentIds = new Set(pendingImgs.map((im) => im.id));
                        imgs.setImages((prev) => prev.filter((im) => !sentIds.has(im.id)));
                      }
                      if (draft.valueRef.current.trim() === text) draft.applyValue('');
                      setMenu(null);
                    });
                  }}
                />
                <ComposerSendButtons
                  submitting={send.submitting}
                  busy={busy}
                  onStop={onStop}
                  inputLocked={inputLocked || !!qip.cmdMode || imgs.loading}
                  hasText={draft.hasText && !qip.cmdMode}
                  manualCount={queue.tosend.length}
                  pendingQuestion={inputPendingQuestion}
                  imagesCount={imgs.images.length}
                  onSubmit={() => void send.submit()}
                />
              </div>}
            </div>
          </div>
        </div>
      </div>
      </div>
      <SteerFallbackDialog
        text={fallbackText === null ? null : summarizeWorkerModelMentions(fallbackText)}
        onCancel={() => settleFallback('failed')}
        onMail={() => { void (async () => {
          const text = fallbackText ?? '';
          const ok = await modelMention.validate(text) && await onSendNowFallback?.(serializeWorkerModelMentions(text), 'mail');
          settleFallback(ok ? 'sent' : 'failed');
        })(); }}
        onInterrupt={() => { void (async () => {
          const text = fallbackText ?? '';
          const ok = await modelMention.validate(text) && await onSendNowFallback?.(text, 'interrupt');
          settleFallback(ok ? 'sent' : 'failed');
        })(); }}
      />
      <WorkerTargetDialog mention request={modelMention.request} onClose={modelMention.close} onSelect={modelMention.apply} />
    </>
  );
}

export const AgentComposer = React.memo(AgentComposerInner);
