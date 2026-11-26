/**
 * 把上传图中心裁成正方形、缩到 size、按圆裁切后导出 PNG data URL。
 */

/** 上传预检上限：超大图先解码可占数百 MB 内存，入口直接拒绝（约 20MB） */
export const MAX_AVATAR_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function cropScaleAvatarFile(file: File, size = 128): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('not-image');
  }
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
    throw new Error('too-large');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-canvas');
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode-failed'));
    img.src = src;
  });
}
