/** Reminder IPC. Knowledge governance uses knowledgeIpc. */
import type {AppContext} from '../context';
import {t} from '../../shared/i18n';
import {resolveWorkspaceControlRoot} from '../ipc/helpers';
import {handle as registerIpc,type IpcHandler} from '../ipc/handle';
import {getMemoryService} from './serviceRef';
import {localizeKnowledgeUserError} from './knowledgeUserErrors';
import {memoryCenterCancelIntent,memoryCenterIntents,memoryCenterRearmIntent} from './centerState';
import type {MemoryCenterIntentsResult} from '../../shared/memoryCenterIpc';
function handle<T extends IpcHandler>(channel:string,fn:T):void {
  registerIpc(channel,(event,...args)=>{
    try { const result=fn(event,...args); return result instanceof Promise?result.catch(localizeKnowledgeUserError):result; }
    catch(error){ return localizeKnowledgeUserError(error); }
  });
}
export function registerMemoryCenterIpc(ctx: AppContext): void {
  const rootOf = (): string => resolveWorkspaceControlRoot(ctx, ctx.config.get().activeWorkspaceId);

  handle('memoryCenter:badge',()=>{
    const svc=getMemoryService();if(!svc)throw new Error(t('记忆服务尚未就绪'));
    // Processing is system activity, never an approval badge demanding user attention.
    return {pending:0};
  });
  handle('memoryCenter:intents', (): MemoryCenterIntentsResult => memoryCenterIntents(rootOf()));

  handle(
    'memoryCenter:intentCancel',
    (_e, id: unknown): { ok: boolean; error?: string } => {
      if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(t('id 不能为空'));
      return memoryCenterCancelIntent(rootOf(), id);
    }
  );

  handle(
    'memoryCenter:intentRearm',
    (_e, id: unknown): { ok: boolean; error?: string } => {
      if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(t('id 不能为空'));
      return memoryCenterRearmIntent(rootOf(), id);
    }
  );

}
