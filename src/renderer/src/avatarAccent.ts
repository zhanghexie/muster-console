import { pickDominantAccent } from '../../shared/workspaceAccent';
import { isImageAvatarSrc } from '../../shared/userAvatar';
import { workspaceIconUrl } from './workspaceIcons';

const SIZE = 32;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * 工作区头像 → 强调色：图片/emoji 画到 32×32 画布取像素，交给 pickDominantAccent。
 * 无画布（jsdom）、跨域污染画布、近灰头像都返回 null → 调用方回退哈希色。
 */
export async function extractAvatarAccent(avatar: string | undefined): Promise<string | null> {
  const src = avatar?.trim();
  if (!src || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx) return null;
  try {
    const builtinSrc = workspaceIconUrl(src);
    if (builtinSrc || isImageAvatarSrc(src)) {
      const img = await loadImage(builtinSrc ?? src);
      if (!img) return null;
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${SIZE - 4}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      ctx.fillText(src, SIZE / 2, SIZE / 2 + 1);
    }
    return pickDominantAccent(ctx.getImageData(0, 0, SIZE, SIZE).data);
  } catch {
    return null;
  }
}
