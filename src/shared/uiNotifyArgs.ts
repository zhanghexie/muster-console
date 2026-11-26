/** ui.notify 定位参数（P3）：sessionId 直达；缺参一次报全 */
export type UiNotifyLocate = {
  workspaceId?: string;
  sessionId?: string;
  sessionName?: string;
  text?: string;
  label?: string;
  lifecycle?: string;
};

export function fillNotifyFromSession(
  args: UiNotifyLocate,
  session: { id: string; name: string; workspaceId?: string } | undefined
): UiNotifyLocate {
  if (!session) return { ...args };
  return {
    ...args,
    sessionId: args.sessionId?.trim() || session.id,
    sessionName: args.sessionName?.trim() || session.name,
    workspaceId: args.workspaceId?.trim() || session.workspaceId || ''
  };
}

export function missingUiNotifyFields(args: UiNotifyLocate): string[] {
  const missing: string[] = [];
  if (!args.workspaceId?.trim()) missing.push('workspaceId');
  if (!args.sessionName?.trim()) missing.push('sessionName');
  return missing;
}
