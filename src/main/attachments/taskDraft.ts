import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ChatImageAttachment } from '../../shared/types';
import { t } from '../../shared/i18n';

/** Freeze upload bytes before handing ownership to a queue or a saved task. */
export async function snapshotTaskAttachments(items: ChatImageAttachment[], local: boolean): Promise<ChatImageAttachment[]> {
  if (!Array.isArray(items) || items.length > 32) throw new Error(t('一次最多发送 32 个附件'));
  let remaining = 256 * 1024 * 1024;
  const snapshots: ChatImageAttachment[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.mimeType !== 'string' || typeof item.data !== 'string' ||
        (item.name !== undefined && typeof item.name !== 'string')) throw new Error(t('附件数据无效，请重新添加'));
    let data = item.data;
    if (item.sourcePath) {
      if (!local) throw new Error(t('远程附件不能引用宿主本地路径，请重新选择文件'));
      if (typeof item.sourcePath !== 'string' || !path.isAbsolute(item.sourcePath)) throw new Error(t('附件数据无效，请重新添加'));
      const file = await open(item.sourcePath, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > remaining) throw new Error(t('{{name}}: 附件大小超过限制', { name: item.name }));
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error(t('附件数据无效，请重新添加'));
          offset += bytesRead;
        }
        if ((await file.stat()).size !== stat.size) throw new Error(t('附件数据无效，请重新添加'));
        data = bytes.toString('base64');
      } finally { await file.close(); }
    }
    const size = Buffer.byteLength(data, 'base64');
    if (size > remaining) throw new Error(t('{{name}}: 附件大小超过限制', { name: item.name }));
    remaining -= size;
    snapshots.push({ id: item.id, data, mimeType: item.mimeType, name: item.name, size });
  }
  return snapshots;
}
