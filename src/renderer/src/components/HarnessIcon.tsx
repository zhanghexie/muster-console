import React from 'react';
import { AppLogo } from './AppLogo';

// These URLs are resolved by Vite at build time, so the catalogue remains usable
// without network access. Sources for the vendor marks are recorded alongside them.
const logos: Record<string, string> = {
  claude: new URL('../assets/harness-brands/claude.svg', import.meta.url).href,
  codex: new URL('../assets/harness-brands/openai.svg', import.meta.url).href,
  cursor: new URL('../assets/harness-brands/cursor.svg', import.meta.url).href,
  gemini: new URL('../assets/harness-brands/geminicli-color.svg', import.meta.url).href,
  kimi: new URL('../assets/harness-brands/kimi.png', import.meta.url).href,
  opencode: new URL('../assets/harness-brands/opencode.png', import.meta.url).href,
  antigravity: new URL('../assets/harness-brands/antigravity.png', import.meta.url).href,
  pi: new URL('../assets/harness-brands/pi.svg', import.meta.url).href,
  deepseek: new URL('../assets/harness-brands/deepseek-color.svg', import.meta.url).href,
  grok: new URL('../assets/harness-brands/grok.png', import.meta.url).href,
  'mimo-code': new URL('../assets/harness-brands/mimo.png', import.meta.url).href,
  zcode: new URL('../assets/harness-brands/zcode.png', import.meta.url).href,
  commandcode: new URL('../assets/harness-brands/commandcode.png', import.meta.url).href,
  muse: new URL('../assets/harness-brands/muse.svg', import.meta.url).href,
  omp: new URL('../assets/harness-brands/omp.svg', import.meta.url).href,
  hermes: new URL('../assets/harness-brands/hermes.svg', import.meta.url).href,
  'github-copilot': new URL('../assets/harness-brands/github-copilot.svg', import.meta.url).href,
  cline: new URL('../assets/harness-brands/cline.svg', import.meta.url).href,
  devin: new URL('../assets/harness-brands/devin.svg', import.meta.url).href,
  kilo: new URL('../assets/harness-brands/kilo.svg', import.meta.url).href
};

const monochrome = new Set(['codex', 'cursor', 'pi', 'github-copilot', 'cline', 'devin', 'kilo']);
const aliases: Record<string, string> = {
  'claude-code': 'claude', 'codex-gui': 'codex', 'cursor-cli': 'cursor',
  'pi-external': 'pi', 'muse-gui': 'muse', 'zcode-gui': 'zcode'
};

/** Decorative brand mark; the nearby product name supplies the accessible label. */
export function HarnessIcon({ harnessId, size = 20, className }: {
  harnessId: string;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const id = aliases[harnessId] ?? harnessId;
  const src = logos[id];
  const base: React.CSSProperties = { width: size, height: size, flex: `0 0 ${size}px`, display: 'inline-grid', placeItems: 'center' };
  if (id === 'muster-core') {
    return <span className={className} style={base} aria-hidden="true"><AppLogo size={size}/></span>;
  }
  if (src && monochrome.has(id)) {
    return <span className={className} aria-hidden="true" style={{ ...base, backgroundColor: 'currentColor',
      maskImage: `url("${src}")`, maskSize: 'contain', maskPosition: 'center', maskRepeat: 'no-repeat',
      WebkitMaskImage: `url("${src}")`, WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', WebkitMaskRepeat: 'no-repeat' }}/>
  }
  if (src) {
    return <img className={className} src={src} width={size} height={size} draggable={false} alt="" aria-hidden="true"
      style={{ ...base, objectFit: 'contain' }}/>;
  }
  return <span className={className} aria-hidden="true" style={{ ...base, borderRadius: Math.max(3, size / 5),
    background: 'var(--surface-raised)', color: 'var(--fg-primary)', fontWeight: 700, fontSize: Math.max(10, size * 0.65), lineHeight: 1 }}>
    {id.slice(0, 1).toUpperCase() || '?'}
  </span>;
}
