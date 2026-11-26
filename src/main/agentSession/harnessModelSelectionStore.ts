import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import { writeJsonAtomicSync } from '../atomicJson';
import { normalizeHarnessModelSelections, validHarnessModelId, validHarnessModelKey, type HarnessModelSelections } from '../../shared/harnessModelSelection';
import { t } from '../../shared/i18n';

const MAX_BYTES = 4 * 1024 * 1024;

/** Independent preferences store: changing a model filter must not rewrite app settings. */
export class HarnessModelSelectionStore {
  private readonly file: string;
  private cached?: HarnessModelSelections;
  constructor(userDataDir: string) { this.file = userDataStorage(userDataDir).file('harness-model-selections'); }

  read(): HarnessModelSelections {
    if (this.cached) return structuredClone(this.cached);
    let content: string;
    try { content = fs.readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cached = {}; return {}; }
      throw error;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error(t('模型设置文件过大，无法读取'));
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new Error(t('模型设置文件损坏，无法读取')); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('模型设置文件格式无效'));
    const envelope = value as { version?: unknown; selections?: unknown };
    if (envelope.version !== 1 || !envelope.selections || typeof envelope.selections !== 'object' || Array.isArray(envelope.selections)) {
      throw new Error(t('模型设置文件格式无效'));
    }
    const raw = envelope.selections as Record<string, unknown>;
    const result = normalizeHarnessModelSelections(raw);
    if (Object.keys(raw).length !== Object.keys(result).length) throw new Error(t('模型设置文件包含无效条目'));
    this.cached = result;
    return structuredClone(result);
  }

  update(key: unknown, modelIds: unknown): HarnessModelSelections {
    if (!validHarnessModelKey(key) || (modelIds !== null &&
      (!Array.isArray(modelIds) || modelIds.length > 8192 || !modelIds.every(validHarnessModelId) ||
        modelIds.reduce((size, id) => size + id.length, 0) > 1_000_000))) {
      throw new Error(t('模型选择无效'));
    }
    const selections = this.read();
    if (modelIds === null) delete selections[key];
    else selections[key] = [...new Set(modelIds as string[])];
    const payload = { version: 1, selections };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_BYTES) throw new Error(t('模型设置过大，无法保存'));
    writeJsonAtomicSync(this.file, payload);
    this.cached = selections;
    return structuredClone(selections);
  }
}
