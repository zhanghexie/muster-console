import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';

describe('renderer CSP contract', () => {
  it('allows the renderer-owned development and custom protocol resources', () => {
    expect(policy).toContain('script-src');
    expect(policy).toContain('http://localhost:5188');
    expect(policy).toContain('ws://localhost:5188');
    for (const source of ['muster-app:', 'muster-root:', 'muster-ws:', 'muster-ext:']) {
      expect(policy).toContain(source);
    }
  });

  it('keeps configured external font providers and remote image previews working', () => {
    for (const source of ['https://www.oppo.com', 'https://cdn-font.hyperos.mi.com', 'https://cdn.jsdelivr.net']) {
      expect(policy).toContain(source);
    }
    expect(policy).toContain('img-src');
    expect(policy).toContain('http: https:');
  });
});
