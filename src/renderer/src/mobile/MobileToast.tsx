/**
 * 手机 toast（MobileApp 底座）：纯文本提示，或带动作尾巴（点击整条触发）。
 * 动作尾巴是 session-status 推送 needs_you 的深链出口（T1.2）；无动作时保持
 * 原有纯提示形态（pointer-events:none，不挡下方交互）。
 */
import React from 'react';

export interface MobileToastAction {
  /** 动作尾巴文案（如「查看」，由调用方本地化） */
  label: string;
  run(): void;
}

export function MobileToast(props: { text: string; action?: MobileToastAction }): React.JSX.Element {
  const action = props.action;
  if (!action) {
    return (
      <div className="ma-toast" role="status">
        {props.text}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ma-toast action"
      onClick={() => {
        action.run();
      }}
    >
      <span className="ma-toast-text">{props.text}</span>
      <span className="ma-toast-act">{action.label}</span>
    </button>
  );
}
