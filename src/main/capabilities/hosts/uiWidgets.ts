import { userDataStorage } from '../../runtimeKernel/storageRootResolver';
/**
 * 智能界面（生成式部件）：ui.render 落盘自包含 HTML 并返回链接。
 * HTML 创作契约见 src/shared/uiRender.ts（同源 docs/prototypes/intelligent-ui/contract.md）；
 * 产物格式与静态检查见 src/main/uiArtifacts.ts。
 * 身份：worker 两侧（GUI 进程内 / CLI Shell API）经 hostTools meta bind:'self' 自动绑定调用方会话；
 * 调度身份从可信调用作用域解析；逻辑身份与安全目录名分离。
 */
import { app } from 'electron';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { uiWidgetSessionDirectory } from '../../../shared/uiWidgetSession';
import path from 'node:path';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { writeUiArtifact } from '../../uiArtifacts';
import { getUiWidgetStore } from '../../uiWidgetStore';
import { smokeUiWidgetReport } from '../../uiWidgetSmoke';
import { inspectUiWidgets, type UiInspectQuery } from '../../uiWidgetInspect';
import { scanHtmlViolations, type UiRenderParams } from '../../../shared/uiRender';
import { uiSessionPageUrl } from '../../../shared/uiSessionPage';

function callerSessionId(args: { sessionId?: string }): string {
  const worker = currentAgentSessionId();
  const sessionId = worker ?? (isSchedulerInvocation()
    ? `orchestrator:${currentAgentWorkspaceId() ?? ''}` : args.sessionId);
  try { uiWidgetSessionDirectory(sessionId); }
  catch { throw new Error(t('交互内容的宿主会话身份缺失或无效')); }
  return sessionId!;
}
function sessionDirectory(sessionId: string): string {
  return path.join(userDataStorage(app.getPath('userData')).resolve('app', 'agent-sessions'), uiWidgetSessionDirectory(sessionId), 'ui');
}
function ownArtifact(dir: string, link: unknown): string {
  if (typeof link !== 'string' || !path.isAbsolute(link)) throw new Error(t('部件路径无效'));
  const relative = path.relative(dir, link);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error(t('部件不属于当前会话'));
  return link;
}

export const uiWidgetsHost = {
  'ui.render': async (ctx: AppContext, args: Record<string, unknown> & { sessionId?: string }) => {
    const sessionId = callerSessionId(args);
    // 产物主题跟随当前生效外观（评审 P2-5：浅色用户的 browser 部件不再恒为深色）
    let theme: 'dark' | 'light' = 'dark';
    try {
      const appearance = ctx.themes?.payload?.().active?.appearance;
      if (appearance === 'light') theme = 'light';
    } catch { /* 主题服务不可用则深色兜底 */ }
    const dir = sessionDirectory(sessionId);
    const store = getUiWidgetStore(app.getPath('userData'));
    const { sessionId: _sessionId, update, ...input } = args;
    let snapshot;
    const result = update ? await (async () => {
      const link = ownArtifact(dir, update);
      snapshot = await store.updateArtifact(link, input as unknown as UiRenderParams);
      ctx.browser?.refreshArtifact(snapshot.path);
      return { ok: true as const, filePath: link, warnings: scanHtmlViolations(String(input.html)) };
    })() : await writeUiArtifact(dir, input, theme);
    if (!result.ok) {
      const detail = result.issues?.map(i => `${i.path}：${i.message}`).join('；') ?? '';
      throw new Error(detail ? `${result.error}——${detail}` : result.error);
    }
    const smoke = await smokeUiWidgetReport(result.filePath);
    result.warnings.push(...smoke.warnings);
    // markdown 字段一律正斜杠：CommonMark 会把 `\.` 当转义吞掉反斜杠（实测 P0），
    // 正斜杠路径 Windows 通用且链接识别侧本就归一分隔符；尖括号形态兼容空格/括号
    const mdPath = result.filePath.replace(/\\/g, '/');
    const safeTitle = String((args as { title?: unknown }).title ?? '部件').replace(/[[\]<>]/g, '');
    snapshot ??= await store.read(result.filePath);
    ctx.getWindow()?.webContents.send('uiWidget:updated', { path: snapshot.path, artifactVersion: snapshot.artifactVersion });
    const session = ctx.sessions.get(sessionId);
    let presentation: { opened: boolean; url: string; tabId?: string; error?: string } | undefined;
    if (session && !ctx.sessions.isChatRuntime(session.runtime)) {
      presentation = { opened: false, url: uiSessionPageUrl(sessionId) };
      try {
        if (!ctx.browser || !ctx.getWindow()) throw new Error('右侧浏览器未就绪');
        presentation.tabId = ctx.browser.openUiSession(sessionId, session.workspaceId);
        presentation.opened = true;
      } catch (error) {
        presentation.error = error instanceof Error ? error.message : String(error);
        result.warnings.push(`交互 UI 已生成，但右侧浏览器打开失败：${presentation.error}`);
      }
    }
    let warningBytes = 0;
    const warnings = result.warnings.filter(warning => { warningBytes += Math.min(warning.length, 900); return warningBytes <= 3500; }).map(warning => warning.slice(0, 900));
    if (warnings.length < result.warnings.length) warnings.push(`另有 ${result.warnings.length - warnings.length} 条告警未展开，请精简内容后重试`);
    const diagnostics = smoke.diagnostics.slice(0, 3).map(detail => {
      const expression = String(detail.expression || ''), position = Number(detail.position) || 0, offset = Math.max(0, position - 128);
      return { code: String(detail.code || '').slice(0, 80), component: String(detail.component || '').slice(0, 40), id: String(detail.id || '').slice(0, 120), name: String(detail.name || '').slice(0, 120),
        attribute: String(detail.attribute || '').slice(0, 64), position, expression: expression.slice(offset, offset + 512), expressionOffset: offset, expressionLength: expression.length,
        message: String(detail.message || '').slice(0, 600), hint: String(detail.hint || '').slice(0, 180) };
    });
    return {
      link: result.filePath,
      markdown: `[${safeTitle}](<${mdPath}>)`,
      usage: presentation?.opened
        ? '交互 UI 已在右侧浏览器的本会话「交互 UI」页打开。请提示用户去右侧浏览器查看和操作；后续 UI 共用此页。打开不代表已渲染，必要时用 ui.inspect 核对。'
        : '把 markdown 字段原样放进回答正文（勿改写；link 为裸路径备用）；若 presentation.opened=false，明确告知用户自动打开失败。',
      ...(presentation ? { presentation } : {}),
      ...(diagnostics.length ? { diagnostics, diagnosticsOmitted: Math.max(0, smoke.diagnostics.length - diagnostics.length) } : {}),
      version: snapshot.artifactVersion,
      receipt: snapshot.receipt,
      ...(warnings.length ? { warnings } : {})
    };
  },
  'ui.inspect': async (_ctx: AppContext, args: Record<string, unknown> & { sessionId?: string }) => {
    const sessionId = callerSessionId(args);
    const dir = sessionDirectory(sessionId), store = getUiWidgetStore(app.getPath('userData'));
    const snapshots = args.link ? [await store.read(ownArtifact(dir, args.link))] : await store.list(sessionId);
    return inspectUiWidgets(snapshots, args as UiInspectQuery);
  }
};
