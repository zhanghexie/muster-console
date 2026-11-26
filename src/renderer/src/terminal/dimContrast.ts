import { parseCssColor } from '../../../shared/theme';
import { appearanceContrast, mixAppearanceColors } from '../../../shared/resolvedAppearance';

type RenderRange = { start: number; end: number };
type RenderTerminal = {
  rows: number;
  onRender: (listener: (range: RenderRange) => void) => { dispose: () => void };
  refresh: (start: number, end: number) => void;
};
type DimAppearance = { enabled: boolean; background: string };
const rgbHex = (r: number, g: number, b: number): string => '#' + [r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('');

function composite(foreground: string, background: string): string {
  const parsed = parseCssColor(foreground);
  return parsed ? mixAppearanceColors(background, rgbHex(parsed.r, parsed.g, parsed.b), parsed.a) : background;
}

/** Preserve the dim hue, repairing only foregrounds whose actual composition is too faint. */
export function readableDimForeground(foreground: string, background: string): string | null {
  const seed = composite(foreground, background);
  if (appearanceContrast(seed, background) >= 4.5) return null;
  const target = appearanceContrast('#ffffff', background) >= appearanceContrast('#000000', background) ? '#ffffff' : '#000000';
  for (let step = 1; step <= 100; step++) {
    const candidate = mixAppearanceColors(seed, target, step / 100);
    if (appearanceContrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}

/** Public onRender + official DOM renderer; never changes terminal text, cells or backgrounds. */
export function attachDimContrast(term: RenderTerminal, container: HTMLElement, initial: DimAppearance): { update: (appearance: DimAppearance) => void; dispose: () => void } {
  let appearance = initial;
  const repaired = new Map<HTMLElement, { value: string; priority: string }>();
  const restore = (): void => {
    for (const [span, original] of repaired) {
      if (!container.contains(span)) continue;
      if (original.value) span.style.setProperty('color', original.value, original.priority);
      else span.style.removeProperty('color');
    }
    repaired.clear();
  };
  const render = ({ start, end }: RenderRange): void => {
    // xterm replaces row nodes on redraw. Keep references bounded to the visible viewport.
    for (const span of repaired.keys()) if (!container.contains(span)) repaired.delete(span);
    if (!appearance.enabled) return;
    const rows = container.querySelector('.xterm-rows');
    if (!rows) return;
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleFor = (element: Element): CSSStyleDeclaration => {
      let style = styles.get(element);
      if (!style) { style = getComputedStyle(element); styles.set(element, style); }
      return style;
    };
    const backgroundFor = (span: HTMLElement): string => {
      const ancestors: HTMLElement[] = [];
      for (let node: HTMLElement | null = span; node && node !== container; node = node.parentElement) ancestors.push(node);
      return ancestors.reverse().reduce((background, node) => composite(styleFor(node).backgroundColor, background), appearance.background);
    };
    const writes: { span: HTMLElement; color: string }[] = [];
    for (let index = Math.max(0, start); index <= Math.min(end, rows.children.length - 1); index++) {
      for (const span of rows.children[index].querySelectorAll<HTMLElement>('.xterm-dim')) {
        const color = readableDimForeground(styleFor(span).color, backgroundFor(span));
        if (color) writes.push({ span, color });
      }
    }
    // Read all computed colors before writing: no per-cell read/write layout interleave.
    for (const { span, color } of writes) {
      if (!repaired.has(span)) repaired.set(span, { value: span.style.getPropertyValue('color'), priority: span.style.getPropertyPriority('color') });
      span.style.setProperty('color', color, 'important');
    }
  };
  const subscription = term.onRender(render);
  return {
    update(next) { restore(); appearance = next; term.refresh(0, Math.max(0, term.rows - 1)); },
    dispose() { subscription.dispose(); restore(); }
  };
}
