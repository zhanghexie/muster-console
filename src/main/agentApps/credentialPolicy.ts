/** No plaintext fallback on any desktop platform. Kept pure for platform matrix tests. */
export function assertCredentialStorage(available: boolean, platform: string, backend?: string): void {
  if (!available || platform === 'linux' && (!backend || ['basic_text', 'unknown'].includes(backend))) {
    throw new Error('系统凭据存储不可用。Windows 请登录当前账户；macOS 请解锁钥匙串；Linux 请启用 Secret Service 或 KWallet 后重试。密码未保存。');
  }
}
