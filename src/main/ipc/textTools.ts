import type { AppContext } from '../context';
import type { TextToolRunRequest } from '../../shared/types';
import { t } from '../../shared/i18n';
import { handle } from './handle';
import { runTextTool } from '../textTools/runTextTool';

/** 渲染层入参收紧：只放行功能定义与文本，长度钳制防误传超大负载 */
function sanitizeRunRequest(raw: unknown): TextToolRunRequest {
  if (!raw || typeof raw !== 'object') throw new Error(t('参数缺失'));
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, field: string, max: number): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(t('{{field}} 缺失', { field }));
    return v.slice(0, max);
  };
  const opt = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  return {
    name: str(r.name, t('功能名'), 40),
    prompt: str(r.prompt, t('提示词'), 8000),
    providerId: opt(r.providerId, 80),
    modelId: opt(r.modelId, 120),
    text: str(r.text, t('选中文本'), 24_000),
    runId: opt(r.runId, 80),
    noThinking: r.noThinking === false ? false : undefined
  };
}

/** 划词文本工具：渲染层只传功能定义与文本，apiKey 始终留在主进程。
 *  带 runId 时走流式：先推一条 modelLabel（实际解析到的服务商·模型），
 *  思考段/正文增量经 textTools:chunk 推送（invoke 的返回仍是权威全文）。 */
export function registerTextToolsIpc(ctx: AppContext): void {
  handle('textTools:run', async (_e, req: unknown) => {
    const fn = sanitizeRunRequest(req);
    const runId = fn.runId;
    const send = (payload: { delta: string; modelLabel?: string; reasoning?: boolean }): void => {
      if (!runId) return;
      try {
        ctx.getWindow()?.webContents.send('textTools:chunk', { runId, ...payload });
      } catch {
        /* 推送失败不影响调用本身（窗口可能在关闭中） */
      }
    };
    return await runTextTool(ctx.config.get(), fn, {
      onStart: (modelLabel) => send({ delta: '', modelLabel }),
      onReasoning: (() => {
        let notified = false;
        return () => {
          // 思考段只报一次"进入思考"标志，增量本身不转发
          if (!notified) {
            notified = true;
            send({ delta: '', reasoning: true });
          }
        };
      })(),
      onDelta: (delta) => send({ delta })
    });
  });
}
