import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseWaitingTips } from '../../src/shared/waitingTips';
import { readWaitingTips } from '../../src/main/waitingTips';

describe('editable waiting tips file', () => {
  it('ships a valid default file as an unpacked resource for installed builds', () => {
    const builder = parseYaml(fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8'));
    expect(builder.extraResources).toContainEqual({ from: 'resources/waiting-tips.json', to: 'waiting-tips.json' });
    const seed = JSON.parse(fs.readFileSync(path.resolve('resources/waiting-tips.json'), 'utf8'));
    expect(parseWaitingTips(seed).length).toBeGreaterThan(0);
  });
  it('seeds once, reloads edits, preserves the file, and reports invalid data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-tips-'));
    try {
      const seed = path.join(root, 'seed.json');
      const data = path.join(root, 'data');
      const first = { version: 1, tips: [{ 'zh-CN': '示例', en: 'Example' }] };
      fs.writeFileSync(seed, JSON.stringify(first));
      const seeded = readWaitingTips(data, seed);
      expect(seeded.ok && seeded.tips[0].en).toBe('Example');
      const file = path.join(data, 'waiting-tips.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, tips: [{ 'zh-CN': '更新', en: 'Updated' }] }));
      const edited = readWaitingTips(data, seed);
      expect(edited.ok && edited.tips[0].en).toBe('Updated');
      fs.writeFileSync(file, '{broken');
      const invalid = readWaitingTips(data, seed);
      expect(invalid.ok).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
      fs.writeFileSync(file, JSON.stringify({ version: 1, tips: [] }));
      expect(readWaitingTips(data, seed)).toMatchObject({ ok: true, tips: [] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
