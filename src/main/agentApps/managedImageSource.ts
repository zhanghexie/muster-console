import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Restrict Agent imports to original files owned by its scheduler conversation. */
export async function managedImageSource(attachmentDirectory: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('需要当前调度会话的受管附件路径');
  let directory: string, source: string;
  try { directory = await fs.realpath(attachmentDirectory); source = await fs.realpath(input); }
  catch { throw new Error('受管附件不存在或已被清理'); }
  if (path.dirname(source) !== directory || !/^(?:[a-f0-9]{12}|[a-f0-9]{64})-.+/i.test(path.basename(source)) || !(await fs.stat(source)).isFile()) throw new Error('只能导入当前调度会话的受管源附件');
  return source;
}
