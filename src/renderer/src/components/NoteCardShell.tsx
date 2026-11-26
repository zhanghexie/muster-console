import React from 'react';
import { usePresence, MOTION } from './motion';
import { NoteEditor } from './NoteEditor';

/**
 * 网页元素备注卡的共享壳：scrim + msg-note-bubble 卡 + 元素截图 +
 * 元素名/选择器两行引用 + 备注多行编辑（Ctrl+Enter 确认 / Esc / 点外取消）。
 * 两处消费：首次拾取录入（BrowserPage 的 BrowserNoteCard，footer=提示文案）与
 * 批注二次编辑（WebNoteEntryHost，footer=URL + 删除钮）。
 * 打开期间的网页区截图让位由消费方各自负责（让位来源不同）。
 */
export function NoteCardShell({
  shot,
  label,
  selector,
  value,
  onValueChange,
  onConfirm,
  onCancel,
  footer,
  onDelete,
  edit = false
}: {
  shot: string | null;
  label: string;
  selector: string;
  value: string;
  onValueChange: (v: string) => void;
  onConfirm: (text?: string) => void;
  onCancel: () => void;
  /** 卡底行：录入提示 / URL + 删除钮 */
  footer: React.ReactNode;
  onDelete?: () => void;
  edit?: boolean;
}): React.JSX.Element {
  const presence = usePresence(true, MOTION.menuMs);
  const onConfirmValue = (text: string): void => { onValueChange(text); onConfirm(text); };

  return (
    <div className="browser-note-scrim" onPointerDown={onCancel}>
      <div
        className="msg-note-bubble is-fixed mp-pop browser-note-card"
        {...presence.spread}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {shot && <img src={shot} alt="" className="browser-note-shot" draggable={false} />}
        <NoteEditor initial={value} edit={edit}
          source={<span title={selector}>{label}</span>}
          onChange={onValueChange} onSave={onConfirmValue} onCancel={onCancel} onDelete={onDelete}
          footer={<div className="browser-note-card-hint">{footer}</div>}/>

      </div>
    </div>
  );
}
