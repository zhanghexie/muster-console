import fs from 'node:fs';
import { writeTextAtomicSync } from '../atomicJson';
import { assertCredentialStorage } from '../agentApps/credentialPolicy';

export interface MessagingCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

type CredentialDocument = { version: 1; entries: Record<string, string> };
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_REFS = 4096;

function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(ref);
}

/** Private encrypted references. No legacy DSH/Feishu lookup and no plaintext fallback. */
export class MessagingCredentialStore {
  private document?: CredentialDocument;
  constructor(private readonly options: { file: string; cipher: MessagingCipher; platform: NodeJS.Platform }) {}

  private storage(): void {
    const { cipher, platform } = this.options;
    assertCredentialStorage(cipher.isEncryptionAvailable(), platform,
      platform === 'linux' ? cipher.getSelectedStorageBackend?.() : undefined);
  }

  private read(): CredentialDocument {
    if (this.document) return this.document;
    let input: unknown;
    try {
      const stat = fs.lstatSync(this.options.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error();
      input = JSON.parse(fs.readFileSync(this.options.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.document = { version: 1, entries: Object.create(null) as Record<string, string> };
      }
      throw new Error('消息渠道凭据文件无法读取，请保留原文件并从有效备份恢复。');
    }
    const value = input as Partial<CredentialDocument> | null;
    if (!value || value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) ||
        Object.keys(value.entries).length > MAX_REFS || Object.entries(value.entries).some(([ref, encrypted]) =>
          !validRef(ref) || typeof encrypted !== 'string' || !encrypted || encrypted.length > MAX_SECRET_BYTES * 2 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted))) {
      throw new Error('消息渠道凭据文件格式或版本不受支持，请保留原文件并从有效备份恢复。');
    }
    return this.document = { version: 1, entries: { ...value.entries } };
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    if (!validRef(ref)) throw new Error('消息渠道凭据引用无效。');
    const encoded = this.read().entries[ref];
    if (!Object.hasOwn(this.read().entries, ref) || !encoded) return undefined;
    this.storage();
    try { return { value: this.options.cipher.decryptString(Buffer.from(encoded, 'base64')), source: 'muster-secure-storage' }; }
    catch { throw new Error('消息渠道凭据无法解密，请解锁系统密钥环或重新配置此账号。'); }
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string }> {
    if (!validRef(ref)) throw new Error('消息渠道凭据引用无效。');
    const configured = Object.hasOwn(this.read().entries, ref);
    return configured ? { configured, source: 'muster-secure-storage' } : { configured };
  }

  async set(ref: string, value: string): Promise<void> {
    if (!validRef(ref) || typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      throw new Error('消息渠道凭据格式或大小无效。');
    }
    const previous = this.read();
    if (!Object.hasOwn(previous.entries, ref) && Object.keys(previous.entries).length >= MAX_REFS) {
      throw new Error('消息渠道凭据数量已达上限，请先移除不再使用的账号。');
    }
    this.storage();
    const encrypted = this.options.cipher.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_SECRET_BYTES * 1.5) {
      throw new Error('系统未能加密消息渠道凭据，原凭据保持不变。');
    }
    this.write({ version: 1, entries: { ...previous.entries, [ref]: encrypted.toString('base64') } });
  }

  async unset(ref: string): Promise<void> {
    if (!validRef(ref)) throw new Error('消息渠道凭据引用无效。');
    const previous = this.read();
    if (!Object.hasOwn(previous.entries, ref)) return;
    const entries = { ...previous.entries };
    delete entries[ref];
    this.write({ version: 1, entries });
  }

  private write(next: CredentialDocument): void {
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) throw new Error('消息渠道凭据存储容量已达上限。');
    writeTextAtomicSync(this.options.file, `${json}\n`, { mode: 0o600 });
    this.document = next;
  }
}
