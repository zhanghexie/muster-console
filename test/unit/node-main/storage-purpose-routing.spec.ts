import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BrowserDownloadStore } from '../../../src/main/browser/downloadStore';
import { RuntimeAwarenessStore } from '../../../src/main/awareness/store';
import { mainLogPath } from '../../../src/main/logs/mainLog';
import { readWaitingTips } from '../../../src/main/waitingTips';

it('rejects legacy leaf-service roots before reading or creating product data', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-storage-routing-'));
  try {
    const old = path.join(parent, 'metaagent-workbench');
    for (const action of [() => new BrowserDownloadStore(old), () => new RuntimeAwarenessStore(old), () => mainLogPath(old), () => readWaitingTips(old, 'unused-seed')]) {
      expect(action).toThrow(/legacy product storage/);
    }
    expect(fs.existsSync(old)).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

it('keeps existing Muster log and waiting-tip paths readable without migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-storage-layout-'));
  try {
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'main.log'), 'existing');
    expect(mainLogPath(root)).toBe(path.join(root, 'logs', 'main.log'));
    fs.writeFileSync(path.join(root, 'waiting-tips.json'), JSON.stringify({ version: 1, tips: [{ 'zh-CN': '现有', en: 'Existing' }] }));
    const result = readWaitingTips(root, 'unused-seed');
    expect(result.ok && result.tips[0].en).toBe('Existing');
    expect(fs.readFileSync(mainLogPath(root), 'utf8')).toBe('existing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
