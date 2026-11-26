import { describe, expect, it } from 'vitest';
import { runtimeFixture } from './helpers/ui-runtime-fixture';

describe('interactive UI Mermaid runtime', () => {
  it('renders pre.mermaid with the shared renderer and keeps the host measurable', async () => {
    const { document, api } = await runtimeFixture('<pre class="mermaid">flowchart LR\nA --> B</pre>');
    const host = document.querySelector('pre.mermaid') as HTMLElement;
    expect(host.dataset.maMermaidState).toBe('rendered');
    expect(host.classList.contains('ma-mermaid-rendered')).toBe(true);
    expect(host.querySelector('svg')).toBeTruthy();
    expect(api.getDiagnostics()).toEqual([]);
  });

  it('falls back to source and exposes a recoverable diagnostic on parse failure', async () => {
    const { document, api } = await runtimeFixture('<pre class="mermaid">invalid diagram</pre>');
    const host = document.querySelector('pre.mermaid') as HTMLElement;
    expect(host.dataset.maMermaidState).toBe('error');
    expect(host.classList.contains('ma-mermaid-fallback')).toBe(true);
    expect(host.textContent).toContain('invalid diagram');
    expect(api.getDiagnostics()).toEqual([expect.objectContaining({ component: 'mermaid', code: 'mermaid_parse' })]);
  });
});
