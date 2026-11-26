import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatRendererErrorLine,
  RENDERER_ERROR_LOG_NAME,
  rotateIfNeeded,
  type RendererErrorRecord
} from '../../shared/rendererErrorLog';

export function rendererErrorLogPath(userDataDir: string): string {
  return path.join(userDataStorage(userDataDir).resolve('app', 'logs'), RENDERER_ERROR_LOG_NAME);
}

export function appendRendererError(userDataDir: string, rec: RendererErrorRecord): string {
  const file = rendererErrorLogPath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(
    () => fs.statSync(file).size,
    () => {
      const old = `${file}.old`;
      try {
        fs.unlinkSync(old);
      } catch {
        /* none */
      }
      fs.renameSync(file, old);
    }
  );
  fs.appendFileSync(file, `${formatRendererErrorLine(rec)}\n`, 'utf8');
  return file;
}
