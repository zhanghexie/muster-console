import fs from 'node:fs';
import type { FeedbackCredentialStatus, FeedbackTarget } from '../../shared/feedback';
import { assertCredentialStorage } from '../agentApps/credentialPolicy';
import { writeTextAtomicSync } from '../atomicJson';

interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
interface StoredCredential { version: 1; target: FeedbackTarget; encrypted: string | null }

/** Holds only encrypted data at rest. Renderer and model tools never receive the token back. */
export class FeedbackCredentialStore {
  private state: StoredCredential | null = null;
  private initializing: Promise<void> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    file: string; target: FeedbackTarget; cipher: Cipher; platform: NodeJS.Platform;
    legacy: (target: FeedbackTarget) => Promise<string | null>;
    validate: (target: FeedbackTarget, token: string) => Promise<void>;
    changed?(): void;
  }) {}

  private checkStorage(): void {
    try {
      const { cipher, platform } = this.options;
      assertCredentialStorage(cipher.isEncryptionAvailable(), platform, platform === 'linux' ? cipher.getSelectedStorageBackend?.() : undefined);
    } catch { throw new Error('系统安全存储不可用，请登录系统账户或解锁密钥环后重试。'); }
  }
  private persist(state: StoredCredential): void {
    writeTextAtomicSync(this.options.file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    this.state = state;
  }
  private encrypt(token: string): string {
    this.checkStorage();
    const value = this.options.cipher.encryptString(token);
    if (!Buffer.isBuffer(value) || !value.length || value.length > 16_384) throw new Error('系统安全存储不可用，请登录系统账户或解锁密钥环后重试。');
    return value.toString('base64');
  }
  private async initialize(): Promise<void> {
    if (fs.existsSync(this.options.file)) {
      let stored: StoredCredential;
      try { stored = JSON.parse(fs.readFileSync(this.options.file, 'utf8')) as StoredCredential; }
      catch { throw new Error('反馈凭据文件损坏，请联系维护人员。'); }
      if (!stored || stored.version !== 1 || !stored.target || typeof stored.target.repository !== 'string' ||
          !['gitlab', 'github'].includes(stored.target.provider) ||
          !(stored.encrypted === null || (typeof stored.encrypted === 'string' && stored.encrypted.length > 0 && stored.encrypted.length <= 24_000))) {
        throw new Error('反馈凭据文件损坏，请联系维护人员。');
      }
      this.state = stored;
      return;
    }
    // One-time import preserves a credential that the user configured before the settings UI existed.
    const legacy = await this.options.legacy(this.options.target);
    this.persist({ version: 1, target: this.options.target, encrypted: legacy ? this.encrypt(legacy) : null });
  }
  private async ready(): Promise<void> {
    if (this.state) return;
    if (!this.initializing) this.initializing = this.initialize().catch(error => { this.initializing = null; throw error; });
    await this.initializing;
  }
  async get(): Promise<string | null> {
    await this.ready();
    const state = this.state!;
    if (!state.encrypted || JSON.stringify(state.target) !== JSON.stringify(this.options.target)) return null;
    this.checkStorage();
    try { return this.options.cipher.decryptString(Buffer.from(state.encrypted, 'base64')) || null; }
    catch { throw new Error('反馈凭据无法解密，请在设置中重新配置。'); }
  }
  async status(): Promise<FeedbackCredentialStatus> { return { configured: !!await this.get() }; }
  async save(input: unknown): Promise<FeedbackCredentialStatus> {
    if (typeof input !== 'string') throw new Error('请输入有效的反馈令牌。');
    const token = input.trim();
    if (!token || token.length > 4096 || /\s|[\x00-\x1f]/.test(token)) throw new Error('请输入有效的反馈令牌。');
    return this.mutate(async () => {
      await this.ready();
      this.checkStorage();
      await this.options.validate(this.options.target, token);
      this.persist({ version: 1, target: this.options.target, encrypted: this.encrypt(token) });
      this.options.changed?.();
      return { configured: true };
    });
  }
  async clear(): Promise<FeedbackCredentialStatus> {
    return this.mutate(async () => {
      await this.ready();
      this.persist({ version: 1, target: this.options.target, encrypted: null });
      this.options.changed?.();
      return { configured: false };
    });
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutations;
    let release!: () => void;
    this.mutations = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }
}
