/**
 * 证据页 IPC（T4.5）：渲染层只读访问证据归档。
 * 三通道都以索引为准绳：entryId 必须命中该会话 index.json 的条目才允许读其
 * 文件（文件名另有白名单校验）——渲染层传来的任何字符串都构不成路径穿越。
 * ctx.evidence 晚绑定（boot 顺序），调用时闭包取值。
 */
import { handle } from './handle';
import type { AppContext } from '../context';

export function registerEvidenceIpc(ctx: AppContext): void {
  handle('evidence:index', (_e, sessionId?: unknown) =>
    typeof sessionId === 'string' ? (ctx.evidence?.readIndex(sessionId) ?? null) : null
  );
  handle('evidence:entryText', (_e, sessionId?: unknown, entryId?: unknown) => {
    const text =
      typeof sessionId === 'string' && typeof entryId === 'string'
        ? ctx.evidence?.readEntryText(sessionId, entryId)
        : undefined;
    return text === undefined ? null : { text };
  });
  handle('evidence:entryImage', (_e, sessionId?: unknown, entryId?: unknown) => {
    const dataUrl =
      typeof sessionId === 'string' && typeof entryId === 'string'
        ? ctx.evidence?.readEntryImage(sessionId, entryId)
        : undefined;
    return dataUrl === undefined ? null : { dataUrl };
  });
}
