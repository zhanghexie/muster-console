export type CliComposerEdge = 'left' | 'right' | 'top' | 'bottom';
export interface CliComposerAnchor { edge: CliComposerEdge; fraction: number }
export interface CliComposerPoint { x: number; y: number }
export interface CliComposerSize { width: number; height: number; capsuleWidth: number; capsuleHeight: number; dialogHeight: number; dialogWidth?: number }
export interface CliComposerDimensions { width: number; bottomOffset: number; rightInset: number }
export type CliComposerResizeEdge = 'left' | 'right';

export const CLI_COMPOSER_INSET = 8;
export const CLI_COMPOSER_MIN_WIDTH = 240;
export const DEFAULT_CLI_COMPOSER_ANCHOR: CliComposerAnchor = { edge: 'right', fraction: 1 };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function available(size: CliComposerSize): { maxX: number; maxY: number; minX: number; minY: number } {
  const minX = Math.min(CLI_COMPOSER_INSET, Math.max(0, size.width - size.capsuleWidth));
  const minY = Math.min(CLI_COMPOSER_INSET, Math.max(0, size.height - size.capsuleHeight));
  return { minX, minY, maxX: Math.max(minX, size.width - size.capsuleWidth - CLI_COMPOSER_INSET),
    maxY: Math.max(minY, size.height - size.capsuleHeight - CLI_COMPOSER_INSET) };
}

export function clampCliComposerPoint(point: CliComposerPoint, size: CliComposerSize): CliComposerPoint {
  const { minX, minY, maxX, maxY } = available(size);
  return { x: clamp(point.x, minX, maxX), y: clamp(point.y, minY, maxY) };
}

export function pointForCliComposerAnchor(anchor: CliComposerAnchor, size: CliComposerSize): CliComposerPoint {
  const { minX, minY, maxX, maxY } = available(size);
  const fraction = clamp(anchor.fraction, 0, 1);
  if (anchor.edge === 'left' || anchor.edge === 'right') {
    return { x: anchor.edge === 'left' ? minX : maxX, y: minY + fraction * (maxY - minY) };
  }
  return { x: minX + fraction * (maxX - minX), y: anchor.edge === 'top' ? minY : maxY };
}

/** Choose the nearest panel edge and retain the relative position along that edge. */
export function snapCliComposerPoint(point: CliComposerPoint, size: CliComposerSize): CliComposerAnchor {
  const { minX, minY, maxX, maxY } = available(size);
  const p = clampCliComposerPoint(point, size);
  const candidates: Array<{ edge: CliComposerEdge; distance: number }> = [
    { edge: 'left', distance: p.x - minX }, { edge: 'right', distance: maxX - p.x },
    { edge: 'top', distance: p.y - minY }, { edge: 'bottom', distance: maxY - p.y }
  ];
  const edge = candidates.reduce((best, item) => item.distance < best.distance ? item : best).edge;
  const fraction = edge === 'left' || edge === 'right'
    ? (maxY === minY ? 0 : (p.y - minY) / (maxY - minY))
    : (maxX === minX ? 0 : (p.x - minX) / (maxX - minX));
  return { edge, fraction: clamp(fraction, 0, 1) };
}

/** Default to the capsule's centre; after resizing keep the selected bottom edge offset. */
export function cliComposerDialogPlacement(point: CliComposerPoint, size: CliComposerSize, bottomOffset?: number, rightInset = 0): {
  left: number; top: number; originX: number; originY: number; scaleX: number; scaleY: number;
} {
  const availableWidth = Math.max(1, size.width - 2 * CLI_COMPOSER_INSET);
  const width = clamp(size.dialogWidth || availableWidth, 1, availableWidth);
  const left = clamp(size.width - CLI_COMPOSER_INSET - rightInset - width, CLI_COMPOSER_INSET,
    Math.max(CLI_COMPOSER_INSET, size.width - CLI_COMPOSER_INSET - width));
  const height = Math.max(1, size.dialogHeight);
  const centreY = point.y + size.capsuleHeight / 2;
  const top = clamp(bottomOffset == null ? centreY - height / 2 : centreY + bottomOffset - height, CLI_COMPOSER_INSET,
    Math.max(CLI_COMPOSER_INSET, size.height - CLI_COMPOSER_INSET - height));
  // The scaled dialog must begin at the capsule's *edges*, not merely scale
  // around its centre: CSS transform-origin is measured on the unscaled box.
  const horizontalTravel = width - size.capsuleWidth;
  const verticalTravel = height - size.capsuleHeight;
  // A resized dialog can be to the right of its capsule. CSS permits an origin
  // outside the box, which keeps the morph's starting edges on the real capsule.
  return { left, top, originX: horizontalTravel > 0 ? (point.x - left) / horizontalTravel * 100 : 50,
    originY: verticalTravel > 0 ? (point.y - top) / verticalTravel * 100 : 50,
    scaleX: clamp(size.capsuleWidth / width, 0.01, 1), scaleY: clamp(size.capsuleHeight / height, 0.01, 1) };
}

/** Clamp to the available panel space without destroying a preference on a small window. */
export function clampCliComposerDimensions(value: CliComposerDimensions, size: CliComposerSize): CliComposerDimensions {
  const availableWidth = Math.max(1, size.width - 2 * CLI_COMPOSER_INSET);
  const rightInset = clamp(value.rightInset, 0, Math.max(0, availableWidth - Math.min(CLI_COMPOSER_MIN_WIDTH, availableWidth)));
  const maxWidth = availableWidth - rightInset;
  return { width: clamp(value.width, Math.min(CLI_COMPOSER_MIN_WIDTH, maxWidth), maxWidth),
    bottomOffset: value.bottomOffset, rightInset };
}

/** Move one edge while keeping the opposite edge fixed in the terminal panel. */
export function resizeCliComposerWidth(value: CliComposerDimensions, size: CliComposerSize,
  edge: CliComposerResizeEdge, deltaX: number): CliComposerDimensions {
  const start = clampCliComposerDimensions(value, size);
  if (edge === 'left') return clampCliComposerDimensions({ ...start, width: start.width - deltaX }, size);
  const maxWidth = start.width + start.rightInset;
  const width = clamp(start.width + deltaX, Math.min(CLI_COMPOSER_MIN_WIDTH, maxWidth), maxWidth);
  return { ...start, width, rightInset: maxWidth - width };
}

export function parseCliComposerDimensions(raw: string | null): CliComposerDimensions | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    // Older preferences also contained a manually chosen height; preserve width and placement,
    // but ignore that height so content can grow naturally again.
    const { width, bottomOffset, rightInset = 0 } = value as Record<string, unknown>;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0 &&
        typeof bottomOffset === 'number' && Number.isFinite(bottomOffset) &&
        typeof rightInset === 'number' && Number.isFinite(rightInset) && rightInset >= 0) return { width, bottomOffset, rightInset };
  } catch { /* corrupt local preference: use the default size */ }
  return null;
}

export function parseCliComposerAnchor(raw: string | null): CliComposerAnchor {
  if (!raw) return DEFAULT_CLI_COMPOSER_ANCHOR;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return DEFAULT_CLI_COMPOSER_ANCHOR;
    const { edge, fraction } = value as { edge?: unknown; fraction?: unknown };
    if ((edge === 'left' || edge === 'right' || edge === 'top' || edge === 'bottom') &&
        typeof fraction === 'number' && Number.isFinite(fraction)) return { edge, fraction: clamp(fraction, 0, 1) };
  } catch { /* corrupt local preference: use the default location */ }
  return DEFAULT_CLI_COMPOSER_ANCHOR;
}
