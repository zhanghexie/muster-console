import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { sourcePathKey } from '../workspacePaths';
import { attachmentDir } from './service';
import { withHandoverReadAccess } from '../handover/paths';
import { withSessionCaptureReadAccess } from '../desktop/sessionCaptureAccess';

/** Grant only this conversation's managed files to host read tools, never SDK write roots. */
export function withAttachmentReadAccess(context: WorkspaceExecutionContext | undefined, userData: string, sessionId: string): WorkspaceExecutionContext | undefined {
  context = withHandoverReadAccess(context, userData, sessionId);
  if (!context) return context;
  const dir = attachmentDir(userData, `gui:${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  const physicalPath = sourcePathKey(fs.realpathSync(dir));
  const expected = path.join(fs.realpathSync(userData), path.relative(userData, dir));
  if (physicalPath !== sourcePathKey(expected)) throw new Error('会话附件目录指向了非受管路径');
  const withAttachments = context.readableDirectories.some(d => d.physicalPath === physicalPath) ? context : Object.freeze({ ...context, readableDirectories: Object.freeze([
    ...context.readableDirectories, Object.freeze({ path: dir, physicalPath })
  ]) });
  return withSessionCaptureReadAccess(withAttachments, userData, sessionId);
}
