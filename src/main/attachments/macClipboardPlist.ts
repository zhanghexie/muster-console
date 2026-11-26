import { spawn } from 'node:child_process';
import { t } from '../../shared/i18n';

const MAX_PLIST_BYTES = 1024 * 1024;

/** macOS ships plutil; feed it stdin directly without a shell or temporary files. */
export function convertMacClipboardPlist(input: Buffer): Promise<Buffer> {
  if (input.length > MAX_PLIST_BYTES) return Promise.reject(new Error(t('系统文件剪贴板数据过大，请拖入或选择文件')));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => finish(new Error(t('读取系统文件剪贴板超时，请拖入或选择文件'))), 3000);
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PLIST_BYTES) finish(new Error(t('系统文件剪贴板数据过大，请拖入或选择文件')));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => finish(new Error(t('系统文件剪贴板格式暂不支持，请拖入或选择文件'))));
    child.stdin.on('error', () => finish(new Error(t('系统文件剪贴板格式暂不支持，请拖入或选择文件'))));
    child.on('close', code => finish(code === 0 ? undefined : new Error(t('系统文件剪贴板格式暂不支持，请拖入或选择文件'))));
    child.stdin.end(input);
  });
}
