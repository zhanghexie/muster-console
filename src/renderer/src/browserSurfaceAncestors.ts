import { browserSurfaceVisibility, type BrowserSurfaceClip, type BrowserSurfaceVisibility } from './browserSurfaceGeometry';

const clipsOverflow = (value: string): boolean => ['hidden', 'clip', 'scroll', 'auto', 'overlay'].includes(value);
function zeroRadius(value: string): boolean {
  const parts = value.trim().split(/[\s/]+/);
  return parts.length > 0 && parts.every(part => /^(?:0+(?:\.0+)?|\.0+)(?:px|%)?$/.test(part));
}
function axisAlignedTransform(value: string): boolean {
  if (!value || value === 'none') return true;
  const match = /^matrix\(([^)]+)\)$/.exec(value);
  if (!match) return false;
  const n = match[1].split(',').map(Number);
  return n.length === 6 && n.every(Number.isFinite) && n[0] > 0 && n[3] > 0 && n[1] === 0 && n[2] === 0;
}

/** One snapshot only: callers must re-evaluate on layout, scroll and animation changes. */
export function inspectBrowserSurface(target: HTMLElement): BrowserSurfaceVisibility {
  if (!target?.isConnected || !target.ownerDocument.defaultView) throw new Error('Browser surface target is disconnected');
  const win = target.ownerDocument.defaultView;
  const surface = target.getBoundingClientRect();
  const viewport = { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight };
  const clips: BrowserSurfaceClip[] = [];
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || node.inert ||
        (style.opacity && Number(style.opacity) === 0)) return { kind: 'hidden' };
    if (!axisAlignedTransform(style.transform) || (style.opacity && Number(style.opacity) !== 1) ||
        (style.clipPath && style.clipPath !== 'none') || (style.maskImage && style.maskImage !== 'none') ||
        (style.filter && style.filter !== 'none') || (style.backdropFilter && style.backdropFilter !== 'none') ||
        (style.mixBlendMode && style.mixBlendMode !== 'normal') || (style.clip && style.clip !== 'auto') ||
        /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(style.contain)) return { kind: 'unsupported' };
    const clipX = clipsOverflow(style.overflowX), clipY = clipsOverflow(style.overflowY);
    if (!clipX && !clipY) continue;
    if (![style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].every(zeroRadius)) return { kind: 'unsupported' };
    const rect = node.getBoundingClientRect();
    if (node.offsetWidth <= 0 || node.offsetHeight <= 0) return { kind: 'hidden' };
    const scaleX = rect.width / node.offsetWidth, scaleY = rect.height / node.offsetHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return { kind: 'unsupported' };
    clips.push({ kind: 'rect', rect: {
      x: clipX ? rect.x + node.clientLeft * scaleX : viewport.x,
      y: clipY ? rect.y + node.clientTop * scaleY : viewport.y,
      width: clipX ? node.clientWidth * scaleX : viewport.width,
      height: clipY ? node.clientHeight * scaleY : viewport.height
    } });
  }
  return browserSurfaceVisibility({ x: surface.x, y: surface.y, width: surface.width, height: surface.height }, viewport, clips);
}
