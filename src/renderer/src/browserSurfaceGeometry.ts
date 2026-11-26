/** CSS viewport coordinates; callers must identify every clipping ancestor. */
export interface BrowserSurfaceRect { x: number; y: number; width: number; height: number }
export type BrowserSurfaceClip = { kind: 'rect'; rect: BrowserSurfaceRect } | { kind: 'unsupported' };
export type BrowserSurfaceVisibility =
  | { kind: 'visible'; inset: { top: number; right: number; bottom: number; left: number } }
  | { kind: 'hidden' }
  | { kind: 'unsupported' };

function valid(rect: BrowserSurfaceRect): boolean {
  return !!rect && [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;
}

/** Rectangular intersections are rounded inward so partial pixels cannot escape a clip. */
export function browserSurfaceVisibility(surface: BrowserSurfaceRect, viewport: BrowserSurfaceRect,
  clips: readonly BrowserSurfaceClip[]): BrowserSurfaceVisibility {
  if (!valid(surface) || !valid(viewport) || !Array.isArray(clips)) throw new Error('Invalid browser surface geometry');
  if (clips.some(clip => !clip || (clip.kind !== 'rect' && clip.kind !== 'unsupported') || (clip.kind === 'rect' && !valid(clip.rect)))) {
    throw new Error('Invalid browser surface clip');
  }
  if (clips.some(clip => clip.kind === 'unsupported')) return { kind: 'unsupported' };
  const rectangles = [viewport, ...clips.flatMap(clip => clip.kind === 'rect' ? [clip.rect] : [])];
  let left = surface.x, top = surface.y, right = surface.x + surface.width, bottom = surface.y + surface.height;
  for (const rect of rectangles) {
    left = Math.max(left, rect.x); top = Math.max(top, rect.y);
    right = Math.min(right, rect.x + rect.width); bottom = Math.min(bottom, rect.y + rect.height);
  }
  if (right <= left || bottom <= top) return { kind: 'hidden' };
  const inset = { top: Math.ceil(top - surface.y), right: Math.ceil(surface.x + surface.width - right),
    bottom: Math.ceil(surface.y + surface.height - bottom), left: Math.ceil(left - surface.x) };
  if (inset.left + inset.right >= surface.width || inset.top + inset.bottom >= surface.height) return { kind: 'hidden' };
  return { kind: 'visible', inset };
}
