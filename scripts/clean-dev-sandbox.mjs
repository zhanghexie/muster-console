/**
 * 彻底清除开发沙箱目录 (.dev-sandbox/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sandboxDir = path.join(repoRoot, '.dev-sandbox');

if (fs.existsSync(sandboxDir)) {
  console.log(`[clean-sandbox] 正在清除沙箱目录: ${sandboxDir}`);
  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    console.log('[clean-sandbox] 沙箱已彻底清除。');
  } catch (err) {
    console.error('[clean-sandbox] 清除失败:', err.message);
    process.exit(1);
  }
} else {
  console.log('[clean-sandbox] 沙箱目录不存在，无需清理。');
}
