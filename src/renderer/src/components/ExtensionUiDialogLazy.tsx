/**
 * ExtensionUiDialog 的懒装载宿主：该组件树重（静态拖 xterm 等 ~1MB），只在
 * 首个 ui:dialog 真正到来后才挂载；此后常驻（弹窗内部 presence 自理退场冻结，
 * 卸载会剪掉退场动画）。App（桌面）与 MobileApp（手机）共用，手机首屏因此
 * 不再为「可能永远不来的扩展弹窗」付下载成本。
 */
import React, { Suspense, useRef } from 'react';
import type { UiDialogRequest } from '../../../shared/uiDialog';

const ExtensionUiDialog = React.lazy(() =>
  import('./ExtensionUiDialog').then((m) => ({ default: m.ExtensionUiDialog }))
);

export function ExtensionUiDialogLazy(props: {
  request: UiDialogRequest | null;
  onRespond: (requestId: string, cancelled: boolean, value?: string | string[]) => void;
}): React.JSX.Element | null {
  const everMountedRef = useRef(false);
  if (props.request) everMountedRef.current = true;
  if (!everMountedRef.current) return null;
  return (
    <Suspense fallback={null}>
      <ExtensionUiDialog request={props.request} onRespond={props.onRespond} />
    </Suspense>
  );
}
